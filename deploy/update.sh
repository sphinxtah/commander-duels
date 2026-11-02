#!/usr/bin/env bash
# On the VM: brings a version's deploy kit from GitHub and deploys that version.
#   ./update.sh            the newest version tag (v0.1.1 deploys the images tagged 0.1.1)
#   ./update.sh 0.1.1      that version
#   ./update.sh main       the newest commit of main: its kit, and the images CI tagged sha-<commit>
#   ./update.sh -n 0.1.1   only fetch the kit into kits/0.1.1, so it can be read before deploying it
# Since 0.8.3 the kit goes into kits/<version>/ and nothing else here changes: deploy.sh makes it
# this folder's own (compose.yaml and the scripts) once the version is deployed.
# Since 0.8.5 main is resolved to its commit first, so the kit and the images are that commit's
# (the main image tag moves with every publish, and the private images have none).
# The repository is public, so this needs no GitHub sign-in. deploy.sh then pulls the images
# from GHCR as before, with the VM's existing docker login.
set -euo pipefail
cd "$(dirname "$0")"
repo=sphinxtah/commander-duels
fetch_only=false
if [ "${1:-}" = -n ]; then
  fetch_only=true
  shift
fi
version="${1:-latest}"

if [ "$version" = latest ]; then
  # Tag names only; sort -V puts the newest version last.
  version="$(curl -fsSL "https://api.github.com/repos/$repo/tags?per_page=100" \
    | grep -o '"name": *"v[0-9][0-9.]*"' | grep -o '[0-9][0-9.]*' | sort -V | tail -n 1)"
  [ -n "$version" ] || { echo "GitHub lists no version tags for $repo" >&2; exit 1; }
fi
case "$version" in
  main)
    commit="$(curl -fsSL -H 'Accept: application/vnd.github.sha' \
      "https://api.github.com/repos/$repo/commits/main")" || commit=""
    [[ "$commit" =~ ^[0-9a-f]{40}$ ]] \
      || { echo "GitHub did not name the commit of main for $repo; nothing was changed" >&2; exit 1; }
    ref="$commit"
    image="sha-${commit:0:12}" ;;
  [0-9]*.[0-9]*.[0-9]*)
    [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
      || { echo "Not a version: $version (use 0.1.1, main or nothing for the newest)" >&2; exit 2; }
    ref="refs/tags/v$version"
    image="$version" ;;
  *) echo "Not a version: $version (use 0.1.1, main or nothing for the newest)" >&2; exit 2 ;;
esac

# One archive of the ref, so the files all come from the same commit. Unpacked beside the kits,
# on the same disk, and moved into kits/ whole.
tmp="$(mktemp -d .update.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://codeload.github.com/$repo/tar.gz/$ref" \
  | tar -xz -C "$tmp" --strip-components=2 --wildcards '*/deploy/*'
for file in compose.yaml deploy.sh backup.sh; do
  [ -s "$tmp/$file" ] || { echo "$ref has no deploy/$file; nothing was changed" >&2; exit 1; }
done
mkdir "$tmp/kit"
for file in compose.yaml deploy.sh backup.sh restore.sh update.sh env.example; do
  [ -f "$tmp/$file" ] || continue
  case "$file" in *.sh) chmod 0750 "$tmp/$file" ;; *) chmod 0640 "$tmp/$file" ;; esac
  mv "$tmp/$file" "$tmp/kit/$file"
done
# Since 0.8.3 a deploy.sh deploys with kits/<tag>/. An older version's own does not, so this
# folder's deploy.sh (0.8.3's or newer) deploys it.
if grep -qsF 'kits/<tag>/' "$tmp/kit/deploy.sh"; then
  deployer="kits/$image/deploy.sh"
elif grep -qsF 'kits/<tag>/' deploy.sh; then
  deployer=./deploy.sh
else
  echo "The kits of $version and of $PWD are older than 0.8.3: deploy 0.8.3 or newer first." >&2
  echo "Nothing was changed." >&2
  exit 1
fi
mkdir -p kits
rm -rf "kits/$image"
mv "$tmp/kit" "kits/$image"
echo "Deploy kit of $version ($ref) is in kits/$image."
# exec skips the EXIT trap.
rm -rf "$tmp"
trap - EXIT

if "$fetch_only"; then
  echo "Deploy it with: cd $PWD && $deployer $image"
  exit 0
fi
exec "$deployer" "$image"
