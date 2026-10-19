# Verification

## v0.0.2

Validated locally on Windows on October 18, 2026. CI evidence is in [the release notes](releases/0.0.2.md).

| Check | Result |
| --- | --- |
| Ruff lint and formatting | Passed |
| mypy strict checks | Passed, 13 Python source files |
| Python suite | 9 passed, 1 skipped (PostgreSQL test without `CD_TEST_POSTGRES_URL`), including the new engine-status pass-through and rejection tests |
| Generated contracts | `contracts/openapi.json` and `web/src/generated/api.d.ts` regenerated and drift-free |
| Engine image build | XMage fetched at the pinned SHA and compiled with JDK 21 (`--release 21`); card database built; engine compiled with `-Xlint:all -Werror` |
| JUnit (during the image build) | 29 passed: boundary, input limits, concurrency, Legacy deck validation, real seeded game, turn cap, timeout cleanup |
| Compose | All services healthy; engine `/ready` healthcheck passes; no engine port on the host; web proxy returns 404/405 for engine paths |
| API pass-through | `/api/v1/engine/status` returns the engine's ready status with the commit and card counts; bootstrap and `/formats` remain unavailable |
| Bot matches | One-line command from the API container completes; stability check 10/10 with flat heap and threads (see the spike findings) |
| Vitest, build, browser journeys | 2 Vitest tests passed; production build passed; 3 Playwright journeys passed against Vite + API and 3 against the Compose web container |
| Dependency scan | Trivy 0.75.0 on the engine image; findings and mitigations recorded in the spike findings |

The host still has no Node, pnpm or JDK on PATH:

- **Java:** all Java work runs in the engine image build.
- **Web suites:** these ran in a `mcr.microsoft.com/playwright:v1.64.1-noble` container (`CI=1`) on a copy of the repository, attached to the Compose network so the second browser pass could use `http://web:8080`. The container installed `python3-venv` and the locked Python requirements so Playwright could start the API itself.
- **Engine measurements:** these used `scripts/engine_bot_matches.py`, from the host against a temporary container with a loopback-only port, and from the API container against Compose.

### Hosted CI

GitHub Actions ("Framework checks") passed on every v0.0.2 change before close-out:

- **Run #6** (`c056c16`, checkpoint): cold engine cache, 8 m 55 s. All 29 JUnit tests ran in the engine image build, and the Compose smoke match completed (seed 1, 17 turns).
- **Run #7** (`e6cd688`, findings and H2 loopback binding): warm engine cache, 2 m 18 s.

Timings per job are in [the release notes](releases/0.0.2.md).

## v0.0.1

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

### Hosted CI

GitHub Actions ("Framework checks") passed on every v0.0.1 change before close-out: run #1 (`63725d3`, initial framework), run #2 (`07ba133`, hardening) and run #3 (`58afb22`, action/runner update). Run #3 reported no annotations.

### Local environment notes

The Windows host has Python 3.12 and Docker Desktop, but no Node, pnpm or JDK on PATH. The hardening changes were verified with the local Python environment plus containers: the Compose build (including the Java compile and engine smoke test), a running Compose stack (`/ready` 200, version reported from `VERSION`), and a `mcr.microsoft.com/playwright:v1.64.1-noble` container with `CI=1` running contracts, Vitest, the production build and all three browser journeys on a copy of the repository.

The test library emits one non-failing deprecation warning about its httpx transport. Initial Windows temp-folder permissions and localhost resolution issues were avoided with a workspace-local pytest directory and explicit 127.0.0.1 PostgreSQL address. Run the PostgreSQL integration test with `CD_TEST_POSTGRES_URL=postgresql+psycopg://commander:commander@127.0.0.1:5432/commander`; it creates and removes a uniquely named test schema.
