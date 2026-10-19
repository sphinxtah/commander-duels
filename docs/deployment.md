# The live site (v0.1.0)

From v0.1.0, Commander Duels runs live at **https://duels.thesphinx.co**, and every version after it deploys there. The owner decided this on 2026-10-19: the scope document lists VM, nginx and certificates as out of scope, and this decision brings them in. Everything here is the owner's personal homelab ("The Sphinx Hosting", TSH), on the Proxmox server Hathor. None of it is TeamLogic IT's Acadia, and nothing here may be mixed into Acadia's configuration.

## How a request reaches the game

```
browser ──HTTPS──▶ public IP 136.63.10.16 ──UniFi forwards 80/443──▶ TSH nginx proxy (10.10.50.2)
                                                                         │ TLS ends here (Let's Encrypt)
                                                                         ▼ HTTP, LAN only
                                     commanderduels (10.10.50.57) :8080 ──▶ web container (nginx, static site)
                                                                         │ /api/ and the game WebSocket
                                                                         ▼
                                                   API ──▶ engine (XMage), PostgreSQL, worker
```

- **DNS.** `duels.thesphinx.co` is an A record for the public IP (the owner's).
- **The TSH proxy** is the homelab's only public web entry: a Debian VM with nginx and certbot in a venv. It adds one site file for Commander Duels and changes no other site.
- **The VM** (`commanderduels`) runs Docker Compose with images built by CI. Only the web container publishes a port (8080), and only the proxy and loopback may use it. The API, the engine and PostgreSQL publish nothing.
- **Visitor addresses.** The proxy replaces `X-Forwarded-For` with the visitor's address; the web container appends the proxy's. The API believes exactly those two hops (`CD_TRUSTED_PROXIES`), so SysOp's network check sees the visitor. The UniFi hairpin keeps LAN source addresses, so SysOp signs in from the home LAN (10.10.1.0/24) through the public name. This was measured for Kingdom Connect on the same proxy.

## The VM

| Setting | Value |
| --- | --- |
| Host | Hathor (Proxmox VE), VLAN 50 like the other TSH sites |
| OS | Debian 13 (trixie), netinst with only "SSH server" and "standard system utilities" |
| Resources | 16 vCPU, 32 GB RAM, 512 GB on one disk (room for Scryfall data and growth), VirtIO NIC, QEMU guest agent |
| Hostname and address | `commanderduels`, 10.10.50.57 (fixed in UniFi) |
| Login | `sphinx`, by SSH key. The deploying computer uses its own key, `~/.ssh/commander_duels_deploy`, through the `duels` entry in its `~/.ssh/config` |
| Ports forwarded from the internet | None. The proxy reaches port 8080 over the LAN |

Sizing: the engine is capped at 1.5 GB (one game peaks near 200 MB of heap) and runs at most two games (`CD_GAMES_MAX`). PostgreSQL, the API, the worker and the web container are small. The VM has room to raise the engine's heap and the game limits later (`CD_ENGINE_MAX_GAMES` up to 8).

## One-time setup

### On the VM

1. Copy the kit over from the repository (from the deploying computer):

   ```sh
   scp deploy/bootstrap-vm.sh deploy/env.example deploy/compose.yaml deploy/deploy.sh deploy/backup.sh duels:~
   ```

2. On the VM, run the bootstrap once as root:

   ```sh
   sudo bash ~/bootstrap-vm.sh sphinx
   ```

   It installs Docker Engine and the Compose plugin from Docker's own repository (not Debian's `docker.io`), and enables the guest agent and unattended upgrades. It puts `sphinx` in the `docker` group and creates `/srv/commander-duels`. There it writes `.env` with a generated database password and engine service token, which never leave the VM. It also installs the nightly backup timer. It never replaces an existing `.env`.

3. Log out and back in (for the `docker` group). Then let Docker pull the private images. GitHub's container registry needs a **classic** personal access token with only `read:packages`; type it at the prompt, never into a chat or a file:

   ```sh
   docker login ghcr.io -u sphinxtah
   ```

4. In `/srv/commander-duels/.env`, set `CD_GOOGLE_CLIENT_ID` (below). Check `CD_PROXY_ADDRESS` (the proxy as this VM sees it, 10.10.50.2) and `CD_SYSOP_NETWORKS` (the home LAN, 10.10.1.0/24).

### Google sign-in

In Google Auth Platform (project "Commander Duels"), add `https://duels.thesphinx.co` as an authorized JavaScript origin, on the existing Web client or on a new one for the live site. The client ID is public; it goes in `CD_GOOGLE_CLIENT_ID`. While the consent screen is in **Testing**, only its listed test users can sign in at all. The live site also uses approval sign-up (`CD_SIGNUP_POLICY=approval`): SysOp approves every new account until the site opens to the public at v1.0.0.

### On the TSH proxy

1. Install the site file from the repository (`deploy/nginx/duels.thesphinx.co`, which forwards to 10.10.50.57:8080):

   ```sh
   sudo cp duels.thesphinx.co /etc/nginx/sites-available/duels.thesphinx.co
   sudo ln -s /etc/nginx/sites-available/duels.thesphinx.co /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```

   It forwards everything, the game WebSocket included, to the VM's port 8080 with a one-hour read timeout, and replaces `X-Forwarded-For`. Its WebSocket `map` uses a variable of its own (`$duels_connection_upgrade`), so it cannot clash with another site's.

2. Issue the certificate with the proxy's venv certbot. The renewal timer (`certbot-venv-renew.timer`) already covers it:

   ```sh
   sudo ~/certbot-env/bin/certbot --nginx --cert-name duels.thesphinx.co -d duels.thesphinx.co \
     --key-type ecdsa --redirect --hsts --deploy-hook "systemctl reload nginx"
   ```

### SysOp

After the first deploy, set SysOp's password on the VM. It asks twice, without echo:

```sh
cd /srv/commander-duels && docker compose exec api python -m api.cli sysop-password
```

## Deploying a version

CI publishes the images to `ghcr.io/sphinxtah/commander-duels/{api,web,engine}` once the verify and engine jobs pass:
- every push to `main` as `sha-<12-character commit>` and `main`;
- every version tag as its version (`v0.1.0` → `0.1.0`).

From the repository on the deploying computer:

```sh
deploy/push.sh 0.1.0
```

It copies `compose.yaml`, `deploy.sh` and `backup.sh` to `/srv/commander-duels` and runs `deploy.sh 0.1.0` there. That:
1. writes the web container's allow list (the proxy and loopback);
2. pulls the tag's images;
3. dumps the database (`backups/commander-<time>-pre-0.1.0.dump`) when it is already running;
4. starts everything. Compose runs the migrations before the API starts, and waits for every health check;
5. records the tag in `.env` as `CD_VERSION`;
6. checks `/api/v1/ready`, `/health` and the engine's status through the web container, and removes unused images.

**Running games end.** Restarting the API interrupts every running game (recovery journals, NET08–NET09, are later work). Deploy when no one is playing.

**Rolling back.** Deploy the previous tag. A migration that already ran stays applied. If the older version cannot use the newer schema, restore the pre-deploy dump (below), then deploy the older tag.

## Backups

- **Nightly** at about 04:30 (`commander-duels-backup.timer`), and **before every deploy**: `pg_dump -Fc` into `/srv/commander-duels/backups`. The newest 14 nightly and 10 pre-deploy dumps are kept. Copying them off the VM (to the NAS, for instance) is the owner's choice.
- **Restoring** a dump replaces the database. Stop the API and the worker, restore, then start them:

  ```sh
  cd /srv/commander-duels
  docker compose stop api worker
  docker compose exec -T db pg_restore -U commander -d commander --clean --if-exists < backups/<file>.dump
  docker compose start api worker
  ```

The card image cache (`card_images` volume) needs no backup: the API fetches any missing image again.

## Checking the live site

After the first deploy and at each version's close-out:

| Check | Expected |
| --- | --- |
| `https://duels.thesphinx.co` | The site loads with a valid Let's Encrypt certificate, and HTTP redirects to HTTPS |
| `/api/v1/health` | `{"status":"ok","version":"<the version>"}` |
| `http://<VM>:8080/` from another LAN machine | 403: only the proxy gets in |
| `/#sysop` from a phone on mobile data | The Play page (SysOp's entrance does not exist off the LAN) |
| `/#sysop` from the home LAN | SysOp's sign-in |
| A practice game | Plays to the end. The game WebSocket stays open while a player thinks, and card images load |
| Google sign-in by a listed test user | A pending account, which SysOp approves under Administration |

## Configuration

`/srv/commander-duels/.env` (mode 600), from [env.example](../deploy/env.example):

| Key | Purpose |
| --- | --- |
| `CD_VERSION` | The image tag running; `deploy.sh` keeps it |
| `CD_PUBLIC_URL` | `https://duels.thesphinx.co` |
| `CD_GOOGLE_CLIENT_ID` | The Web client with the live origin |
| `CD_SIGNUP_POLICY` | `approval` |
| `CD_PROXY_ADDRESS` | The TSH proxy, 10.10.50.2 |
| `CD_SYSOP_NETWORKS` | The home LAN, 10.10.1.0/24 |
| `CD_GAMES_PER_ACCOUNT`, `CD_GAMES_MAX` | 1 and 2 |
| `CD_DB_PASSWORD`, `CD_ENGINE_SERVICE_TOKEN` | Generated on the VM by the bootstrap |

The API runs with `CD_ENVIRONMENT=production`. In production it refuses to start unless:
- the public URL is HTTPS and cookies are Secure;
- the database is PostgreSQL with a generated password;
- the service token and a Google client ID are set;
- trusted proxies are listed;
- no SysOp network covers every address.

The engine's development routes are off (`CD_ENGINE_DEV_ENDPOINTS=false`).
