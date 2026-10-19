# Framework architecture

The browser renders user intent. FastAPI will own identity, ownership, deck persistence and match orchestration. The Java adapter will own rules, AI and private authoritative game state. Python must never become a second implementation of card effects. PostgreSQL owns durable records; the worker owns scheduled tasks.

v0.0.1 implemented the infrastructure. v0.0.2 added the XMage engine build and internal bot-versus-bot games. v0.0.3 added a human seat with typed prompts and authorized per-seat views, on development engine endpoints driven by scripts. v0.0.4 generalized the seat bridge to Commander tables of two to four seats with any mix of humans and bots. v0.0.5 added identity: Google sign-in, server-side sessions, roles, an append-only audit trail and SysOp, the local root account ([identity](identity.md)). No player can play yet. `/api/v1/bootstrap` exposes feature availability. `/api/v1/formats` describes planned modes, all unavailable. `/api/v1/health` is process liveness; `/api/v1/ready` checks the database and requires the exact Alembic head revision, read from the migration scripts at startup. Neither means games are playable. `/api/v1/engine/status` validates the Java boundary response, with a two-second timeout. `/api/v1/me` returns the signed-in account or 401; there is no development identity bypass.

API resources close on shutdown through FastAPI lifespan. Request IDs are generated server-side, returned in headers, and included in HTTP error bodies. Error responses omit submitted credentials and validation payloads. No permissive CORS is configured: local Vite and the web container forward same-origin API requests. State-changing `/api/` requests from another origin are refused before any session is read, and signed-in ones also need the session's CSRF token.

## Data and migrations

Tables:
- **0001:** users, external identities with unique issuer/subject, rules bundles, and scheduled jobs.
- **0002 (identity):** profile columns on users, sessions, role grants, audit events and Google sign-in challenges.

UTC-aware timestamps and UUID identities establish conventions. Jobs, preferences and audit details use JSONB in PostgreSQL. A trigger makes `audit_events` append-only, and a partial unique index allows one SysOp. Later feature tables will arrive in feature-specific migrations; the full relational model in scope section 15 remains required.

Migrations explicitly declare their historical schema. Model changes cannot silently alter an old migration. Use `alembic revision --autogenerate -m "description"`, review upgrade/downgrade, then test against PostgreSQL. SQLite tests cover portable lifecycle logic only; they do not prove concurrency or PostgreSQL semantics.

Worker claims use `FOR UPDATE SKIP LOCKED`, expiring leases, and an incrementing generation. Completion checks the generation, status, and unexpired lease. Only a bounded health probe runs today. Long-running imports need lease renewal, staged data, atomic promotion and transactionally fenced side effects before adding a handler. The current worker has no automatic catalog schedule. A shutdown signal stops claims and exits after the current bounded iteration.

## Engine and protocol

The engine is a Java 21 service built on XMage, pinned to release `xmage_1.4.62V1` (`eb69d05b`) in `engine/xmage/pin.properties`. The engine image fetches exactly that commit, builds the needed XMage modules with Maven on JDK 21 with no upstream patches (since v0.0.4 including the `CommanderDuel` game), and builds XMage's card database at image-build time. It runs on a JRE 21 as uid 10001. [The spike findings](engine/xmage-spike.md) record the measurements, the threading model, the determinism results and how XMage's human player waits for choices.

The engine drives XMage's game objects directly, as XMage's test framework does, without XMage's server, users or sessions. `/health` reports the engine state (`loading`, `ready` or `failed`), the pinned XMage build, the card counts, and `gameplay_available: false`. `/ready` returns 503 until the card database is open. A development-only `POST /v1/bot_match`, enabled by `CD_ENGINE_DEV_ENDPOINTS=true`, plays one Legacy Two Player Duel between two XMage "Computer - mad" players with fixture decks. It enforces a turn cap and a wall-clock budget, allows one match at a time, and isn't part of the player command envelope.

The same flag enables development games. Their routes are `POST /v1/games`, plus `GET .../view`, `POST .../commands` and `POST .../close` under `/v1/games/{id}`. A game is Legacy at two seats or Commander at two to four, and each seat is XMage's unmodified `HumanPlayer` or a computer player:
- **Prompts.** Each of XMage's blocking requests becomes a typed prompt with an ID, published with that seat's view at a new revision of that seat. XMage asks one player at a time, so at most one prompt is open per game.
- **Answers.** An answer must name the seat's open prompt and the seat's current revision. Repeated action IDs return their first result.
- **Seats.** Each human seat's token, returned once at creation, alone selects that seat. A read-only spectator token reads the public view, optionally delayed.
- **Views.** These are built field by field on the game thread, with opaque object IDs, never XMage UUIDs, and counts in place of every concealed zone. Commander tax and commander damage come from XMage's own watchers.
- **Lifecycle.** Games live in memory. At most `CD_ENGINE_MAX_GAMES` run at once (default 2), and idle games are closed.

[The human seat](engine/human-seat.md) documents the prompt mechanics, view rules, endpoints and leak checks; [Commander tables](engine/commander-tables.md) covers the tables, seats, commander fields and multiplayer prompts. Every other `/v1/` operation still fails closed with 503. Compose publishes no engine port, and the web proxy forwards nothing to the engine. The API proxies only `/health`, as `/api/v1/engine/status`.

The JSON Schema envelope captures protocol, action identity, game identity, expected revision and prompt identity, with the `submit_choice` and `concede` payloads the development seat API accepts. [The seat-view contract](../contracts/engine-seat-view.schema.json) closes every object, so another player's hand, library contents, the seed and XMage identifiers cannot appear. Authorization context, the remaining operations and private recovery schemas remain M0 work. The schemas are not a safe production command validator on their own. Before routing any game action, implement service authentication, limits, protocol negotiation, server-selected seat ownership, controller leases and per-operation schemas. Never project internal snapshots by removing a few fields; define explicit authorized-view types.

## Browser

React uses CSS Modules and hash navigation so a route refresh stays in the application. Main headings receive keyboard focus on navigation. Format dialogs use native modal focus behavior. Large text and reduced motion preferences persist in a versioned, defensive localStorage record and, for a signed-in account, in its profile; no identities or tokens are stored in the browser. The session cookie is HttpOnly, and the CSRF token lives in memory. Google's sign-in script loads only on the Profile page, and only when a client ID is configured. System reduced-motion settings are respected. CSS geometry and the SVG brand are original assets with no external images or font requests. The web container's Content Security Policy allows Google's sign-in script, stylesheet and button frame and nothing else from outside.

API availability is explicitly separate from connectivity and feature availability. Failed bootstrap requests expose retry. No service worker or installability claim is present: PWA updates and genuine local gameplay remain M5 work.

## Configuration

Settings use the `CD_` prefix, `.env` locally and injected environment variables in containers. `.env` is ignored. Invalid enum values, URLs and worker intervals fail validation. Only development/test environments are accepted; production hardening has not been completed.

| Key | Default / purpose |
| --- | --- |
| `CD_ENVIRONMENT` | `development`; also accepts `test` |
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

The engine reads its own environment: `CD_ENGINE_PORT` (default 8090), `CD_ENGINE_DEV_ENDPOINTS` (default off, `true` in Compose; enables bot matches and development games), `CD_ENGINE_MAX_GAMES` (concurrent development games, default 2, at most 8), `CD_ENGINE_DECKS` (the fixture deck folder) and `JDK_JAVA_OPTIONS`. Compose sets the heap explicitly (`-Xms256m -Xmx768m`), a 1.5 GB memory limit, and `-Dh2.bindAddress=127.0.0.1`, which keeps the TCP listener that XMage's H2 settings start on loopback.

Dependency versions are recorded in package manifests and lockfiles. Container base images have version tags; digest pinning, SBOM generation and published artifact provenance remain release-hardening work. No host infrastructure is modified.

Implementation references: [FastAPI lifespan](https://fastapi.tiangolo.com/advanced/events/), [SQLAlchemy connection pooling](https://docs.sqlalchemy.org/en/20/core/pooling.html), [Vite setup](https://vite.dev/guide/).
