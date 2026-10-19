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
ls -1t backups/*-nightly.dump 2>/dev/null | tail -n +15 | xargs -r rm --
ls -1t backups/*-pre-*.dump 2>/dev/null | tail -n +11 | xargs -r rm --
echo "Backup: $file ($(du -h "$file" | cut -f1))"
