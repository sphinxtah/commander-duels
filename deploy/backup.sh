#!/usr/bin/env bash
# A pg_dump of the live database into backups/ (custom format; restore with pg_restore).
# ./backup.sh nightly (the timer), ./backup.sh pre-<tag> (deploy.sh, before migrations) or
# ./backup.sh pre-restore (restore.sh, before it replaces the database).
# Keeps the newest 14 nightly, 10 pre-deploy and 5 pre-restore dumps. The pools are separate, so
# restores never push out the pre-deploy dumps that a rollback needs. Since 0.8.5 the dumps that
# deployed.env names (deploy.sh: the way back to the version before) are kept besides, and a new
# dump counts only once pg_restore has read all of it; until then no older dump is removed.
set -euo pipefail
cd "$(dirname "$0")"
label="${1:-manual}"
[[ "$label" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Not a label: $label" >&2; exit 2; }
mkdir -p backups
# What a run that was killed left; this one's own goes when it exits, whatever happens.
find backups -maxdepth 1 -name '*.partial' -mmin +720 -delete
time="$(date -u +%Y%m%dT%H%M%SZ)"
file="backups/commander-$time-$label.dump"
# Two dumps in one second would share a name, and the older one may be the way back: the second
# is <time>.2 (which sorts after <time>), and so on.
n=1
while [ -e "$file" ]; do
  n=$((n + 1))
  file="backups/commander-$time.$n-$label.dump"
done
partial="$file.partial"
trap 'rm -f -- "$partial"' EXIT
docker compose exec -T db pg_dump -U commander -d commander -Fc > "$partial"

# pg_restore reads the table of contents, then every byte of the data: only reading the data finds
# a dump that was cut short. A dump with tables must also hold the last migration's row.
check() {
  local toc
  [ -s "$partial" ] || { echo "The dump is empty." >&2; return 1; }
  toc="$(docker compose exec -T db pg_restore --list < "$partial")" || return 1
  docker compose exec -T db pg_restore -f /dev/null < "$partial" || return 1
  if grep -q ' TABLE ' <<< "$toc" && ! grep -q ' TABLE DATA public alembic_version ' <<< "$toc"
  then
    echo "The dump has tables but not alembic_version's data." >&2
    return 1
  fi
}
if ! check; then
  echo "The dump $file did not pass its check: it was not kept, and no older dump was removed." >&2
  exit 1
fi
mv "$partial" "$file"

# Keeps the newest $1 dumps that pass the find tests after it. find, unlike ls, succeeds when none
# match yet.
prune() {
  local keep="$1"
  shift
  find backups -maxdepth 1 "$@" -printf '%T@ %p\n' | sort -rn | tail -n +"$((keep + 1))" \
    | cut -d' ' -f2- | xargs -r rm --
}
# deployed.env (deploy.sh, since 0.8.5) names the dump to restore before going back to the version
# before the one running (CD_ROLLBACK_DUMP) and the one taken before the deploy in progress
# (CD_DUMP). Neither is pruned, nor counts among the ten.
named=()
if [ -f deployed.env ]; then
  for key in CD_DUMP CD_ROLLBACK_DUMP; do
    path="$(sed -n "s/^$key=//p" deployed.env | tail -n 1)"
    [ -z "$path" ] || named+=(! -path "$path")
  done
fi
prune 14 -name '*-nightly.dump'
prune 10 -name '*-pre-*.dump' ! -name '*-pre-restore.dump' "${named[@]}"
prune 5 -name '*-pre-restore.dump'
echo "Backup: $file ($(du -h "$file" | cut -f1))"
