#!/usr/bin/env bash
# Replaces the live database with a dump from backups/: ./restore.sh backups/<file>.dump
# Keeps a dump of the database it replaces (pre-restore), stops the API and the worker, empties
# the database and restores the dump in one transaction that stops at the first error. So the
# database ends up exactly as dumped, or empty, never a mix of the dump and newer tables or rows.
# The API and the worker stay stopped: deploy the version the dump belongs to (./deploy.sh <tag>).
set -euo pipefail
cd "$(dirname "$0")"
dump="${1:?usage: restore.sh backups/<file>.dump}"
[ -f "$dump" ] || { echo "No such dump: $dump" >&2; exit 2; }
# The archive must be readable before anything is dropped.
docker compose exec -T db pg_restore --list < "$dump" > /dev/null
# Held open from here: the pre-restore backup prunes old dumps, and this may be one of them.
exec 3< "$dump"
./backup.sh pre-restore
docker compose stop api worker
docker compose exec -T db psql -U commander -d postgres -v ON_ERROR_STOP=1 \
  -c 'DROP DATABASE commander WITH (FORCE)' \
  -c 'CREATE DATABASE commander OWNER commander TEMPLATE template0'
docker compose exec -T db pg_restore -U commander -d commander \
  --exit-on-error --single-transaction <&3
revision="$(docker compose exec -T db psql -U commander -d commander -tAc \
  'SELECT version_num FROM alembic_version')" || revision=none
echo "Restored $dump. Its last migration: $revision."
echo "The API and the worker stay stopped. Deploy the version with that last migration:"
echo "  ./deploy.sh <tag>"
