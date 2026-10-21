"""The deploy kit: the web proxy follows the API to a new address and serves the public pages
as files of their own, deploy.sh migrates before it replaces anything and brings the previous
version back only onto its own database, and
restore.sh replaces the database with exactly the dump, whatever its own backup prunes, and
update.sh brings a version's kit from GitHub before deploying it, and upgrade.sh brings it from
a clone of the repository."""

import os
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

needs_bash = pytest.mark.skipif(
    sys.platform == "win32" or shutil.which("bash") is None, reason="runs the kit in bash"
)


def test_web_proxy_asks_dockers_dns_again():
    # A literal proxy_pass host is resolved once at startup; a recreated api moves elsewhere.
    conf = (ROOT / "web" / "nginx.conf").read_text()
    assert re.search(r"^resolver 127\.0\.0\.11 valid=\d+s", conf, re.M)
    upstream = re.search(r"upstream api \{(.*?)\}", conf, re.S)
    assert upstream and "zone api " in upstream[1]
    assert "server api:8000 resolve;" in upstream[1]
    assert set(re.findall(r"proxy_pass (\S+);", conf)) == {"http://api"}


def test_web_proxy_limits_google_sign_in_challenges():
    # Each challenge is a database row kept for a day, and anyone may ask for one. Only the host
    # proxy reaches the live container, and it sets X-Forwarded-For to the visitor's address.
    conf = (ROOT / "web" / "nginx.conf").read_text()
    zone = re.search(
        r"^limit_req_zone \$http_x_forwarded_for zone=(\w+):\w+ rate=(\d+)r/m;", conf, re.M
    )
    assert zone and int(zone[2]) <= 10
    location = re.search(r"location = /api/v1/auth/google/start \{(.*?)\}", conf, re.S)
    assert location
    assert re.search(rf"limit_req zone={zone[1]} burst=\d+ nodelay;", location[1])
    assert "limit_req_status 429;" in location[1]
    assert "proxy_pass http://api;" in location[1]
    # The API takes the visitor's address from this header (SysOp's network check depends on it).
    assert "proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;" in location[1]


def test_web_proxy_serves_the_public_pages():
    # About, Privacy and Terms (v0.4.1): files at addresses of their own, for anyone, with
    # JavaScript or without. Google's consent screen names them.
    conf = (ROOT / "web" / "nginx.conf").read_text()
    public = ROOT / "web" / "public"
    for name in ("about", "privacy", "terms"):
        location = re.search(rf"location = /{name} \{{(.*?)\}}", conf, re.S)
        assert location, name
        # One exact file, never `$uri/`, whose directory redirect would name the container's port.
        assert f"try_files /pages/{name}.html =404;" in location[1]
        assert "$uri/" not in location[1]
        # Checked on every visit, so a new text shows at once; and no add_header of its own,
        # which would drop the site's headers for this location.
        assert "expires -1;" in location[1]
        assert "add_header" not in location[1]
        assert (public / "pages" / f"{name}.html").is_file()
    folder = re.search(r"location /pages/ \{(.*?)\}", conf, re.S)
    assert folder and "try_files $uri =404;" in folder[1] and "add_header" not in folder[1]


def test_public_pages_need_nothing_the_content_security_policy_refuses():
    conf = (ROOT / "web" / "nginx.conf").read_text()
    policy = re.search(r'Content-Security-Policy "([^"]*)"', conf)
    assert policy and "style-src 'self'" in policy[1] and "'unsafe-inline'" not in policy[1]
    public = ROOT / "web" / "public"
    pages = sorted((public / "pages").glob("*.html"))
    assert [page.name for page in pages] == ["about.html", "privacy.html", "terms.html"]
    for page in pages:
        html = page.read_text(encoding="utf-8")
        # No inline script, style or event handler: the policy would refuse them.
        assert not re.search(r"<script|<style|\sstyle=|\son\w+=", html, re.I), page.name
        # The stylesheet and every image come from the site itself, and exist.
        assert re.findall(r'<link rel="stylesheet" href="([^"]+)"', html) == ["/pages/pages.css"]
        for path in re.findall(r'(?:src|href)="(/[^"]*\.(?:css|png|webp))"', html):
            assert (public / path.lstrip("/")).is_file(), (page.name, path)


def test_both_proxies_take_a_report_with_its_screenshot():
    # A 5 MB screenshot is about 7 MB in base64; every other request stays within nginx's 1 MB.
    for path, forwarded in (
        (ROOT / "web" / "nginx.conf", "$proxy_add_x_forwarded_for"),
        (ROOT / "deploy" / "nginx" / "duels.thesphinx.co", "$remote_addr"),
    ):
        conf = path.read_text()
        assert len(re.findall(r"client_max_body_size", conf)) == 1, path
        location = re.search(r"location = /api/v1/reports \{(.*?)\n\s*\}", conf, re.S)
        assert location, path
        size = re.search(r"client_max_body_size (\d+)m;", location[1])
        assert size and 7 <= int(size[1]) <= 10, path
        assert re.search(r"proxy_pass http://\S+;", location[1]), path
        assert f"proxy_set_header X-Forwarded-For {forwarded};" in location[1], path


def test_restore_empties_the_database_and_stops_at_the_first_error():
    script = (ROOT / "deploy" / "restore.sh").read_text()
    drop = script.index("DROP DATABASE commander WITH (FORCE)")
    restore = script.index("pg_restore -U commander -d commander")
    assert script.index("./backup.sh pre-restore") < script.index("stop api worker") < drop
    assert drop < restore
    assert "--exit-on-error --single-transaction" in script[restore:]
    assert "--clean" not in script


def install(tmp_path: Path, stub: str, *scripts: str) -> tuple[Path, dict[str, str]]:
    """Copies the kit's scripts into tmp_path/kit, with a stub docker (and sleep) on the PATH."""
    kit = tmp_path / "kit"
    (kit / "backups").mkdir(parents=True)
    for name in scripts:
        shutil.copy(ROOT / "deploy" / name, kit / name)
        # As push.sh leaves them on the VM, whatever mode the checkout gave them.
        (kit / name).chmod(0o750)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    # deploy.sh waits between its readiness checks; the tests need not.
    for name, body in (("docker", stub), ("sleep", "#!/bin/sh\n")):
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    return kit, {"PATH": f"{bin_dir}:/usr/bin:/bin", "STUB_LOG": str(tmp_path / "docker.log")}


# Stands in for docker on the VM. It logs each call with the CD_VERSION it sees and keeps the
# running API version (or none) in STUB_RUNNING and the database's last migration in STUB_DB.
# The tags in STUB_NEWER end at migration r2, the others at r1; like Alembic, a migrate step fails
# on a database past its tag's last migration. Steps also fail for the tags in STUB_MIGRATE_FAIL,
# STUB_UP_FAIL or STUB_READY_FAIL. Like Compose, `up` replaces the running containers before its
# migrate step runs.
DEPLOY_STUB = r"""#!/usr/bin/env bash
echo "CD_VERSION=${CD_VERSION:-} $*" >> "$STUB_LOG"
fails() { local v; for v in $1; do [ "$v" = "$2" ] && return 0; done; return 1; }
last_migration() { if fails "${STUB_NEWER:-}" "$1"; then echo r2; else echo r1; fi; }
migrate() {
  if fails "${STUB_MIGRATE_FAIL:-}" "$CD_VERSION" \
      || [ "$(cat "$STUB_DB")" \> "$(last_migration "$CD_VERSION")" ]; then
    echo "FAILED" >&2
    return 1
  fi
  last_migration "$CD_VERSION" > "$STUB_DB"
}
case "$*" in
  "compose ps -q db") echo 0123456789ab ;;
  "compose ps -q api") [ "$(cat "$STUB_RUNNING")" = none ] || echo 0123456789ac ;;
  "compose exec -T db pg_dump"*) echo dump ;;
  "compose exec -T db psql"*"FROM alembic_version") cat "$STUB_DB" ;;
  "compose run --rm -T migrate") migrate || exit 1 ;;
  "compose pull --quiet")
    if fails "${STUB_PULL_FAIL:-}" "$CD_VERSION"; then echo "denied" >&2; exit 1; fi ;;
  "compose up -d --wait --remove-orphans")
    if ! migrate || fails "${STUB_UP_FAIL:-}" "$CD_VERSION"; then
      echo none > "$STUB_RUNNING"
      exit 1
    fi
    echo "$CD_VERSION" > "$STUB_RUNNING" ;;
  *"/api/v1/ready")
    if fails "${STUB_READY_FAIL:-}" "$(cat "$STUB_RUNNING")"; then
      echo "wget: server returned error: HTTP/1.1 502 Bad Gateway" >&2; exit 1
    fi
    echo '{"status":"ready"}' ;;
  *"/api/v1/health"|*"/api/v1/engine/status"|"image prune -f") ;;
  *) echo "unexpected: docker $*" >&2; exit 99 ;;
esac
"""


def deploy(
    tmp_path: Path,
    previous: str,
    tag: str,
    running: str = "",
    db: str = "",
    settings: str = "",
    **stub: str,
) -> dict[str, str]:
    """Runs deploy.sh <tag> with <previous> in .env, running (unless running="none") on a
    database at its own last migration (unless db is given). settings adds lines to .env."""
    kit, env = install(tmp_path, DEPLOY_STUB, "deploy.sh", "backup.sh")
    (kit / ".env").write_text(
        f"CD_VERSION={previous}\nCD_GOOGLE_CLIENT_ID=client\nCD_PROXY_ADDRESS=10.10.50.2\n"
        + settings
    )
    (tmp_path / "running").write_text(running or previous)
    newer = stub.get("STUB_NEWER", "").split()
    (tmp_path / "db").write_text(db or ("r2" if previous in newer else "r1"))
    env |= {"STUB_RUNNING": str(tmp_path / "running"), "STUB_DB": str(tmp_path / "db"), **stub}
    result = subprocess.run(
        ["bash", str(kit / "deploy.sh"), tag], env=env, capture_output=True, text=True
    )
    return {
        "status": str(result.returncode),
        "stdout": result.stdout,
        "stderr": result.stderr,
        "log": (tmp_path / "docker.log").read_text(),
        "running": (tmp_path / "running").read_text().strip(),
        "db": (tmp_path / "db").read_text().strip(),
        "env": re.findall(r"^CD_VERSION=(.*)$", (kit / ".env").read_text(), re.M)[0],
    }


@needs_bash
def test_deploy_migrates_before_replacing_anything(tmp_path):
    result = deploy(tmp_path, "0.1.0", "0.1.1", STUB_NEWER="0.1.1")
    assert result["status"] == "0"
    log = result["log"]
    migrate = log.index("CD_VERSION=0.1.1 compose run --rm -T migrate")
    assert log.index("pg_dump") < migrate < log.index("CD_VERSION=0.1.1 compose up")
    assert (result["running"], result["env"], result["db"]) == ("0.1.1", "0.1.1", "r2")


def test_the_engine_image_may_be_the_owners_private_one():
    # v0.4.0: CD_ENGINE_IMAGE in .env names another engine image (the one with the Godlike
    # tier's custom cards), tagged as the version like the others; unset, the public one.
    compose = (ROOT / "deploy" / "compose.yaml").read_text()
    images = dict(re.findall(r"^  (\w+):\n(?:    .*\n)*?    image: (\S+)", compose, re.M))
    assert images["engine"] == (
        "${CD_ENGINE_IMAGE:-${CD_REGISTRY:-ghcr.io/sphinxtah/commander-duels}/engine}"
        ":${CD_VERSION:?}"
    )
    assert images["web"] == "${CD_REGISTRY:-ghcr.io/sphinxtah/commander-duels}/web:${CD_VERSION:?}"
    api = re.search(r"^  image: (.+)$", compose, re.M)
    assert api and api[1] == (
        "${CD_REGISTRY:-ghcr.io/sphinxtah/commander-duels}/api:${CD_VERSION:?set by deploy.sh}"
    )
    # The dev stack builds its engine from this repository.
    dev = (ROOT / "compose.yaml").read_text()
    assert "build: {context: ., dockerfile: engine/Dockerfile}" in dev
    # The image puts a derived image's plugins on the engine's classpath.
    dockerfile = (ROOT / "engine" / "Dockerfile").read_text()
    runtime = dockerfile[dockerfile.index("AS runtime") :]
    assert "chown 10001:10001 /app/plugins" in runtime
    assert '"-cp", "/app/engine.jar:/app/lib/*:/app/plugins/*"' in runtime


@needs_bash
def test_deploy_names_a_private_engine_and_stops_when_it_cannot_pull(tmp_path):
    private = "CD_ENGINE_IMAGE=ghcr.io/sphinxtah/commander-duels-engine-sphinx\n"
    pulled = deploy(tmp_path / "pulled", "0.1.0", "0.1.1", settings=private)
    assert pulled["status"] == "0"
    assert "(engine: ghcr.io/sphinxtah/commander-duels-engine-sphinx:0.1.1)" in pulled["stdout"]
    refused = deploy(
        tmp_path / "refused", "0.1.0", "0.1.1", settings=private, STUB_PULL_FAIL="0.1.1"
    )
    assert refused["status"] == "1"
    assert "pg_dump" not in refused["log"] and "migrate" not in refused["log"]
    assert (refused["running"], refused["env"]) == ("0.1.0", "0.1.0")
    assert "logged in to ghcr.io" in refused["stderr"]
    # The public engine needs no login, and the message does not suggest one.
    public = deploy(tmp_path / "public", "0.1.0", "0.1.1", STUB_PULL_FAIL="0.1.1")
    assert public["status"] == "1" and "ghcr.io" not in public["stderr"]


@needs_bash
def test_failed_migrations_leave_the_running_version_alone(tmp_path):
    result = deploy(tmp_path, "0.1.0", "0.1.1", STUB_MIGRATE_FAIL="0.1.1")
    assert result["status"] == "1"
    assert "compose up" not in result["log"]
    assert (result["running"], result["env"]) == ("0.1.0", "0.1.0")
    assert "Nothing was replaced" in result["stderr"]


@needs_bash
def test_a_rollback_past_a_migration_is_refused_before_anything_is_replaced(tmp_path):
    # The older image's migrate step cannot find the newer revision.
    result = deploy(tmp_path, "0.1.1", "0.1.0", STUB_NEWER="0.1.1")
    assert result["status"] == "1"
    assert "compose up" not in result["log"]
    assert (result["running"], result["db"]) == ("0.1.1", "r2")
    assert "Rolling back" in result["stderr"]


@needs_bash
@pytest.mark.parametrize("failure", ["STUB_UP_FAIL", "STUB_READY_FAIL"])
def test_a_tag_that_fails_to_start_brings_the_previous_one_back(tmp_path, failure):
    result = deploy(tmp_path, "0.1.0", "0.1.1", **{failure: "0.1.1"})
    assert result["status"] == "1"
    assert "CD_VERSION=0.1.0 compose up" in result["log"]
    assert (result["running"], result["env"]) == ("0.1.0", "0.1.0")
    assert "0.1.0 is running again." in result["stderr"]


@needs_bash
@pytest.mark.parametrize("failure", ["STUB_UP_FAIL", "STUB_READY_FAIL"])
def test_a_tag_whose_migrations_moved_the_database_names_the_dump_to_restore(tmp_path, failure):
    result = deploy(tmp_path, "0.1.0", "0.1.1", STUB_NEWER="0.1.1", **{failure: "0.1.1"})
    assert result["status"] == "1"
    assert "CD_VERSION=0.1.0 compose up" not in result["log"]
    assert result["db"] == "r2"
    assert re.search(
        r"\./restore\.sh backups/commander-\d{8}T\d{6}Z-pre-0\.1\.1\.dump && \./deploy\.sh 0\.1\.0",
        result["stderr"],
    )


@needs_bash
@pytest.mark.parametrize("failure", ["STUB_UP_FAIL", "STUB_READY_FAIL"])
def test_a_failed_rollback_leaves_the_restored_database_alone(tmp_path, failure):
    # Rolling back from 0.1.2: restore.sh put back 0.1.1's database (r1) and stopped the API,
    # and .env still names 0.1.2. Starting 0.1.2 again would migrate the database to r2.
    result = deploy(
        tmp_path,
        "0.1.2",
        "0.1.1",
        running="none",
        db="r1",
        STUB_NEWER="0.1.2",
        **{failure: "0.1.1"},
    )
    assert result["status"] == "1"
    assert "CD_VERSION=0.1.2" not in result["log"]
    assert result["db"] == "r1"
    assert "0.1.2 is not started again" in result["stderr"]


# Stands in for docker under restore.sh: STUB_RESTORED gets what pg_restore reads.
RESTORE_STUB = r"""#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$*" in
  "compose exec -T db pg_restore --list") cat > /dev/null ;;
  "compose exec -T db pg_dump"*) echo "the replaced database" ;;
  "compose exec -T db pg_restore -U commander -d commander"*) cat > "$STUB_RESTORED" ;;
  "compose exec -T db psql -U commander -d commander"*) echo r1 ;;
  "compose stop api worker"|"compose exec -T db psql -U commander -d postgres"*) ;;
  *) echo "unexpected: docker $*" >&2; exit 99 ;;
esac
"""


@needs_bash
@pytest.mark.parametrize("target", ["pre-0.1.2", "pre-restore"])
def test_restore_keeps_the_dump_it_restores_when_its_backup_prunes(tmp_path, target):
    # Ten pre-deploy and five pre-restore dumps, each kind full; the oldest is the one restored.
    kit, env = install(tmp_path, RESTORE_STUB, "restore.sh", "backup.sh")
    labels = [f"pre-sha-{n}" for n in range(10)] + ["pre-restore"] * 5
    labels.remove("pre-restore" if target == "pre-restore" else "pre-sha-0")
    for day, label in enumerate([target, *labels], start=1):
        dump = kit / "backups" / f"commander-202610{day:02}T000000Z-{label}.dump"
        dump.write_text(f"dump {day}")
        os.utime(dump, (1_790_000_000 + day * 3600,) * 2)
    oldest = f"backups/commander-20261001T000000Z-{target}.dump"
    env["STUB_RESTORED"] = str(tmp_path / "restored")
    result = subprocess.run(
        ["bash", str(kit / "restore.sh"), oldest], env=env, capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
    assert (tmp_path / "restored").read_text() == "dump 1"
    # A restore never pushes out the pre-deploy dumps that a rollback needs.
    kept = sorted(p.name for p in (kit / "backups").iterdir())
    assert len([name for name in kept if not name.endswith("-pre-restore.dump")]) == 10
    assert len([name for name in kept if name.endswith("-pre-restore.dump")]) == 5


# Stands in for curl on the VM: GitHub's tag list (STUB_TAGS) and its archives of a ref, one
# .tar.gz per ref in STUB_ARCHIVES, named after the ref with / as _. Unknown refs answer 404.
CURL_STUB = r"""#!/usr/bin/env bash
url="${*: -1}"
echo "$url" >> "$STUB_LOG"
case "$url" in
  https://api.github.com/repos/sphinxtah/commander-duels/tags*) cat "$STUB_TAGS" ;;
  https://codeload.github.com/sphinxtah/commander-duels/tar.gz/*)
    archive="$STUB_ARCHIVES/$(printf '%s' "${url##*/tar.gz/}" | tr / _).tar.gz"
    if [ -f "$archive" ]; then cat "$archive"; else
      echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; fi ;;
  *) echo "unexpected: curl $*" >&2; exit 99 ;;
esac
"""


def archive(tmp_path: Path, ref: str, files: dict[str, str]) -> None:
    """GitHub's archive of a ref: everything under one top folder, the kit under deploy/."""
    folder = tmp_path / "archives"
    folder.mkdir(exist_ok=True)
    with tarfile.open(folder / f"{ref.replace('/', '_')}.tar.gz", "w:gz") as tar:
        for name, body in files.items():
            source = tmp_path / "member"
            source.write_text(body)
            tar.add(source, arcname=f"commander-duels-{ref.rsplit('/', 1)[-1]}/deploy/{name}")


def kit_of(version: str) -> dict[str, str]:
    """A version's kit whose deploy.sh records what it was asked to deploy."""
    return {
        "compose.yaml": f"# compose of {version}\n",
        "deploy.sh": f'#!/usr/bin/env bash\necho "{version} $*" > "$STUB_DEPLOYED"\n',
        "backup.sh": f"#!/usr/bin/env bash\n# backup of {version}\n",
        "restore.sh": f"#!/usr/bin/env bash\n# restore of {version}\n",
        "env.example": f"# env of {version}\n",
        "nginx/duels.thesphinx.co": "# the proxy's site file stays out of the VM's folder\n",
    }


def update(tmp_path: Path, *args: str, tags: tuple[str, ...] = ()) -> dict[str, str]:
    """Runs update.sh from a VM folder holding an older kit, a .env and a backup."""
    kit = tmp_path / "kit"
    (kit / "backups").mkdir(parents=True)
    for name in ("compose.yaml", "deploy.sh", "backup.sh", "restore.sh"):
        (kit / name).write_text("old\n")
    (kit / ".env").write_text("CD_VERSION=0.1.0\n")
    (kit / "backups" / "commander-20261020T000000Z-nightly.dump").write_text("dump")
    shutil.copy(ROOT / "deploy" / "update.sh", kit / "update.sh")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "curl").write_text(CURL_STUB)
    (bin_dir / "curl").chmod(0o755)
    listed = ",".join(f'{{"name": "{tag}", "commit": {{}}}}' for tag in tags)
    (tmp_path / "tags.json").write_text(f"[{listed}]")
    env = {
        "PATH": f"{bin_dir}:/usr/bin:/bin",
        "STUB_LOG": str(tmp_path / "curl.log"),
        "STUB_TAGS": str(tmp_path / "tags.json"),
        "STUB_ARCHIVES": str(tmp_path / "archives"),
        "STUB_DEPLOYED": str(tmp_path / "deployed"),
    }
    result = subprocess.run(
        ["bash", str(kit / "update.sh"), *args], env=env, capture_output=True, text=True
    )
    deployed = tmp_path / "deployed"
    urls = tmp_path / "curl.log"
    return {
        "status": str(result.returncode),
        "stdout": result.stdout,
        "stderr": result.stderr,
        "deployed": deployed.read_text().strip() if deployed.exists() else "",
        "urls": urls.read_text() if urls.exists() else "",
    }


@needs_bash
def test_update_brings_the_newest_versions_kit_and_deploys_it(tmp_path):
    for version in ("0.1.2", "0.1.10"):
        archive(tmp_path, f"refs/tags/v{version}", kit_of(version))
    result = update(tmp_path, tags=("v0.1.2", "v0.1.10", "v0.0.9", "not-a-version"))
    assert result["status"] == "0", result["stderr"]
    # Versions compare as numbers: 0.1.10 is newer than 0.1.2.
    assert "tar.gz/refs/tags/v0.1.10" in result["urls"]
    assert result["deployed"] == "0.1.10 0.1.10"
    kit = tmp_path / "kit"
    assert (kit / "compose.yaml").read_text() == "# compose of 0.1.10\n"
    assert "backup of 0.1.10" in (kit / "backup.sh").read_text()
    assert "restore of 0.1.10" in (kit / "restore.sh").read_text()
    assert (kit / "env.example").exists() and not (kit / "nginx").exists()
    # The VM's own files stay as they were.
    assert (kit / ".env").read_text() == "CD_VERSION=0.1.0\n"
    backups = [p.name for p in (kit / "backups").iterdir()]
    assert backups == ["commander-20261020T000000Z-nightly.dump"]
    for name in ("deploy.sh", "backup.sh", "restore.sh"):
        assert (kit / name).stat().st_mode & 0o777 == 0o750
    # An archive without update.sh (v0.1.1 and older) leaves the running one in place.
    assert (kit / "update.sh").read_text() == (ROOT / "deploy" / "update.sh").read_text()
    assert not list(kit.glob(".update.*"))


@needs_bash
def test_update_can_fetch_main_without_deploying(tmp_path):
    files = kit_of("main") | {"update.sh": "#!/usr/bin/env bash\n# a newer update.sh\n"}
    archive(tmp_path, "refs/heads/main", files)
    result = update(tmp_path, "-n", "main")
    assert result["status"] == "0", result["stderr"]
    assert result["deployed"] == ""
    assert "./deploy.sh main" in result["stdout"]
    kit = tmp_path / "kit"
    assert (kit / "compose.yaml").read_text() == "# compose of main\n"
    assert (kit / "update.sh").read_text().endswith("# a newer update.sh\n")
    assert "api.github.com" not in result["urls"]


@needs_bash
@pytest.mark.parametrize(
    "case", ["unknown version", "kit without backup.sh", "not a version", "no tags"]
)
def test_update_changes_nothing_when_it_cannot_bring_a_whole_kit(tmp_path, case):
    args: tuple[str, ...] = ()
    if case == "unknown version":
        args = ("9.9.9",)
    elif case == "kit without backup.sh":
        files = kit_of("0.2.0")
        del files["backup.sh"]
        archive(tmp_path, "refs/tags/v0.2.0", files)
        args = ("0.2.0",)
    elif case == "not a version":
        args = ("latest; rm -rf /",)
    result = update(tmp_path, *args)
    assert result["status"] != "0"
    assert result["deployed"] == ""
    kit = tmp_path / "kit"
    for name in ("compose.yaml", "deploy.sh", "backup.sh", "restore.sh"):
        assert (kit / name).read_text() == "old\n", name
    assert not list(kit.glob(".update.*"))


needs_git = pytest.mark.skipif(shutil.which("git") is None, reason="upgrade.sh reads a git clone")


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


def commit_kit(repo: Path, version: str, tag: str | None = None) -> None:
    """One commit of the clone: the kit of a version, upgrade.sh as it is now, and a tag."""
    for name, body in kit_of(version).items():
        path = repo / "deploy" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    shutil.copy(ROOT / "deploy" / "upgrade.sh", repo / "deploy" / "upgrade.sh")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", f"kit of {version}")
    if tag:
        git(repo, "tag", "-a", tag, "-m", tag)


def upgrade(tmp_path: Path, *args: str) -> dict[str, str]:
    """Runs deploy/upgrade.sh from a clone (~/commander-duels) against the VM's folder, as the
    deploy user: as root it refuses, or runs again through sudo as the user who called it."""
    if os.geteuid() == 0:
        pytest.skip("runs as the deploy user, not root")
    app = tmp_path / "srv"
    (app / "backups").mkdir(parents=True)
    for name in ("compose.yaml", "deploy.sh", "backup.sh", "restore.sh"):
        (app / name).write_text("old\n")
    (app / ".env").write_text("CD_VERSION=0.1.0\n")
    (app / "backups" / "commander-20261020T000000Z-nightly.dump").write_text("dump")
    env = {
        "PATH": "/usr/bin:/bin:/usr/local/bin",
        "HOME": str(tmp_path),
        "CD_DIR": str(app),
        "STUB_DEPLOYED": str(tmp_path / "deployed"),
    }
    result = subprocess.run(
        ["bash", "deploy/upgrade.sh", *args],
        cwd=tmp_path / "clone",
        env=env,
        capture_output=True,
        text=True,
    )
    deployed = tmp_path / "deployed"
    return {
        "status": str(result.returncode),
        "stdout": result.stdout,
        "stderr": result.stderr,
        "deployed": deployed.read_text().strip() if deployed.exists() else "",
    }


@pytest.fixture
def clone(tmp_path: Path) -> Path:
    """A clone with v0.1.2 and v0.1.10 tagged, and main one commit past the newest tag."""
    repo = tmp_path / "clone"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.email", "test@example.com")
    git(repo, "config", "user.name", "Test")
    commit_kit(repo, "0.1.2", "v0.1.2")
    commit_kit(repo, "0.1.10", "v0.1.10")
    commit_kit(repo, "main")
    return repo


@needs_bash
@needs_git
def test_upgrade_deploys_the_newest_tag_in_the_clone(tmp_path, clone):
    result = upgrade(tmp_path)
    assert result["status"] == "0", result["stderr"]
    # Versions compare as numbers, and main's newer commit is not a version.
    assert result["deployed"] == "0.1.10 0.1.10"
    app = tmp_path / "srv"
    assert (app / "compose.yaml").read_text() == "# compose of 0.1.10\n"
    assert "restore of 0.1.10" in (app / "restore.sh").read_text()
    assert (app / "env.example").exists() and not (app / "nginx").exists()
    assert not (app / "upgrade.sh").exists()
    # The VM's own files stay, and the clone stays on main for the next git pull.
    assert (app / ".env").read_text() == "CD_VERSION=0.1.0\n"
    assert [p.name for p in (app / "backups").iterdir()] == [
        "commander-20261020T000000Z-nightly.dump"
    ]
    assert git(clone, "rev-parse", "--abbrev-ref", "HEAD") == "main"
    assert git(clone, "status", "--porcelain") == ""
    for name in ("deploy.sh", "backup.sh", "restore.sh"):
        assert (app / name).stat().st_mode & 0o777 == 0o750
    assert not list(app.glob(".upgrade.*"))


@needs_bash
@needs_git
def test_upgrade_takes_a_version_or_mains_own_build(tmp_path, clone):
    older = upgrade(tmp_path, "0.1.2")
    assert older["status"] == "0", older["stderr"]
    assert older["deployed"] == "0.1.2 0.1.2"
    shutil.rmtree(tmp_path / "srv")
    (tmp_path / "deployed").unlink()
    main = upgrade(tmp_path, "-n", "main")
    assert main["status"] == "0", main["stderr"]
    assert main["deployed"] == ""
    commit = git(clone, "rev-parse", "--short=12", "HEAD")
    assert f"./deploy.sh sha-{commit}" in main["stdout"]
    assert (tmp_path / "srv" / "compose.yaml").read_text() == "# compose of main\n"


@needs_bash
@needs_git
@pytest.mark.parametrize("case", ["unknown version", "not a version", "no tag in the clone"])
def test_upgrade_changes_nothing_when_it_cannot(tmp_path, clone, case):
    args = {
        "unknown version": ("9.9.9",),
        "not a version": ("0.1.10; rm -rf /",),
        "no tag in the clone": (),
    }[case]
    if case == "no tag in the clone":
        for tag in git(clone, "tag", "--list").split():
            git(clone, "tag", "-d", tag)
    result = upgrade(tmp_path, *args)
    assert result["status"] != "0"
    assert result["deployed"] == ""
    for name in ("compose.yaml", "deploy.sh", "backup.sh", "restore.sh"):
        assert (tmp_path / "srv" / name).read_text() == "old\n", name
    assert not list((tmp_path / "srv").glob(".upgrade.*"))


@needs_bash
@needs_git
def test_upgrade_needs_a_set_up_vm(tmp_path, clone):
    app = tmp_path / "srv"
    app.mkdir()
    result = subprocess.run(
        ["bash", "deploy/upgrade.sh"],
        cwd=clone,
        env={"PATH": "/usr/bin:/bin", "HOME": str(tmp_path), "CD_DIR": str(app)},
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "has no .env" in result.stderr
    assert list(app.iterdir()) == []
