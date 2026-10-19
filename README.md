# Commander Duels

**v0.0.3: human seat and per-seat views.** A runnable foundation for the Commander Duels development scope: React/TypeScript interface, Python/FastAPI application, PostgreSQL migrations, a durable worker, and a Java 21 engine service built on XMage from a pinned commit.

The engine loads XMage's card database and plays complete Legacy games, either between two XMage computer players or with a human seat against one. The human seat runs through XMage's own human player: every choice becomes a typed prompt, stale answers are refused, and the seat sees only an authorized view. These are internal development games, driven by scripts. There is no sign-in or game UI yet, and gameplay is unavailable to players. The application shows unavailable features and their milestones. The source scope remains the full product backlog.

## Start with Docker

Install Docker with Compose and start its Linux engine, then run from this directory:

```sh
docker compose up --build
```

The first build compiles XMage from source inside the engine image (about 3–4 minutes on a fast machine; give Docker Desktop at least 6 GB of memory). Later builds reuse that layer until the XMage pin changes.

Open http://localhost:8080. API documentation is at http://localhost:8000/api/v1/docs. Compose waits for PostgreSQL and applies migrations before starting the API and worker. Only localhost ports are published; the Java boundary is internal. Development credentials are intentionally public and must not be used for deployment. Database data persists in the named volume. `docker compose down` stops the stack without deleting data.

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
uvicorn api.main:create_app --factory --reload --host 127.0.0.1 --port 8000
```

In a second terminal, run `pnpm dev` and open http://localhost:5173. Vite proxies `/api` to port 8000. Run `python -m catalog.worker` in a third activated terminal when testing jobs. The worker only supports `health_probe`; it records other kinds as failed instead of pretending to import data.

### Engine

`engine/` is a Maven project built in Docker. The image fetches exactly the XMage commit in `engine/xmage/pin.properties` (a shallow fetch of that one SHA), installs the XMage modules it needs into a Maven repository inside the image, builds XMage's card database, then compiles the engine and runs its JUnit suite, including real bot games. XMage source and build output never enter this repository. See [the spike findings](docs/engine/xmage-spike.md).

```sh
docker compose build engine
```

With the stack running, play one development bot match (Legacy rules, two XMage "Computer - mad" players, fixture decks from `engine/decks`). The engine has no published port, so the request runs from the API container:

```sh
docker compose exec api python -c "import httpx, json, os; r = httpx.post(os.environ['CD_ENGINE_URL'] + '/v1/bot_match', json={'seed': 42}, timeout=700); print(json.dumps(r.json(), indent=2))"
```

Optional inputs: `seed`, `turn_cap` (1–200, default 60), `time_budget_seconds` (1–600, default 120), `skill` (1–6, default 4) and `include_log`. Out-of-range values are clamped. One match runs at a time; others get 429. To run several in a row and summarize them:

```sh
docker compose exec -T api python - --count 10 < scripts/engine_bot_matches.py
```

Play one development game with a human seat. A scripted player answers every prompt for seat 0 through the seat API, prints the prompts, options and answers alongside the game log, and checks every payload for concealed information:

```sh
docker compose exec -T api python - < scripts/engine_human_game.py
```

Options go after `-`: `--deck legacy-mono-green-creatures`, `--seed`, `--skill` (default 1), `--turn-cap` (default 30) and `--quiet` (summary only). The last line is a JSON summary. See [the human seat](docs/engine/human-seat.md) for the endpoints, prompt kinds and view rules.

Both development endpoints exist only when `CD_ENGINE_DEV_ENDPOINTS=true`, which Compose sets. At most `CD_ENGINE_MAX_GAMES` human games (default 2) run at once.

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
pnpm test:e2e
docker compose config --quiet
```

Commit regenerated `contracts/openapi.json` and `web/src/generated/api.d.ts` together. The browser uses `openapi-fetch` against the generated types. API tests detect schema drift. CI also builds the engine image (Maven and JUnit), smoke-tests it in Compose with a bot match and a schema-checked human-seat game, runs migration checks against PostgreSQL and browser journeys, and builds the other containers.

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
| `web` | Accessible eight-section shell, format details, device preferences, API client |
| `api` | HTTP contracts, configuration, lifecycle, persistence models and Alembic migrations |
| `engine` | Java 21 XMage engine service: pinned build, card database, development bot matches and human-seat games |
| `catalog` | PostgreSQL lease claim, generation fencing and bounded worker loop |
| `contracts` | Generated public OpenAPI, the internal command envelope and the seat-view contract |
| `content` | Constrained draft scenario schema and example |
| `tests` | API, migration, contract and job lifecycle regressions |
| `docs` | Architecture, scope ledger, reference inventory and release evidence |

See [architecture](docs/architecture.md), [remaining work](docs/backlog.md), [the next version's plan](docs/plans/0.0.4.md), and release notes for [0.0.3](docs/releases/0.0.3.md), [0.0.2](docs/releases/0.0.2.md) and [0.0.1](docs/releases/0.0.1.md). No production VM, host nginx, certificate, firewall, or routing configuration is included.
