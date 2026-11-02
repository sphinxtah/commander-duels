#!/usr/bin/env bash
# One-time setup of the VM, commanderduels (Debian 13). Run as root from the deploy kit's folder:
#   sudo bash bootstrap-vm.sh sphinx
# Installs Docker Engine from Docker's repository, lets the named user run it, creates
# /srv/commander-duels with a .env whose secrets are generated here, and adds the nightly backup.
# Safe to run again: it never replaces an existing .env, and since 0.8.5 it installs the deploy kit
# only into a folder that has none. Later versions' kits come with upgrade.sh (docs/deployment.md).
set -euo pipefail
user="${1:?usage: bootstrap-vm.sh <deploy user>}"
id "$user" >/dev/null
here="$(cd "$(dirname "$0")" && pwd)"
app=/srv/commander-duels
. /etc/os-release
[ "$ID" = debian ] || { echo "Expected Debian, found $ID" >&2; exit 2; }

apt-get update -q
apt-get install -y -q ca-certificates curl git qemu-guest-agent unattended-upgrades
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $VERSION_CODENAME
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update -q
apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker qemu-guest-agent
usermod -aG docker "$user"

install -d -o "$user" -g "$user" -m 0750 "$app" "$app/backups"
kit_files=(compose.yaml deploy.sh backup.sh restore.sh update.sh)
installed=()
for file in "${kit_files[@]}"; do
  [ ! -e "$app/$file" ] || installed+=("$file")
done
if [ "${#installed[@]}" = 0 ]; then
  for file in "${kit_files[@]}"; do
    install -o "$user" -g "$user" -m 0750 "$here/$file" "$app/$file"
  done
  echo "Installed the deploy kit in $app"
else
  # The kit there is the running version's: replacing it with this one would run the nightly
  # backup and restore.sh with another version's files.
  echo "$app already has a deploy kit (${installed[*]}); it stays as it is. Deploy a version with"
  echo "  cd ~/commander-duels && git pull && bash deploy/upgrade.sh"
fi
if [ ! -f "$app/.env" ]; then
  # Letters and digits only, so they need no quoting in .env or the database URL.
  secret() { head -c 96 /dev/urandom | base64 -w0 | tr -dc 'A-Za-z0-9' | cut -c "1-$1"; }
  sed -e "s/^CD_DB_PASSWORD=.*/CD_DB_PASSWORD=$(secret 40)/" \
      -e "s/^CD_ENGINE_SERVICE_TOKEN=.*/CD_ENGINE_SERVICE_TOKEN=$(secret 48)/" \
      "$here/env.example" > "$app/.env"
  chown "$user:$user" "$app/.env"
  chmod 600 "$app/.env"
  echo "Wrote $app/.env with generated secrets"
fi

cat > /etc/systemd/system/commander-duels-backup.service <<EOF
[Unit]
Description=Commander Duels nightly database backup
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=$user
ExecStart=$app/backup.sh nightly
EOF
cat > /etc/systemd/system/commander-duels-backup.timer <<EOF
[Unit]
Description=Commander Duels nightly database backup

[Timer]
OnCalendar=*-*-* 04:30:00
RandomizedDelaySec=900
Persistent=true

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now commander-duels-backup.timer

docker --version
docker compose version
echo "Done. Log out and back in as $user so the docker group applies, then:"
echo "  docker login ghcr.io -u sphinxtah   (password: a classic token with read:packages only)"
