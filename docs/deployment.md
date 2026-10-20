# The live site (v0.1.0)

From v0.1.0, Commander Duels runs live at **https://duels.thesphinx.co**, and every version after it deploys there. The owner decided this on 2026-10-19: the scope document lists VM, nginx and certificates as out of scope, and this decision brings them in. Everything here is the owner's personal homelab ("The Sphinx Hosting", TSH), on the Proxmox server Hathor, and nothing here may be mixed into any other environment's configuration.

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
- **The sign-in challenge limit** (since v0.1.1). The web container lets each visitor ask for 10 Google sign-in challenges a minute, after a burst of 20 ([identity](identity.md#google-sign-in-auth01auth05)). It keys on `X-Forwarded-For`, so it depends on the proxy replacing that header, never appending to it, as its site file does. The live proxy needs no change; the repository's copy of the site file only gained a comment saying so.

## The VM

| Setting | Value |
| --- | --- |
| Host | Hathor (Proxmox VE), VLAN 50 like the other TSH sites |
| OS | Debian 13 (trixie), netinst with only "SSH server" and "standard system utilities" |
| Resources | 16 vCPU, 32 GB RAM, 512 GB on one disk (room for Scryfall data and growth), VirtIO NIC, QEMU guest agent |
| Hostname and address | `commanderduels`, 10.10.50.57 (fixed in UniFi) |
| Login | `sphinx`, by SSH key. The deploying computer uses its own key, `~/.ssh/commander_duels_deploy`, through the `duels` entry in its `~/.ssh/config` |
| Ports forwarded from the internet | None. The proxy reaches port 8080 over the LAN |

Sizing (since v0.1.1): the live site runs at most six games at once (`CD_GAMES_MAX`, 1–8). The engine gets the same number of slots (`CD_ENGINE_MAX_GAMES` follows `CD_GAMES_MAX` in the production Compose file). One game peaks near 200 MB of live heap, so the engine has a 3 GB heap, which holds eight, and a 4 GB container limit. PostgreSQL, the API, the worker and the web container are small. The VM's 16 vCPU and 32 GB leave room for more. The development Compose file keeps two games and a 1.5 GB limit.

## One-time setup

### On the VM

1. Bring the kit to the VM. The repository is public, so on the VM:

   ```sh
   curl -fsSL https://codeload.github.com/sphinxtah/commander-duels/tar.gz/refs/heads/main | tar -xz --strip-components=2 --wildcards '*/deploy/*'
   ```

   (Or copy it from the deploying computer: `scp deploy/*.sh deploy/env.example deploy/compose.yaml duels:~`.)

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

Set up on 2026-10-19, step by step with discovery first, so that no other site or certificate changed. Discovery found eight enabled sites, one certificate per site, no wildcard names, no `map` blocks and no `default_server`.

1. Create the site from the repository's `deploy/nginx/duels.thesphinx.co` as `/etc/nginx/sites-available/zz-duels.thesphinx.co`. Enable it with a symlink in `sites-enabled`, then run `sudo nginx -t` and reload. Before the certificate, `http://` for the name answered 502 (nothing deployed yet).

   It forwards everything, the game WebSocket included, to 10.10.50.57:8080 with a one-hour read timeout, and replaces `X-Forwarded-For`. Its WebSocket `map` uses a variable of its own (`$duels_connection_upgrade`), so it cannot clash with another site's.

   The `zz-` prefix kept the file after `dw.thesphinx.co`, which was then nginx's implicit fallback for unknown hostnames. With the explicit fallback below, the prefix no longer matters.

2. Rehearse the certificate, then issue it with the proxy's venv certbot, after keeping a copy of the file (`~/zz-duels.thesphinx.co.before-certbot`):

   ```sh
   sudo ~/certbot-env/bin/certbot certonly --nginx --dry-run --cert-name duels.thesphinx.co -d duels.thesphinx.co --key-type ecdsa
   sudo ~/certbot-env/bin/certbot --nginx --cert-name duels.thesphinx.co -d duels.thesphinx.co      --key-type ecdsa --redirect --hsts --deploy-hook "systemctl reload nginx"
   ```

   Certbot edited only this file: the HTTPS listener, the certificate (ECDSA, renewed through the nginx plugin by `certbot-venv-renew.timer`), HSTS, and a port-80 redirect.

3. **The proxy's fallback** (the owner's request while setting up). `/etc/nginx/sites-enabled/00-fallback` is an explicit `default_server` for ports 80 and 443, IPv4 and IPv6. It redirects every hostname the proxy does not serve, and the bare IP, to `https://thesphinx.co/`.
   - On 443 it presents thesphinx.co's certificate, so a browser asking for an unknown name sees a name mismatch before the redirect. That happened with DW's certificate before.
   - Its TLS lines (TLS 1.2 and 1.3, `http2`, the shared session cache) match those of DW, the former implicit default. So the handshake every site's visitors go through did not change.

4. **Checked from the proxy afterwards:**
   - unknown names and the IP redirect to thesphinx.co;
   - `duels` redirects HTTP to HTTPS and answered 502 until the first deploy;
   - the eight other sites answer as before.

### SysOp

After the first deploy, set SysOp's password on the VM. It asks twice, without echo:

```sh
cd /srv/commander-duels && docker compose exec api python -m api.cli sysop-password
```

## Deploying a version

CI publishes the images to `ghcr.io/sphinxtah/commander-duels/{api,web,engine}` once the verify and engine jobs pass:
- every push to `main` as `sha-<12-character commit>` and `main`;
- every version tag as its version (`v0.1.0` → `0.1.0`).

Since v0.1.1 the verify job also checks the kit's scripts (`deploy/*.sh`) with ShellCheck (`koalaman/shellcheck:v0.10.0`, warnings and errors). `tests/test_deploy_kit.py` covers `restore.sh`, `deploy.sh`'s migrate-first and fall-back steps, the backup pools, and the web container re-resolving the API and limiting sign-in challenges. Its bash tests run in CI's Linux pytest and are skipped on Windows.

**Pushing.** On the deploying computer, `git push` sends `main` and, because this checkout sets `push.followTags`, any new version tag with it. CI then publishes the images.

**Pulling, on the VM** (since the repository went public, after v0.1.1):

```sh
cd /srv/commander-duels && ./update.sh
```

`update.sh` brings the deploy kit of the newest version tag from GitHub and deploys that version. `./update.sh 0.1.1` takes a given version, `./update.sh main` the newest build of `main` (the images CI tags `main`), and `./update.sh -n 0.1.1` only fetches the kit, for reading before `./deploy.sh 0.1.1`. It needs no GitHub sign-in: it downloads one archive of the tag from GitHub, which keeps the files of one commit together, and replaces `compose.yaml`, `deploy.sh`, `backup.sh`, `restore.sh`, `update.sh` and `env.example`. A tag that lacks one of them (`update.sh` in v0.1.1 and older, for instance) leaves the VM's copy in place. `.env`, `web-access.conf` and `backups/` are never touched. If the archive cannot be fetched, or lacks `compose.yaml`, `deploy.sh` or `backup.sh`, nothing changes. A tag never changes after it is pushed; `main` can lag a few minutes behind a push on GitHub's side.

The images still come from GHCR with the VM's `docker login`.

**Or from the deploying computer:** `deploy/push.sh 0.1.0` copies the same files from the checkout and runs `deploy.sh 0.1.0` on the VM.

Either way, `deploy.sh 0.1.0`:
1. writes the web container's allow list (the proxy and loopback);
2. pulls the tag's images;
3. dumps the database (`backups/commander-<time>-pre-0.1.0.dump`) when it is already running;
4. runs the tag's migrations on their own (`docker compose run migrate`) while the running version keeps serving. Alembic runs them in one transaction, so if they fail the database is unchanged, and `deploy.sh` stops with nothing replaced;
5. starts everything and waits for every health check;
6. records the tag in `.env` as `CD_VERSION`;
7. checks `/api/v1/ready` (for up to about 10 seconds), `/health` and the engine's status through the web container, and removes unused images.

**A failed start.** If the tag does not start (step 5) or is not ready (step 7), `deploy.sh` brings the previous tag back and says so. It does this only when the previous tag was running and the database is still at the migration it ran on, because starting a tag runs its migrations. Otherwise it replaces nothing more:
- If the new tag's migrations moved the database, it prints the commands that roll back (below), with the dump it took in step 3.
- If no version was running, as after `restore.sh`, it starts nothing. Bringing back the tag in `.env` would migrate the restored database forward again.

The site stays down until you run those commands or deploy a fixed tag.

**Migrations keep the previous version working.** From step 4 until step 5 replaces them, a few seconds, the running API and worker use the newly migrated database. So a migration only adds what the previous version can ignore: tables, columns that are nullable or have a default, indexes. Dropping or renaming a table or column the previous version uses, or a backfill of data it keeps writing, waits for a later version that no longer uses it (expand, then contract).

**Running games end.** Restarting the API interrupts every running game (recovery journals, NET08–NET09, are later work). Deploy when no one is playing.

**Rolling back.** A version runs only on a database at its own last migration. Its migrate step cannot find a newer revision, and its API reports ready only at its own. So:
- If the version you are leaving added no migration (compare `api/migrations/versions` between the two tags), deploy the previous tag: `deploy/push.sh <previous tag>`.
- If it added one, first restore the dump taken just before it was deployed, then deploy the previous tag. On the VM:

  ```sh
  cd /srv/commander-duels
  ./restore.sh backups/commander-<time>-pre-<the version you are leaving>.dump
  ./deploy.sh <previous tag>
  ```

  Everything written since that deploy is lost (`restore.sh` keeps it in a `pre-restore` dump first). Pick the dump by its tag, not by its age: every later deploy attempt writes a newer `pre-<tag>` dump, and an attempt to roll back writes one that already has the newer schema.

Without the restore, `deploy.sh` refuses the previous tag at its migrate step, before anything is replaced.

## Backups

- **Nightly** at about 04:30 (`commander-duels-backup.timer`), **before every deploy** and **before every restore**: `pg_dump -Fc` into `/srv/commander-duels/backups`. The newest 14 nightly, 10 pre-deploy and 5 pre-restore dumps are kept. Each kind is counted on its own, so restores never push out the pre-deploy dumps a rollback needs. The first nightly dump ran on 2026-10-20 at 04:41 (the timer adds a random delay).
- **Off the VM.** The owner backs up the whole VM to the NAS with Proxmox VE's own scheduled backups, set up on Hathor (since v0.1.1; nothing on the VM copies dumps itself). A snapshot of a running database is only crash-consistent. The dumps in `backups/` are consistent, and every VM backup carries them, so restore from a dump, not from the snapshot's database files. A fuller backup arrangement may come later.
- **Restoring** a dump replaces the database with it. On the VM:

  ```sh
  cd /srv/commander-duels
  ./restore.sh backups/<file>.dump
  ./deploy.sh <the tag the dump belongs to>
  ```

  `restore.sh`:
  1. checks that the file is a dump it can read, and holds it open;
  2. dumps the database it replaces (`…-pre-restore.dump`). This may prune the oldest `pre-restore` dump, which still restores if it is the one being restored;
  3. stops the API and the worker;
  4. drops the database and creates it again, empty;
  5. restores the dump in one transaction that stops at the first error (`pg_restore --exit-on-error --single-transaction`);
  6. names the dump's last migration.

  The database ends up exactly as dumped, or empty if the restore fails. It is never a mix of the dump and the tables, columns or rows a newer version added, as v0.1.0's `pg_restore --clean` into the live database could leave. The API and the worker stay stopped until `deploy.sh` starts the version with that last migration. A `pre-<tag>` dump belongs to the version that ran before `<tag>`. A nightly or `pre-restore` dump belongs to the version running when it was taken. The web container keeps running: its nginx asks Docker's DNS for the API's new address every 10 seconds.

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
| `CD_GAMES_PER_ACCOUNT`, `CD_GAMES_MAX` | 1 and 6 (v0.1.0's `.env` says 2: change it to 6 when deploying v0.1.1) |
| `CD_DB_PASSWORD`, `CD_ENGINE_SERVICE_TOKEN` | Generated on the VM by the bootstrap |

The API runs with `CD_ENVIRONMENT=production`. In production it refuses to start unless:
- the public URL is HTTPS and cookies are Secure;
- the database is PostgreSQL with a generated password;
- the service token and a Google client ID are set;
- trusted proxies are listed;
- no SysOp network covers every address.

The engine's development routes are off (`CD_ENGINE_DEV_ENDPOINTS=false`).
