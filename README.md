# Commander Duels

**v0.2.0: your own decks and priority controls.** A runnable foundation for the Commander Duels development scope: React/TypeScript interface, Python/FastAPI application, PostgreSQL migrations, a durable worker, and a Java 21 engine service built on XMage from a pinned commit.

The engine loads XMage's card database and plays complete games: Legacy between two seats, and Commander at two, three or four seats, with any mix of human seats and XMage computer players. Human seats run through XMage's own human player: every choice becomes a typed prompt, stale answers are refused, and each seat sees only its own authorized view, including commander tax and commander damage. Players sign in with Google; the account keeps a handle, an avatar and its accessibility preferences. Administrators approve accounts, assign roles and read an append-only audit log. SysOp, the local root account, signs in with a password only from the operator's network.

A signed-in, approved player starts a practice game against bots on the Play page and plays it to the end in the browser, by mouse or by keyboard: Legacy against one bot, or Commander at a table of up to four ([the game screen](docs/game-screen.md)). Cards show their printed images, which the API fetches from Scryfall once and serves itself. The API holds the engine's seat tokens, one tab at a time controls the seat, and resent commands run once. SysOp also inspects every hand and library, observes any game and plays deck lists of any card in the game. The site runs live at https://duels.thesphinx.co ([the live site](docs/deployment.md)).

Since v0.2.0 the worker imports Scryfall's card catalog every day and maps it to the cards the engine implements; a card plays only when the engine's implementation passed automatic checks ([the card catalog](docs/catalog.md)). Players search it on the Cards page, and build Legacy and Commander decks that the server validates, versions and shares by link, with guided creation, statistics and import and export; their playable decks go to the practice table ([decks](docs/decks.md)). The game screen adds the priority controls: passes until a chosen point, stops and full control ([release notes](docs/releases/0.2.0.md)). The application shows unavailable features and their milestones. The source scope remains the full product backlog.

Since v0.7.0 the table has a layer of special effects for its notable moments, drawn by the browser from the same events as its animation and never from the log: a red X slashed over a creature slain in combat, bursts for commander casts and big spells, embers, shock rings, a shattering portrait, confetti ([the game screen](docs/game-screen.md#the-table), [release notes](docs/releases/0.7.0.md)); Settings › Special effects sets Full, Subtle or Off. Since v0.7.1 a low-skill bot plays like an amateur ([fair bots](docs/engine/fair-bots.md#skill-and-habits-v071)) and the auction house's transfer sections fold. Since v0.7.2 a game has music: the owner's track, streamed during games only, with its own volume and mute ([release notes](docs/releases/0.7.2.md)); it is not in this repository, so the public images are silent and the live site takes it from a private web image ([the live site](docs/deployment.md#the-web-image-with-the-music-v072)).

## Start with Docker

Install Docker with Compose and start its Linux engine, then run from this directory:

```sh
docker compose up --build
```

The first build compiles XMage from source inside the engine image (about 3–4 minutes on a fast machine; give Docker Desktop at least 6 GB of memory). Later builds reuse that layer until the XMage pin changes.

Open http://localhost:8080 and start a practice game from the Play page once you are signed in. API documentation is at http://localhost:8000/api/v1/docs. Card images need outbound HTTPS to Scryfall; without it, cards show their text frames.

- **Music (v0.7.2).** The gameplay track is not in the repository. Copy it to `music/game.mp3` (a gitignored folder beside `compose.yaml`; Compose mounts it into the web container, and the dev server serves it too) and the table plays it during games. Without it the table is quiet.

### Sign-in and SysOp

- **Google sign-in.** Off until you set a client ID.
  1. Create an OAuth client ID of type *Web application* in Google Cloud Console.
  2. Add `http://localhost` and `http://localhost:8080` as authorized JavaScript origins.
  3. Put the ID in `.env` as `CD_GOOGLE_CLIENT_ID=…`. It is public and needs no client secret.
  4. Run `docker compose up -d` again.

  Sign-up is open. Set `CD_SIGNUP_POLICY=approval` to approve new accounts first.
- **SysOp.** Set its password from the console; the first run creates the account:

  ```sh
  docker compose exec api python -m api.cli sysop-password
  ```

  Then open http://localhost:8080/#sysop and sign in as `sysop`. In Compose, SysOp's entrance exists only for this computer's browser. Elsewhere it looks like any unknown page.

- **Games.** The API and the engine share a service token. Generate one into `.env`, then run `docker compose up -d` again:

  ```sh
  python -c "import secrets; print('CD_ENGINE_SERVICE_TOKEN=' + secrets.token_urlsafe(32))" >> .env
  ```

  Without it, practice games answer 503 `games_unavailable`.
- **PostgreSQL's port.** Compose publishes it on 127.0.0.1:5432. If Windows has reserved that port (`netsh interface ipv4 show excludedportrange protocol=tcp`), set `CD_DB_PORT` in `.env`, for example `CD_DB_PORT=15432`.

See [identity](docs/identity.md) for the flows, roles, sessions and the production network settings, and [games through the API](docs/games.md) for practice games, the WebSocket protocol and SysOp's inspection. Compose waits for PostgreSQL and applies migrations before starting the API and worker. Only localhost ports are published; the Java boundary is internal. Development credentials are intentionally public and must not be used for deployment. Database data persists in the named volume. `docker compose down` stops the stack without deleting data.

## Local development

Prerequisites: Python 3.12, Node 24.19, pnpm 11.25, and Docker for engine work (Maven and the JDK run inside the engine image build). PostgreSQL 17 is required for durable workers and integration tests. A UI/API preview can run without PostgreSQL; readiness correctly returns 503.

```sh
python -m venv .venv
# Windows PowerShell: .\.venv\Scripts\Activate.ps1
# Linux/macOS: source .venv/bin/activate
pip install -r requirements.lock
pip install --no-deps -e .
pnpm install --frozen-lockfile
# Copy .env.example to .env if overriding the defaults.
docker compose up -d db
alembic upgrade head
python -m api.cli sysop-password   # optional: SysOp, from 127.0.0.1 with .env.example's networks
uvicorn api.main:create_app --factory --reload --host 127.0.0.1 --port 8000 --no-proxy-headers
```

In a second terminal, run `pnpm dev` and open http://localhost:5173. Vite proxies `/api` to port 8000. Run `python -m catalog.worker` in a third activated terminal when testing jobs. With `CD_CATALOG_DIR` set it imports Scryfall's catalog (about 115 MB, two minutes); without it, `python scripts/load_fixture_catalog.py` loads the 70-card test slice instead, enough for the deck builder.

### Engine

`engine/` is a Maven project built in Docker. The image fetches exactly the XMage commit in `engine/xmage/pin.properties` (a shallow fetch of that one SHA), installs the XMage modules it needs into a Maven repository inside the image, builds XMage's card database, then compiles the engine and runs its JUnit suite, including real bot games. XMage source and build output never enter this repository. See [the spike findings](docs/engine/xmage-spike.md).

```sh
docker compose build engine
```

For faster engine iterations, build the XMage and card database stages once, then compile and test against them in a throwaway container. The source is copied inside, so build output stays out of the repository:

```sh
docker build -f engine/Dockerfile --target carddb -t commander-duels-carddb .
docker run --rm -v "$PWD/engine:/src:ro" -v commander-duels-m2:/root/.m2/repository commander-duels-carddb sh -c 'cp -r /src /build && cd /build && ln -s /xmage/carddb/db db && mvn -B -ntp -Dmaven.repo.local.tail=/xmage/m2 test'
```

Add `-Dtest=HumanGameTest` to run one test class. Rebuild the stage only when `engine/xmage/` changes.

With the stack running, play one development bot match (Legacy rules, two XMage "Computer - mad" players, fixture decks from `engine/decks`). The engine has no published port, so the request runs from the API container:

```sh
docker compose exec api python -c "import httpx, json, os; r = httpx.post(os.environ['CD_ENGINE_URL'] + '/v1/bot_match', json={'seed': 42}, timeout=700); print(json.dumps(r.json(), indent=2))"
```

Optional inputs: `seed`, `turn_cap` (1–200, default 60), `time_budget_seconds` (1–600, default 120), `skill` (1–6, default 4) and `include_log`. Out-of-range values are clamped. One match runs at a time; others get 429. To run several in a row and summarize them:

```sh
docker compose exec -T api python - --count 10 < scripts/engine_bot_matches.py
```

Play one development game. A scripted player answers every prompt for every human seat through the seat API, each seat with its own token, prints the prompts, options and answers alongside the game log, and checks every payload for concealed information:

```sh
docker compose exec -T api python - < scripts/engine_human_game.py
```

A four-seat Commander game with two human seats and two bots:

```sh
docker compose exec -T api python - --format commander --seats human,human,bot,bot < scripts/engine_human_game.py
```

A spectator thread watches every game through the read-only spectator token. Options go after `-`: `--format` (`legacy` or `commander`), `--seats` (default `human,bot` for Legacy and `human,bot,bot,bot` for Commander), `--deck` (the first human seat's deck), `--seed`, `--skill` (default 1), `--turn-cap` (default 30), `--spectator-delay` (seconds, default 0) and `--quiet` (summary only). The last line is a JSON summary. See [the human seat](docs/engine/human-seat.md) for the endpoints, prompt kinds and view rules, and [Commander tables](docs/engine/commander-tables.md) for tables, seats and commander fields.

Both development endpoints exist only when `CD_ENGINE_DEV_ENDPOINTS=true`, which Compose sets. At most `CD_ENGINE_MAX_GAMES` games (default 2, development and API games together) run at once.

### Practice games through the API

`scripts/api_practice_game.py` plays a whole practice game through the API and its WebSocket as SysOp, the way the browser will. It checks every snapshot and inspection, and proves the controller lease and a resend along the way. It needs `websockets` (in `requirements.lock`), the service token in Compose, and SysOp's password in `CD_SYSOP_PASSWORD`. Run it from this computer, SysOp's network, through the web proxy:

```sh
python scripts/api_practice_game.py --url http://localhost:8080 --origin http://localhost:8080 --schemas contracts
```

Add `--format commander --bots 3` for a four-seat Commander game, `--deck-list FILE` for a SysOp deck list (one card per line, any card in the game), and `--quiet` for the summary only. The protocol and the routes are in [games through the API](docs/games.md).

### Deploying

CI publishes the images to GitHub's container registry. `deploy/push.sh <tag>` deploys one to the live VM over SSH: it backs up the database, migrates before replacing anything, restarts and checks the site. If the new tag does not start or is not ready, the previous one comes back when the database still allows it. On the VM, `restore.sh` restores a backup into an emptied database. The one-time setup of the VM and the TSH proxy, backups, restores, rolling back and the live checks are in [the live site](docs/deployment.md).

## Verify changes

```sh
ruff check api catalog tests scripts
ruff format --check api catalog tests scripts
mypy
pytest
# Optional PostgreSQL concurrency check: set CD_TEST_POSTGRES_URL to the development DB URL.
# If Windows temp-folder permissions block pytest, create .local and use
# pytest --basetemp=.local/pytest-run (pytest owns and clears that test directory).
alembic upgrade head
alembic check
python scripts/export_contracts.py
pnpm contracts
pnpm test
pnpm build
pnpm --dir web exec playwright install chromium
# Playwright starts the API (from the activated Python environment) and Vite, or reuses running ones.
# The SysOp journey runs when CD_E2E_SYSOP_PASSWORD holds SysOp's password in that database.
pnpm test:e2e
docker compose config --quiet
docker run --rm -v "$PWD:/mnt:ro" -w /mnt koalaman/shellcheck:v0.10.0 --severity=warning deploy/*.sh
```

Commit regenerated `contracts/openapi.json` and `web/src/generated/api.d.ts` together. The browser uses `openapi-fetch` against the generated types. API tests detect schema drift. CI also builds the engine image (Maven and JUnit), smoke-tests it in Compose with a bot match, a schema-checked Legacy human-seat game and a schema-checked four-seat Commander game, plays a Legacy and a Commander practice game through the API as SysOp, plays practice games in Chromium through the game screen (`web/e2e/game.spec.ts`, with `CD_E2E_GAMES=1`), runs migration checks against PostgreSQL and browser journeys, checks the deploy scripts with ShellCheck, and builds the other containers. On pushes to `main` and version tags it publishes the images.

To run browser tests against the built Compose app, set `CD_BROWSER_URL=http://127.0.0.1:8080` before `pnpm test:e2e`. Without this override, the tests start the API on port 8000 and Vite on port 5173.

## Versioning

Each development thread is one version, and `VERSION` is the only file that holds the number. Python packaging and the API read it directly; the web build injects it as `__APP_VERSION__`. To bump a release:

1. Edit `VERSION`.
2. Run `python scripts/export_contracts.py` and `pnpm contracts`. The OpenAPI document embeds the version, so the drift test fails until both are regenerated.
3. Run `pip install --no-deps -e .` so the installed package metadata matches.
4. Add `docs/releases/<version>.md`.

## Repository map

| Directory | Responsibility |
| --- | --- |
| `web` | Accessible shell, the practice table and the game screen (`web/src/game`), the card catalog (`web/src/catalog`) and deck builder (`web/src/decks`), format details, preferences, Google sign-in, profile, administration and SysOp screens, API client, the owner's logo and banner |
| `api` | HTTP contracts, configuration, lifecycle, identity (sign-in, sessions, roles, audit, SysOp), administration, practice games and their WebSocket, the card image cache, card search, deck validation, decks and guided creation, persistence models and Alembic migrations |
| `engine` | Java 21 XMage engine service: pinned build, card database, fixture decks, development bot matches, multi-seat Legacy and Commander games, the API's service games, SysOp's inspection view and deck lists, priority controls, and the implementation list built with the image |
| `catalog` | The worker: PostgreSQL lease claim, generation fencing, and the daily Scryfall import with its revisions, statuses and the engine's implementation list |
| `contracts` | Generated public OpenAPI, the internal command envelope, the seat-view contract and SysOp's inspection contract |
| `content` | Constrained draft scenario schema and example |
| `tests` | API, migration, contract, catalog, validation, deck and job lifecycle regressions, with a slice of Scryfall's data (`tests/fixtures`) |
| `deploy` | The live site: production Compose file, VM bootstrap, deploy, backup and restore scripts, the TSH proxy's nginx site |
| `docs` | Architecture, scope ledger, reference inventory and release evidence |

See [architecture](docs/architecture.md), [identity](docs/identity.md), [games through the API](docs/games.md), [the game screen](docs/game-screen.md), [the card catalog](docs/catalog.md), [decks](docs/decks.md), [the live site](docs/deployment.md), [remaining work](docs/backlog.md), [the v0.1.0 plan](docs/plans/0.1.0.md), [the v0.1.1 plan](docs/plans/0.1.1.md), [the v0.2.0 plan](docs/plans/0.2.0.md), [the v0.3.0 plan](docs/plans/0.3.0.md), [the v0.7.0 plan](docs/plans/0.7.0.md), [the v0.7.1 plan](docs/plans/0.7.1.md), [the v0.7.2 plan](docs/plans/0.7.2.md), [Two-Headed Giant feasibility](docs/engine/two-headed-giant.md), and release notes for [0.7.2](docs/releases/0.7.2.md), [0.7.1](docs/releases/0.7.1.md), [0.7.0](docs/releases/0.7.0.md), [0.2.0](docs/releases/0.2.0.md), [0.1.1](docs/releases/0.1.1.md), [0.1.0](docs/releases/0.1.0.md), [0.0.6](docs/releases/0.0.6.md), [0.0.5](docs/releases/0.0.5.md), [0.0.4](docs/releases/0.0.4.md), [0.0.3](docs/releases/0.0.3.md), [0.0.2](docs/releases/0.0.2.md) and [0.0.1](docs/releases/0.0.1.md).
