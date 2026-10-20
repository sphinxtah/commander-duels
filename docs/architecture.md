# Framework architecture

The browser renders user intent. FastAPI will own identity, ownership, deck persistence and match orchestration. The Java adapter will own rules, AI and private authoritative game state. Python must never become a second implementation of card effects. PostgreSQL owns durable records; the worker owns scheduled tasks.

v0.0.1 implemented the infrastructure. v0.0.2 added the XMage engine build and internal bot-versus-bot games. v0.0.3 added a human seat with typed prompts and authorized per-seat views, on development engine endpoints driven by scripts. v0.0.4 generalized the seat bridge to Commander tables of two to four seats with any mix of humans and bots. v0.0.5 added identity: Google sign-in, server-side sessions, roles, an append-only audit trail and SysOp, the local root account ([identity](identity.md)). v0.0.6 routes games through the API: a signed-in account plays practice games against bots over a WebSocket, the API owns the engine's seat tokens and the controller lease, and SysOp can inspect every hand and library ([games through the API](games.md)). v0.1.0 added the game screen, so approved players play practice games against bots in the browser ([the game screen](game-screen.md)), and put the site live ([the live site](deployment.md)). v0.2.0 added the card catalog, imported daily from Scryfall and mapped to the engine's implementations ([the card catalog](catalog.md)), players' own decks with validation, sharing and guided creation ([decks](decks.md)), and the priority controls ([the game screen](game-screen.md#priority-controls-ui07-v020)). `/api/v1/bootstrap` exposes feature availability; since v0.1.1 it marks practice play available. `/api/v1/formats` describes the modes: Commander and Legacy are available, because practice games play them, and Two-Headed Giant is planned. `/api/v1/health` is process liveness; `/api/v1/ready` checks the database and requires the exact Alembic head revision, read from the migration scripts at startup. Neither means games are playable. `/api/v1/engine/status` validates the Java boundary response, with a two-second timeout. `/api/v1/me` returns the signed-in account or 401; there is no development identity bypass.

API resources close on shutdown through FastAPI lifespan. Request IDs are generated server-side, returned in headers, and included in HTTP error bodies. Error responses omit submitted credentials and validation payloads. No permissive CORS is configured: local Vite and the web container forward same-origin API requests. State-changing `/api/` requests from another origin are refused before any session is read, and signed-in ones also need the session's CSRF token.

## Data and migrations

Tables:
- **0001:** users, external identities with unique issuer/subject, rules bundles, and scheduled jobs.
- **0002 (identity):** profile columns on users, sessions, role grants, audit events and Google sign-in challenges.
- **0003 (games):** games the API started in the engine (status and result) and their seats (owner account or bot, deck or deck list).
- **0004 (card images):** what Scryfall answered for each card name whose image the API cached.
- **0005 (catalog):** catalog revisions and sync runs, source snapshots, card concepts with their faces, printings, rulings, relations, aliases and tags, change records, the engine's implementation list and format versions.
- **0006 (decks):** decks with their drafts, immutable deck revisions and their entries (a PostgreSQL trigger refuses updates to both), and the deck revision, catalog revision and format version on games and seats.

UTC-aware timestamps and UUID identities establish conventions. Jobs, preferences and audit details use JSONB in PostgreSQL. A trigger makes `audit_events` append-only, and a partial unique index allows one SysOp. Later feature tables will arrive in feature-specific migrations; the full relational model in scope section 15 remains required.

Migrations explicitly declare their historical schema. Model changes cannot silently alter an old migration. Use `alembic revision --autogenerate -m "description"`, review upgrade/downgrade, then test against PostgreSQL. SQLite tests cover portable lifecycle logic only; they do not prove concurrency or PostgreSQL semantics. A deploy migrates while the previous version still serves ([the live site](deployment.md#deploying-a-version)), so a migration only adds what that version can ignore: tables, nullable or defaulted columns, indexes. Dropping or renaming what that version uses, or backfilling data it keeps writing, waits for a later version (expand, then contract).

Requests do not hold pooled connections while they wait. The dependency that signs a request in ends its read transaction before the route runs, so no request holds a connection while it waits on a per-account lock, the engine or Scryfall, and a burst of requests cannot exhaust the pool. The card-image routes also close their session before a lookup, because the cache opens its own.

Worker claims use `FOR UPDATE SKIP LOCKED`, expiring leases, and an incrementing generation. Completion checks the generation, status, and unexpired lease. Since v0.2.0 the worker runs the daily catalog sync: it keeps today's and tomorrow's run scheduled, renews a run's lease from a heartbeat while it downloads and imports, and writes the revision in one transaction that locks the job row and checks its generation, so a run that lost its lease writes nothing ([the card catalog](catalog.md#the-daily-sync)). A shutdown signal stops claims and exits after the current bounded iteration.

## Engine and protocol

The engine is a Java 21 service built on XMage, pinned to release `xmage_1.4.62V1` (`eb69d05b`) in `engine/xmage/pin.properties`. The engine image fetches exactly that commit, builds the needed XMage modules with Maven on JDK 21 with no upstream patches (since v0.0.4 including the `CommanderDuel` game), and builds XMage's card database at image-build time. It runs on a JRE 21 as uid 10001. [The spike findings](engine/xmage-spike.md) record the measurements, the threading model, the determinism results and how XMage's human player waits for choices.

The engine drives XMage's game objects directly, as XMage's test framework does, without XMage's server, users or sessions. `/health` reports the engine state (`loading`, `ready` or `failed`), the pinned XMage build, the card counts, and `gameplay_available`. That is true when the engine is ready and its service routes serve the API's players' games, and false otherwise; the API passes it through at `/api/v1/engine/status`. `/ready` returns 503 until the card database is open. A development-only `POST /v1/bot_match`, enabled by `CD_ENGINE_DEV_ENDPOINTS=true`, plays one Legacy Two Player Duel between two XMage "Computer - mad" players with fixture decks. It enforces a turn cap and a wall-clock budget, allows one match at a time, and isn't part of the player command envelope.

The same flag enables development games, which scripts drive directly. Their routes are `POST /v1/games`, plus `GET .../view`, `POST .../commands` and `POST .../close` under `/v1/games/{id}`. A game is Legacy at two seats or Commander at two to four, and each seat is XMage's unmodified `HumanPlayer` or a computer player:
- **Prompts.** Each of XMage's blocking requests becomes a typed prompt with an ID, published with that seat's view at a new revision of that seat. XMage asks one player at a time, so at most one prompt is open per game.
- **Answers.** An answer must name the seat's open prompt and the seat's current revision. Repeated action IDs return their first result.
- **Seats.** Each human seat's token, returned once at creation, alone selects that seat. A read-only spectator token reads the public view, optionally delayed.
- **Views.** These are built field by field on the game thread, with opaque object IDs, never XMage UUIDs, and counts in place of every concealed zone. Commander tax and commander damage come from XMage's own watchers.
- **Lifecycle.** Games live in memory. At most `CD_ENGINE_MAX_GAMES` run at once (default 2), and idle games are closed.

[The human seat](engine/human-seat.md) documents the prompt mechanics, view rules, endpoints and leak checks; [Commander tables](engine/commander-tables.md) covers the tables, seats, commander fields and multiplayer prompts. Since v0.0.6, `CD_ENGINE_SERVICE_TOKEN` enables the API's service games under `/v1/service`. Every request there carries the token; seats still need their seat tokens. The routes add closing, SysOp's inspection view and card-name lookup, and accept deck lists ([games through the API](games.md#the-engines-service-routes)). Every other `/v1/` operation still fails closed with 503. Compose publishes no engine port, and the web proxy forwards nothing to the engine. Only the API reaches it: its status at `/api/v1/engine/status`, and its games.

The JSON Schema envelope captures protocol, action identity, game identity, expected revision and prompt identity, with the `submit_choice` and `concede` payloads the development seat API accepts. [The seat-view contract](../contracts/engine-seat-view.schema.json) closes every object, so another player's hand, library contents, the seed and XMage identifiers cannot appear. Since v0.0.6 the API routes practice games with service authentication, per-account and global limits, server-selected seat ownership, controller leases and a schema-checked command model. The remaining operations and private recovery schemas remain M0 work. Never project internal snapshots by removing a few fields; define explicit authorized-view types, as the seat, spectator and inspection views are.

## Browser

React uses CSS Modules and hash navigation so a route refresh stays in the application. Main headings receive keyboard focus on navigation, including when leaving a game. The skip link focuses the main region without changing the route. A network failure while reloading `/api/v1/me` keeps a known account; only a 401 signs the page out. Format dialogs use native modal focus behavior. Large text and reduced motion preferences persist in a versioned, defensive localStorage record and, for a signed-in account, in its profile; no identities or tokens are stored in the browser. The session cookie is HttpOnly, and the CSRF token lives in memory. Google's sign-in script loads only on the Profile page, and only when a client ID is configured. System reduced-motion settings are respected. The brand images are the owner's logo and banner, resized by `scripts/brand_assets.py` ([provenance](asset-provenance.csv)); the rest is CSS geometry. Card images come from Scryfall through the API's own cache, so the browser makes no external image or font requests ([the game screen](game-screen.md)). The web container's Content Security Policy allows Google's sign-in script, stylesheet and button frame and nothing else from outside.

API availability is explicitly separate from connectivity and feature availability. Failed bootstrap requests expose retry. No service worker or installability claim is present: PWA updates and genuine local gameplay remain M5 work.

## Configuration

Settings use the `CD_` prefix, `.env` locally and injected environment variables in containers. `.env` is ignored. Invalid enum values, URLs and worker intervals fail validation. `production` refuses to start with development credentials or an unsafe proxy setup ([the live site](deployment.md#configuration)).

| Key | Default / purpose |
| --- | --- |
| `CD_ENVIRONMENT` | `development`; also `test`, and `production` for the live site, which requires HTTPS, Secure cookies, a generated database password, the service token, a Google client ID and trusted proxies |
| `CD_DATABASE_URL` | Local PostgreSQL psycopg connection; SQLite only for isolated tests |
| `CD_ENGINE_URL` | `http://localhost:8090`; server-to-server health probe |
| `CD_PUBLIC_URL` | `http://localhost:5173`; the site's origin. State-changing requests must come from it (or its loopback twin) |
| `CD_LOG_LEVEL` | `INFO`; worker logging level |
| `CD_WORKER_POLL_SECONDS` | 5, allowed 0.1–60 |
| `CD_GOOGLE_CLIENT_ID` | Empty (Google sign-in off); a Web OAuth client ID, public, no secret |
| `CD_SIGNUP_POLICY` | `open`; `approval` keeps new accounts pending until approved |
| `CD_SYSOP_NETWORKS` | Empty (SysOp's entrance off); CIDR list SysOp may sign in from. Compose: the Docker gateway, meaning this computer |
| `CD_TRUSTED_PROXIES` | Empty; CIDR list of proxies whose `X-Forwarded-For` is believed. Compose: the web container. May not overlap the SysOp networks |
| `CD_COOKIE_SECURE` | `true`; browsers keep Secure cookies on `http://localhost` |
| `CD_PLAYER_IDLE_MINUTES`, `CD_PLAYER_ABSOLUTE_MINUTES` | 20160 (14 days) and 43200 (30 days) |
| `CD_SYSOP_IDLE_MINUTES`, `CD_SYSOP_ABSOLUTE_MINUTES` | 60 and 720 (12 hours) |
| `CD_REAUTH_MINUTES` | 720; maximum sign-in age for role and account-status changes |
| `CD_ENGINE_SERVICE_TOKEN` | Empty (games off); shared with the engine, at least 32 characters |
| `CD_GAMES_PER_ACCOUNT`, `CD_GAMES_MAX` | 1 (SysOp unlimited) and 2: running games per account and in the API |
| `CD_CARD_IMAGE_DIR` | Empty (card images off); where the API keeps the card images it fetches from Scryfall. Compose and the live site: a named volume |
| `CD_SCRYFALL_URL` | `https://api.scryfall.com`; Scryfall's API, for card-image lookups and the bulk-data list |
| `CD_CATALOG_DIR` | Empty (catalog sync off); where the worker keeps Scryfall's bulk files. Compose and the live site: the worker's `catalog_data` volume |
| `CD_CATALOG_SYNC_TIME`, `CD_CATALOG_SYNC_JITTER_MINUTES` | `10:00` (UTC) and 30 (0–360): when the daily sync becomes due, plus a jitter |
| `CD_CATALOG_MAX_DOWNLOAD_MB`, `CD_CATALOG_MAX_DATASET_MB` | 1024 and 4096: limits on one bulk file, compressed and unpacked |
| `CD_STARTER_DECKS_DIR` | `engine/decks`; the starter decks players may copy. The API image holds a copy at `/app/starters` |

The engine reads its own environment: `CD_ENGINE_PORT` (default 8090), `CD_ENGINE_DEV_ENDPOINTS` (default off, `true` in Compose; enables bot matches and development games), `CD_ENGINE_SERVICE_TOKEN` (the API's service games), `CD_ENGINE_MAX_GAMES` (concurrent games of both kinds, default 2, at most 8), `CD_ENGINE_DECKS` (the fixture deck folder), `CD_ENGINE_IMPLEMENTATIONS` (since v0.2.0, the folder with the implementation list built into the image, default `catalog`) and `JDK_JAVA_OPTIONS`. Compose sets the heap explicitly (`-Xms256m -Xmx768m`), a 1.5 GB memory limit, and `-Dh2.bindAddress=127.0.0.1`, which keeps the TCP listener that XMage's H2 settings start on loopback. Compose publishes PostgreSQL on `127.0.0.1:${CD_DB_PORT:-5432}`, for host-side tests and Alembic only; move it when Windows reserves 5432.

Dependency versions are recorded in package manifests and lockfiles. Container base images have version tags; digest pinning, SBOM generation and published artifact provenance remain release-hardening work. CI publishes the images to GitHub's container registry for [the live site](deployment.md).

Implementation references: [FastAPI lifespan](https://fastapi.tiangolo.com/advanced/events/), [SQLAlchemy connection pooling](https://docs.sqlalchemy.org/en/20/core/pooling.html), [Vite setup](https://vite.dev/guide/).
