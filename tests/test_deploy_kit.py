"""The deploy kit: the web proxy follows the API to a new address and serves the public pages
as files of their own, deploy.sh dumps any database with tables and migrates before it replaces
anything, deploys each tag with its own kit and brings the previous version back, with its own kit,
only onto its own database, and
restore.sh replaces the database with exactly the dump, whatever its own backup prunes, and
update.sh brings a version's kit from GitHub into kits/<version>/ before deploying it, upgrade.sh
brings it from a clone of the repository, and push.sh from the tag in the checkout."""

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


# Stands in for docker on the VM. It logs each call with the CD_VERSION it sees and the kit whose
# compose.yaml it was given ("[top]" for the folder's own), and keeps the running API version (or
# none) in STUB_RUNNING and the database's last migration (or empty) in STUB_DB.
# The tags in STUB_NEWER end at migration r2, the others at r1; like Alembic, a migrate step fails
# on a database past its tag's last migration. Steps also fail for the tags in STUB_MIGRATE_FAIL,
# STUB_UP_FAIL or STUB_READY_FAIL, the database's start with STUB_DB_FAIL and its dump with
# STUB_DUMP_FAIL (STUB_DUMP_BAD: a dump pg_restore cannot read). Like Compose, `up` replaces the
# running containers before its migrate step runs. The worker of a tag in STUB_WORKER_FAIL keeps
# restarting, and STUB_RESTARTS counts its restarts.
DEPLOY_STUB = r"""#!/usr/bin/env bash
kit=top
if [ "$1" = compose ] && [ "${2:-}" = --project-directory ]; then
  # A kit's compose.yaml, with the folder's .env, project and volumes.
  [ "$4" = --env-file ] && [ "$5" = "$3/.env" ] && [ "$6" = -f ] && [ -f "$7" ] \
    && [ "$7" = "$3/kits/$(basename "$(dirname "$7")")/compose.yaml" ] \
    || { echo "unexpected: docker $*" >&2; exit 98; }
  kit="$(basename "$(dirname "$7")")"
  set -- compose "${@:8}"
fi
echo "CD_VERSION=${CD_VERSION:-} $* [$kit]" >> "$STUB_LOG"
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
  "compose up -d --wait db") [ -z "${STUB_DB_FAIL:-}" ] || exit 1 ;;
  "compose ps -q api") [ "$(cat "$STUB_RUNNING")" = none ] || echo 0123456789ac ;;
  "compose ps --format {{.Image}} api")
    running="$(cat "$STUB_RUNNING")"
    [ "$running" = none ] || echo "ghcr.io/sphinxtah/commander-duels/api:$running" ;;
  "compose ps -q worker") [ "$(cat "$STUB_RUNNING")" = none ] || echo 0123456789ad ;;
  "inspect -f "*" 0123456789ad")
    if fails "${STUB_WORKER_FAIL:-}" "$(cat "$STUB_RUNNING")"; then
      echo $(( $(cat "$STUB_RESTARTS" 2>/dev/null || echo 0) + 1 )) > "$STUB_RESTARTS"
      echo "restarting $(cat "$STUB_RESTARTS") starting"
    else
      echo "running 0 healthy"
    fi ;;
  "compose exec -T db pg_dump"*) [ -z "${STUB_DUMP_FAIL:-}" ] || exit 1; echo dump ;;
  "compose exec -T db pg_restore --list")
    cat > /dev/null
    printf '%s\n' "217; 1259 16385 TABLE public alembic_version commander" \
      "3421; 0 16385 TABLE DATA public alembic_version commander" ;;
  "compose exec -T db pg_restore -f /dev/null")
    if [ -n "${STUB_DUMP_BAD:-}" ]; then
      echo "pg_restore: error: could not read from input file: end of file" >&2; exit 1
    fi
    cat > /dev/null ;;
  "compose exec -T db psql"*"FROM pg_tables"*) [ -s "$STUB_DB" ] && echo 31 || echo 0 ;;
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


def stage(folder: Path, version: str, deploy_sh: str | None = None) -> None:
    """Puts a version's kit into folder/kits/<version>/ as upgrade.sh does: this checkout's
    deploy.sh (or deploy_sh) and backup.sh, and a compose.yaml that names the version."""
    kit = folder / "kits" / version
    kit.mkdir(parents=True)
    (kit / "compose.yaml").write_text(f"# compose of {version}\n")
    (kit / "deploy.sh").write_text(
        deploy_sh or (ROOT / "deploy" / "deploy.sh").read_text() + f"# kit of {version}\n"
    )
    (kit / "backup.sh").write_text((ROOT / "deploy" / "backup.sh").read_text())
    for name in ("deploy.sh", "backup.sh"):
        (kit / name).chmod(0o750)


def deploy(
    tmp_path: Path,
    previous: str,
    tag: str,
    running: str = "",
    db: str | None = None,
    settings: str = "",
    kits: tuple[str, ...] | None = None,
    script: str = "",
    **stub: str,
) -> dict[str, str]:
    """Runs deploy.sh <tag> with <previous> in .env, running (unless running="none") on a
    database at its own last migration (unless db is given; "" is an empty one). settings adds
    lines to .env. The folder's own compose.yaml is the previous version's; kits/ holds the kits
    of <kits> (by default only the tag's, as upgrade.sh leaves it on the first deploy since 0.8.3;
    None stages it, () leaves kits/ out). The tag's deploy.sh runs, or with script="top" the
    folder's."""
    kit, env = install(tmp_path, DEPLOY_STUB, "deploy.sh", "backup.sh")
    (kit / "compose.yaml").write_text(f"# compose of {previous}\n")
    for version in (tag,) if kits is None else kits:
        stage(kit, version)
    (kit / ".env").write_text(
        f"CD_VERSION={previous}\nCD_GOOGLE_CLIENT_ID=client\nCD_PROXY_ADDRESS=10.10.50.2\n"
        + settings
    )
    (tmp_path / "running").write_text(running or previous)
    newer = stub.get("STUB_NEWER", "").split()
    (tmp_path / "db").write_text(("r2" if previous in newer else "r1") if db is None else db)
    script_path = kit / "deploy.sh" if script == "top" else kit / "kits" / tag / "deploy.sh"
    return run_deploy(tmp_path, script_path, tag, env | stub)


def again(tmp_path: Path, tag: str, **stub: str) -> dict[str, str]:
    """Runs deploy.sh <tag> once more in the folder an earlier deploy() left, as a retry or the
    next deploy would, with the kit of <tag> in kits/ (staged if it is not there yet)."""
    kit = tmp_path / "kit"
    if not (kit / "kits" / tag).exists():
        stage(kit, tag)
    env = {"PATH": f"{tmp_path / 'bin'}:/usr/bin:/bin", "STUB_LOG": str(tmp_path / "docker.log")}
    (tmp_path / "docker.log").unlink(missing_ok=True)
    return run_deploy(tmp_path, kit / "kits" / tag / "deploy.sh", tag, env | stub)


def run_deploy(tmp_path: Path, script_path: Path, tag: str, env: dict[str, str]) -> dict[str, str]:
    kit = tmp_path / "kit"
    env = {
        "STUB_RUNNING": str(tmp_path / "running"),
        "STUB_DB": str(tmp_path / "db"),
        "STUB_RESTARTS": str(tmp_path / "restarts"),
        **env,
    }
    result = subprocess.run(
        ["bash", str(script_path), tag], env=env, capture_output=True, text=True
    )
    log = tmp_path / "docker.log"
    return {
        "status": str(result.returncode),
        "stdout": result.stdout,
        "stderr": result.stderr,
        "log": log.read_text() if log.exists() else "",
        "running": (tmp_path / "running").read_text().strip(),
        "db": (tmp_path / "db").read_text().strip(),
        "env": re.findall(r"^CD_VERSION=(.*)$", (kit / ".env").read_text(), re.M)[0],
        "compose": (kit / "compose.yaml").read_text(),
        "deployed": recorded(kit),
    }


def recorded(kit: Path) -> dict[str, str]:
    """deployed.env, which deploy.sh keeps since 0.8.5: the last deploy that succeeded."""
    path = kit / "deployed.env"
    if not path.exists():
        return {}
    return dict(re.findall(r"^(CD_[A-Z_]+)=(.*)$", path.read_text(), re.M))


@needs_bash
def test_deploy_migrates_before_replacing_anything(tmp_path):
    result = deploy(tmp_path, "0.1.0", "0.1.1", STUB_NEWER="0.1.1")
    assert result["status"] == "0"
    log = result["log"]
    migrate = log.index("CD_VERSION=0.1.1 compose run --rm -T migrate")
    assert log.index("pg_dump") < migrate < log.index("CD_VERSION=0.1.1 compose up -d --wait --r")
    assert (result["running"], result["env"], result["db"]) == ("0.1.1", "0.1.1", "r2")


def test_the_engine_and_web_images_may_be_the_owners_private_ones():
    # v0.4.0: CD_ENGINE_IMAGE in .env names another engine image (the one with the Godlike
    # tier's custom cards), tagged as the version like the others; unset, the public one.
    # v0.7.2: CD_WEB_IMAGE likewise names the web image with the gameplay music.
    compose = (ROOT / "deploy" / "compose.yaml").read_text()
    images = dict(re.findall(r"^  (\w+):\n(?:    .*\n)*?    image: (\S+)", compose, re.M))
    assert images["engine"] == (
        "${CD_ENGINE_IMAGE:-${CD_REGISTRY:-ghcr.io/sphinxtah/commander-duels}/engine}"
        ":${CD_VERSION:?}"
    )
    assert images["web"] == (
        "${CD_WEB_IMAGE:-${CD_REGISTRY:-ghcr.io/sphinxtah/commander-duels}/web}:${CD_VERSION:?}"
    )
    example = (ROOT / "deploy" / "env.example").read_text()
    assert "\nCD_ENGINE_IMAGE=\n" in example and "\nCD_WEB_IMAGE=\n" in example
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
    # v0.7.2: the web image with the music, named the same way, alone or beside the engine's.
    web = "CD_WEB_IMAGE=ghcr.io/sphinxtah/commander-duels-web-sphinx\n"
    both = deploy(tmp_path / "both", "0.1.0", "0.1.1", settings=private + web)
    assert both["status"] == "0"
    assert "(engine: ghcr.io/sphinxtah/commander-duels-engine-sphinx:0.1.1)" in both["stdout"]
    assert "(web: ghcr.io/sphinxtah/commander-duels-web-sphinx:0.1.1)" in both["stdout"]
    web_only = deploy(tmp_path / "web-only", "0.1.0", "0.1.1", settings=web, STUB_PULL_FAIL="0.1.1")
    assert web_only["status"] == "1"
    assert "web ghcr.io/sphinxtah/commander-duels-web-sphinx" in web_only["stderr"]
    assert "logged in to ghcr.io" in web_only["stderr"]
    assert "engine" not in web_only["stderr"]


def games_max(tmp_path: Path) -> list[str]:
    return re.findall(r"^CD_GAMES_MAX=(.*)$", (tmp_path / "kit" / ".env").read_text(), re.M)


@needs_bash
def test_deploy_raises_the_old_kits_game_limit_once(tmp_path):
    # v0.4.2: the live .env still said 6 after 0.4.1's deploy, so the engine ran 6 games.
    old = "CD_GAMES_MAX=6\n"
    raised = deploy(tmp_path / "raised", "0.4.1", "0.4.2", settings=old)
    assert raised["status"] == "0"
    assert games_max(tmp_path / "raised") == ["64"]
    assert "is now 64" in raised["stdout"]
    # After that, a 6 is the owner's own; so is any other value.
    for case, previous, settings in (
        ("later", "0.4.2", old),
        ("own", "0.4.1", "CD_GAMES_MAX=32\n"),
        ("unset", "0.4.1", ""),
    ):
        kept = deploy(tmp_path / case, previous, "0.4.3", settings=settings)
        assert kept["status"] == "0" and "is now 64" not in kept["stdout"]
        assert games_max(tmp_path / case) == re.findall(r"=(\d+)", settings)
    # Nothing changes when the deploy stops before replacing anything.
    stopped = deploy(tmp_path / "stopped", "0.4.1", "0.4.2", settings=old, STUB_PULL_FAIL="0.4.2")
    assert stopped["status"] == "1" and games_max(tmp_path / "stopped") == ["6"]


@needs_bash
def test_failed_migrations_leave_the_running_version_alone(tmp_path):
    result = deploy(tmp_path, "0.1.0", "0.1.1", STUB_MIGRATE_FAIL="0.1.1")
    assert result["status"] == "1"
    assert "compose up -d --wait --remove-orphans" not in result["log"]
    assert (result["running"], result["env"]) == ("0.1.0", "0.1.0")
    assert "Nothing was replaced" in result["stderr"]


@needs_bash
def test_a_rollback_past_a_migration_is_refused_before_anything_is_replaced(tmp_path):
    # The older image's migrate step cannot find the newer revision.
    result = deploy(tmp_path, "0.1.1", "0.1.0", STUB_NEWER="0.1.1")
    assert result["status"] == "1"
    assert "compose up -d --wait --remove-orphans" not in result["log"]
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


@needs_bash
@pytest.mark.parametrize("running", ["0.1.0", "none"])
def test_deploy_dumps_any_database_with_tables_and_starts_it_first(tmp_path, running):
    # v0.8.3: `docker compose ps -q db` lists running containers only, so a stopped stack's
    # database was migrated without a dump. It is started first, and its tables decide.
    result = deploy(tmp_path, "0.1.0", "0.1.1", running=running)
    assert result["status"] == "0", result["stderr"]
    log = result["log"]
    start = log.index("compose up -d --wait db [top]")
    assert start < log.index("pg_dump") < log.index("compose run --rm -T migrate")
    assert "ps -q db" not in log
    assert list((tmp_path / "kit" / "backups").glob("commander-*-pre-0.1.1.dump"))


@needs_bash
@pytest.mark.parametrize("failure", ["STUB_DB_FAIL", "STUB_DUMP_FAIL"])
def test_deploy_stops_when_the_database_does_not_start_or_dump(tmp_path, failure):
    result = deploy(tmp_path, "0.1.0", "0.1.1", running="none", **{failure: "1"})
    assert result["status"] == "1"
    assert "migrate" not in result["log"] and "--remove-orphans" not in result["log"]
    assert (result["env"], result["db"]) == ("0.1.0", "r1")
    assert result["compose"] == "# compose of 0.1.0\n"
    assert "Nothing was replaced" in result["stderr"]
    if failure == "STUB_DB_FAIL":
        assert "pg_dump" not in result["log"] and "did not start" in result["stderr"]


@needs_bash
def test_a_first_deploy_on_an_empty_database_takes_no_dump(tmp_path):
    result = deploy(tmp_path, "", "0.1.0", running="none", db="")
    assert result["status"] == "0", result["stderr"]
    assert "pg_dump" not in result["log"]
    assert "CD_VERSION=0.1.0 compose run --rm -T migrate [0.1.0]" in result["log"]
    assert (result["running"], result["env"], result["db"]) == ("0.1.0", "0.1.0", "r1")
    assert [p.name for p in (tmp_path / "kit" / "kits").iterdir()] == ["0.1.0"]


@needs_bash
def test_deploy_runs_each_tag_with_its_own_kit_and_then_makes_it_the_folders(tmp_path):
    # v0.8.3: the first deploy since kits/ keeps the folder's files as the previous tag's kit.
    result = deploy(tmp_path, "0.1.0", "0.1.1")
    assert result["status"] == "0", result["stderr"]
    for step in ("pull --quiet", "run --rm -T migrate", "up -d --wait --remove-orphans"):
        assert f"CD_VERSION=0.1.1 compose {step} [0.1.1]" in result["log"]
    assert "pg_dump -U commander -d commander -Fc [top]" in result["log"]
    folder = tmp_path / "kit"
    assert (folder / "kits" / "0.1.0" / "compose.yaml").read_text() == "# compose of 0.1.0\n"
    # Deployed, the tag's kit is the folder's own, for the nightly backup and restore.sh.
    assert result["compose"] == "# compose of 0.1.1\n"
    assert (folder / "deploy.sh").read_text().endswith("# kit of 0.1.1\n")
    assert (folder / "deploy.sh").stat().st_mode & 0o777 == 0o750
    assert not list(folder.glob(".*.new")) and not list(folder.glob(".seed.*"))


@needs_bash
@pytest.mark.parametrize(
    "failure", ["STUB_PULL_FAIL", "STUB_MIGRATE_FAIL", "STUB_UP_FAIL", "STUB_READY_FAIL"]
)
def test_a_failed_deploy_leaves_the_folders_kit_and_falls_back_with_the_previous_one(
    tmp_path, failure
):
    result = deploy(tmp_path, "0.1.0", "0.1.1", **{failure: "0.1.1"})
    assert result["status"] == "1"
    assert result["compose"] == "# compose of 0.1.0\n"
    assert (result["running"], result["env"]) == ("0.1.0", "0.1.0")
    if failure in ("STUB_UP_FAIL", "STUB_READY_FAIL"):
        assert "CD_VERSION=0.1.0 compose up -d --wait --remove-orphans [0.1.0]" in result["log"]


@needs_bash
def test_a_rollback_to_a_kit_from_before_kits_keeps_the_folders_deploy_sh(tmp_path):
    # Going back to 0.8.2 with 0.8.3's ./deploy.sh: 0.8.2's compose.yaml becomes the folder's,
    # but its deploy.sh, which knows nothing of kits/, does not.
    old = "#!/usr/bin/env bash\n# deploy.sh of 0.1.0\n"
    folder = tmp_path / "rollback"
    result = deploy(folder, "0.1.1", "0.1.0", kits=("0.1.1",), script="top")
    assert result["status"] == "2" and "no deploy kit of 0.1.0" in result["stderr"]
    shutil.rmtree(folder)
    folder.mkdir()
    stage(folder / "kit", "0.1.0", deploy_sh=old)
    result = deploy(folder, "0.1.1", "0.1.0", kits=("0.1.1",), script="top")
    assert result["status"] == "0", result["stderr"]
    assert "[0.1.0]" in result["log"] and result["compose"] == "# compose of 0.1.0\n"
    assert (folder / "kit" / "deploy.sh").read_text() == (ROOT / "deploy" / "deploy.sh").read_text()


@needs_bash
def test_deploy_keeps_the_last_five_kits_and_the_previous_one(tmp_path):
    folder = tmp_path / "kit"
    older = [f"0.0.{n}" for n in range(1, 8)]
    for n, version in enumerate(older):
        stage(folder, version)
        os.utime(folder / "kits" / version, (1_790_000_000 + n * 3600,) * 2)
    result = deploy(tmp_path, "0.0.1", "0.1.0", kits=("0.1.0",))
    assert result["status"] == "0", result["stderr"]
    kept = sorted(p.name for p in (folder / "kits").iterdir())
    assert kept == ["0.0.1", "0.0.4", "0.0.5", "0.0.6", "0.0.7", "0.1.0"]


@needs_bash
def test_deploy_takes_the_folders_kit_when_an_older_script_put_it_there(tmp_path):
    # 0.8.2's update.sh and push.sh copy a kit over the folder's files and run its deploy.sh
    # there; the previous tag's kit is gone, so a failed start does not bring it back.
    folder = tmp_path / "kit"
    result = deploy(tmp_path, "0.1.0", "0.1.1", kits=(), script="top", STUB_UP_FAIL="0.1.1")
    assert result["status"] == "1"
    assert "CD_VERSION=0.1.1 compose up -d --wait --remove-orphans [0.1.1]" in result["log"]
    assert "CD_VERSION=0.1.0 compose up" not in result["log"]
    assert "no kit of 0.1.0" in result["stderr"]
    assert sorted(p.name for p in (folder / "kits").iterdir()) == ["0.1.1"]


# Stands in for docker under restore.sh: STUB_RESTORED gets what pg_restore reads.
RESTORE_STUB = r"""#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$*" in
  "compose exec -T db pg_restore --list") cat > /dev/null ;;
  "compose exec -T db pg_restore -f /dev/null") cat > /dev/null ;;
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


# Stands in for curl on the VM: GitHub's tag list (STUB_TAGS), the commit main is on (STUB_MAIN)
# and its archives of a ref, one .tar.gz per ref in STUB_ARCHIVES, named after the ref with / as _.
# Unknown refs answer 404.
CURL_STUB = r"""#!/usr/bin/env bash
url="${*: -1}"
echo "$url" >> "$STUB_LOG"
case "$url" in
  https://api.github.com/repos/sphinxtah/commander-duels/tags*) cat "$STUB_TAGS" ;;
  https://api.github.com/repos/sphinxtah/commander-duels/commits/main)
    if [ -z "${STUB_MAIN:-}" ]; then
      echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; fi
    printf '%s' "$STUB_MAIN" ;;
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


def kit_of(version: str, kits: bool = True) -> dict[str, str]:
    """A version's kit whose deploy.sh records what it was asked to deploy. Since 0.8.3 a
    deploy.sh says it deploys with kits/<tag>/; one from before (kits=False) does not."""
    since = "# deploys with kits/<tag>/\n" if kits else ""
    return {
        "compose.yaml": f"# compose of {version}\n",
        "deploy.sh": f'#!/usr/bin/env bash\n{since}echo "{version} $*" > "$STUB_DEPLOYED"\n',
        "backup.sh": f"#!/usr/bin/env bash\n# backup of {version}\n",
        "restore.sh": f"#!/usr/bin/env bash\n# restore of {version}\n",
        "env.example": f"# env of {version}\n",
        "nginx/duels.thesphinx.co": "# the proxy's site file stays out of the VM's folder\n",
    }


def update(
    tmp_path: Path, *args: str, tags: tuple[str, ...] = (), main: str = ""
) -> dict[str, str]:
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
        "STUB_MAIN": main,
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
    # Since 0.8.3 the kit goes into kits/<version>/, and its own deploy.sh deploys it from there.
    new = kit / "kits" / "0.1.10"
    assert (new / "compose.yaml").read_text() == "# compose of 0.1.10\n"
    assert "backup of 0.1.10" in (new / "backup.sh").read_text()
    assert "restore of 0.1.10" in (new / "restore.sh").read_text()
    assert (new / "env.example").exists() and not (new / "nginx").exists()
    for name in ("deploy.sh", "backup.sh", "restore.sh"):
        assert (new / name).stat().st_mode & 0o777 == 0o750
    # The VM's own files stay as they were: deploy.sh replaces them once the version runs.
    for name in ("compose.yaml", "deploy.sh", "backup.sh", "restore.sh"):
        assert (kit / name).read_text() == "old\n", name
    assert (kit / ".env").read_text() == "CD_VERSION=0.1.0\n"
    backups = [p.name for p in (kit / "backups").iterdir()]
    assert backups == ["commander-20261020T000000Z-nightly.dump"]
    assert (kit / "update.sh").read_text() == (ROOT / "deploy" / "update.sh").read_text()
    assert not list(kit.glob(".update.*"))


MAIN = "0123456789abcdef0123456789abcdef01234567"


@needs_bash
def test_update_can_fetch_main_without_deploying(tmp_path):
    # v0.8.5: main is resolved to its commit, whose kit and sha- images go together; the main
    # image tag moves with every publish, and the private images have none.
    files = kit_of("main") | {"update.sh": "#!/usr/bin/env bash\n# a newer update.sh\n"}
    archive(tmp_path, MAIN, files)
    result = update(tmp_path, "-n", "main", main=MAIN)
    assert result["status"] == "0", result["stderr"]
    assert result["deployed"] == ""
    assert "kits/sha-0123456789ab/deploy.sh sha-0123456789ab" in result["stdout"]
    kit = tmp_path / "kit" / "kits" / "sha-0123456789ab"
    assert (kit / "compose.yaml").read_text() == "# compose of main\n"
    assert (kit / "update.sh").read_text().endswith("# a newer update.sh\n")
    assert (tmp_path / "kit" / "compose.yaml").read_text() == "old\n"
    assert f"tar.gz/{MAIN}" in result["urls"] and "refs/heads/main" not in result["urls"]


@needs_bash
def test_update_deploys_main_by_its_commit(tmp_path):
    archive(tmp_path, MAIN, kit_of("main"))
    result = update(tmp_path, "main", main=MAIN)
    assert result["status"] == "0", result["stderr"]
    assert result["deployed"] == "main sha-0123456789ab"
    # GitHub not naming a commit changes nothing.
    refused = update(tmp_path / "refused", "main", main="not a commit")
    assert refused["status"] != "0" and refused["deployed"] == ""
    assert "nothing was changed" in refused["stderr"]
    assert not (tmp_path / "refused" / "kit" / "kits").exists()


@needs_bash
@pytest.mark.parametrize("tag", ["main", "latest"])
def test_deploy_refuses_a_moving_image_tag(tmp_path, tag):
    result = deploy(tmp_path, "0.1.0", tag)
    assert result["status"] == "2"
    assert "upgrade.sh main" in result["stderr"]
    assert result["log"] == ""


@needs_bash
@pytest.mark.parametrize(
    "case",
    ["unknown version", "kit without backup.sh", "not a version", "no tags", "kits before 0.8.3"],
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
    elif case == "kits before 0.8.3":
        # Neither the tag's deploy.sh nor the VM's (both "old") deploys with kits/.
        archive(tmp_path, "refs/tags/v0.2.0", kit_of("0.2.0", kits=False))
        args = ("0.2.0",)
    result = update(tmp_path, *args)
    assert result["status"] != "0"
    assert result["deployed"] == ""
    kit = tmp_path / "kit"
    for name in ("compose.yaml", "deploy.sh", "backup.sh", "restore.sh"):
        assert (kit / name).read_text() == "old\n", name
    assert not (kit / "kits").exists()
    assert not list(kit.glob(".update.*"))


needs_git = pytest.mark.skipif(shutil.which("git") is None, reason="upgrade.sh reads a git clone")


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True, check=True
    )
    return result.stdout.strip()


def commit_kit(repo: Path, version: str, tag: str | None = None, kits: bool = True) -> None:
    """One commit of the clone: the kit of a version, upgrade.sh and push.sh as they are now,
    and a tag."""
    for name, body in kit_of(version, kits).items():
        path = repo / "deploy" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    for name in ("upgrade.sh", "push.sh"):
        shutil.copy(ROOT / "deploy" / name, repo / "deploy" / name)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", f"kit of {version}")
    if tag:
        git(repo, "tag", "-a", tag, "-m", tag)


def upgrade(tmp_path: Path, *args: str, vm_deploy: str = "old\n") -> dict[str, str]:
    """Runs deploy/upgrade.sh from a clone (~/commander-duels) against the VM's folder, as the
    deploy user: as root it refuses, or runs again through sudo as the user who called it. The
    VM's own files are "old", its deploy.sh vm_deploy."""
    if os.geteuid() == 0:
        pytest.skip("runs as the deploy user, not root")
    app = tmp_path / "srv"
    (app / "backups").mkdir(parents=True)
    for name in ("compose.yaml", "deploy.sh", "backup.sh", "restore.sh"):
        (app / name).write_text("old\n")
    (app / "deploy.sh").write_text(vm_deploy)
    (app / "deploy.sh").chmod(0o750)
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
    # Since 0.8.3 the kit goes into kits/<version>/, and its own deploy.sh deploys it from there.
    new = app / "kits" / "0.1.10"
    assert (new / "compose.yaml").read_text() == "# compose of 0.1.10\n"
    assert "restore of 0.1.10" in (new / "restore.sh").read_text()
    assert (new / "env.example").exists() and not (new / "nginx").exists()
    assert not (new / "upgrade.sh").exists() and not (new / "push.sh").exists()
    assert not (app / "upgrade.sh").exists()
    # The VM's own files stay (deploy.sh replaces them once the version runs), and the clone
    # stays on main for the next git pull.
    for name in ("compose.yaml", "deploy.sh", "backup.sh", "restore.sh"):
        assert (app / name).read_text() == "old\n", name
    assert (app / ".env").read_text() == "CD_VERSION=0.1.0\n"
    assert [p.name for p in (app / "backups").iterdir()] == [
        "commander-20261020T000000Z-nightly.dump"
    ]
    assert git(clone, "rev-parse", "--abbrev-ref", "HEAD") == "main"
    assert git(clone, "status", "--porcelain") == ""
    for name in ("deploy.sh", "backup.sh", "restore.sh"):
        assert (new / name).stat().st_mode & 0o777 == 0o750
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
    assert f"kits/sha-{commit}/deploy.sh sha-{commit}" in main["stdout"]
    kit = tmp_path / "srv" / "kits" / f"sha-{commit}"
    assert (kit / "compose.yaml").read_text() == "# compose of main\n"


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
    assert not (tmp_path / "srv" / "kits").exists()
    assert not list((tmp_path / "srv").glob(".upgrade.*"))


@needs_bash
@needs_git
def test_upgrade_deploys_a_kit_from_before_kits_with_the_vms_deploy_sh(tmp_path, clone):
    # Going back to 0.8.2: its deploy.sh knows nothing of kits/, so the VM's (0.8.3's) runs it.
    commit_kit(clone, "0.1.11", "v0.1.11", kits=False)
    refused = upgrade(tmp_path, "0.1.11")
    assert refused["status"] != "0" and "Nothing was changed" in refused["stderr"]
    assert refused["deployed"] == "" and not (tmp_path / "srv" / "kits").exists()
    shutil.rmtree(tmp_path / "srv")
    vm = '#!/usr/bin/env bash\n# deploys with kits/<tag>/\necho "vm $*" > "$STUB_DEPLOYED"\n'
    result = upgrade(tmp_path, "0.1.11", vm_deploy=vm)
    assert result["status"] == "0", result["stderr"]
    assert result["deployed"] == "vm 0.1.11"
    kit = tmp_path / "srv" / "kits" / "0.1.11"
    assert (kit / "compose.yaml").read_text() == "# compose of 0.1.11\n"


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


# Stands in for ssh to the VM: runs the command in STUB_VM in place of /srv/commander-duels,
# with the same stdin, and logs it. scp is never needed.
SSH_STUB = r"""#!/usr/bin/env bash
printf '%s\n' "$*" >> "$STUB_LOG"
[ "$1" = duels ] || { echo "unexpected host: $1" >&2; exit 99; }
exec bash -c "${2//\/srv\/commander-duels/$STUB_VM}"
"""


def push(tmp_path: Path, clone: Path, *args: str) -> dict[str, str]:
    """Runs deploy/push.sh from the clone against a VM folder holding an older kit."""
    vm = tmp_path / "vm"
    (vm / "backups").mkdir(parents=True)
    for name in ("compose.yaml", "deploy.sh", "backup.sh", "restore.sh"):
        (vm / name).write_text("old\n")
    (vm / ".env").write_text("CD_VERSION=0.1.0\n")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in (("ssh", SSH_STUB), ("scp", "#!/bin/sh\nexit 99\n")):
        (bin_dir / name).write_text(body)
        (bin_dir / name).chmod(0o755)
    env = {
        "PATH": f"{bin_dir}:/usr/bin:/bin",
        "HOME": str(tmp_path),
        "STUB_LOG": str(tmp_path / "ssh.log"),
        "STUB_VM": str(vm),
        "STUB_DEPLOYED": str(tmp_path / "deployed"),
    }
    result = subprocess.run(
        ["bash", "deploy/push.sh", *args], cwd=clone, env=env, capture_output=True, text=True
    )
    deployed = tmp_path / "deployed"
    log = tmp_path / "ssh.log"
    return {
        "status": str(result.returncode),
        "stderr": result.stderr,
        "deployed": deployed.read_text().strip() if deployed.exists() else "",
        "ssh": log.read_text() if log.exists() else "",
    }


@needs_bash
@needs_git
def test_push_ships_the_tags_own_kit_not_the_checkout(tmp_path, clone):
    # v0.8.3: push.sh copied the working tree, uncommitted edits and all.
    (clone / "deploy" / "compose.yaml").write_text("# an edit in the checkout\n")
    result = push(tmp_path, clone, "0.1.2")
    assert result["status"] == "0", result["stderr"]
    assert result["deployed"] == "0.1.2 0.1.2"
    vm = tmp_path / "vm"
    kit = vm / "kits" / "0.1.2"
    assert (kit / "compose.yaml").read_text() == "# compose of 0.1.2\n"
    assert sorted(p.name for p in kit.iterdir()) == [
        "backup.sh",
        "compose.yaml",
        "deploy.sh",
        "env.example",
        "restore.sh",
    ]
    for name in ("deploy.sh", "backup.sh", "restore.sh"):
        assert (kit / name).stat().st_mode & 0o777 == 0o750
    # Nothing else on the VM changes before deploy.sh has deployed the tag.
    for name in ("compose.yaml", "deploy.sh", "backup.sh", "restore.sh"):
        assert (vm / name).read_text() == "old\n", name
    assert not list(vm.glob(".push.*"))
    # A build of main, by its commit.
    commit = git(clone, "rev-parse", "--short=12", "v0.1.10")
    built = push(tmp_path / "sha", clone, f"sha-{commit}")
    assert built["deployed"] == f"0.1.10 sha-{commit}", built["stderr"]


@needs_bash
@needs_git
@pytest.mark.parametrize("tag", ["0.1.2; rm -rf /", "9.9.9", "../0.1.2"])
def test_push_checks_the_tag_before_reaching_the_vm(tmp_path, clone, tag):
    result = push(tmp_path, clone, tag)
    assert result["status"] != "0"
    assert result["ssh"] == "" and result["deployed"] == ""


def pre_dumps(tmp_path: Path) -> list[str]:
    return sorted(p.name for p in (tmp_path / "kit" / "backups").glob("*-pre-*.dump"))


@needs_bash
def test_deploy_records_the_tag_and_migration_it_ran_on(tmp_path):
    # v0.8.5: deployed.env (no secrets) says what the last deploy that succeeded ran, and where
    # the way back to the version before it is.
    first = deploy(tmp_path, "0.1.0", "0.1.1", STUB_NEWER="0.1.1")
    assert first["status"] == "0", first["stderr"]
    [dump] = pre_dumps(tmp_path)
    assert first["deployed"] == {
        "CD_TAG": "0.1.1",
        "CD_REVISION": "r2",
        "CD_PREVIOUS_TAG": "0.1.0",
        "CD_ROLLBACK_DUMP": f"backups/{dump}",
        "CD_DUMP": "",
        "CD_ATTEMPT": "",
    }
    assert "PASSWORD" not in (tmp_path / "kit" / "deployed.env").read_text()
    # A version on the same migration needs no dump to go back.
    second = again(tmp_path, "0.1.2", STUB_NEWER="0.1.1 0.1.2")
    assert second["status"] == "0", second["stderr"]
    assert second["deployed"]["CD_PREVIOUS_TAG"] == "0.1.1"
    assert second["deployed"]["CD_ROLLBACK_DUMP"] == ""


@needs_bash
def test_a_retry_after_migrations_names_the_dump_from_before_them(tmp_path):
    # The first attempt migrated the database to r2 and its API started but never became ready,
    # so .env names 0.1.1. The retry must not take 0.1.1 for the version to go back to.
    first = deploy(tmp_path, "0.1.0", "0.1.1", STUB_NEWER="0.1.1", STUB_READY_FAIL="0.1.1")
    assert first["status"] == "1"
    assert (first["running"], first["env"], first["db"]) == ("0.1.1", "0.1.1", "r2")
    [before] = pre_dumps(tmp_path)
    assert first["deployed"]["CD_TAG"] == "0.1.0"
    assert first["deployed"]["CD_DUMP"] == f"backups/{before}"
    assert first["deployed"]["CD_ATTEMPT"] == "0.1.1"
    retry = again(tmp_path, "0.1.1", STUB_NEWER="0.1.1", STUB_READY_FAIL="0.1.1")
    assert retry["status"] == "1"
    assert "CD_VERSION=0.1.0 compose up" not in retry["log"]
    assert f"./restore.sh backups/{before} && ./deploy.sh 0.1.0" in retry["stderr"]
    # The retry's own dump, which has 0.1.1's schema, is not the way back.
    assert len(pre_dumps(tmp_path)) == 2
    assert retry["deployed"]["CD_DUMP"] == f"backups/{before}"


@needs_bash
def test_a_redeploy_of_the_running_tag_takes_no_dump(tmp_path):
    first = deploy(tmp_path, "0.1.0", "0.1.1", STUB_NEWER="0.1.1")
    assert first["status"] == "0", first["stderr"]
    same = again(tmp_path, "0.1.1", STUB_NEWER="0.1.1")
    assert same["status"] == "0", same["stderr"]
    assert "pg_dump" not in same["log"]
    assert "no pre-deploy dump" in same["stdout"]
    assert len(pre_dumps(tmp_path)) == 1


@needs_bash
def test_the_dump_to_roll_back_to_outlives_ten_newer_ones(tmp_path):
    first = deploy(tmp_path, "0.1.0", "0.1.1", STUB_NEWER="0.1.1")
    assert first["status"] == "0", first["stderr"]
    rollback = first["deployed"]["CD_ROLLBACK_DUMP"]
    backups = tmp_path / "kit" / "backups"
    os.utime(tmp_path / "kit" / rollback, (1_790_000_000,) * 2)
    for n in range(12):
        newer = backups / f"commander-202611{n + 1:02}T000000Z-pre-sha-{n}.dump"
        newer.write_text("dump")
        os.utime(newer, (1_790_000_000 + (n + 1) * 3600,) * 2)
    later = again(tmp_path, "0.1.2", STUB_NEWER="0.1.1 0.1.2")
    assert later["status"] == "0", later["stderr"]
    kept = pre_dumps(tmp_path)
    assert Path(rollback).name in kept
    assert len(kept) == 11


@needs_bash
def test_a_dump_that_does_not_read_back_keeps_the_older_ones(tmp_path):
    kit, env = install(tmp_path, DEPLOY_STUB, "backup.sh")
    backups = kit / "backups"
    for n in range(10):
        old = backups / f"commander-202610{n + 1:02}T000000Z-pre-0.1.{n}.dump"
        old.write_text("dump")
        os.utime(old, (1_790_000_000 + n * 3600,) * 2)
    (backups / "commander-20261001T000000Z-nightly.dump.partial").write_text("killed")
    os.utime(backups / "commander-20261001T000000Z-nightly.dump.partial", (1_790_000_000,) * 2)
    env |= {"STUB_DUMP_BAD": "1", "STUB_RUNNING": str(tmp_path / "running")}
    (tmp_path / "running").write_text("0.1.9")
    bad = subprocess.run(
        ["bash", str(kit / "backup.sh"), "pre-0.2.0"], env=env, capture_output=True, text=True
    )
    assert bad.returncode == 1
    assert "did not pass its check" in bad.stderr
    # The ten stay, and neither this run's partial file nor an old one is left.
    assert len(list(backups.glob("*-pre-*.dump"))) == 10
    assert not list(backups.glob("*.partial"))
    del env["STUB_DUMP_BAD"]
    good = subprocess.run(
        ["bash", str(kit / "backup.sh"), "pre-0.2.0"], env=env, capture_output=True, text=True
    )
    assert good.returncode == 0, good.stderr
    names = sorted(p.name for p in backups.glob("*-pre-*.dump"))
    assert len(names) == 10 and names[-1].endswith("-pre-0.2.0.dump")


@needs_bash
def test_a_deploy_whose_dump_does_not_read_back_replaces_nothing(tmp_path):
    result = deploy(tmp_path, "0.1.0", "0.1.1", STUB_DUMP_BAD="1")
    assert result["status"] == "1"
    assert "migrate" not in result["log"]
    assert (result["running"], result["env"]) == ("0.1.0", "0.1.0")
    assert not list((tmp_path / "kit" / "backups").iterdir())


@needs_bash
def test_a_worker_that_keeps_restarting_fails_the_deploy(tmp_path):
    result = deploy(tmp_path, "0.1.0", "0.1.1", STUB_WORKER_FAIL="0.1.1")
    assert result["status"] == "1"
    assert "The worker is not running and healthy" in result["stderr"]
    assert "CD_VERSION=0.1.0 compose up -d --wait --remove-orphans [0.1.0]" in result["log"]
    assert (result["running"], result["env"]) == ("0.1.0", "0.1.0")
    assert result["compose"] == "# compose of 0.1.0\n"


def test_the_worker_reports_its_health():
    compose = (ROOT / "deploy" / "compose.yaml").read_text()
    worker = compose[compose.index("\n  worker:\n") : compose.index("\n  engine:\n")]
    assert "CD_WORKER_HEARTBEAT: /tmp/worker-heartbeat" in worker
    assert "healthcheck:" in worker and "/tmp/worker-heartbeat" in worker.split("healthcheck:")[1]


def test_the_dev_stack_never_shares_the_live_sites_names():
    # v0.8.5: both were the project commander-duels, so docker compose in the VM's clone could
    # replace the live containers, and down -v delete its database volume.
    dev = re.search(r"^name: (\S+)$", (ROOT / "compose.yaml").read_text(), re.M)
    live = re.search(r"^name: (\S+)$", (ROOT / "deploy" / "compose.yaml").read_text(), re.M)
    assert dev and live and (dev[1], live[1]) == ("commander-duels-dev", "commander-duels")


def test_bootstrap_never_replaces_an_installed_kit():
    script = (ROOT / "deploy" / "bootstrap-vm.sh").read_text()
    install_kit = script.index('install -o "$user" -g "$user" -m 0750 "$here/$file"')
    assert script.index('if [ "${#installed[@]}" = 0 ]; then') < install_kit
    assert "upgrade.sh" in script[install_kit:]


def test_the_workflows_pin_their_actions_and_read_only_by_default():
    for workflow in (ROOT / ".github" / "workflows").glob("*.yml"):
        text = workflow.read_text()
        assert re.search(r"^permissions:\n  contents: read$", text, re.M), workflow.name
        for use in re.findall(r"uses: (\S+)", text):
            assert re.fullmatch(r"[\w.-]+/[\w.-]+@[0-9a-f]{40}", use), (workflow.name, use)
        assert not re.search(r"uses: \S+@[0-9a-f]{40}$", text, re.M), "every pin names its release"


@needs_bash
def test_a_record_left_by_an_older_kits_deploy_is_set_aside(tmp_path):
    # 0.8.5 recorded 0.1.1; then a kit from before 0.8.5 deployed 0.1.2, which deployed.env does
    # not know. Going back by deployed.env would start 0.1.1 on 0.1.2's database.
    first = deploy(tmp_path, "0.1.0", "0.1.1")
    assert first["status"] == "0", first["stderr"]
    env = tmp_path / "kit" / ".env"
    env.write_text(env.read_text().replace("CD_VERSION=0.1.1", "CD_VERSION=0.1.2"))
    (tmp_path / "running").write_text("0.1.2")
    (tmp_path / "db").write_text("r2")
    stage(tmp_path / "kit", "0.1.2")
    later = again(tmp_path, "0.1.3", STUB_NEWER="0.1.2 0.1.3", STUB_UP_FAIL="0.1.3")
    assert later["status"] == "1"
    assert "deployed.env is set aside" in later["stderr"]
    # 0.1.2 runs (its image says so) on its own r2: it comes back, never 0.1.1.
    assert "CD_VERSION=0.1.2 compose up -d --wait --remove-orphans [0.1.2]" in later["log"]
    assert "CD_VERSION=0.1.1 compose up" not in later["log"]
