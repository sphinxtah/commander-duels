#!/usr/bin/env bash
# Deploys one published image tag on the VM: ./deploy.sh 0.1.0, or ./deploy.sh sha-<commit>
# for a build of main. Backs up the database, migrates, restarts and checks the site.
# Restarting the API interrupts running games (no recovery journal yet).
set -euo pipefail
cd "$(dirname "$0")"
tag="${1:?usage: deploy.sh <image tag>}"
[[ "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "Not an image tag: $tag" >&2; exit 2; }
setting() { sed -n "s/^$1=//p" .env | tail -n 1; }
[ -n "$(setting CD_GOOGLE_CLIENT_ID)" ] || { echo "Set CD_GOOGLE_CLIENT_ID in .env first" >&2; exit 2; }
grep -q __GENERATED__ .env && { echo ".env still has placeholders; run bootstrap-vm.sh" >&2; exit 2; }

# Only the host proxy and loopback may reach the web container.
printf 'allow %s;\nallow 127.0.0.1;\ndeny all;\n' "$(setting CD_PROXY_ADDRESS)" > web-access.conf

export CD_VERSION="$tag"
echo "Pulling $tag"
docker compose pull --quiet
if [ -n "$(docker compose ps -q db 2>/dev/null)" ]; then
  ./backup.sh "pre-$tag"
fi
docker compose up -d --wait --remove-orphans
sed -i "s/^CD_VERSION=.*/CD_VERSION=$tag/" .env

ready="$(docker compose exec -T web wget -qO- http://127.0.0.1:8080/api/v1/ready)"
health="$(docker compose exec -T web wget -qO- http://127.0.0.1:8080/api/v1/health)"
engine="$(docker compose exec -T web wget -qO- http://127.0.0.1:8080/api/v1/engine/status)"
echo "ready:  $ready"
echo "health: $health"
echo "engine: $(printf '%s' "$engine" | head -c 200)"
case "$ready" in *'"status":"ready"'*) ;; *) echo "The API is not ready" >&2; exit 1 ;; esac
docker image prune -f >/dev/null
echo "Deployed $tag"
