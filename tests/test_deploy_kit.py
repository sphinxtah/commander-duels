"""The deploy kit: the web proxy follows the API to a new address, deploy.sh migrates before it
replaces anything and brings the previous version back only onto its own database, and
restore.sh replaces the database with exactly the dump, whatever its own backup prunes, and
update.sh brings a version's kit from GitHub before deploying it."""

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
  "compose pull --quiet"|*"/api/v1/health"|*"/api/v1/engine/status"|"image prune -f") ;;
  *) echo "unexpected: docker $*" >&2; exit 99 ;;
esac
"""


def deploy(
    tmp_path: Path, previous: str, tag: str, running: str = "", db: str = "", **stub: str
) -> dict[str, str]:
    """Runs deploy.sh <tag> with <previous> in .env, running (unless running="none") on a
    database at its own last migration (unless db is given)."""
    kit, env = install(tmp_path, DEPLOY_STUB, "deploy.sh", "backup.sh")
    (kit / ".env").write_text(
        f"CD_VERSION={previous}\nCD_GOOGLE_CLIENT_ID=client\nCD_PROXY_ADDRESS=10.10.50.2\n"
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
