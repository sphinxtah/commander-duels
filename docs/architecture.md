# Framework architecture

The browser renders user intent. FastAPI will own identity, ownership, deck persistence and match orchestration. The Java adapter will own rules, AI and private authoritative game state. Python must never become a second implementation of card effects. PostgreSQL owns durable records; the worker owns scheduled tasks.

v0.0.1 implemented the infrastructure. v0.0.2 added the XMage engine build and internal bot-versus-bot games; no player can play yet. `/api/v1/bootstrap` exposes feature availability. `/api/v1/formats` describes planned modes, all unavailable. `/api/v1/health` is process liveness; `/api/v1/ready` checks the database and requires the exact Alembic head revision, read from the migration scripts at startup. Neither means games are playable. `/api/v1/engine/status` validates the Java boundary response, with a two-second timeout. `/api/v1/me` fails with 401; there is no development identity bypass.

API resources close on shutdown through FastAPI lifespan. Request IDs are generated server-side, returned in headers, and included in HTTP error bodies. Error responses omit submitted credentials and validation payloads. No permissive CORS is configured: local Vite and the web container forward same-origin API requests.

## Data and migrations

Initial tables: users, external identities with unique issuer/subject, rules bundles, and scheduled jobs. UTC-aware timestamps and UUID identities establish conventions. Jobs use JSONB in PostgreSQL. Later feature tables will arrive in feature-specific migrations; the full relational model in scope section 15 remains required. An identity row does not implement authentication or authorization.

Migrations explicitly declare their historical schema. Model changes cannot silently alter an old migration. Use `alembic revision --autogenerate -m "description"`, review upgrade/downgrade, then test against PostgreSQL. SQLite tests cover portable lifecycle logic only; they do not prove concurrency or PostgreSQL semantics.

Worker claims use `FOR UPDATE SKIP LOCKED`, expiring leases, and an incrementing generation. Completion checks the generation, status, and unexpired lease. Only a bounded health probe runs today. Long-running imports need lease renewal, staged data, atomic promotion and transactionally fenced side effects before adding a handler. The current worker has no automatic catalog schedule. A shutdown signal stops claims and exits after the current bounded iteration.

## Engine and protocol

The engine is a Java 21 service built on XMage, pinned to release `xmage_1.4.62V1` (`eb69d05b`) in `engine/xmage/pin.properties`. The engine image fetches exactly that commit, builds the needed XMage modules with Maven on JDK 21 with no upstream patches, and builds XMage's card database at image-build time. It runs on a JRE 21 as uid 10001. [The spike findings](engine/xmage-spike.md) record the measurements, the threading model, the determinism results and how XMage's human player waits for choices.

The engine drives XMage's game objects directly, as XMage's test framework does, without XMage's server, users or sessions. `/health` reports the engine state (`loading`, `ready` or `failed`), the pinned XMage build, the card counts, and `gameplay_available: false`. `/ready` returns 503 until the card database is open. A development-only `POST /v1/bot_match`, enabled by `CD_ENGINE_DEV_ENDPOINTS=true`, plays one Legacy Two Player Duel between two XMage "Computer - mad" players with fixture decks. It enforces a turn cap and a wall-clock budget, allows one match at a time, and isn't part of the player command envelope. Every other `/v1/` operation still fails closed with 503. Compose publishes no engine port, and the web proxy forwards nothing to the engine. The API proxies only `/health`, as `/api/v1/engine/status`.

The JSON Schema envelope captures protocol, action identity, game identity and expected revision. Operation-specific payloads, authorization context, prompt contracts, visibility projections and private recovery schemas remain M0 work. The draft schema is not a safe production command validator. Before routing any game action, implement service authentication, limits, protocol negotiation, server-selected seat ownership, controller leases and per-operation schemas. Never project internal snapshots by removing a few fields; define explicit authorized-view types.

## Browser

React uses CSS Modules and hash navigation so a route refresh stays in the application. Main headings receive keyboard focus on navigation. Format dialogs use native modal focus behavior. Large text and reduced motion preferences persist in a versioned, defensive localStorage record; no identities or tokens are stored there. System reduced-motion settings are respected. CSS geometry and the SVG brand are original assets with no external images or font requests.

API availability is explicitly separate from connectivity and feature availability. Failed bootstrap requests expose retry. No service worker or installability claim is present: PWA updates and genuine local gameplay remain M5 work.

## Configuration

Settings use the `CD_` prefix, `.env` locally and injected environment variables in containers. `.env` is ignored. Invalid enum values, URLs and worker intervals fail validation. Only development/test environments are accepted; production hardening has not been completed.

| Key | Default / purpose |
| --- | --- |
| `CD_ENVIRONMENT` | `development`; also accepts `test` |
| `CD_DATABASE_URL` | Local PostgreSQL psycopg connection; SQLite only for isolated tests |
| `CD_ENGINE_URL` | `http://localhost:8090`; server-to-server health probe |
| `CD_PUBLIC_URL` | `http://localhost:5173`; reserved origin for auth work |
| `CD_LOG_LEVEL` | `INFO`; worker logging level |
| `CD_WORKER_POLL_SECONDS` | 5, allowed 0.1–60 |
| `CD_GOOGLE_CLIENT_ID` | Empty; reserved, setting it does not enable login |

The engine reads its own environment: `CD_ENGINE_PORT` (default 8090), `CD_ENGINE_DEV_ENDPOINTS` (default off, `true` in Compose), `CD_ENGINE_DECKS` (the fixture deck folder) and `JDK_JAVA_OPTIONS`. Compose sets the heap explicitly (`-Xms256m -Xmx768m`), a 1.5 GB memory limit, and `-Dh2.bindAddress=127.0.0.1`, which keeps the TCP listener that XMage's H2 settings start on loopback.

Dependency versions are recorded in package manifests and lockfiles. Container base images have version tags; digest pinning, SBOM generation and published artifact provenance remain release-hardening work. No host infrastructure is modified.

Implementation references: [FastAPI lifespan](https://fastapi.tiangolo.com/advanced/events/), [SQLAlchemy connection pooling](https://docs.sqlalchemy.org/en/20/core/pooling.html), [Vite setup](https://vite.dev/guide/).
