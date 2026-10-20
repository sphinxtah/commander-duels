#!/usr/bin/env bash
# A pg_dump of the live database into backups/ (custom format; restore with pg_restore).
# ./backup.sh nightly (the timer) or ./backup.sh pre-<tag> (deploy.sh, before migrations).
# Keeps the newest 14 nightly and 10 pre-deploy dumps.
set -euo pipefail
cd "$(dirname "$0")"
label="${1:-manual}"
[[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Not a label: $label" >&2; exit 2; }
mkdir -p backups
file="backups/commander-$(date -u +%Y%m%dT%H%M%SZ)-$label.dump"
docker compose exec -T db pg_dump -U commander -d commander -Fc > "$file.partial"
mv "$file.partial" "$file"
# Keeps the newest $2 dumps whose names match $1. find, unlike ls, succeeds when none match yet.
prune() {
  find backups -maxdepth 1 -name "$1" -printf '%T@ %p\n' | sort -rn | tail -n +"$(($2 + 1))" \
    | cut -d' ' -f2- | xargs -r rm --
}
prune '*-nightly.dump' 14
prune '*-pre-*.dump' 10
echo "Backup: $file ($(du -h "$file" | cut -f1))"
