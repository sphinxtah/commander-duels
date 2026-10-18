# v0.0.1 verification

Validated locally on Windows on October 18, 2026.

| Check | Result |
| --- | --- |
| Ruff lint and formatting | Passed |
| mypy strict checks | Passed, 13 Python source files |
| Python suite | 8 passed, including real PostgreSQL parallel claims |
| Vitest | 2 preference storage tests passed |
| TypeScript and Vite production build | Passed |
| Generated OpenAPI drift test | Passed |
| Alembic upgrade/downgrade/upgrade | Passed in isolated SQLite fixture |
| PostgreSQL migration and model comparison | Passed; no new upgrade operations detected |
| Java 21 compile with warnings as errors | Passed during Docker build |
| Java boundary smoke test | Passed during Docker build; unimplemented operations return 503 |
| Docker Compose build and startup | All five services built; migration exited successfully; API/database healthy |
| Browser journeys | 3 passed against both Vite and the final Compose web container: navigation/dialog/preferences, outage/retry, layout/keyboard |
| JavaScript dependency audit | No known vulnerabilities reported |

Visual inspection covered desktop, narrow viewport, and enlarged text screenshots. Layout checks include 1920×1080, 1366×768, 683×384 and 390×844. This is framework layout validation, not the final Chrome/Edge release acceptance matrix or full gamepad/accessibility certification.

The preview's `/api/v1/ready` returns ready for the migrated database. `/api/v1/engine/status` reports scaffold with gameplay unavailable. No game, identity provider, catalog synchronization or offline acceptance case has been claimed.

## Hosted CI

GitHub Actions ("Framework checks") passed on every v0.0.1 change before close-out: run #1 (`63725d3`, initial framework), run #2 (`07ba133`, hardening) and run #3 (`58afb22`, action/runner update). Run #3 reported no annotations.

## Local environment notes

The Windows host has Python 3.12 and Docker Desktop, but no Node, pnpm or JDK on PATH. The hardening changes were verified with the local Python environment plus containers: the Compose build (including the Java compile and engine smoke test), a running Compose stack (`/ready` 200, version reported from `VERSION`), and a `mcr.microsoft.com/playwright:v1.64.1-noble` container with `CI=1` running contracts, Vitest, the production build and all three browser journeys on a copy of the repository.

The test library emits one non-failing deprecation warning about its httpx transport. Initial Windows temp-folder permissions and localhost resolution issues were avoided with a workspace-local pytest directory and explicit 127.0.0.1 PostgreSQL address. Run the PostgreSQL integration test with `CD_TEST_POSTGRES_URL=postgresql+psycopg://commander:commander@127.0.0.1:5432/commander`; it creates and removes a uniquely named test schema.
