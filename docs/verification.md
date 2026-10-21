# Verification

## v0.3.0

Validated locally on Windows on October 20, 2026, on the work as committed for v0.3.0 (86cdedf, and the screen check's fix after it). Python ran on 3.12.10 in the API image, as in CI, on a copy of the repository; the web toolchain ran in the `mcr.microsoft.com/playwright:v1.64.1-noble` container on a copy, with WebGL2 on SwiftShader as in CI.

| Check | Result |
| --- | --- |
| Ruff lint and formatting | Passed (API, catalog, tests and scripts; 63 files) |
| mypy strict checks | Passed, 43 Python source files |
| Python suite | 140 passed against a throwaway PostgreSQL 17.5; 6 skipped that read a git clone (CI runs them). New: the card image API's `png` size (a PNG checked as a PNG, kept under its own name, up to 8 MB, and a printing without one served at the next size down without being recorded as missing) and the unknown sizes refused |
| Generated contracts | `contracts/openapi.json` and `web/src/generated/api.d.ts` regenerated with `size=png` and both image media types; no drift |
| Vitest, TypeScript and the production build | 705 tests in 55 files: the table's model, layout and hit-box invariants at two to four seats, events between views, the scene's host, the DOM layer and its names, the pointer, drag and drop, the magnifier, the response timer and its keys, sound cues, the prompt column's diamonds and Stop Timer, the drawers and Escape's layers, settings, full screen, the install banner, the service worker's rules and the live-game lock; `tsc -b` (journeys included) and the Vite build passed |
| The fake table (`web/e2e/table.spec.ts`) | 19 passed on Vite's dev server with no engine or API: the table at 1280 × 720 (1× and 1.5×), 1366 × 768, 1920 × 1080 (1× and 2×), 2560 × 1440 and 3840 × 2160, the three- and four-seat, 240-permanent, long-stack and 25-card-hand fixtures, and the plain table at two sizes. At each: `data-scale`, no scrolling, the canvas at the screen's device pixels, and the element at the centre of every enabled card and option is itself. Also P and a card's option answering the prompt and revision on screen, the timer passing once and Space stopping it, Escape closing the Game menu and then the log drawer, the magnifier never taking a click, and a lost WebGL context drawing the plain table until it came back |
| Game and app journeys | 10 passed against a throwaway stack: the local engine image, the API and web images built from the working tree behind nginx and its CSP, a scratch database with the test catalog and a generated SysOp. A Legacy game by mouse completed in 9 turns (74 prompts; 222 snapshots in 298 frames), with the table checked mid-game at 1920 × 1080, 1280 × 720, 1366 × 768, 2560 × 1440 and 3840 × 2160; a Legacy game by keyboard with reduced motion to its 8-turn limit (57 prompts); a four-player Commander table at 2560 × 1440 (three opponents' articles) to its 4-turn limit, then checked at three sizes; a second tab and a resend; a deck of the player's own with the priority drawer, full control and a pass until the next turn (`until_my_turn` reported); the response timer passing once at a real response moment (the bot's spell on the stack) for that prompt and revision, and Space stopping it at the next with nothing sent; and a game that started in full screen with Escape locked, kept it through Escape closing the Game menu, left and returned with F, and left it with the Game menu's Table. Every frame, every text and name on the table (except the log) and every card image asked for was checked for concealed cards, with no CSP violation, page error or console error. The app: the manifest, icons and screenshots, `/sw.js` with `no-cache`, a 404 for a missing brand file, the worker controlling the page without answering `/api/`, and the install banner with injected Chrome client hints and a synthetic install offer (Not now, hidden after a reload, shown again after 30 days) |

**Seen while checking, then fixed:**
- **The canvas drew at the old window's pixels after a resize.** The viewport's device-pixel width came from a ResizeObserver report that could still describe the window before the resize, so the 2560 × 1440 table drew 1366 pixels wide until the next report. The width is now used only while it matches the window, and only when it agrees with the pixel ratio (under an emulated scale Chromium reports CSS pixels there).
- **A card could show blank for a moment** as its image arrived: the text frame hid at once while the image faded in. The frame now stays until the fade ends.
- **The magnifier drew under the plain table's cards** (z-index 60 against the cards' 1–999); it now sits above the cards, the column and the drawers, below option menus.
- **The journeys:** the four-player table was size-checked with the result dialog open over it (it is closed first now), a locator for the Priority region also matched the prompt section headed "Priority", and a failed journey left its game running, which filled the engine's tables for the next ones (a failed journey's game is now closed). In CI run #52 the new screen check reported "Cancel" (a blue bot's card, and also the prompt's Cancel button); as the frames' check already does, the words of an option that names no object are no longer read as card names.

**Not covered by the journeys, and not yet checked by hand** (design §24.5's manual list, for the live site after the deploy): Google sign-in in the installed window; install from the banner and from the browser's menu, and the desktop icon; relaunching the app during a live game; an update during a live game in the installed app (T25: the browser cannot be given a new worker version reliably mid-test; the unit tests cover the waiting and applying); holding Escape to leave full screen; Windows display scaling at 125, 150 and 200%; a real GPU at 4K; sound; NVDA through one turn; forced colours.

**Hosted CI.** Recorded in [the release notes](releases/0.3.0.md#verification).

## v0.2.0

Validated locally on Windows on October 20, 2026, on the work as committed for v0.2.0. Python ran on 3.12.10 in the API image, as in CI, on a copy of the repository; the web toolchain ran in the `mcr.microsoft.com/playwright:v1.64.1-noble` container on a copy.

| Check | Result |
| --- | --- |
| Ruff lint and formatting | Passed (API, catalog, tests and scripts; 63 files) |
| mypy strict checks | Passed, 43 Python source files |
| Python suite | 137 passed against a throwaway PostgreSQL 17. New: `tests/test_catalog.py` (every status with its reason, the engine unavailable, failed gates and differing characteristics, unchanged imports, new cards, reprints, Oracle changes, bans and removed printings, dropped cards kept, malformed and shrunken files, fencing, reader bounds, text normalization), `tests/test_catalog_sync.py` (unchanged days, broken downloads and rate limits with backoff, fencing, overlap, the schedule, and the first import waiting for the engine), `tests/test_validation.py` (Legacy and Commander rules, T03–T05, pairs, companions), `tests/test_decks_api.py` (card search and details, the deck lifecycle, conflicts and revisions, T29: other accounts' 404s and sharing without notes, imports that round-trip, Commander imports and starters, guided decks of exact size, images and the practice table) and new PostgreSQL cases (the revision trigger, search on PostgreSQL) |
| Alembic | `0005_catalog` and `0006_decks`: upgrade, `alembic check`, downgrade to base, upgrade and check again on PostgreSQL, clean |
| Generated contracts | `contracts/openapi.json` (Python 3.12) and `web/src/generated/api.d.ts` regenerated, with the card, catalog and deck routes and version 0.2.0; no drift |
| Vitest, TypeScript and the production build | 97 tests in 14 files (new: deck statistics and odds, the deck editor's autosave and conflict choices, the decks page, the priority panel and its Escape, the connection's `set_priority`, the Admin catalog tab, the session buttons); `tsc -b` and the Vite build passed |
| Engine image build | JUnit: 88 passed, including `PriorityControlsTest` (held priority with a nested stack, a cancelled payment, pass modes, full control on and off, command validation) and the implementation route |
| The real catalog | The worker's first sync on the development stack: 2 minutes 3 seconds, downloads included (111 MB of gzip files), revision 1, a 489 MB database. The engine build `1.4.62-eb69d05b-7909ff1a7bd0` lists 32,486 cards, all passing the gates; 32,089 card concepts are playable. Warm searches took 39–71 ms (median per query), at most 120 ms |
| Decks against the real engine | Through the API on the real catalog: a Legacy deck with Fire // Ice, Delver of Secrets and Bonecrusher Giant started a game whose seat was dealt its cards; a guided Kenrith tokens deck (100 cards, playable) started a Commander game. After the guided fix: Kenrith tokens and Thrasios with Tymna 100 cards each, Legacy red aggro and white-blue control 60 each, all legal and playable |
| Browser journeys | 15 passed. Against a throwaway API on a scratch database with the test catalog (`scripts/load_fixture_catalog.py`): shell 4, identity 3, and decks 3 (a list imported with a copy-limit error, fixed, edited, saved as a version, shared and opened by link without its notes, taken to the practice table and archived; a Commander deck taken to the table in its own format; the Cards page's syntax, a card's details and the Admin catalog tab). Against the real engine and the real catalog: games 5, with every WebSocket frame leak-checked. A Legacy game by mouse completed in 9 turns (90 prompts; 205 snapshots in 297 frames); a Legacy game by keyboard to its 8-turn limit (62 prompts); a four-player Commander table to its 4-turn limit; a second tab and a resend; and a deck of the player's own with full control on and off and a pass until the next turn, which the views reported (`until_my_turn`), completed in 7 turns |

**Hosted CI.** Recorded in [the release notes](releases/0.2.0.md#verification): run #37 failed on a stale contract, runs #38 and #39 passed; #39 ran 137 pytest, 97 Vitest tests, 10 browser journeys in verify and 5 game journeys in the engine job, the own-deck game with the priority controls among them.

**Seen while checking, then fixed:**
- **"Play it" across formats** cleared the chosen deck: the practice table's format reset ran after the deck was chosen. The new Commander journey covers it.
- **The deck editor** could show an older reply to "Share by link" over a newer one, because notes save on blur in the same click. Only the newest reply shows now.
- **The engine image** on the development stack predated the priority work, so the first run of the own-deck journey found no pass modes. The journey now fails clearly when no prompt offers them; it passed on the rebuilt image.
- **The identity journey** failed when run alongside the deck journeys: the extra SysOp sessions gave the Profile page two "Sign out" buttons. The other sessions' buttons now say "End the session", named by their browser.
- **Guided Commander decks with a pair** had 101 cards, and the test catalog's small pool left proposals short; the lands now fill what the spells leave.
- **The first sync** would have imported without the engine's list when the engine was still loading; it now waits for it (`tests/test_catalog_sync.py`).

**The throwaway stacks.** The Python suite ran against its own PostgreSQL container. The deck journeys used a scratch database with the test catalog and an API built from the working tree; the game journeys used a scratch database with the real catalog, the development engine, and an API from the working tree. Each had a generated test SysOp, and Playwright shared the API's network, so the browser came from loopback, as in CI. The developer's database and SysOp were not used.

## v0.1.1

Validated locally on Windows on October 20, 2026. A bug and security sweep found the defects: 18 reviewers, one per area and lens, and then gap finders. Each finding had to survive one to three independent verifiers, depending on its severity. Of 58 findings, 54 were confirmed and 4 refuted. The fixes were made in eight groups that never touched the same files, then reviewed by group and as a whole. Python ran on 3.12.10 in the API image, as in CI; the web toolchain ran in the `mcr.microsoft.com/playwright:v1.64.1-noble` container on a copy of the repository.

| Check | Result |
| --- | --- |
| Ruff lint and formatting | Passed (API, catalog, tests and scripts; 40 files) |
| mypy strict checks | Passed, 26 Python source files |
| Python suite | 86 passed against a throwaway PostgreSQL 17 (final run); the sweep's fixes passed 85 in three full runs, and the session, game and card-image files five more, with no flakes. New: `tests/test_sessions.py` (7: a bug's 500 keeps the rotated cookie, the pool under a burst, the rotated cookie on errors and returned responses, the 60-second grace and its end) and `tests/test_deploy_kit.py` (14: deploy, restore, backup pools, the web container's resolver and rate limit) |
| Alembic | `alembic upgrade head` and `alembic check` on PostgreSQL; downgrade to base and upgrade again, clean. No new migration |
| Generated contracts | `contracts/openapi.json` (Python 3.12) and `web/src/generated/api.d.ts` regenerated: version 0.1.1, `gameplay_available` a boolean, two route descriptions; no drift |
| Vitest, TypeScript, Prettier and the production build | 71 tests in 10 files, in three runs; `tsc -b` and the Vite build passed; Prettier clean on 35 files |
| Engine image build | JUnit: 84 passed (Maven about 2 minutes), including the new `SpecialPaymentTest`, `UnpayableCostTest` (Chain Lightning's {R}{R} copy offered to a player with only Forests: every payment offers only cancel, with the reason) and a two-humans-and-a-bot table, and the stricter leak checks that fail on any error XMage recovered from. Run twice more for the close change, with no "Non-game thread" line in the log |
| Deploy kit | ShellCheck clean on `deploy/*.sh` (also a CI step now); `nginx -t` passed on `web/nginx.conf` and the TSH site file; a scripted burst got 429 after the challenge limit, from one address only |
| CI run #24's payment loop | Replayed with run #24's test player at the keyboard journey's table (human green, bot red, skill 1, 8 turns) on v0.1.0's prompt: 45 of 408 games looped on Chain Lightning's {R}{R} copy, paying with green pool mana. With v0.1.1's prompt, 1,000 games had no payment loop, and in about 123,000 priority prompts the engine never listed a spell the seat could not pay for. Eight games started at once on a fresh engine, five times: 40 of 40 clean after the token-list fix (before it, two at once lost a game in 2 of 6 fresh starts) |
| Browser journeys | 11 passed on their first run, twice: after the sweep's fixes, and again with the final engine. The final run's keyboard game met Chain Lightning's copy cost: the payment offered only cancel, said "Nothing you control can pay {R}{R}.", and the game played on to its limit. Against a throwaway stack built from the working tree: shell and identity 7; games 4 against the real engine at bot skill 1, every WebSocket frame leak-checked. These local runs used the strict "public in the same view" rule and passed it; hosted CI run #30 then failed it once (a log line named a bot's Centaur Courser one view early), so the spec keeps the later-view rule. A Legacy game by mouse won in 11 turns (94 prompts; 280 snapshots in 376 frames); a Legacy game by keyboard to its 8-turn limit (61 prompts); a four-player Commander table to its 4-turn limit; a second tab took control and got the lost reply's first result on the resend. No 5xx responses or tracebacks in the services' logs |
| Practice games through the API | `scripts/api_practice_game.py` as in CI, through the web container: Legacy completed in 11 turns (56 prompts, 306 payloads, 136 inspections); Commander with two bots to its 24-turn limit (210 prompts, 26 payments, 606 payloads, 458 inspections). Observer refusal, lease takeover and the resend verified; no problems, and no errors in the engine's or the API's logs |
| Restore rehearsal | On the VM, `restore.sh` restored the first nightly dump into a scratch Compose project in 13 seconds; every table matched the live database except rows added since the dump |
| Tapped permanents | Screenshots at 1920 x 1080, 1366 x 768 and 390 x 844, with up to 9 tapped permanents and attacking creatures. A script measured every tapped card's turned face against its slot, its neighbours and the strips: no overlaps at any size. A tapped slot is 131, 88 and 70 px wide |

**Hosted CI and the live site.** Recorded in [the release notes](releases/0.1.1.md#verification): run #30 failed (script modes in git; the strict leak check), runs #31 and #32 passed. The owner deployed `0.1.1` on 2026-10-20 with `./update.sh`, and the live checks passed.

**The throwaway stacks.** The Python suite ran against its own PostgreSQL container. The browser journeys used their own network, database, engine, API and web containers, built from the working tree, with a generated service token and test SysOp. Playwright shared the web container's network, so the browser came from loopback. The developer's Compose stack, database and SysOp were not used.

**Seen while checking, then fixed:** when every human seat went out, the engine's close sent concessions that XMage refused, and XMage logged "Non-game thread can't concede or end games": with one bot left it raced XMage's own end, and with two it could land between steps or after the first bot's concession ended the game. The engine now closes such a game only while two or more players remain, concedes only while a player holds priority or a choice, and stops once the game is over. The engine suite then ran with no such line in its log (82 tests, including a new two-humans-and-a-bot table). v0.1.0 behaved the same.

## v0.1.0

Validated locally on Windows on October 19, 2026. The host has no Node, so the web toolchain ran in the `mcr.microsoft.com/playwright:v1.64.1-noble` container on a copy of the repository.

| Check | Result |
| --- | --- |
| Ruff lint and formatting | Passed (API, catalog, tests and scripts) |
| mypy strict checks | Passed, 26 Python source files |
| Python suite | 43 passed against PostgreSQL 17. New: 11 card-image tests (against a fake Scryfall and image host: found, faces, missing and its week, failures, the host guard, sizes, sign-in, the 120 ms spacing, one fetch per name, caching headers, a rotated cookie) and the production-settings test |
| Alembic | `0004_card_images` upgrade, downgrade to base and upgrade again, then `alembic check`, on SQLite and PostgreSQL |
| Generated contracts | `contracts/openapi.json` and `web/src/generated/api.d.ts` regenerated with the card-image routes and version 0.1.0 |
| TypeScript, Prettier, Vitest and the production build | Passed |
| Browser journeys, existing | Shell and identity: 6 passed, against a throwaway stack (below) |
| Browser journeys, games | 4 passed against the real engine at bot skill 1, every WebSocket frame leak-checked. Last run: a Legacy game by mouse won in 10 turns (98 prompts: priority, targets, mana payment, attackers and blockers; 276 snapshots in 376 frames); a Legacy game by keyboard alone to its 8-turn limit (67 prompts); a four-player Commander table to its 4-turn limit; and a second tab that watched, took control, lost a reply with its connection and got the first result back on the resend |
| Sizes | Screenshots at 1920 x 1080, 1366 x 768 and 390 x 844 checked by eye; no horizontal scroll at any size. The hand now stays in view at 1366 x 768 |
| Card images | Real Scryfall images for the fixture decks, fetched once by the API and served from its volume |
| Deploy kit | ShellCheck clean (`deploy/*.sh`); the production Compose file renders; actionlint clean on the workflow |

**Hosted CI and the live site.** Recorded in [the release notes](releases/0.1.0.md#verification):
- runs #24 and #25;
- the deployment to `commanderduels` behind the TSH proxy;
- the live checks from the owner's workstation;
- the owner's own SysOp sign-in, game and Google sign-in.

**The throwaway stack.** It had its own database (`commander_e2e` on the Compose server) and a test SysOp whose password was generated for the run. It used the Compose engine and the built API and web images, with the web container on `127.0.0.1:8080`. The Playwright container shared the web container's network, so the browser came from loopback. The developer's database and SysOp were not used.

**Found and fixed while playing:**
- A cached card image could finish loading before the card reset its state, leaving the image hidden behind the frame. Cards now remount when their name changes.
- After a reconnect, the snapshot arrives before the lease. The page dropped its unanswered command as if another tab had moved the game on, so it was never resent. It now drops one only when another tab holds the lease.
- Selects inside their labels took every option's text into their accessible names. They are named explicitly now.
- The leak check matched XMage's button word "Cancel" against the card Cancel. Like the engine's own check, it now reads only object options' labels.

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
