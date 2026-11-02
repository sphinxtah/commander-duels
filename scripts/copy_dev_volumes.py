"""Copies the local Docker stack's volumes from its old project name to its new one, once.

Until v0.8.5 the development stack (compose.yaml) and the live site (deploy/compose.yaml) were both
the Compose project commander-duels. Since v0.8.5 the development stack is commander-duels-dev, so
its volumes have new names, and `docker compose up` starts with an empty database. This copies the
old volumes into the new ones:

    commander-duels_postgres_data -> commander-duels-dev_postgres_data   (the local database)
    commander-duels_card_images   -> commander-duels-dev_card_images     (the card image cache)
    commander-duels_catalog_data  -> commander-duels-dev_catalog_data    (Scryfall's bulk files)

Run it from this directory, with Docker running, on Windows, Linux or macOS:

    python scripts/copy_dev_volumes.py

It stops the old project's containers first (docker compose -p commander-duels stop: nothing is
removed). A new volume that already holds files is left alone, as is every old volume: delete
those yourself once the new stack works (docker volume rm commander-duels_postgres_data ...).
Never run it on the live site's VM: there commander-duels is the live site's project.
"""

import subprocess
import sys

OLD, NEW = "commander-duels", "commander-duels-dev"
VOLUMES = ("postgres_data", "card_images", "catalog_data")
# Any small image with sh and cp; this one is already pulled for the database.
IMAGE = "postgres:17.5-alpine"


def docker(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["docker", *args], capture_output=True, text=True, check=check)


def exists(volume: str) -> bool:
    return docker("volume", "inspect", volume, check=False).returncode == 0


def main() -> int:
    if docker("compose", "-p", NEW, "ps", "-q", check=False).stdout.strip():
        print(f"The {NEW} stack is running: docker compose down first, then run this again.")
        return 1
    olds = [name for name in VOLUMES if exists(f"{OLD}_{name}")]
    if not olds:
        print(f"No {OLD}_* volumes: nothing to copy.")
        return 0
    print(f"Stopping the {OLD} containers (nothing is removed)")
    subprocess.run(["docker", "compose", "-p", OLD, "stop"], check=True)
    status = 0
    for name in olds:
        old, new = f"{OLD}_{name}", f"{NEW}_{name}"
        if not exists(new):
            # Labelled as Compose labels its own, so `docker compose up` takes it without a warning.
            docker(
                "volume",
                "create",
                "--label",
                f"com.docker.compose.project={NEW}",
                "--label",
                f"com.docker.compose.volume={name}",
                new,
            )
        copy = docker(
            "run",
            "--rm",
            "-v",
            f"{old}:/from:ro",
            "-v",
            f"{new}:/to",
            "--entrypoint",
            "sh",
            IMAGE,
            "-c",
            'if [ -n "$(ls -A /to)" ]; then echo "not empty"; exit 3; fi; cp -a /from/. /to/',
            check=False,
        )
        if copy.returncode == 3:
            print(f"{new} already holds files, so {old} was not copied into it.")
            status = 1
        elif copy.returncode != 0:
            print(f"Copying {old} failed:\n{copy.stderr}")
            status = 1
        else:
            print(f"{old} -> {new}")
    if status == 0:
        print(f"Done. Start the stack with docker compose up; the {OLD}_* volumes stay until you")
        print("delete them.")
    return status


if __name__ == "__main__":
    sys.exit(main())
