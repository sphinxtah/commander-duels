#!/usr/bin/env bash
# On the VM, from a clone of the repository in your home folder, as for Kingdom Connect:
#
#   cd ~/commander-duels && git pull && bash deploy/upgrade.sh
#
# Puts a version's deploy kit into kits/<image tag>/ in /srv/commander-duels (CD_DIR) and deploys
# that version with it. Nothing else there changes: deploy.sh makes the kit the folder's own
# (compose.yaml and the scripts beside .env) once the version is deployed.
#   bash deploy/upgrade.sh          the newest version tag in the clone (v0.2.0 deploys the images tagged 0.2.0)
#   bash deploy/upgrade.sh 0.2.0    that version
#   bash deploy/upgrade.sh main     the commit the clone is on: its kit, and the images CI tagged sha-<commit>
#   bash deploy/upgrade.sh -n 0.2.0 only put the kit in kits/0.2.0, to read it before deploy.sh
# The kit is read from the tag with git, so the clone stays on main and the next git pull works.
# With sudo it runs again as the user who called it: deploy.sh uses Docker as that user.
set -euo pipefail
if [ "$(id -u)" -eq 0 ]; then
  [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] \
    || { echo "Run it as the deploy user, not root: bash deploy/upgrade.sh" >&2; exit 2; }
  exec sudo -u "$SUDO_USER" -- bash "$0" "$@"
fi
repo="$(cd "$(dirname "$0")/.." && pwd)"
app="${CD_DIR:-/srv/commander-duels}"
git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 \
  || { echo "$repo is not a clone of the repository" >&2; exit 2; }
[ -f "$app/.env" ] || { echo "$app has no .env; set up the VM first (docs/deployment.md)" >&2; exit 2; }
fetch_only=false
if [ "${1:-}" = -n ]; then
  fetch_only=true
  shift
fi
version="${1:-latest}"

if [ "$version" = latest ]; then
  # Tag names only; sort -V puts the newest version last.
  version="$(git -C "$repo" tag --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sed 's/^v//' | sort -V | tail -n 1 || true)"
  [ -n "$version" ] || { echo "The clone has no version tags; run git pull first" >&2; exit 1; }
fi
case "$version" in
  main)
    ref=HEAD
    # Exactly 12 characters, as CI tags it (--short=12 may give more).
    image="sha-$(git -C "$repo" rev-parse HEAD | cut -c 1-12)" ;;
  [0-9]*.[0-9]*.[0-9]*)
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
      || { echo "Not a version: $version (use 0.2.0, main or nothing for the newest)" >&2; exit 2; }
    ref="v$version"
    git -C "$repo" rev-parse -q --verify "refs/tags/$ref" >/dev/null \
      || { echo "The clone has no tag $ref; run git pull first" >&2; exit 1; }
    image="$version" ;;
  *) echo "Not a version: $version (use 0.2.0, main or nothing for the newest)" >&2; exit 2 ;;
esac

# The kit of that one commit, unpacked beside the VM's folder on the same disk and moved into
# kits/ whole.
tmp="$(mktemp -d "$app/.upgrade.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
git -C "$repo" archive --format=tar "$ref" deploy | tar -x -C "$tmp" --strip-components=1
for file in compose.yaml deploy.sh backup.sh; do
  [ -s "$tmp/$file" ] || { echo "$ref has no deploy/$file; nothing was changed" >&2; exit 1; }
done
mkdir "$tmp/kit"
for file in compose.yaml deploy.sh backup.sh restore.sh update.sh env.example; do
  [ -f "$tmp/$file" ] || continue
  case "$file" in *.sh) chmod 0750 "$tmp/$file" ;; *) chmod 0640 "$tmp/$file" ;; esac
  mv "$tmp/$file" "$tmp/kit/$file"
done
# Since 0.8.3 a deploy.sh deploys with kits/<tag>/. An older version's own does not, so the
# folder's deploy.sh (0.8.3's or newer) deploys it.
if grep -qsF 'kits/<tag>/' "$tmp/kit/deploy.sh"; then
  deployer="kits/$image/deploy.sh"
elif grep -qsF 'kits/<tag>/' "$app/deploy.sh"; then
  deployer=./deploy.sh
else
  echo "The kits of $version and of $app are older than 0.8.3: deploy 0.8.3 or newer first." >&2
  echo "Nothing was changed." >&2
  exit 1
fi
cd "$app"
mkdir -p kits
rm -rf "kits/$image"
mv "$tmp/kit" "kits/$image"
echo "Deploy kit of $version ($(git -C "$repo" log -1 --format='%h %s' "$ref")) is in $app/kits/$image."
# exec skips the EXIT trap.
rm -rf "$tmp"
trap - EXIT

if "$fetch_only"; then
  echo "Deploy it with: cd $app && $deployer $image"
  exit 0
fi
exec "$deployer" "$image"
