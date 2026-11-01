#!/usr/bin/env bash
# Deploys one published image tag on the VM: ./deploy.sh 0.1.0, or ./deploy.sh sha-<commit>
# for a build of main. Backs up the database, migrates, restarts and checks the site.
# Restarting the API interrupts running games (no recovery journal yet).
# Failed migrations change nothing. A tag that does not start or answer is replaced by the
# previous one again, if that was running and the database is still at its last migration.
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
setting() { sed -n "s/^$1=//p" .env | tail -n 1; }
[ -n "$(setting CD_GOOGLE_CLIENT_ID)" ] || { echo "Set CD_GOOGLE_CLIENT_ID in .env first" >&2; exit 2; }
grep -q __GENERATED__ .env && { echo ".env still has placeholders; run bootstrap-vm.sh" >&2; exit 2; }
previous="$(setting CD_VERSION)"
[[ -z "$previous" || "$previous" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
  || { echo "CD_VERSION in .env is not an image tag: $previous" >&2; exit 2; }
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
dump="backups/<the pre-$tag dump>"
if [ "$tables" != 0 ]; then
  ./backup.sh "pre-$tag" \
    || { echo "The dump before $tag failed, so it was not deployed. Nothing was replaced." >&2; exit 1; }
  # The newest one: the names start with the time.
  dumps=(backups/*-pre-"$tag".dump)
  dump="${dumps[-1]}"
fi

# The database's last migration; empty when it cannot be read.
revision() {
  docker compose exec -T db psql -U commander -d commander -tAc \
    'SELECT version_num FROM alembic_version' 2>/dev/null || true
}
# The last migration under the version running now. Empty when no API runs: on a first deploy,
# or after restore.sh, which may have left the database older than the previous tag.
before=""
if [ -n "$(docker compose ps -q api 2>/dev/null)" ]; then before="$(revision)"; fi

# Brings the previous tag back after $tag failed, then stops. Only onto the database it ran on:
# starting it runs its migrations, which would move a database restored for $tag forward again.
fall_back() {
  echo "$1" >&2
  if [ -z "$previous" ] || [ "$previous" = "$tag" ]; then
    echo "There is no previous version to go back to." >&2
  elif [ -z "$before" ]; then
    echo "No version was running before $tag, so $previous is not started again." >&2
  elif [ "$(revision)" != "$before" ]; then
    echo "The migrations of $tag changed the database, so $previous cannot run on it." >&2
    echo "To go back to $previous, restore the dump taken before them and deploy it, on the VM:" >&2
    echo "  cd $PWD && ./restore.sh $dump && ./deploy.sh $previous" >&2
  elif [ ! -f "kits/$previous/compose.yaml" ]; then
    echo "There is no kit of $previous in $PWD/kits, so it is not started again. Deploy it with" >&2
    echo "  cd ~/commander-duels && bash deploy/upgrade.sh $previous" >&2
  elif CD_VERSION="$previous" kit "$previous" up -d --wait --remove-orphans; then
    sed -i "s/^CD_VERSION=.*/CD_VERSION=$previous/" .env
    echo "$previous is running again." >&2
  else
    echo "$previous did not start either." >&2
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
    [ "$old" = "$previous" ] || rm -rf -- "kits/$old"
  done
docker image prune -f >/dev/null
echo "Deployed $tag"
