#!/usr/bin/env bash
# A pg_dump of the live database into backups/ (custom format; restore with pg_restore).
# ./backup.sh nightly (the timer), ./backup.sh pre-<tag> (deploy.sh, before migrations) or
# ./backup.sh pre-restore (restore.sh, before it replaces the database).
# Keeps the newest 14 nightly, 10 pre-deploy and 5 pre-restore dumps. The pools are separate, so
# restores never push out the pre-deploy dumps that a rollback needs.
set -euo pipefail
cd "$(dirname "$0")"
label="${1:-manual}"
[[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Not a label: $label" >&2; exit 2; }
mkdir -p backups
file="backups/commander-$(date -u +%Y%m%dT%H%M%SZ)-$label.dump"
docker compose exec -T db pg_dump -U commander -d commander -Fc > "$file.partial"
mv "$file.partial" "$file"
# Keeps the newest $1 dumps that pass the find tests after it. find, unlike ls, succeeds when none
# match yet.
prune() {
  local keep="$1"
  shift
  find backups -maxdepth 1 "$@" -printf '%T@ %p\n' | sort -rn | tail -n +"$((keep + 1))" \
    | cut -d' ' -f2- | xargs -r rm --
}
prune 14 -name '*-nightly.dump'
prune 10 -name '*-pre-*.dump' ! -name '*-pre-restore.dump'
prune 5 -name '*-pre-restore.dump'
echo "Backup: $file ($(du -h "$file" | cut -f1))"
