# Verification

## v0.0.4

Validated locally on Windows on October 18–19, 2026 (UTC).

| Check | Result |
| --- | --- |
| Ruff lint and formatting | Passed (API, catalog, tests and scripts) |
| mypy strict checks | Passed, 13 Python source files; `scripts/engine_human_game.py` also passes `mypy --strict` |
| Python suite | 11 passed, including PostgreSQL parallel claims and the contract tests. The seat-view contract now also rejects a fifth seat, a hidden commander's object id, an odd commander tax and leftover Legacy deck fields |
| Generated contracts | `contracts/openapi.json` and `web/src/generated/api.d.ts` regenerated; only the version changed |
| Alembic | `alembic check` against PostgreSQL: no new upgrade operations |
| Engine image build | XMage fetched at the pinned SHA with `Mage.Game.CommanderDuel` added: fetch 12 s, compile 185 s (177 s in v0.0.3), peak 4.5 GB. Card database rebuilt in 22 s (93,992 printings, 32,739 names). Later image builds reused the XMage layers: 2 m 15 s in total |
| Fixture decks | The four Commander decks pass XMage's `mage.deck.Commander` validator (99 cards and one commander each) and share no card name; checked again by JUnit |
| JUnit (during the image build) | 61 passed, up from 45, in 118 s. See below |
| Compose | All services healthy. The engine reports ready with the same card counts |
| Bot match | Seed 1 completed in 19 turns (17 in v0.0.3: XMage's AI is not reproducible from a seed alone, see the spike's determinism section) |
| Scripted Legacy game | The CI command: 11 turns, 100 prompts, 211 payloads, all validated against the seat-view contract, both refusals verified, no problems |
| Scripted four-seat Commander game | The CI command, two humans and two bots: 24 turns, 330 prompts, 1,110 payloads, all schema-validated. Refusals verified: stale revision, stale prompt, and another seat's token answering the open prompt. No problems |
| Four-human one-liner | `docker compose exec -T api python - --format commander --seats human,human,human,human --turn-cap 20 < scripts/engine_human_game.py`: 20 turns and 505 prompts across the four seats, each printed with its seat; 2,910 payloads checked client-side, no problems |
| Resource check | After those games, a bot match reported 0 game threads, 49 live threads and 62 MB of heap in use |
| Vitest and production build | 2 Vitest tests passed and the production build passed, in a `mcr.microsoft.com/playwright:v1.64.1-noble` container on a copy of the repository |
| Browser journeys | Not run locally; only the generated API types' version comment changed. CI runs them |

JUnit details:
- **Legacy (`HumanGameTest`).** The six v0.0.3 scripted games pass on the multi-seat API, with stale, forged, repeated and reused answers refused.
- **Commander tables (`CommanderGameTest`).**
  - Nine scripted tables, every one finished, with no leak or state failure: human/bot, bot/human and human/human at two seats; human/bot/bot and bot/human/human at three; human with three bots, two humans with two bots, and two four-human games.
  - 6,113 prompts answered and 24,288 views checked, every human seat's against XMage's state.
  - Every prompt kind was reached: `choose_defender` 84 times, `choose_ability` 18, `choose_choice` 2 and Commander `yes_no` 8. No request was unsupported.
  - Commanders were seen in the command zone, on the stack, on the battlefield, in the graveyard and in exile. Commanders reached a tax of {4} and dealt up to 14 commander damage, always equal to XMage's watchers.
- **Rules profile.** At two, three and four seats, the game class, free mulligans, first-draw rule, 40 starting life and seat-order turns all match.
- **All humans out.** The game ends as `humans_eliminated`.
- **Scenario (`CommanderScenarioTest`).** The four-human game finishes in 3 s and reaches all five steps listed in [Commander tables](engine/commander-tables.md#the-scenario-test).
- **HTTP (`HumanGameHttpTest`).** A new test proves that each seat's token reads and answers only its own seat and sees only its own deck.

Earlier local runs found four problems, all fixed before this record:
- answers sent to a stale player object after an XMage state restore, which stalled and hung games;
- a race caused by XMage treating JUnit's `main` thread as a game thread;
- turns passing in reverse seat order;
- prompts slowed by about 100 ms each at multi-human tables, because other seats' views were built after the prompt had opened.

They are described in [Commander tables](engine/commander-tables.md#findings).

## v0.0.3

Validated locally on Windows on October 18, 2026.

| Check | Result |
| --- | --- |
| Ruff lint and formatting | Passed (API, catalog, tests and scripts) |
| mypy strict checks | Passed, 13 Python source files; `scripts/engine_human_game.py` also passes `mypy --strict` |
| Python suite | 11 passed, including PostgreSQL parallel claims and the two contract tests: the command envelope, and a seat-view contract that rejects an opponent's hand, library contents, the seed, XMage UUIDs and named hidden cards |
| Generated contracts | `contracts/openapi.json` and `web/src/generated/api.d.ts` regenerated; only the version changed |
| Alembic | `alembic check` against PostgreSQL: no new upgrade operations |
| Engine image build | XMage fetched at the pinned SHA with `Mage.Player.Human` added; compile 177 s, peak 4.6 GB; card database rebuilt (93,992 printings) |
| JUnit (during the image build) | 45 passed. `HumanGameTest`: 6 complete scripted games (3 per deck, AI skill 1) and about 1,400 published views checked against XMage's state with no leak; every fixture prompt family seen and none unsupported; stale, forged, repeated and reused answers refused. Concede, close, idle timeout and the game cap; HTTP tokens, 404s and envelope refusals; parsers |
| Compose | All services healthy; engine log reports human games enabled (at most 2) |
| Human-seat games | `docker compose exec -T api python - < scripts/engine_human_game.py`: 13 turns, 106 prompts, 300 payloads checked, refusals verified. Six more games at skill 4 (3 per deck) with every payload validated against the seat-view contract: no problems. The same seed replayed the same game twice |
| Resource check | After the human games, a bot match reported 0 game threads, 44 live threads (one more than v0.0.2: the game watchdog) and 57 MB heap after GC with 7 finished games retained |
| Vitest, build, browser journeys | Not run locally this version; only the generated API types' version comment changed. CI runs them |

The CI smoke command was first run locally: a `python:3.12.10-slim` container sharing the engine's network namespace, installing pinned `jsonschema` with its dependencies.

### Hosted CI

GitHub Actions ("Framework checks") run #10 (`3e19b71`) passed:
- **Duration and cache.** 9 m 16 s on a cold engine cache: adding `Mage.Player.Human` changed `engine/xmage/`, so XMage was recompiled.
- **Jobs.** Verify took 2 m 13 s: Python, contracts, Vitest, the production build and the browser journeys. The engine job took 9 m 12 s: the image build with all 45 JUnit tests took 8 m 26 s, and the Compose smoke 32 s.
- **Bot match.** Completed, 17 turns, 14.3 s.
- **Human-seat game.** Completed, 13 turns, 106 prompts and 240 payloads, every one validated against the seat-view contract, with both refusals verified and no problems. It was the same game as the local run with the same seed.

The close-out commit's run is listed in [the release notes](releases/0.0.3.md).

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
