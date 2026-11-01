#!/usr/bin/env bash
# Run from the repository on the deploying computer: puts an image tag's deploy kit, as committed
# in that tag, into kits/<tag>/ on the VM and deploys the tag there. The tag must already be
# published by CI (a version such as 0.1.0, or sha-<12-character commit> for a build of main).
# The checkout's own files are never copied, so edits in it do not reach the VM.
#   deploy/push.sh 0.1.0
# CD_DEPLOY_HOST names the SSH host (default "duels", an entry in ~/.ssh/config).
set -euo pipefail
cd "$(dirname "$0")/.."
tag="${1:?usage: deploy/push.sh <image tag>}"
[[ "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "Not an image tag: $tag" >&2; exit 2; }
host="${CD_DEPLOY_HOST:-duels}"
case "$tag" in
  sha-*) ref="${tag#sha-}" ;;
  *) ref="v$tag" ;;
esac
git rev-parse -q --verify "$ref^{commit}" >/dev/null \
  || { echo "This checkout has no $ref; git fetch --tags first. Nothing was copied." >&2; exit 2; }
for file in compose.yaml deploy.sh backup.sh; do
  git cat-file -e "$ref:deploy/$file" 2>/dev/null \
    || { echo "$ref has no deploy/$file; nothing was copied" >&2; exit 1; }
done
files=()
for file in compose.yaml deploy.sh backup.sh restore.sh update.sh env.example; do
  if git cat-file -e "$ref:deploy/$file" 2>/dev/null; then files+=("deploy/$file"); fi
done
# Unpacked beside the kits on the VM and moved into kits/ whole; nothing else there changes until
# deploy.sh has deployed the tag. Since 0.8.3 a deploy.sh deploys with kits/<tag>/; an older
# version's own does not, so the VM's deploy.sh (0.8.3's or newer) deploys it.
git archive --format=tar "$ref" "${files[@]}" | ssh "$host" "set -eu
cd /srv/commander-duels
rm -rf '.push.$tag' && mkdir '.push.$tag'
tar -x -C '.push.$tag' --strip-components=1
chmod 0640 '.push.$tag'/* && chmod 0750 '.push.$tag'/*.sh
mkdir -p kits && rm -rf 'kits/$tag' && mv '.push.$tag' 'kits/$tag'"
ssh "$host" "cd /srv/commander-duels
if grep -qsF 'kits/<tag>/' 'kits/$tag/deploy.sh'; then exec 'kits/$tag/deploy.sh' '$tag'; fi
if grep -qsF 'kits/<tag>/' deploy.sh; then exec ./deploy.sh '$tag'; fi
echo 'The kits of $tag and of the VM are older than 0.8.3: deploy 0.8.3 or newer first.' >&2
exit 1"
