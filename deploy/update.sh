#!/usr/bin/env bash
# On the VM: brings a version's deploy kit from GitHub and deploys that version.
#   ./update.sh            the newest version tag (v0.1.1 deploys the images tagged 0.1.1)
#   ./update.sh 0.1.1      that version
#   ./update.sh main       the newest build of main (its kit, and the images CI tagged main)
#   ./update.sh -n 0.1.1   only fetch the kit, so it can be read before ./deploy.sh 0.1.1
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
  main) ref=refs/heads/main ;;
  [0-9]*.[0-9]*.[0-9]*) ref="refs/tags/v$version" ;;
  *) echo "Not a version: $version (use 0.1.1, main or nothing for the newest)" >&2; exit 2 ;;
esac

# One archive of the ref, so the files all come from the same commit. Unpacked beside the kit,
# on the same disk, so each file is replaced in one step.
tmp="$(mktemp -d .update.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://codeload.github.com/$repo/tar.gz/$ref" \
  | tar -xz -C "$tmp" --strip-components=2 --wildcards '*/deploy/*'
for file in compose.yaml deploy.sh backup.sh; do
  [ -s "$tmp/$file" ] || { echo "$ref has no deploy/$file; nothing was changed" >&2; exit 1; }
done
# A replaced update.sh is a new file: this run keeps reading the old one to its end.
for file in compose.yaml deploy.sh backup.sh restore.sh update.sh env.example; do
  [ -f "$tmp/$file" ] || continue
  case "$file" in *.sh) chmod 0750 "$tmp/$file" ;; *) chmod 0640 "$tmp/$file" ;; esac
  mv -f "$tmp/$file" "$file"
done
echo "Deploy kit of $version ($ref) is in place."
# exec skips the EXIT trap.
rm -rf "$tmp"
trap - EXIT

if "$fetch_only"; then
  echo "Deploy it with: ./deploy.sh $version"
  exit 0
fi
exec ./deploy.sh "$version"
