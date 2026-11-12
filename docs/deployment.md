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

Sizing (since v0.4.1, the owner's limit for the beta): the live site runs at most 64 games at once (`CD_GAMES_MAX`, 1–64; the engine's start line says how many, "at most 64 games at once"). The engine gets the same number of slots (`CD_ENGINE_MAX_GAMES` follows `CD_GAMES_MAX` in the production Compose file), a 12 GB heap and a 16 GB container limit. PostgreSQL, the API, the worker and the web container are small. The development Compose file keeps two games and a 1.5 GB limit. From v0.1.1 to v0.4.0 the site ran six games, with a 3 GB heap and a 4 GB limit.

The sizing comes from a load test on the development machine (v0.4.1, [verification](verification.md#v041)): 64 practice games started together through the API, half Legacy against one bot and half Commander against three, bot skill 1 to 3, with the engine held to 16 CPUs like the VM. The scripted players answer at once, so the bots think nearly all the time: a heavier load than people playing.

| | 16 GB heap | 12 GB heap, 16 GB limit (the live settings) |
| --- | --- | --- |
| Games finished, results recorded | 64 of 64, in 5 minutes | 64 of 64, in 5 minutes |
| Heap left after a collection, at most | 8.7 GB | 7.6 GB |
| Engine container's memory, at most | 16.1 GB (the heap grew into its room) | 12.7 GB |
| CPU, at most and median | 13 and 3.4 of 16 | 14 and 3.7 of 16 |
| Bot searches cut off by their budget | 86 of 14,943 | 91 of 14,689 |
| Longest wait for a search thread | 0.1 s | 0.5 s |

No game failed, and neither the engine nor the API logged an error. The VM's 32 GB hold the engine's 16 GB and the rest with room to spare; if many people play at once, CPU is the first limit.

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

   It installs Docker Engine and the Compose plugin from Docker's own repository (not Debian's `docker.io`), and enables the guest agent and unattended upgrades. It puts `sphinx` in the `docker` group and creates `/srv/commander-duels`. There it writes `.env` with a generated database password and engine service token, which never leave the VM. It also installs the nightly backup timer. It never replaces an existing `.env`, and since v0.8.5 it installs the kit's files only into a folder that has none: run again on a set-up VM, it leaves the running version's kit alone and points at `upgrade.sh` (until v0.8.4 it copied its own kit over the live one).

3. Log out and back in (for the `docker` group). Then let Docker pull the private images. GitHub's container registry needs a **classic** personal access token with only `read:packages`; type it at the prompt, never into a chat or a file:

   ```sh
   docker login ghcr.io -u sphinxtah
   ```

4. In `/srv/commander-duels/.env`, set `CD_GOOGLE_CLIENT_ID` (below). Check `CD_PROXY_ADDRESS` (the proxy as this VM sees it, 10.10.50.2) and `CD_SYSOP_NETWORKS` (the home LAN, 10.10.1.0/24).

### Google sign-in

In Google Auth Platform (project "Commander Duels"), add `https://duels.thesphinx.co` as an authorized JavaScript origin, on the existing Web client or on a new one for the live site. The client ID is public; it goes in `CD_GOOGLE_CLIENT_ID`. While the consent screen is in **Testing**, only its listed test users can sign in at all. The live site also uses approval sign-up (`CD_SIGNUP_POLICY=approval`): SysOp approves every new account until the site opens to the public at v1.0.0.

**Opening sign-in to the beta testers (v0.4.1).** The owner's steps in Google's consoles, once v0.4.1 is deployed, so that anyone can press "Sign in with Google" and request an account. The site asks Google only for the basic sign-in scopes (`openid`, `email`, `profile`), and that does not change: they need no app verification by Google, only its branding check. The client ID stays the same, so nothing on the VM changes.

1. **Check the public pages** while signed out (in a private window): https://duels.thesphinx.co/about, https://duels.thesphinx.co/privacy and https://duels.thesphinx.co/terms ([identity](identity.md#the-public-pages-v041)). Google's reviewers read them, so read the policy and the terms first: they are drafts for the owner.
2. **Verify the domain.** In Google Search Console (https://search.google.com/search-console), add the domain property `thesphinx.co`. Search Console shows a TXT record (`google-site-verification=…`); create it at the DNS host of `thesphinx.co`, then press Verify. Use the Google account that owns the Cloud project, or one that is an owner or editor of it, so the domain shows as verified in Google Auth Platform.
3. **Branding** (Google Cloud Console → Google Auth Platform → Branding):

   | Field | Value |
   | --- | --- |
   | App name | `Commander Duels` (as the About page names it) |
   | User support email | The owner's choice. It must be the owner's own Google account or a Google Group the owner manages; testers see it on the consent screen |
   | App logo | `web/public/brand/google-logo-120.png` from the repository: a square 120 × 120 PNG (14 KB) of the wordless mark on the site's background, with no Google marks, made by `scripts/brand_assets.py google`. Google takes a square JPG, PNG or BMP of at most 1 MB, 120 × 120 px being best |
   | Application home page | `https://duels.thesphinx.co/about` (Google refuses a home page that is only a sign-in page) |
   | Application privacy policy link | `https://duels.thesphinx.co/privacy` |
   | Application terms of service link | `https://duels.thesphinx.co/terms` |
   | Authorized domains | `thesphinx.co` |
   | Developer contact information | An email address of the owner's choice, for Google's messages about the project |

   Save. Under **Data Access**, leave the scopes empty or at `openid`, `email` and `profile` only; any other scope would need Google's verification.
4. **Audience → Publish app.** The publishing status goes from **Testing** to **In production** (the user type stays External). From then on any Google account can sign in, and each first sign-in is a pending account that waits until SysOp approves it in Administration. The test-user list no longer matters.
5. **Verify branding.** On the Branding page (or in Verification Center), choose "Verify branding". With only the basic scopes, this is the whole review: Google checks the app name, the logo, the home page, the privacy policy link and the verified domain. It takes from a few minutes to a few business days. Once Google approves the branding, publish it within 7 days, as Google asks.
6. **Check it** with a Google account that was never a test user: the consent screen names Commander Duels, the account waits for approval with the beta's wording, and SysOp sees it in Administration.

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

5. **Problem reports with screenshots (v0.4.1, the owner's step).** nginx refuses requests over 1 MB unless told otherwise, and a report's screenshot may be 5 MB, about 7 MB in base64 ([problem reports](reports.md#the-screenshot)). The repository's site file now has a `location = /api/v1/reports` block that takes up to 8 MB on that one route; every other request keeps the 1 MB limit. Certbot edited the live file, so copy only that block into it, inside the server block that certbot gave `listen 443 ssl` (the one with `location /`), keeping a copy of the file first. Then `sudo nginx -t` and reload. The web container's own nginx takes the same 8 MB on that route with the image. Until the proxy has the block, a report whose screenshot is over 750 KB is refused on the way, and the page sends it again with the screenshot made smaller, so reports still arrive.

### The engine with the custom cards (v0.4.0)

The Godlike tier's custom cards play only on an engine that has loaded them ([progression](progression.md#the-godlike-tiers-custom-cards)). Their implementations live in the owner's private repository, whose CI publishes a private engine image: the public engine image with a plugin added to `/app/plugins` and its card database rebuilt ([engine plugins](engine/xmage-spike.md#plugins-v040)). The live site runs that image instead of the public one. Once, on the VM:

1. Log Docker in to GitHub's container registry, if it is not already (step 3 above did it before the repository went public). It needs a **classic** personal access token with only `read:packages`, from the account that owns the private image; type it at the prompt, never into a chat or a file:

   ```sh
   docker login ghcr.io -u sphinxtah
   ```

2. In `/srv/commander-duels/.env`, name the private image, without a tag:

   ```sh
   CD_ENGINE_IMAGE=ghcr.io/sphinxtah/commander-duels-engine-sphinx
   ```

From then on `deploy.sh` pulls that image with the same tag as the version it deploys (`0.4.0`, or `sha-<commit>` for a build of `main`), so the private repository's CI must publish each version's tag before that version is deployed. If the pull fails, `deploy.sh` stops before anything is replaced and asks whether the VM is logged in and the tag exists. The private repository's workflow (`build.yml`, "Private engine image") builds the newest public `v*` tag's image on a daily schedule, when that image is missing, and at once when run by hand: from the repository's Actions page ("Run workflow", the version empty for the newest tag), or `POST /repos/sphinxtah/commander-duels-sphinx/actions/workflows/build.yml/dispatches` with `{"ref":"main","inputs":{"version":"0.7.0"}}` (v0.7.0: the tag's public images were published at 05:50 UTC, the private image did not exist until this dispatch built it in under 4 minutes, and the first `upgrade.sh` stopped at the pull as designed). Without `CD_ENGINE_IMAGE` (or with it empty) the site runs the public engine: everything works, and the custom cards show "Not loaded by this engine" in the deck builder and cannot start a game. The deploy's engine status line shows which card database is running (its `cards` counts are higher on the private image). Since v0.8.0 the private image also carries the campaign finale's content (`commander-duels/content/campaign-finale.json` in its plugin, served to the API at `/v1/service/content/campaign-finale`): with the public engine the campaign's last duel plays its public stand-in and no incarnation ([the campaign](campaign.md#the-finales-incarnation)).

### The web image with the music (v0.7.2)

The gameplay music ([the game screen](game-screen.md#the-table)) is the owner's track, never in the public repository or its images: the public web image answers 404 at `/music/game.mp3` and the table stays quiet. Since v0.7.3 the menu playlist ([menus](menus.md#the-music-v073)) is the same story: its songs (twenty-six since v0.8.1) and the manifest that names them, `music/playlist.json`, are in the private repository's `music/` folder beside the track, the private web image serves them under `/music/`, and the public web image answers 404 at `/music/playlist.json`, so its menus show no player. Since v0.8.1 the campaign's cut-scene track, `music/campaign.mp3` ([the campaign](campaign.md#the-cut-scenes)), is there too, and the public image answers 404 for it, so its cut scenes are quiet. The private repository `sphinxtah/commander-duels-sphinx` holds the files (`music/game.mp3`, the songs and the manifest) and publishes a private web image, `ghcr.io/sphinxtah/commander-duels-web-sphinx:<version>`: the public web image of the same version with the music folder copied into nginx's root (`web/Dockerfile` there, and the workflow `web.yml`, "Private web image", which runs on a push of the music or the Dockerfile, by hand with a version, and daily for the newest public tag whose private web image is missing, as the engine's does). The live site runs that image instead of the public one. The public `web` package is private, like the engine's: the private repository reads it only because `commander-duels-sphinx` is listed under the package's Manage Actions access (Read), which the owner added on 2026-10-31 after the workflow's first run stopped at the pull. Once, on the VM, with the same ghcr.io login as the engine's (step 1 above):

```sh
# In /srv/commander-duels/.env, without a tag:
CD_WEB_IMAGE=ghcr.io/sphinxtah/commander-duels-web-sphinx
```

From then on `deploy.sh` pulls that image with the version's tag, after the private repository's web workflow has published it; if the pull fails, `deploy.sh` stops before anything is replaced and names the private images it was asked for. Without `CD_WEB_IMAGE` (or with it empty) the site runs the public web image: everything works, and games are silent. The web image is the only one that changes for the music; the API, the engine and the worker know nothing of it, and the browser streams the track from nginx with Range requests (about 16 kB/s a listener), so the VM's cost is the file's bytes and nothing more. The playlist's songs stream the same way, one at a time (64 kbps, about 8 kB/s a listener), and the manifest is a 2 kB file read once a visit (`cache: "no-cache"`, so nginx's week of caching does not hide a new playlist). The private repository's `scripts/smoke-test-web.sh` checks the manifest and every song it names, and since v0.8.1 the campaign's track, before the image is pushed.

**The official rules (v0.8.6).** The same image carries How to play's official text: Wizards of the Coast's Comprehensive Rules, `rules/comprehensive-rules.txt` in the private repository, copied to `/usr/share/nginx/html/rules/` as a second build context. `web/nginx.conf` serves it as UTF-8 text, compressed, asked again on every visit; the public image answers 404, and How to play shows its own guide and a link to Wizards' rules page ([how to play](how-to-play.md)). The private repository checks Wizards' rules page every Monday (06:17 in Phoenix) and opens a pull request for a new release; merging it builds the private web image for the latest public version at once (`web.yml` runs on a push that changes `rules/`), and the next `upgrade.sh` takes it. The check needs one repository setting, once: Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests" in `commander-duels-sphinx`. The private web image of a version before 0.8.6 has the file too but no route for it, which changes nothing for that version's pages.

### SysOp

After the first deploy, set SysOp's password on the VM. It asks twice, without echo:

```sh
cd /srv/commander-duels && docker compose exec api python -m api.cli sysop-password
```

## Deploying a version

CI publishes the images to `ghcr.io/sphinxtah/commander-duels/{api,web,engine}` once the verify and engine jobs pass (the live site's engine may instead be the owner's private image, `CD_ENGINE_IMAGE`, above):
- every push to `main` as `sha-<12-character commit>` and `main`;
- every version tag as its version (`v0.1.0` → `0.1.0`).

The kit deploys a build of `main` by its `sha-` tag only: the `main` tag moves with every publish, the private images have none, and `deploy.sh` refuses `main` and `latest` (since v0.8.5). Since v0.8.5 one publish of a ref runs at a time (`concurrency` in the workflow), and a publish for a commit that `main` has already moved past pushes only its `sha-` tag, so an older run cannot take the `main` tag back from a newer one. GitHub keeps one publish waiting per ref, so after quick pushes an older commit's waiting publish may be cancelled for the newer one: deploy the newest commit (`git pull` first). The workflow reads the repository only (`permissions: contents: read`), except the publish job, which may also write packages, and every action is pinned to a commit, with its release in a comment.

Since v0.1.1 the verify job also checks the kit's scripts (`deploy/*.sh`) with ShellCheck (`koalaman/shellcheck:v0.10.0`, warnings and errors), and since v0.8.5 the production Compose file (`docker compose -f deploy/compose.yaml config`, with `env.example` filled in). `tests/test_deploy_kit.py` covers `restore.sh`, `deploy.sh`'s migrate-first and fall-back steps, its pre-deploy dump (since v0.8.3, also of a stopped database) and its per-version kits, the backup pools, `update.sh`, `upgrade.sh` and `push.sh` (against a real Git clone), and the web container re-resolving the API, limiting sign-in challenges and serving the public pages (since v0.4.1); since v0.8.5 also `deployed.env`, retries, the kept rollback dump, the dump check and the worker's check. Its bash tests run in CI's Linux pytest and are skipped on Windows.

**Pushing.** On the deploying computer, `git push` sends `main` and, because this checkout sets `push.followTags`, any new version tag with it. CI then publishes the images.

**Pulling and updating, on the VM** (since 2026-10-20, as for Kingdom Connect): one command pulls the repository from GitHub and deploys the newest version.

```sh
cd ~/commander-duels && git pull && bash deploy/upgrade.sh
```

Once, before the first time: install Git (`bootstrap-vm.sh` does on a new VM) and clone the repository into your home folder. It is public, so this needs no deploy key or GitHub sign-in.

```sh
sudo apt-get install -y git
git clone https://github.com/sphinxtah/commander-duels.git ~/commander-duels
```

`git pull` brings `main` and the version tags on it. `deploy/upgrade.sh` then reads the deploy kit of the newest version tag from the clone and deploys that version, the images CI tagged with it:
- **Other versions.** `bash deploy/upgrade.sh 0.2.0` takes a given version. `bash deploy/upgrade.sh main` takes the commit the clone is on, with the images CI published for that commit (`sha-<12 characters>`); CI publishes them a few minutes after the push, once its checks pass. `bash deploy/upgrade.sh -n 0.2.0` only puts the kit in `kits/0.2.0/`, for reading before deploying it with the command it prints (`kits/0.2.0/deploy.sh 0.2.0` in `/srv/commander-duels`).
- **What it changes.** Since v0.8.3 it puts the kit (`compose.yaml`, `deploy.sh`, `backup.sh`, `restore.sh`, `update.sh` and `env.example`, all from that one commit) into `/srv/commander-duels/kits/<image tag>/` and runs that kit's `deploy.sh`; nothing else in the folder changes until the version is deployed (see [One kit per version](#one-kit-per-version-since-v083)). `.env`, `web-access.conf` and `backups/` are never touched. If the tag lacks `compose.yaml`, `deploy.sh` or `backup.sh`, nothing changes.
- **The clone stays on `main`.** The kit is read from the tag with Git, so nothing is checked out and the next `git pull` works. Change nothing in the clone, and run no `docker compose` there: its `compose.yaml` is the development stack. Since v0.8.5 that stack's project is `commander-duels-dev`, never the live `commander-duels`, so a stray command there no longer replaces the live containers or deletes the live volumes (until v0.8.4 both had the same project name).
- **No sudo needed.** The deploy user runs Docker. With `sudo` it runs itself again as the user who called it, so the backups and the kit keep their owner; as root without sudo it refuses.

**Without a clone,** `update.sh` does the same from `/srv/commander-duels`, fetching an archive of the tag from GitHub instead (since the repository went public, after v0.1.1):

```sh
cd /srv/commander-duels && ./update.sh
```

`update.sh` brings the deploy kit of the newest version tag from GitHub and deploys that version. `./update.sh 0.1.1` takes a given version, `./update.sh main` the newest commit of `main`: since v0.8.5 it asks GitHub for that commit first and deploys the commit's kit with its images, `sha-<12 characters>`, as `upgrade.sh main` does (until v0.8.4 it took the images tagged `main`, which could be another commit's). And `./update.sh -n 0.1.1` only fetches the kit, for reading before deploying it with the command it prints. It needs no GitHub sign-in: it downloads one archive of the tag from GitHub, which keeps the files of one commit together, and since v0.8.3 puts `compose.yaml`, `deploy.sh`, `backup.sh`, `restore.sh`, `update.sh` and `env.example` into `kits/<version>/`, like `upgrade.sh`. A tag that lacks one of them (`update.sh` in v0.1.1 and older, for instance) has none in its kit. `.env`, `web-access.conf` and `backups/` are never touched. If the archive cannot be fetched, or lacks `compose.yaml`, `deploy.sh` or `backup.sh`, nothing changes. A tag never changes after it is pushed; `main` can lag a few minutes behind a push on GitHub's side.

The images still come from GHCR with the VM's `docker login`.

**Or from the deploying computer:** `deploy/push.sh 0.1.0` (or `deploy/push.sh sha-<12-character commit>`) puts the kit of that tag, as committed in it, into `kits/0.1.0/` on the VM and runs its `deploy.sh 0.1.0` there. Since v0.8.3 it never copies the checkout's own files, so uncommitted edits stay on the deploying computer, and it checks the tag before it connects: one the checkout does not have (`git fetch --tags` first) stops it with nothing copied.

Either way, `deploy.sh 0.1.0`:
1. writes the web container's allow list (the proxy and loopback);
2. pulls the tag's images;
3. starts the database if it is not running (after `docker compose stop` or `down`, say), as the running version's `compose.yaml` has it. If it does not start, `deploy.sh` stops with nothing replaced;
4. dumps the database (`backups/commander-<time>-pre-0.1.0.dump`) whenever it has any table, so on every deploy but the first. If the dump fails, or does not read back (below), `deploy.sh` stops with nothing replaced. (Until v0.8.2 it dumped only a database container that was running, so after a `docker compose stop` the next deploy migrated the data without a dump.) Since v0.8.5 a deploy of the tag that is deployed already, on the database it left, takes no dump: its migrations have nothing to do, and the dump would only push an older one out;
5. runs the tag's migrations on their own (`docker compose run migrate`) while the running version keeps serving. Alembic runs them in one transaction, so if they fail the database is unchanged, and `deploy.sh` stops with nothing replaced;
6. starts everything and waits for every health check, the worker's included (since v0.8.5);
7. records the tag in `.env` as `CD_VERSION`;
8. checks `/api/v1/ready` (for up to about 10 seconds), `/health` and the engine's status through the web container, then (since v0.8.5) that the worker is running, healthy and not restarting;
9. records the deploy in `deployed.env` (below), makes the tag's kit the folder's own (below), and removes unused images.

Steps 2, 5, 6 and 8 use the tag's own kit, `kits/0.1.0/compose.yaml`, with the folder's `.env`, `web-access.conf`, project name and volumes.

**The worker's health (since v0.8.5).** The worker touches a heartbeat file (`CD_WORKER_HEARTBEAT`, `/tmp/worker-heartbeat` in the container) once it has started and after every iteration that succeeds, and its health check fails when the beat is over 30 minutes old (one job, a day's catalog import of a few minutes, runs between two beats). A worker that crashes at start never beats, so the deploy waits for it in step 6 and fails; one that restarts between checks fails step 8. Until v0.8.4 the worker had no health check, and a crash-looping worker passed the deploy.

**`deployed.env` (since v0.8.5).** Beside `.env`, readable by the deploy user and holding no secrets, `deploy.sh` records the last deploy that succeeded: its tag (`CD_TAG`) and the migration it left the database at (`CD_REVISION`), the tag before it (`CD_PREVIOUS_TAG`), and the dump to restore before going back to that one (`CD_ROLLBACK_DUMP`; empty when the two tags share a migration). While a deploy has not succeeded, it also records the tag being tried (`CD_ATTEMPT`) and the dump of the recorded tag's own database, taken before any of the new tag's migrations (`CD_DUMP`). The first deploy with a kit of v0.8.5 or newer has no record yet: it takes the running API's version from its image, if that is `CD_VERSION`, and the database's migration as it finds it. If `.env` names a tag that is neither the recorded nor the attempted one (a kit from before v0.8.5 deployed since), the record is set aside.

<a id="one-kit-per-version-since-v083"></a>**One kit per version (since v0.8.3).** `/srv/commander-duels/kits/<image tag>/` holds each version's `compose.yaml` and scripts as that tag shipped them. `upgrade.sh`, `update.sh` and `push.sh` put a tag's kit there and change nothing else; `deploy.sh` deploys the tag with it, and brings the previous version back with the previous version's kit. Only once the tag is deployed and ready does its kit replace the folder's own `compose.yaml`, `backup.sh`, `restore.sh`, `env.example`, `deploy.sh` and `update.sh`, the files the nightly backup, `restore.sh` and you (`docker compose ...` in the folder) use. So a failed pull, dump or migration leaves the folder exactly as it was, and a new required setting in a newer `compose.yaml` cannot break the nightly backup before that version runs. (Until v0.8.2 the kit replaced the folder's files before anything was pulled, so the previous version came back, and rollbacks ran, under the new version's `compose.yaml`.) `deploy.sh` keeps the kits of the five tags deployed or brought last, and the previous tag's.

- **The first deploy of v0.8.3** runs as always (`cd ~/commander-duels && git pull && bash deploy/upgrade.sh`). It finds no `kits/0.8.2/`, so it copies the folder's own files there first: they are still 0.8.2's. Nothing needs doing by hand. Use `upgrade.sh` for it, not the VM's `./update.sh`, which is still 0.8.2's until then and copies the kit over the folder's files; if that happens anyway, 0.8.3 still deploys, but a failed start cannot bring 0.8.2 back by itself (`deploy.sh` says how).
- **A version from before v0.8.3** (`upgrade.sh 0.8.2`, `push.sh 0.8.2`) has a `deploy.sh` that knows nothing of `kits/`, so the folder's own `deploy.sh` (0.8.3's or newer) deploys it with its kit, and it stays the folder's `deploy.sh` and `update.sh` afterwards.
- **A tag with no kit in `kits/`** (pruned, or never brought): `deploy.sh` refuses it and says how to bring it (`bash deploy/upgrade.sh -n <version>` in the clone, or `./update.sh -n <version>`).

**A failed start.** If the tag does not start (step 6) or is not ready (step 8), `deploy.sh` brings back the tag of the last deploy that succeeded (`CD_TAG` in `deployed.env`), with that tag's own kit, and says so. It does this only when the database is still at the migration that tag ran on, because starting a tag runs its migrations. Otherwise it replaces nothing more:
- If the database has moved, it prints the commands that roll back (below), with the dump of that tag's own database (`CD_DUMP`), taken before the new tag's migrations ran.
- A retry is the same. Until v0.8.4 a retry of a deploy whose migrations had run took the new tag's still-running API for the previous version, and printed no restore command; now the previous version is the recorded one, and the dump named is still the one from before the first attempt (a retry's own dump already has the new schema).
- If no deploy is on record and no version was running, as after `restore.sh` on a VM never deployed with v0.8.5, it starts nothing; if its own migrations moved the database, it prints the restore command for the dump it took. Bringing back the tag in `.env` would migrate the restored database forward again.
- If the tag that failed is the recorded one (a redeploy), it names the version before it, with its dump if the two differ in migrations.

The site stays down until you run those commands or deploy a fixed tag.

**Migrations keep the previous version working.** From step 5 until step 6 replaces them, a few seconds, the running API and worker use the newly migrated database. So a migration only adds what the previous version can ignore: tables, columns that are nullable or have a default, indexes. Dropping or renaming a table or column the previous version uses, or a backfill of data it keeps writing, waits for a later version that no longer uses it (expand, then contract).

**The card catalog (since v0.2.0).** The worker keeps Scryfall's bulk files in the `catalog_data` volume, which the first deploy of v0.2.0 creates; nothing in `.env` changes. Its first sync is due as soon as it starts: it downloads about 115 MB and takes about two minutes, during which the Cards page says the catalog is not imported yet and the deck builder finds no cards. If the engine is still loading, the sync waits for it and retries. The database grows by about 450 MB. After that the sync runs daily at 10:00 UTC (plus up to 30 minutes), and an unchanged day downloads nothing. Administration → Card catalog shows each run, and "Run the catalog sync now" queues one.

**Running games end on an upgrade.** A new version is a new engine build, and a game's recording is played on only by the build that made it, so a deploy that replaces the engine ends every running game as interrupted, as before. Deploy when no one is playing. A restart that keeps the version (`docker compose restart api` or `engine`, the engine restarted by Docker after running out of memory, the VM rebooted) no longer ends them since v0.9.9 ([below](#recordings-v099)).

<a id="recordings-v099"></a>**Recordings (v0.9.9).** The engine keeps a recording of every running game in the `engine_recordings` volume (`/var/lib/commander-duels/recordings` in the container; [recording and recovery](engine/recovery.md)), and takes a game up from it when the API asks for it again after either restart. Nothing in `.env` needs setting; the first deploy of v0.9.9 creates the volume.
- `CD_ENGINE_RECORDING_RETENTION_HOURS` (24): a recording is removed once nothing in it has changed for this long; a running game's never.
- `CD_ENGINE_CHECKPOINT_SECONDS` (3): how often a game's state reaches the disk while only bots play. When a person is asked something it is written at once.
- **Size.** Under 1 MiB for a running game, a few KiB for a finished one: 64 games at once keep under 100 MiB.
- **Not in the backups.** A recording holds every hand and library of a game, and is of use only to the engine build that made it: the nightly dumps do not hold it, and nothing needs restoring after a restore. Treat the volume as you treat the database.
- **Looking.** The service route `GET /v1/service/recordings` gives the numbers, and `RecordingTool` says whether each recording is whole, without showing any game:

  ```sh
  cd /srv/commander-duels
  docker compose exec engine java -cp '/app/engine.jar:/app/lib/*:/app/plugins/*' \
    com.commanderduels.RecordingTool /var/lib/commander-duels/recordings
  ```
- **A full disk** stops the recording of the games running then: they play on, but a restart then ends them interrupted ([what is not supported](engine/recovery.md#what-is-not-supported)).

**Rolling back.** A version runs only on a database at its own last migration. Its migrate step cannot find a newer revision, and its API reports ready only at its own. So:
- If the version you are leaving added no migration (compare `api/migrations/versions` between the two tags), deploy the previous tag: on the VM `cd /srv/commander-duels && ./deploy.sh <previous tag>`, or `deploy/push.sh <previous tag>` from the deploying computer. Either way it runs with the previous tag's own kit from `kits/` (since v0.8.3; `push.sh` brings it from the tag again). A tag whose kit is no longer in `kits/` comes back with `bash deploy/upgrade.sh <previous tag>` in the clone.
- If it added one, first restore the dump taken just before it was deployed, then deploy the previous tag. On the VM:

  ```sh
  cd /srv/commander-duels
  ./restore.sh backups/commander-<time>-pre-<the version you are leaving>.dump
  ./deploy.sh <previous tag>
  ```

  `./deploy.sh` deploys the previous tag with its kit in `kits/` (since v0.8.3); if it says there is none, bring it first with `bash deploy/upgrade.sh -n <previous tag>` in the clone. Everything written since that deploy is lost (`restore.sh` keeps it in a `pre-restore` dump first). Since v0.8.5 the dump to restore is `CD_ROLLBACK_DUMP` in `deployed.env` (`grep ROLLBACK /srv/commander-duels/deployed.env`), and the backups never prune it. Without that, pick the dump by its tag, not by its age: every later deploy attempt writes a newer `pre-<tag>` dump, and an attempt to roll back writes one that already has the newer schema.

Without the restore, `deploy.sh` refuses the previous tag at its migrate step, before anything is replaced.

## Backups

- **Nightly** at about 04:30 (`commander-duels-backup.timer`), **before every deploy** (of any database with a table, started first if it is stopped, since v0.8.3; since v0.8.5 not before a redeploy of the deployed tag on its own database) and **before every restore**: `pg_dump -Fc` into `/srv/commander-duels/backups`. The newest 14 nightly, 10 pre-deploy and 5 pre-restore dumps are kept. Each kind is counted on its own, so restores never push out the pre-deploy dumps a rollback needs. Since v0.8.5 the two dumps `deployed.env` names (the way back to the version before, and during a deploy the dump from before its migrations) are kept as well, outside the ten, so retries and redeploys never push them out. The first nightly dump ran on 2026-10-20 at 04:41 (the timer adds a random delay).
- **Checked before anything is pruned** (since v0.8.5). A dump is written as `<name>.partial`, then read back whole by `pg_restore` (the table of contents and every byte of the data; a dump with tables must hold `alembic_version`'s row). Only a dump that passes gets its name, and only then are older ones pruned; one that fails is deleted and the run fails, so a deploy stops with nothing replaced. A run's `.partial` file goes when it exits, and one left by a run that was killed is deleted by the next run after 12 hours. (Until v0.8.4 a dump cut short replaced an older good one, and failed runs' `.partial` files stayed.)
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

The card image cache (`card_images` volume) needs no backup: the API fetches any missing image again. Nor do Scryfall's bulk files (`catalog_data`, since v0.2.0): the worker downloads them again. The catalog itself is in the database, so the dumps hold it, and a restore brings back its revisions with the decks that refer to them. So are the players' problem reports with their screenshots (v0.4.1, [problem reports](reports.md#storage-and-backups)).

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
| Administration → Card catalog (since v0.2.0) | The last run succeeded, with a catalog revision and the playable count; the Cards page searches |
| A deck of your own (since v0.2.0) | Imported or built in the deck builder, "Ready to play", and played at the practice table |
| Google sign-in by a listed test user | A pending account, which SysOp approves under Administration |
| `/about`, `/privacy` and `/terms`, signed out, on a computer and a phone (since v0.4.1) | Each page in the site's look, with links between them and back to the site; the landing page's line of links opens them |
| Google sign-in by an account that was never a test user (after the steps [above](#google-sign-in), since v0.4.1) | The consent screen names Commander Duels; the account waits for approval with the beta's wording |

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
| `CD_GAMES_PER_ACCOUNT`, `CD_GAMES_MAX` | 1 and 64 (since v0.4.1). The `.env` of earlier versions says 6, and the live one still did after 0.4.1's deploy, so the engine ran 6 games; since v0.4.2 `deploy.sh` raises a 6 to 64 when it deploys over 0.1.1–0.4.1, and keeps any other value |
| `CD_DB_PASSWORD`, `CD_ENGINE_SERVICE_TOKEN` | Generated on the VM by the bootstrap |
| `CD_WEB_IMAGE` | Since v0.7.2: the web image without its tag. Empty or absent: the public `ghcr.io/sphinxtah/commander-duels/web`, silent. The live site: `ghcr.io/sphinxtah/commander-duels-web-sphinx`, the private image with the gameplay music ([above](#the-web-image-with-the-music-v072)) |
| `CD_ENGINE_IMAGE` | Since v0.4.0: the engine image without its tag. Empty or absent: the public `ghcr.io/sphinxtah/commander-duels/engine`. The live site: `ghcr.io/sphinxtah/commander-duels-engine-sphinx`, the private image with the custom cards ([above](#the-engine-with-the-custom-cards-v040)) |

The API runs with `CD_ENVIRONMENT=production`. In production it refuses to start unless:
- the public URL is HTTPS and cookies are Secure;
- the database is PostgreSQL with a generated password;
- the service token and a Google client ID are set;
- trusted proxies are listed;
- no SysOp network covers every address.

The engine's development routes are off (`CD_ENGINE_DEV_ENDPOINTS=false`).
