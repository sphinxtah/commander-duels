# Commander Duels

**v0.0.1 — initial framework.** A runnable foundation for the Commander Duels development scope: React/TypeScript interface, Python/FastAPI application, PostgreSQL migrations, a durable worker, and an isolated Java service boundary.

This release is not playable and does not complete M0. It has no mock login, invented card catalog, simulated matches, or claimed offline support. The application displays unavailable features and their milestones. The source scope remains the full product backlog.

## Start with Docker

Install Docker with Compose and start its Linux engine, then run from this directory:

```sh
docker compose up --build
```

Open http://localhost:8080. API documentation is at http://localhost:8000/api/v1/docs. Compose waits for PostgreSQL and applies migrations before starting the API and worker. Only localhost ports are published; the Java boundary is internal. Development credentials are intentionally public and must not be used for deployment. Database data persists in the named volume. `docker compose down` stops the stack without deleting data.

## Local development

Prerequisites: Python 3.12, Node 24.19, pnpm 11.25, and Java 21 for engine work. PostgreSQL 17 is required for durable workers and integration tests. A UI/API preview can run without PostgreSQL; readiness correctly returns 503.

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

The Java boundary can be compiled without Maven:

```sh
javac -Xlint:all -Werror -d engine/out engine/src/main/java/com/commanderduels/*.java engine/src/test/java/com/commanderduels/*.java
java -cp engine/out com.commanderduels.EngineServerTest
java -cp engine/out com.commanderduels.EngineServer
```

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

Commit regenerated `contracts/openapi.json` and `web/src/generated/api.d.ts` together. The browser uses `openapi-fetch` against the generated types. API tests detect schema drift. CI also runs Java smoke tests, migration checks against PostgreSQL, browser journeys, and container builds.

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
| `engine` | Java 21 boundary; XMage adaptation is still outstanding |
| `catalog` | PostgreSQL lease claim, generation fencing and bounded worker loop |
| `contracts` | Generated public OpenAPI and draft internal command envelope |
| `content` | Constrained draft scenario schema and example |
| `tests` | API, migration, contract and job lifecycle regressions |
| `docs` | Architecture, scope ledger, reference inventory and release evidence |

See [architecture](docs/architecture.md), [remaining work](docs/backlog.md), and [release notes](docs/releases/0.0.1.md). No production VM, host nginx, certificate, firewall, or routing configuration is included.
