# Verification

## v0.0.6

Validated locally on Windows on October 19, 2026.

| Check | Result |
| --- | --- |
| Ruff lint and formatting | Passed (API, catalog, tests and scripts) |
| mypy strict checks | Passed, 24 Python source files; `scripts/api_practice_game.py` also passes `mypy --strict` |
| Python suite | 32 passed against PostgreSQL 17, including nine game tests against a fake engine, the inspection contract test and the two PostgreSQL tests. Tests now ignore the developer's `.env`, which holds a real Google client ID since v0.0.5 |
| Generated contracts | `contracts/openapi.json` and `web/src/generated/api.d.ts` regenerated with the game routes; the WebSocket and SysOp's routes do not appear in them |
| Alembic | `0003_games` applied in Compose. `alembic check` on SQLite and PostgreSQL: no new upgrade operations. The migration tests upgrade, downgrade and upgrade again on both |
| Engine image build | XMage and card-database layers cached. JUnit: 69 passed, including the five new `ServiceGameHttpTest` tests |
| Compose | Restarted without the port override: PostgreSQL published on 127.0.0.1:15432 (`CD_DB_PORT` in `.env`; Windows still reserves 5364–5463), all services healthy. The engine logs "service games enabled" and `/api/v1/engine/status` reports `service_games_enabled: true` |
| Legacy game through the API | `scripts/api_practice_game.py` as a throwaway SysOp, through an API container on a separate `commander_e2e` database and the Compose engine. The bot won in 13 turns, and the API recorded `finished` and `completed`. 109 prompts answered in 21 s. 321 snapshots checked and validated against the seat-view contract. 259 inspection views validated against their contract, each with hand and library sizes equal to the public counts. `game.inspection_opened` audited. The observer refusal, the lease takeover and a resend after a dropped connection were all verified. No problems |
| Commander game through the API | The same, against three bots with `--turn-cap 20`. The game reached the turn limit at turn 20, and the API recorded it. 143 prompts answered in 43 s, with two `choose_defender` prompts. 466 snapshots and 287 inspections validated, and the same three proofs. No problems |
| Development route | `docker compose exec -T api python - --quiet --skill 1 < scripts/engine_human_game.py`. The bot won in 11 turns: 100 prompts, 390 payloads (162 of them the spectator's), both refusals verified, no problems |
| WebSocket through the web proxy | A handshake to `ws://localhost:8080/api/v1/games/…/events` from the site's origin reached the API and was refused for having no session (4401 `authentication_required`); one from another origin got 4403 `origin_refused` |
| Vitest and production build | 2 Vitest tests and the production build passed in a `mcr.microsoft.com/playwright:v1.64.1-noble` container on a copy of the repository |
| Browser journeys | 6 passed in that container. A throwaway API on `commander_e2e` was configured as Playwright's own would be, with a throwaway SysOp. The shell journey now also checks that the sidebar mark, the Play page's logo and the favicon load. Screenshots at 1920, 1366 and 390 px were checked by eye after two layout fixes to the logo's caption |

The game tests (`tests/test_games.py`) run against a fake engine that speaks the service routes, with its seat tokens, revisions, prompts and action-ID memory:
- **Ownership (T29's match case).** Another account gets 404 for the game, its close and its WebSocket (close code 4404), and 403 for its inspection. Neither the seat token nor the service token appears in any response or WebSocket message.
- **The lease (AUTH07).**
  - The first tab takes control, and a second observes.
  - The observer's command is refused with `not_controller`.
  - The controller's command is applied, and both tabs see the new revision.
  - The second tab takes control; the first gets `taken_over`, and its command is refused.
- **Resends (T14).**
  - Resending an applied command returns the identical result and applies nothing.
  - A command sent by a tab that closed without reading the reply was applied once. Its resend from a new tab returned 200 and applied nothing more.
- **Refusals.** Another origin, no session, a wrong CSRF token, a missing hello, inspection by a player, and an unknown game. Signing out everywhere ends an open connection at its next command, without applying the command.
- **Results and restarts.** A concession is recorded as `completed` with the winner and the conceded seat. A close is recorded as `closed`. A second API process on the same database marks the running game `interrupted` and closes it in the engine.
- **SysOp.**
  - A player's deck list is refused, and so is the card lookup.
  - SysOp's deck list with unknown names returns their names. A Commander deck list with set annotations reaches the engine as cards and commanders, with a bot's deck list too.
  - SysOp has no per-account limit.
  - SysOp lists, observes, inspects and closes a player's game, sees every deck, and cannot take that seat's lease.
  - `game.deck_lists_used`, `game.observed`, `game.inspection_opened` and `game.closed` are audited.
- **Limits and parsing.**
  - The API-wide limit returns 429 with `Retry-After`, and games are off without a service token. A short service token is refused at startup.
  - The fixture decks match `engine/decks`.
  - The deck-list parser merges counts, ignores comments, set annotations and sideboards, and refuses empty lists, counts over 250, too many cards, a commander in Legacy, a Commander list without one, and two copies of a commander.

The engine tests (`ServiceGameHttpTest`, real XMage games):
- **The service token.** It guards every service route: without it, or with a wrong one, 401. A token under 32 characters is refused, and development games are off when only service games are configured.
- **Separate routes.** A development game's token and ID find nothing on the service routes and the reverse. A seat token alone does not reach a service game.
- **Deck lists.** 25 Lightning Bolts, 40 Mountains and 5 Counterspells, named in lower case, with Krenko, Mob Boss as commander: the game has 70 cards in hand and library and Krenko in the command zone. Unknown names come back together; a deck and a deck list on one seat, an empty list, a zero count, a commander in Legacy and a Commander list without one are refused.
- **Inspection against XMage.** At each of six prompts, every player's hand and library match XMage's own: card by card, in order, and each opaque id resolving to that very card. Every seat's deck is shown, and versions increase. After a close, the final inspection carries the result.
- **Card lookup.** `lightning bo` finds Lightning Bolt first. Bad queries are refused.

### Hosted CI

GitHub Actions ("Framework checks") run #20 (`c686a21`) passed in 9 m 48 s. The XMage layers came from the cache; the engine module was rebuilt and tested.
- **Verify, 2 m 35 s.** Python checks against PostgreSQL, including the game tests. Contracts without drift, Vitest, the production build, the six browser journeys and the container builds.
- **Engine, 9 m 43 s.**
  - **Image build, 4 m 55 s.** 69 JUnit tests passed.
  - **Development smoke, 1 m 26 s.** A bot match; Legacy in 11 turns with 358 payloads; four-seat Commander in 24 turns with 352 prompts and 1,599 payloads.
  - **Practice games through the API, 2 m 55 s.** SysOp played a Legacy game, which the bot won in 9 turns: 59 prompts, 193 snapshots and 128 inspections. Then a Commander game against two bots, to the 24-turn limit: 218 prompts, 625 snapshots and 484 inspections. Both results were recorded and both inspections audited. The observer refusal, the lease takeover and the resend were verified, with no problems. This is the first run of that step on GitHub's runners: host networking reached the API from the Compose gateway, SysOp's network, as on this computer.

## v0.0.5

Validated locally on Windows on October 18–19, 2026 (UTC).

| Check | Result |
| --- | --- |
| Ruff lint and formatting | Passed (API, catalog, tests and scripts) |
| mypy strict checks | Passed, 21 Python source files |
| Python suite | 22 passed against PostgreSQL 17, including nine identity tests and two PostgreSQL tests: parallel job claims, and migrations with the append-only audit trail |
| Generated contracts | `contracts/openapi.json` and `web/src/generated/api.d.ts` regenerated; regenerating again changes nothing. SysOp's routes are absent from both |
| Alembic | `upgrade head`, `downgrade base` and `upgrade head` again on SQLite and PostgreSQL; `alembic check` on both: no new upgrade operations |
| Vitest and production build | 2 Vitest tests and the production build passed in a `mcr.microsoft.com/playwright:v1.64.1-noble` container on a copy of the repository |
| Browser journeys | 6 passed (3 new). The API ran in a `python:3.12.10-slim` container against a separate `commander_e2e` database, with a test SysOp from the console command. Playwright and Vite ran in its network namespace, so the API saw loopback addresses as in CI |
| Compose | API, migrate, worker and web images rebuilt; all services healthy. Migration `0002_identity` applied to the development database |
| SysOp network in Compose | Through the web proxy from this computer: 204. Straight to the API from this computer: 204. With a forged `X-Forwarded-For: 8.8.8.8` from this computer: 204, because the API takes the gateway hop the proxy appended, not the forged one. From the engine container through the web proxy: 404. From the engine container straight to the API, claiming the gateway in `X-Forwarded-For`: 404 |
| Security headers | `index.html` now carries the CSP, nosniff and Referrer-Policy headers; before this version its location block's own `add_header` dropped them |
| Hosted CI | Run #17 on `9a7c568` passed in 2 m 52 s; details in [the release notes](releases/0.0.5.md#verification) |
| Live sign-in (2026-10-19) | SysOp from the console-set password. Google with the owner's real account and a Web client for `http://localhost:8080`. A handle, a sign-out and sign-in, then SysOp's grant of Administrator with the session rotating on the next request. Every step is in the audit trail. Details in [the release notes](releases/0.0.5.md#verification) |
| Port note | After a Windows restart, WinNAT reserved TCP 5364–5463, which blocked publishing PostgreSQL on 127.0.0.1:5432. The live checks ran with an untracked Compose override that leaves the database port unpublished; the stack itself never uses that port |

The identity tests (`tests/test_identity.py`) sign Google ID tokens with a test RSA key. The verifier's certificate fetch, through the real caching transport, returns that key, so google-auth's own checks run on every token. The tests cover:
- **T01 (server side).** A first sign-in creates one active account with a private session cookie (HttpOnly, Secure, SameSite=Lax, path `/api`). A second sign-in with a changed email finds the same account and ends the old session.
- **T02.** Expired, wrong-audience, wrong-issuer, forged, nonce-less, wrongly-nonced and garbage tokens are refused, as is a valid token without its challenge cookie. A replay of a successful token with its cookie is refused. None created an account or a session. Google certificates were fetched once and then cached. An outage reports 503.
- **Sessions.** Per-session sign-out, sign out, sign out everywhere, the 14-day idle limit and the 30-day absolute limit under daily use.
- **Approval mode.** A pending account can choose a handle and nothing else. SysOp approves it, and the account's next request rotates its session. Denial is allowed only for a pending account.
- **SysOp's entrance.** It answers exactly like a missing path:
  - from outside;
  - for an untrusted peer forging `X-Forwarded-For`;
  - through the proxy for an outside client;
  - for a malformed chain.

  On the network, the entrance exists before SysOp does, but nobody can sign in. After that:
  - Five failures lock an address, even for the right password.
  - SysOp holds every permission and has no email.
  - A SysOp cookie used off the network is signed out.
  - A password change needs the current password and ends other sessions.
  - The console refuses a short password.
- **Roles and T29 (administrative part).**
  - A player is refused every administrative operation and cannot end another account's session.
  - SysOp is never listed and cannot be targeted.
  - SysOp's administrator grant reaches the account on its next request, with a rotated session.
  - An administrator can grant moderator but not administrator, and cannot change its own account.
  - Pagination and search work.
  - Disabling ends sessions and blocks sign-in.
  - Others see SysOp as *Site administrator*, without addresses or its sign-in trail.
  - A role change after 13 hours needs reauthentication.
- **Origins.** State changes from another origin, or marked cross-site, are refused. Both loopback spellings of the site's origin are accepted.

The new browser journeys:
- **Signed out.** Administration offers sign-in and remembers to come back. The Google button, with Google's script replaced, gets a fresh challenge after a refused credential. The API fetched Google's real certificates and refused the token as `invalid_token`, which also showed that Chromium sent the Secure, Strict, path-scoped challenge cookie over `http://127.0.0.1`.
- **Off the network.** `#sysop` renders the Play page with a Play breadcrumb and no mention of SysOp.
- **SysOp.** A wrong password is refused, then SysOp signs in and lands in Administration. Its audit trail shows the sign-in and the failure. The session survives a reload. The Profile page and Administration fit at 390 px without horizontal scrolling. Sign-out removes Administration from the navigation.

## v0.0.4

Validated locally on Windows on October 18–19, 2026 (UTC).

| Check | Result |
| --- | --- |
| Ruff lint and formatting | Passed (API, catalog, tests and scripts) |
| mypy strict checks | Passed, 13 Python source files; `scripts/engine_human_game.py` also passes `mypy --strict` |
| Python suite | 12 passed, including PostgreSQL parallel claims and the contract tests. The seat-view contract now also rejects a fifth seat, a hidden commander's object id, an odd commander tax and leftover Legacy deck fields. For spectators, it rejects a prompt, a `you`, a hand or looked-at cards, and a pile holding an XMage id |
| Generated contracts | `contracts/openapi.json` and `web/src/generated/api.d.ts` regenerated; only the version changed |
| Alembic | `alembic check` against PostgreSQL: no new upgrade operations |
| Engine image build | XMage fetched at the pinned SHA with `Mage.Game.CommanderDuel` added: fetch 12 s, compile 185 s (177 s in v0.0.3), peak 4.5 GB. Card database rebuilt in 22 s (93,992 printings, 32,739 names). Later image builds reused the XMage layers: 1 m 44 s in total for the final one |
| Fixture decks | The four Commander decks, including the seven cards added for the rarer prompts, pass XMage's `mage.deck.Commander` validator (99 cards and one commander each) and share no card name; checked again by JUnit |
| JUnit (during the image build) | 64 passed, up from 45. See below |
| Compose | All services healthy. The engine reports ready with the same card counts |
| Bot match | Seed 1 completed in 19 turns (17 in v0.0.3: XMage's AI is not reproducible from a seed alone, see the spike's determinism section) |
| Scripted Legacy game | The CI command: 11 turns, 100 prompts, 345 payloads (149 of them the spectator's), all validated against the seat-view contract, both refusals verified, no problems |
| Scripted four-seat Commander game | The CI command, two humans and two bots: 24 turns, 350 prompts (one `choose_mode`), 1,620 payloads (465 of them the spectator's), all schema-validated. Refusals verified: stale revision, stale prompt, and another seat's token answering the open prompt. No problems |
| Four-human one-liner | `docker compose exec -T api python - --format commander --seats human,human,human,human --turn-cap 20 --spectator-delay 2 < scripts/engine_human_game.py`: 20 turns and 541 prompts across the four seats, each printed with its seat; 3,263 payloads checked client-side, including 9 delayed spectator views (about one per second of play), no problems |
| Resource check | After those games, a bot match reported 0 game threads, 51 live threads and 64 MB of heap in use |
| Vitest and production build | 2 Vitest tests passed and the production build passed, in a `mcr.microsoft.com/playwright:v1.64.1-noble` container on a copy of the repository (the web code has not changed since) |
| Browser journeys | Not run locally; only the generated API types' version comment changed. CI runs them |

JUnit details:
- **Legacy (`HumanGameTest`).** The six v0.0.3 scripted games pass on the multi-seat API, with stale, forged, repeated and reused answers refused.
- **Commander tables (`CommanderGameTest`).**
  - Nine scripted tables, every one finished, with no leak or state failure: human/bot, bot/human and human/human at two seats; human/bot/bot and bot/human/human at three; human with three bots, two humans with two bots, and two four-human games.
  - 4,160 prompts answered and 16,602 seat views checked against XMage's state, plus every spectator view.
  - Reached by the random games: `choose_defender` 70 times, `choose_ability` 17, `choose_mode` 1 and Commander `yes_no` 10. `choose_choice` (Mother of Runes) came up in an earlier run of the same suite, not this one. No request was unsupported.
  - Commanders were seen in the command zone, on the stack, on the battlefield, in the graveyard and in exile. Commanders reached a tax of {6} and dealt up to 14 commander damage, always equal to XMage's watchers.
  - A spectator with a 1-second delay never saw a view younger than the delay, and saw the result only after it.
- **Rules profile.** At two, three and four seats, the game class, free mulligans, first-draw rule, 40 starting life and seat-order turns all match.
- **All humans out.** The game ends as `humans_eliminated`.
- **Scenario (`CommanderScenarioTest`).** The four-human game finishes in 3 s and reaches all five steps listed in [Commander tables](engine/commander-tables.md#the-scenario-test).
- **Prompt families (`PromptFamiliesTest`).** The four-human game reaches `choose_mode` twice, a custom `choose_amount` twice, `order_triggers` and `choose_pile` (five revealed cards split between the piles), with no leak or state failure for any seat or the spectator.
- **HTTP (`HumanGameHttpTest`).** New tests prove that each seat's token reads and answers only its own seat and sees only its own deck, and that the spectator token reads the public view and nothing else.

Earlier local runs found five problems, all fixed before this record:
- answers sent to a stale player object after an XMage state restore, which stalled and hung games;
- a race caused by XMage treating JUnit's `main` thread as a game thread;
- turns passing in reverse seat order;
- prompts slowed by about 100 ms each at multi-human tables, because other seats' views were built after the prompt had opened;
- a delayed spectator stuck on an old view during continuous play, because merging near-simultaneous views kept refreshing the newest one's time.

They are described in [Commander tables](engine/commander-tables.md#findings).

### Hosted CI

GitHub Actions ("Framework checks") passed on both v0.0.4 work commits:
- **Run #13** (`f01ebf7`, Commander tables and seats). 10 m 33 s on a cold engine cache: adding `Mage.Game.CommanderDuel` changed `engine/xmage/`, so XMage was recompiled. Verify took 2 m 45 s and the engine job 10 m 28 s, including the image build with 61 JUnit tests (9 m 7 s).
- **Run #14** (`89f3065`, prompt families and spectator views). 6 m 0 s with the XMage layers reused. Verify took 2 m 50 s and the engine job 5 m 55 s, including the image build with 64 JUnit tests (4 m 20 s). The Compose smoke ran:
  - a bot match (17 turns);
  - the schema-checked Legacy game (11 turns, 354 payloads);
  - the schema-checked four-seat Commander game (24 turns, 352 prompts, 1,613 payloads, 465 of them the spectator's), with no problems.

The close-out commit's run is listed in [the release notes](releases/0.0.4.md).

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
