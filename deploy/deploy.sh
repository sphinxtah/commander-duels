#!/usr/bin/env bash
# Deploys one published image tag on the VM: ./deploy.sh 0.1.0, or ./deploy.sh sha-<commit>
# for a build of main. Backs up the database, migrates, restarts and checks the site.
# Restarting the API interrupts running games (no recovery journal yet).
# Failed migrations change nothing. A tag that does not start or answer is replaced by the
# previous one again, if the database is still at the migration that one ran on.
# Since 0.8.5 deployed.env (no secrets) records the tag and the migration of the last deploy that
# succeeded, and the dump to restore before going back to it; the previous tag is the one it names,
# never whatever API happens to run. A redeploy of the running tag on its own database takes no dump.
# Since 0.8.3 each tag deploys with its own kit, kits/<tag>/ in the VM's folder (upgrade.sh,
# update.sh and push.sh put it there), and the previous one comes back with its own. Only a
# deployed tag's kit replaces the folder's compose.yaml and scripts, which the nightly backup,
# restore.sh and the operator use. (Those scripts look for "kits/<tag>/" in a deploy.sh to tell
# one that deploys this way from an older one.)
set -euo pipefail
cd "$(dirname "$0")"
# Run from kits/<tag>/, it works in the VM's folder.
if [ "$(basename "$(dirname "$PWD")")" = kits ]; then cd ../..; fi
tag="${1:?usage: deploy.sh <image tag>}"
[[ "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "Not an image tag: $tag" >&2; exit 2; }
# main and latest move with every publish (and the private images have neither): a build of main
# deploys by its commit, which upgrade.sh main and update.sh main work out.
case "$tag" in
  main | latest)
    echo "$tag is not a fixed image tag. Deploy a version, or a build of main as sha-<commit>:" >&2
    echo "  cd ~/commander-duels && git pull && bash deploy/upgrade.sh main" >&2
    exit 2 ;;
esac
setting() { sed -n "s/^$1=//p" .env | tail -n 1; }
[ -n "$(setting CD_GOOGLE_CLIENT_ID)" ] || { echo "Set CD_GOOGLE_CLIENT_ID in .env first" >&2; exit 2; }
grep -q __GENERATED__ .env && { echo ".env still has placeholders; run bootstrap-vm.sh" >&2; exit 2; }
previous="$(setting CD_VERSION)"
[[ -z "$previous" || "$previous" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
  || { echo "CD_VERSION in .env is not an image tag: $previous" >&2; exit 2; }
# deployed.env: the last deploy that succeeded (CD_TAG, on migration CD_REVISION), the tag before it
# (CD_PREVIOUS_TAG) with the dump to restore before going back to that one (CD_ROLLBACK_DUMP), and
# while a deploy of CD_ATTEMPT has not succeeded, the dump of CD_TAG's database it took (CD_DUMP).
# backup.sh never prunes CD_DUMP or CD_ROLLBACK_DUMP.
recorded() { [ ! -f deployed.env ] || sed -n "s/^$1=//p" deployed.env | tail -n 1; }
last_tag="$(recorded CD_TAG)"
last_revision="$(recorded CD_REVISION)"
previous_tag="$(recorded CD_PREVIOUS_TAG)"
rollback_dump="$(recorded CD_ROLLBACK_DUMP)"
held_dump="$(recorded CD_DUMP)"
attempt="$(recorded CD_ATTEMPT)"
for value in "$last_tag" "$previous_tag" "$attempt"; do
  [[ -z "$value" || "$value" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
    || { echo "deployed.env names something that is not an image tag: $value" >&2; exit 2; }
done
[[ -z "$held_dump" || "$held_dump" =~ ^backups/[A-Za-z0-9._-]+\.dump$ ]] || held_dump=""
[[ -z "$rollback_dump" || "$rollback_dump" =~ ^backups/[A-Za-z0-9._-]+\.dump$ ]] || rollback_dump=""
# .env names the tag of the last deploy, or of an attempt that got as far as starting. Any other
# tag there means a kit older than 0.8.5 deployed since: the record is not about this database.
if [ -n "$last_tag" ] && [ "$previous" != "$last_tag" ] && [ "$previous" != "$attempt" ]; then
  echo "deployed.env names $last_tag, but .env $previous: deployed.env is set aside." >&2
  last_tag="" last_revision="" previous_tag="" rollback_dump="" held_dump=""
fi
record() {
  local new
  new="$(mktemp .deployed.XXXXXX)"
  {
    echo "# Written by deploy.sh: the last deploy that succeeded. No secrets."
    printf '%s\n' "CD_TAG=$last_tag" "CD_REVISION=$last_revision" "CD_PREVIOUS_TAG=$previous_tag" \
      "CD_ROLLBACK_DUMP=$rollback_dump" "CD_DUMP=$held_dump" "CD_ATTEMPT=$attempt"
  } > "$new"
  chmod 0640 "$new"
  mv -f "$new" deployed.env
}
# Copies this folder's kit (compose.yaml and the scripts) into kits/<$1>/.
keep_kit() {
  local seed
  seed="$(mktemp -d .seed.XXXXXX)"
  for file in compose.yaml deploy.sh backup.sh restore.sh update.sh env.example; do
    [ ! -f "$file" ] || cp -p "$file" "$seed/"
  done
  mkdir -p kits
  rm -rf "kits/$1"
  mv "$seed" "kits/$1"
  echo "The kit of $1 in $PWD is now kits/$1 as well."
}
if [ ! -d kits ]; then
  # This deploy.sh runs from the folder, with no kits/ yet: an older update.sh or push.sh (0.8.2's
  # and before) or bootstrap-vm.sh put the kit of $tag here, over the previous tag's.
  keep_kit "$tag"
elif [ ! -f "kits/$tag/compose.yaml" ]; then
  echo "There is no deploy kit of $tag in $PWD/kits. Bring it first, on the VM:" >&2
  echo "  cd ~/commander-duels && git pull && bash deploy/upgrade.sh -n <version, or main>" >&2
  echo "or ./update.sh -n <version> here. Then deploy it as they say." >&2
  exit 2
elif [ -n "$previous" ] && [ ! -f "kits/$previous/compose.yaml" ]; then
  # The first deploy since 0.8.3 finds no kit of the previous tag. This folder's files are still
  # its kit: nothing replaces them before a deploy succeeds.
  keep_kit "$previous"
fi
# Compose with one tag's kit, for this folder: its .env, web-access.conf, project and volumes.
kit() {
  local version="$1"
  shift
  docker compose --project-directory "$PWD" --env-file "$PWD/.env" \
    -f "$PWD/kits/$version/compose.yaml" "$@"
}

# Only the host proxy and loopback may reach the web container.
printf 'allow %s;\nallow 127.0.0.1;\ndeny all;\n' "$(setting CD_PROXY_ADDRESS)" > web-access.conf

export CD_VERSION="$tag"
# The engine and the web may be the owner's private images (CD_ENGINE_IMAGE and CD_WEB_IMAGE in
# .env), which need the VM's read-only login to ghcr.io (docs/deployment.md).
engine_image="$(setting CD_ENGINE_IMAGE)"
web_image="$(setting CD_WEB_IMAGE)"
echo "Pulling $tag${engine_image:+ (engine: $engine_image:$tag)}${web_image:+ (web: $web_image:$tag)}"
if ! kit "$tag" pull --quiet; then
  echo "Pulling $tag failed; nothing was replaced." >&2
  if [ -n "$engine_image" ] || [ -n "$web_image" ]; then
    echo "Private images:${engine_image:+ engine $engine_image}${web_image:+ web $web_image}." >&2
    echo "Is the VM logged in to ghcr.io with a read:packages token, and does each private image" >&2
    echo "have the tag $tag? See docs/deployment.md." >&2
  fi
  exit 1
fi
# The database starts if it is not running (after docker compose stop or down, say), as this
# folder's compose.yaml, the running version's, has it. A database with any table is dumped before
# anything runs on it; only an empty one, on a first deploy, is not.
if ! docker compose up -d --wait db; then
  echo "The database did not start (docker compose logs db), so $tag was not deployed." >&2
  echo "Nothing was replaced." >&2
  exit 1
fi
if ! tables="$(docker compose exec -T db psql -U commander -d commander -tAc \
    "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')")"
then
  echo "The database could not be read, so $tag was not deployed. Nothing was replaced." >&2
  exit 1
fi
# The database's last migration; empty when it cannot be read.
revision() {
  docker compose exec -T db psql -U commander -d commander -tAc \
    'SELECT version_num FROM alembic_version' 2>/dev/null || true
}
start_revision="$(revision)"
# The first deploy with a kit that keeps deployed.env: the API running now is CD_VERSION if its
# image says so, and its database is at the migration that version ran on.
if [ -z "$last_tag" ] && [ -n "$previous" ]; then
  running_image="$(docker compose ps --format '{{.Image}}' api 2>/dev/null || true)"
  if [ "${running_image##*:}" = "$previous" ]; then
    last_tag="$previous"
    last_revision="$start_revision"
  fi
fi

dump=""
if [ "$tables" = 0 ]; then
  :
elif [ "$tag" = "$last_tag" ] && [ "$start_revision" = "$last_revision" ]; then
  # Its migrations have nothing to do, and a dump would only push an older one out.
  echo "$tag runs on this database already (migration $start_revision): no pre-deploy dump."
else
  backup="$(./backup.sh "pre-$tag")" \
    || { echo "The dump before $tag failed, so it was not deployed. Nothing was replaced." >&2; exit 1; }
  echo "$backup"
  dump="$(sed -n 's/^Backup: \([^ ]*\) .*/\1/p' <<< "$backup" | tail -n 1)"
  if [ -z "$dump" ]; then
    # The newest one: the names start with the time.
    dumps=(backups/*-pre-"$tag".dump)
    dump="${dumps[-1]}"
  fi
  # A dump of the last deployed tag's own database is the way back to it, kept until a deploy
  # succeeds. A dump of a database a failed attempt already migrated is not, and leaves it alone.
  if [ -n "$last_tag" ] && [ -n "$dump" ] && [ "$start_revision" = "$last_revision" ]; then
    held_dump="$dump"
  fi
fi
if [ -n "$last_tag" ]; then
  attempt="$tag"
  record
fi

# How to put back the database $last_tag ran on, when the dump of it is known.
restore_hint() {
  if [ -n "$held_dump" ] && [ -f "$held_dump" ]; then
    echo "To go back to $last_tag, restore the dump of its database taken before any migration" >&2
    echo "of $tag ran, and deploy it, on the VM:" >&2
    echo "  cd $PWD && ./restore.sh $held_dump && ./deploy.sh $last_tag" >&2
  else
    echo "No dump of $last_tag's database (migration $last_revision) is on record. The dumps are in" >&2
    echo "$PWD/backups; restore.sh names the last migration of the one it restores." >&2
  fi
  # The database was elsewhere when this deploy started (after restore.sh, say): its own dump.
  if [ -n "$dump" ] && [ "$dump" != "$held_dump" ] && [ "$(revision)" != "$start_revision" ]; then
    echo "The database as this deploy found it (migration $start_revision) is in $dump:" >&2
    echo "  cd $PWD && ./restore.sh $dump" >&2
  fi
}
# Brings the last deployed tag back after $tag failed, then stops. Only onto the database it ran on:
# starting it runs its migrations, which would move a database restored for $tag forward again.
fall_back() {
  echo "$1" >&2
  local now
  now="$(revision)"
  if [ -z "$last_tag" ]; then
    if [ -n "$previous" ] && [ "$previous" != "$tag" ]; then
      echo "No version was running before $tag, so $previous is not started again." >&2
    else
      echo "There is no previous version to go back to." >&2
    fi
    if [ -n "$dump" ] && [ "$now" != "$start_revision" ]; then
      echo "The database before the migrations of $tag is in $dump:" >&2
      echo "  cd $PWD && ./restore.sh $dump" >&2
    fi
  elif [ "$last_tag" = "$tag" ]; then
    echo "$tag is also the last version deployed, so it is not started again." >&2
    if [ -n "$previous_tag" ] && [ "$previous_tag" != "$tag" ]; then
      if [ -n "$rollback_dump" ] && [ -f "$rollback_dump" ]; then
        echo "The version before it, $previous_tag, comes back with its dump, on the VM:" >&2
        echo "  cd $PWD && ./restore.sh $rollback_dump && ./deploy.sh $previous_tag" >&2
      else
        echo "The version before it, $previous_tag, ran on the same migration:" >&2
        echo "  cd $PWD && ./deploy.sh $previous_tag" >&2
      fi
    fi
  elif [ "$now" != "$last_revision" ]; then
    echo "$last_tag ran on migration $last_revision and the database is now at ${now:-an unknown one}," >&2
    echo "so $last_tag is not started again: its own migrations would run on a database not its own." >&2
    restore_hint
  elif [ ! -f "kits/$last_tag/compose.yaml" ]; then
    echo "There is no kit of $last_tag in $PWD/kits, so it is not started again. Deploy it with" >&2
    echo "  cd ~/commander-duels && bash deploy/upgrade.sh $last_tag" >&2
  elif CD_VERSION="$last_tag" kit "$last_tag" up -d --wait --remove-orphans; then
    sed -i "s/^CD_VERSION=.*/CD_VERSION=$last_tag/" .env
    echo "$last_tag is running again." >&2
  else
    echo "$last_tag did not start either, on its own database (migration $last_revision)." >&2
    echo "Look at docker compose logs, then deploy it again or a fixed tag, on the VM:" >&2
    echo "  cd $PWD && ./deploy.sh $last_tag" >&2
  fi
  exit 1
}

# The migrations run on their own before anything is replaced, so the running version keeps
# serving if they fail. Alembic runs them in one transaction: a failure changes nothing.
echo "Migrating to $tag"
if ! kit "$tag" run --rm -T migrate; then
  echo "The migrations of $tag failed and were rolled back. Nothing was replaced." >&2
  echo "A tag older than the database's last migration cannot run on it: see Rolling back in" >&2
  echo "docs/deployment.md." >&2
  exit 1
fi
# The kits of 0.1.1 to 0.4.0 had .env say CD_GAMES_MAX=6. Since 0.4.1 the site runs up to 64 games
# at once (the owner's limit) and the engine is sized for them, but an .env kept from before still
# held the engine to 6. Deploying over one of those versions raises that 6 to 64; any other value
# is the owner's own choice and stays, as does a 6 set after this.
case "$previous" in
  0.1.* | 0.2.* | 0.3.* | 0.4.0 | 0.4.1)
    if [ "$(setting CD_GAMES_MAX)" = 6 ]; then
      sed -i 's/^CD_GAMES_MAX=6$/CD_GAMES_MAX=64/' .env
      echo "CD_GAMES_MAX in .env: 6, from the kits before 0.4.1, is now 64"
    fi
    ;;
esac
kit "$tag" up -d --wait --remove-orphans || fall_back "$tag did not start."
sed -i "s/^CD_VERSION=.*/CD_VERSION=$tag/" .env

# Through the web container, as the proxy reaches the API; wget's own message explains a failure.
api() { kit "$tag" exec -T web wget -qO- "http://127.0.0.1:8080/api/v1/$1" 2>&1; }
# The web container may have started a moment ago.
for attempt in 1 2 3 4 5; do
  ready="$(api ready)" && break
  [ "$attempt" = 5 ] || sleep 2
done
health="$(api health)" || true
engine="$(api engine/status)" || true
echo "ready:  $ready"
echo "health: $health"
echo "engine: $(printf '%s' "$engine" | head -c 200)"
case "$ready" in *'"status":"ready"'*) ;; *) fall_back "The API is not ready" ;; esac
# A worker that keeps restarting fails the deploy too: it must be running, healthy, and not have
# restarted over a few seconds. Since 0.8.5 its health check reads the heartbeat its loop writes; a
# kit without one reports none, and running without restarts has to do.
worker_status() {
  local id
  id="$(kit "$tag" ps -q worker 2>/dev/null || true)"
  [ -z "$id" ] || docker inspect -f \
    '{{.State.Status}} {{.RestartCount}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$id" 2>/dev/null || true
}
read -r _ restarts_before _ <<< "$(worker_status)"
sleep 5
worker="$(worker_status)"
read -r worker_state restarts worker_health <<< "$worker"
echo "worker: ${worker:-not running}"
if [ "$worker_state" != running ] || [ "$restarts" != "$restarts_before" ] \
    || { [ "$worker_health" != healthy ] && [ "$worker_health" != none ]; }; then
  fall_back "The worker is not running and healthy (${worker:-no container}; docker compose logs worker)."
fi

# The deploy succeeded: the way back to the version before is the dump of its database, unless
# this tag runs on the same migration.
revision_now="$(revision)"
if [ -n "$last_tag" ] && [ "$last_tag" != "$tag" ]; then
  previous_tag="$last_tag"
  rollback_dump=""
  [ "$revision_now" = "$last_revision" ] || rollback_dump="$held_dump"
fi
last_tag="$tag" last_revision="$revision_now" held_dump="" attempt=""
record

# The tag's kit becomes this folder's own, each file replaced in one step (a running script keeps
# reading the file it started with). A kit from before 0.8.3 leaves deploy.sh and update.sh, which
# deploy with kits/, as they are.
files=(compose.yaml backup.sh restore.sh env.example)
if grep -qsF 'kits/<tag>/' "kits/$tag/deploy.sh"; then files+=(deploy.sh update.sh); fi
for file in "${files[@]}"; do
  [ -f "kits/$tag/$file" ] || continue
  cp -p "kits/$tag/$file" ".$file.new"
  mv -f ".$file.new" "$file"
done
# The kits of the five tags deployed or brought last stay, and the previous tag's.
touch "kits/$tag"
find kits -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -rn | tail -n +6 \
  | cut -d' ' -f2- | while read -r old; do
    [ "$old" = "$previous" ] || [ "$old" = "$last_tag" ] || rm -rf -- "kits/$old"
  done
docker image prune -f >/dev/null
echo "Deployed $tag"
