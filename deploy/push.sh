#!/usr/bin/env bash
# Run from the repository on the deploying computer: copies the deploy kit to the VM and
# deploys an image tag there. The tag must already be published by CI (a version such as 0.1.0,
# or sha-<12-character commit> for a build of main).
#   deploy/push.sh 0.1.0
# CD_DEPLOY_HOST names the SSH host (default "duels", an entry in ~/.ssh/config).
set -euo pipefail
cd "$(dirname "$0")"
tag="${1:?usage: deploy/push.sh <image tag>}"
host="${CD_DEPLOY_HOST:-duels}"
scp -q compose.yaml deploy.sh backup.sh restore.sh "$host:/srv/commander-duels/"
ssh "$host" "cd /srv/commander-duels && chmod 0750 deploy.sh backup.sh restore.sh && ./deploy.sh '$tag'"
