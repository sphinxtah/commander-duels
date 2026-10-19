# XMage headless engine spike (v0.0.2)

v0.0.2 is the first slice of milestone M0. The engine image builds XMage from one pinned commit on Java 21, loads its card database, and plays complete Legacy games between two XMage computer players with no UI. This document records what was built and measured, and what v0.0.3 needs: a human seat and per-seat views.

What it proves: the pinned XMage compiles and runs on Java 21, and its rules engine and AI can be driven directly as a library. Games reliably finish, and runaway games can be stopped.

What it does not prove: anything about human seats, prompts, hidden-information safety, multiplayer, recovery, or card coverage beyond the two fixture decks. Gameplay stays unavailable to players.

Measurements were taken on 2026-10-18. "Local" means Docker Desktop 29.8.1 on Windows 11 (24 CPUs, 31 GB given to Docker). "CI" means a GitHub-hosted `ubuntu-24.04` runner.

## Results at a glance

| Item | Result |
| --- | --- |
| Pinned XMage | `xmage_1.4.62V1`, `eb69d05b88142b5c4eec4869bcb23a0fec13c091`, 2026-10-03 |
| Upstream patches | None |
| Java | Compiled by Temurin JDK 21.0.12.1 with `--release 21`; runs on Temurin JRE 21.0.12 |
| XMage compile | 167 s locally, 206 s in CI (plus 12–13 s fetch); peak build memory 4.4 GB locally, 4.0 GB in CI |
| Card database | Built at image-build time: 93,992 printings, 32,739 distinct names, 279 MB H2 file |
| Engine start to ready | 0.78–0.85 s cold, 0.64–0.66 s warm (JVM uptime when the database is open) |
| Runtime image | 994 MB |
| Bot matches | 30/30 random seeds completed (median 14 turns, 0.77 s); stability check 10/10, no growth |
| Determinism | Not reproducible as shipped by XMage; close but not exact with our library-order fix (details below) |

## Pinned commit

| Field | Value |
| --- | --- |
| Repository | https://github.com/magefree/mage (MIT) |
| Tag | `xmage_1.4.62V1` |
| Commit | `eb69d05b88142b5c4eec4869bcb23a0fec13c091` |
| Commit date | 2026-10-03T20:33:40Z ("version bump") |
| Maven version | 1.4.62 |

Why this commit: it is the newest XMage release tag, published as release 1.4.62V1 on 2026-10-03. Upstream's "Build and run tests" workflow passed on it in 5.7 minutes. Releases are what XMage players actually run, and a named release maps cleanly to the engine commit in the RULE02 rules bundle. The alternative was master HEAD, `713a740` from 2026-10-18, which was also green. It had 15 more days of card fixes, but master changes several times a day and gets less field use than a release. The fixture decks use only long-established cards, so those fixes don't matter here.

`engine/xmage/pin.properties` is the single source of truth for the pin. The engine reads it from its classpath to report the pin on `/health`. `XmagePinTest` fails if it disagrees with the compiled XMage version or with `engine/pom.xml`.

### How the source is fetched

`engine/xmage/build-xmage.sh` runs only inside the image build. It runs `git init` and adds the remote. It sets up a sparse checkout of the nine directories it needs (`Mage`, `Mage.Common`, `Mage.Sets`, `repository`, and five plugin modules). Then it runs `git fetch --depth 1 --filter=blob:none origin <sha>`: a shallow, partial fetch of that one commit, never a clone of the history.

It checks that `HEAD` equals the pinned SHA and that the root POM version equals the pinned version. After the build it deletes the source tree from the layer. It keeps XMage's `LICENSE.txt` and a short notice, both shipped in `/app/licenses`. XMage source, the Maven repository and build output never touch the repository folder or OneDrive.

### Patches

None are needed. `engine/xmage/patches/` holds `NNNN-*.patch` files that `git apply` applies in name order. A patch that no longer applies fails the build. Every v0.0.2 workaround lives in our own code; see "Driving XMage headless".

## Modules built

XMage isn't on Maven Central. Its root POM lists every module, so building a subset through the reactor would need all the module POMs. Instead, the script installs the two parent POMs non-recursively (`mvn -N install`) and builds each needed module with `mvn -f <module>/pom.xml install`, into a Maven repository inside the image layer (`/xmage/m2`).

| Module (directory) | Artifact | Why |
| --- | --- | --- |
| `Mage` | `mage` | Rules framework, game objects, card database code |
| `Mage.Common` | `mage-common` | Required by the AI module; pulls in XMage's old client-server libraries (JBoss Remoting) |
| `Mage.Sets` | `mage-sets` | All card implementations (33,087 source files, a 60 MB jar) |
| `Mage.Server.Plugins` | parent POM | Parent of the plugin modules |
| `Mage.Server.Plugins/Mage.Player.AI` | `mage-player-ai` | Base computer player |
| `Mage.Server.Plugins/Mage.Player.AI.MAD` | `mage-player-ai-mad` | "Computer - mad": `ComputerPlayerControllableProxy`, which extends `ComputerPlayer7`. The directory is `MAD`, not `MA` |
| `Mage.Server.Plugins/Mage.Game.TwoPlayerDuel` | `mage-game-twoplayerduel` | `TwoPlayerDuel` game and `TwoPlayerMatch` |
| `Mage.Server.Plugins/Mage.Game.CommanderFreeForAll` | `mage-game-commanderfreeforall` | Commander free-for-all; built and on the classpath, not used until M3 |
| `Mage.Server.Plugins/Mage.Deck.Constructed` | `mage-deck-constructed` | Constructed validators, including `mage.deck.Legacy` |

These aren't built: `Mage.Server` (users, sessions, tables), `Mage.Client` (Swing), `Mage.Tests`, `Mage.Verify`, `Mage.Reports` and the other game, tournament and player plugins.

## Build cost

| Step | Local | CI cold cache |
| --- | --- | --- |
| Fetch the pinned commit | 12 s | 13 s |
| Compile and install XMage | 167 s (Mage 35 s, Mage.Common 11 s, Mage.Sets 83 s) | 206 s (36 s, 12 s, 114 s) |
| Peak memory of the XMage step (cgroup) | 4.42 GB with `-Xmx3g` (5.15 GB with `-Xmx4g`, same time) | 4.04 GB |
| Build the card database | 21 s, 1.63 GB peak | 30 s, 1.84 GB peak |
| Engine module and the 29 JUnit tests | 14 s (stage 36 s) | 35 s |
| Whole engine image | 216 s from scratch | 8 m 7 s cold (including the cache export), 26 s warm |

The Maven heap is set explicitly: `MAVEN_OPTS=-Xmx3g -XX:+UseParallelGC` (override with `XMAGE_MAVEN_OPTS`). A 4 GB heap made no difference to the time. **Give Docker Desktop at least 6 GB of memory** for the first build. This machine gives it 31 GB, so nothing needed changing.

Caching:

- The `xmage` and `carddb` stages depend only on `engine/xmage/` (the pin, the build script, the patches and the database builder). Changing engine code doesn't recompile XMage. Locally the BuildKit layer cache covers this.
- In CI the same layers come from the GitHub Actions cache (`type=gha`, `mode=max`). BuildKit cache mounts aren't exported to that cache, so the XMage Maven repository lives in a normal layer. The engine stage uses a cache mount only for its own downloads (JUnit and plugins), with `maven.repo.local.tail=/xmage/m2`, so XMage stays read-only.
- The XMage build doesn't run upstream tests (`-Dmaven.test.skip=true`); upstream CI covers them at this commit.

CI timing: on a cold cache (run #6) the whole workflow took 8 m 55 s. The engine job took 8 m 52 s, of which the image build was 8 m 7 s, including the cache export, and the Compose smoke test 17 s. It runs in parallel with the 2 m 38 s verify job. On a warm cache (run #7) the workflow took 2 m 18 s: the engine job took 1 m 3 s, with a 26 s image build and the 18 s smoke test. That's about 12 billed runner minutes cold and 5 warm. See [the release notes](../releases/0.0.2.md).

Image sizes: the runtime image is 994 MB. That's the Ubuntu 26.04 JRE base (Java alone is 159 MB), the card database (279 MB) and the engine libraries (79 MB, 60 MB of it `mage-sets`). The build-stage image is about 1.5 GB and isn't shipped.

## Java 21 findings

- XMage's root POM sets `java.version` and `java.release` to 8, with the comment "game must be able to run under java 8". It uses `maven-compiler-plugin` 3.15.0.
- The build overrides both on the Maven command line (`-Djava.version=21 -Djava.release=21`), so it isn't a patch. Every module above compiles with Temurin JDK 21.0.12.1 with one warning: a deprecated item not annotated `@Deprecated` (`Permanent.java:43`). Compiling with `--release 21` checks the code against the Java 21 API, which a `--release 8` build would not.
- The modules built don't use any API removed or restricted since Java 8: `javax.xml.bind`, `Thread.stop`, the SecurityManager, `sun.misc` and Nashorn were searched for. JAXB is used only by `Mage.Server`'s config loader, which isn't built.
- The engine runs on Temurin JRE 21.0.12 with no `--add-opens` flags. XMage copies game state with Java serialization (`mage.util.Copier`), which works unchanged.
- More than 100 matches across this work raised no Java-version error. Our code compiles with `-Xlint:all -Werror` against the XMage jars.

No incompatibilities needed resolving.

## Card database and startup

XMage keeps card metadata in an embedded H2 database at `./db/cards.h2` relative to the working directory. It fills it by instantiating every card class (`CardScanner.scan()`).

- **Where it lives:** it's built once per pin at image-build time (`engine/xmage/BuildCardDatabase.java`) and shipped at `/app/db/cards.h2.mv.db`, owned by uid 10001. Building it at startup instead would add about 21 s to every cold start and use about 1.7 GB of memory during startup.
- **Startup:** the engine opens the database and counts rows. It skips XMage's per-card existence check (about 94,000 queries) by setting `CardScanner.scanned`, because the shipped database is complete. If the database were missing or stale, XMage would drop the table, and the engine would detect the empty table and rebuild it. `/ready` returns 200 only after this; before that it returns 503 `engine_loading`, and `engine_failed` if loading failed.
- **Counts:** 93,992 printings and 32,739 distinct names, reported on `/health`.

| Start (Compose, three runs each) | JVM uptime at ready | Database open | Measured from outside |
| --- | --- | --- | --- |
| Cold (new container) | 778–852 ms | 604–674 ms | ~1.2 s |
| Warm (restart) | 639–664 ms | 461–492 ms | 0.7–1.2 s |

**Memory:**
- **Heap after GC:** 40–41 MB, idle or after any number of matches. Idle container memory is 129 MiB.
- **Peak live heap in a match:** at most 202 MB at skill 6, from GC logs over 10 matches on a 512 MB heap.
- **Chosen settings:** `-Xms256m -Xmx768m` with G1, `-XX:+ExitOnOutOfMemoryError`, and a 1.5 GB container limit. After matches the container sits around 1.0 GiB, which is the committed heap plus the H2 file's page cache.

## Driving XMage headless

The engine drives XMage's game objects directly, the same way `Mage.Tests` does. It doesn't start the XMage server, users, sessions or tables. One match does the following (`BotMatchRunner`):

1. Seeds `RandomUtil` (see Determinism).
2. Imports the two fixture decks from `engine/decks/*.txt` with `DeckImporter`, loads them with `Deck.load`, and checks each with `new mage.deck.Legacy().validate(deck)`. A test confirms the validator rejects an illegal deck (five Lightning Bolt and the banned Mental Misstep).
3. Creates `new TwoPlayerDuel(MultiplayerAttackOption.LEFT, RangeOfInfluence.ONE, MulliganType.LONDON.getMulligan(0), 60, 20, 7)`: Legacy settings, with a London mulligan, 60-card minimum, 20 life and 7 cards.
4. Creates two `ComputerPlayerControllableProxy` players ("Computer - mad") at the requested skill. Each is added to the game and also to a `TwoPlayerMatch` that is never started.
5. Sets `GameOptions.stopOnTurn = turnCap + 1` (stop at the untap step after the last allowed turn) and turns rollbacks off.
6. Subscribes to the game's table events for the log, then calls `game.start(choosingPlayer)` on the game thread.

Findings from building this:

- **The AI needs match context.** Without a match, every AI priority decision throws a `NullPointerException` in `SimulatedPlayer2` → `MatchPlayer.<init>` (`source.wins`). The AI's search copies each player's match record. The test framework creates a fake match for the same reason.
- **XMage hides fatal errors behind a "technical winner".** On repeated game errors it auto-restores to a saved state ("Auto-restored to T1.M1 due game error"). After 15 errors it ends the game and picks a winner by life total or at random. The game looks completed, with a winner. The engine listens for XMage's `ERROR` table events, reports such games as `error`, and counts recovered errors as `engine_errors`. The first broken build "completed" its seeded test this way, which is how this was found.
- **Game code must run on a thread whose name starts with `GAME`.** `ThreadUtils.ensureRunInGameThread()` enforces it. The match thread is named `GAME bot_match <uuid>`.
- **Mulligans** are driven by the game's mulligan object, not by `MatchOptions`. (Upstream's setter is spelled `setMullgianType`.)
- **The game log** is the `INFO` table events a client would display. The engine strips the HTML, tags each line with the turn, active seat and step, and keeps up to 5,000 entries per match. It also computes a digest for comparing runs.

## Threading model

| Thread | Count | Purpose |
| --- | --- | --- |
| HTTP | virtual thread per request | JDK `HttpServer`. `/health` stays responsive during a match (tested) |
| `card-database-loader` | 1 platform thread at startup | Opens or rebuilds the card database, then exits |
| `GAME bot_match <uuid>` | 1 platform daemon thread per match | Runs `game.start()`, so all rules processing and AI decisions for that game |
| `AI-SIM-MAD-*` | 5, static, shared by every game in the JVM | `ComputerPlayer6` submits one search per decision and the game thread waits on it with `task.get(skill × 3 s)` |
| watcher | 1 virtual thread, only if a game thread outlives its match | Releases the match slot when the stray thread finally exits |

Key facts for later milestones:

- **Shared state across games.** XMage's AI uses a static five-thread pool and a static node counter (`SimulationNode2.nodeCount`, capped at 5,000 nodes per search). It also draws from one process-wide `java.util.Random` (`RandomUtil`). Concurrent games in one JVM would share all three. v0.0.2 runs one match at a time, enforced by a semaphore that returns 429 to a second request.
- **The AI's think limit.** It is skill × 3 seconds per decision, with a search depth of max(4, skill). With these decks searches end on the node cap, and a whole game takes about a second.
- **The match slot.** It is held until the game thread has actually exited, not just until the HTTP response. A game that ignores the stop request keeps further matches out instead of piling up threads (tested).

### Stopping a game

XMage's game loop treats an interrupted game thread as "game over" (`GameImpl.checkIfGameIsOver`). But the AI catches `InterruptedException` while waiting on its search and clears the flag, so a single interrupt can be swallowed. On timeout the runner interrupts every 50 ms for up to 15 s and joins in between. The result reports `cleanup: complete` or `game_thread_still_running`.

The JUnit timeout test slows a real game (20 ms per log line) so a 1-second budget always expires mid-game. It checks that the result is `timeout`, that the game thread exits, and that no `GAME` threads remain. With real games a 1-second budget usually can't be reached, because a warm game finishes in about 0.7 s.

After every match the response reports the heap after an explicit GC, the live thread count and the number of game threads. These stayed flat across all runs (heap 40–41 MB, 43 threads, 0 game threads).

## Determinism

XMage has one seed control: `RandomUtil.setSeed(long)` on its single process-wide `Random`. It drives shuffles, coin flips, random printing selection and AI tie-breaks.

Observed with seed 42, repeated six times each at skills 1, 4 and 6:

1. **As XMage ships it:** the same starting player every time, then different games. Six of six log digests differed at every skill, and the winner changed (skill 4: seats 1, 1, 0, 1, 1, 1). The first divergence was the second player's mulligan decision on turn 1, before any AI search, so the opening hands were already different.
   - The cause: `Deck.getMaindeckCards()` collects into a plain `HashSet`, and cards use identity hash codes. So the library's order before the seeded Fisher–Yates shuffle changes on every run.
2. **With the library reloaded in deck-list order** before the opening shuffle (an adapter change in `BotMatchRunner`, not a patch): all 12 games (skills 1 and 4) had the same winner, 19 turns and 179 log lines. The same seed in a different container gave the same winner and turn count, and seed 1 played 17 turns both locally and on the GitHub runner. But the logs still differed in 3–4 ways.
   - The remaining divergence was an AI tie-break between two equally valued blocks (two 2/1 attackers). The AI orders equal options by object IDs, and those come from `UUID.randomUUID()` (SecureRandom), not from the seed.

Sources of nondeterminism:

| Source | Status |
| --- | --- |
| Identity-hash ordering of the library before the opening shuffle | Fixed in the adapter |
| Random object IDs (`UUID.randomUUID()` in `CardImpl`, `MageObjectImpl`, abilities, effects) ordering hash-based collections the AI iterates | Observed; needs a seeded per-game ID source (an upstream change) |
| AI search bounded by wall-clock time (skill × 3 s) | Present in the code, not observed with these decks (searches hit the node cap first); would show up on slower or busy hosts |
| One `Random`, AI thread pool and node counter shared across concurrent games | Avoided by running one match at a time; would break per-game reproducibility otherwise |

What full determinism would need (input for RULE02 and NET09):
- A per-game seeded RNG.
- A per-game deterministic ID generator.
- AI budgets counted in nodes, not seconds.
- No identity-hash iteration.
- Per-game AI state.

That is deep upstream surgery. A more practical design is to record every decision (human and AI) and every random draw in the action journal, and replay from that journal instead of re-running the AI. In either case, journal RNG state for recovery and keep hidden-state seeds out of client views (SEC03).

## Bot match results

All runs used the two fixture decks: mono-red burn in seat 0 and mono-green creatures in seat 1. Turns count every player's turn.

| Run | Matches | Result | Turns (min / median / max) | Duration (min / median / max) | Notes |
| --- | --- | --- | --- | --- | --- |
| Random seeds, skill 4 | 30 | 30 completed | 7 / 14 / 33 | 293 / 771 / 1,380 ms | Green won 19, red 11; 0 engine errors |
| Random seeds, skill 6, 512 MB heap | 10 | 10 completed | 8 / 12 / 27 | 548 / 1,044 / 4,588 ms | Peak live heap 202 MB |
| **Stability check** (Compose, skill 4) | 10 | 10 completed | 8 / 11.5 / 21 | 588 / 982 / 1,250 ms | Heap after GC 41 → 41 MB; 43 → 43 threads; 0 game threads; container 1.01 → 1.05 GiB; no errors in the engine log |
| Turn cap 3 (HTTP) | 1 | `turn_limit` | 3 | 99 ms | Neither player won |
| Concurrency (HTTP) | 2 | 200 and 429 | | | Second request rejected while the first ran |
| CI smoke test (GitHub runner, fresh JVM) | 1 | completed | 17 | 9,346 ms | Seed 1; includes JVM warm-up |

No match hung, crashed or reported an engine error. A first match on a fresh JVM takes 4–5 s, while classes load and the JIT warms up.

`scripts/engine_bot_matches.py` reproduces these runs (see the README).

## Security and dependencies

The engine image runs as uid 10001. It publishes no port, and the web proxy forwards nothing to it (verified: no connection from the host; the web container answers 404/405).

Trivy 0.75.0 on the runtime image:

| Package | Finding | Exposure here | Follow-up |
| --- | --- | --- | --- |
| `com.h2database:h2` 1.4.197 | CVE-2021-42392, CVE-2022-23221 (critical; console and JNDI or remote-class loading via JDBC URLs) | The H2 console isn't started, and XMage hard-codes the JDBC URL | XMage pins 1.4.197 because newer H2 can't read its files. Upgrading needs an upstream change |
| H2 auto-server | XMage opens the database with `AUTO_SERVER=TRUE`, which starts an H2 TCP server on a random port | It was listening on all interfaces (other Compose services could connect) | **Mitigated:** `-Dh2.bindAddress=127.0.0.1` binds it to loopback (verified) |
| `org.jboss.remoting:jboss-remoting` 2.5.4.SP5 | CVE-2020-35510 (high) | XMage's client-server transport, pulled in by `mage-common`; the engine never starts it | Try excluding it once the AI's real dependency on `mage-common` is known |
| `org.jsoup:jsoup` 1.21.2 | CVE-2026-75140 (high), CVE-2026-71497 (medium) | XMage formats card text; no untrusted HTML is parsed | Fixed in 1.23.2; needs an upstream bump or a dependency override |
| Ubuntu 26.04 base | 5 high (curl, OpenSSL) plus a bundled `pebble` binary on an older Go | Base image packages | Newer packages exist; refresh the base image digest during release hardening |

The 32 third-party jars and their declared licences are in [xmage-dependencies.csv](xmage-dependencies.csv). The build also writes `THIRD-PARTY.txt` into `/app/licenses` (`license-maven-plugin`). Several POMs declare no licence (the XMage modules, which are MIT by the repository licence, plus `jspf-core`, `jboss-serialization` and `trove`), and the JBoss Remoting libraries are LGPL. Both points need review before SEC06.

## How XMage's human player waits for choices (design input for v0.0.3)

`mage.player.human.HumanPlayer` (in `Mage.Server.Plugins/Mage.Player.Human`, not built in v0.0.2) bridges a blocking rules engine to an asynchronous client:

1. **The game thread asks.** Every choice method calls `prepareForResponse(game)`, which marks the player as the priority player. It then calls a `game.fire*Event(...)` method, which emits a `PlayerQueryEvent` to the listener registered with `game.addPlayerQueryEventListener`. In XMage that listener is the server's `GameController`, which sends a callback to the client. Then it calls `waitForResponse(game)`.
2. **The game thread blocks.** `waitForResponse` clears the previous answer, sets `responseOpenedForAnswer = true`, resumes the player's priority timer, and calls `response.wait()` while holding the player's `PlayerResponse` monitor. It returns early if an answer or an async command is already waiting. `InterruptedException` is caught and ignored.
3. **A network thread answers.** The client's reply arrives on a `CALL` thread as `setResponseUUID`, `setResponseBoolean`, `setResponseString`, `setResponseInteger` or `setResponseManaType`.
   - Each first calls `waitResponseOpen()`, which polls every 100 ms for up to 30 s until the game thread is waiting. Only the newest answer is kept; an older waiting answer is dropped.
   - It then stores the value in `response` and calls `notifyAll()`.
4. **The game thread validates.** It wakes, pauses the timer, and checks the answer against the request. Most choice methods run inside a `while (canRespond())` loop, so an invalid answer means asking again.
5. **Async commands.** Concede and cheat set flags on `response` and `notifyAll()`. The waiting game thread processes them and then waits again. `abort()`, which `game.end()` calls, sets the abort flag and wakes the thread.

Choice methods that wait for an answer (all overrides of `Player`):

| Method | Client event (`PlayerQueryEvent` type) | Answer |
| --- | --- | --- |
| `priority` (play a card or ability, or pass) | `SELECT` | UUID of the object to use; boolean or integer (an F-key pass mode) to pass; string "special" for special actions; mana type to pay from the pool |
| `chooseMulligan` | `ASK` | boolean |
| `chooseUse` (yes/no, optional effects) | `ASK` | boolean |
| `choose(Outcome, Choice)` (named choices: colour, card type, card name and so on) | `CHOOSE_CHOICE` | string |
| `chooseReplacementEffect` (order replacement effects) | `CHOOSE_CHOICE` | string |
| `choose(Outcome, Target, …)`, `chooseTarget(Outcome, Target, …)` (targets and non-targeted choices of players and permanents) | `PICK_TARGET` | UUID per pick, boolean to finish or cancel |
| `choose(Outcome, Cards, TargetCard, …)`, `chooseTarget(Outcome, Cards, TargetCard, …)` (cards in hand, library or graveyard) | `PICK_TARGET` | UUID, boolean |
| `chooseTargetAmount` (divide damage or counters) | `PICK_TARGET`, then `MULTI_AMOUNT` to divide | UUID per target, then string (encoded list) |
| `chooseTriggeredAbility` (order simultaneous triggers) | `PICK_ABILITY` | UUID |
| `chooseMode` (modal spells) | `CHOOSE_MODE` | UUID of the mode |
| `chooseAbilityForCast`, `chooseLandOrSpellAbility`, `activateAbility`, `activateSpecialAction` (which ability or face) | `CHOOSE_ABILITY` | UUID |
| `playManaHandling` (pay a mana cost) | `PLAY_MANA` | UUID of a mana source to activate, mana type from the pool, string "special" for special actions, boolean to cancel |
| `announceX` (announce X) | `AMOUNT` | integer |
| `announceRepetitions` | `AMOUNT` | integer |
| `getAmount` (choose a number) | `AMOUNT` | integer |
| `getMultiAmountWithIndividualConstraints` (split amounts) | `MULTI_AMOUNT` | string (encoded list) |
| `selectAttackers` | `SELECT` | UUID per attacker toggled; string "special" for all attack; integer (F-key) to skip; boolean when done |
| `selectBlockers`, with `selectCombatGroup` for which attacker | `SELECT`, then `PICK_TARGET` | UUID per blocker, then the attacker's UUID; integer (F-key) to skip; boolean when done |
| `choosePile` | `CHOOSE_PILE` | boolean |

Implications for v0.0.3:

- **Bridge points.** A human seat can reuse `HumanPlayer` as-is: register a `PlayerQueryEvent` listener (the engine already registers a table-event listener the same way) and turn each event into a typed prompt. Feed answers back through the `setResponse*` methods. The bridge points are this listener and those five setters; no rules code needs touching.
- **Threads.** The game thread blocks inside `response.wait()` for as long as a human thinks. Each human game therefore holds one platform thread. The answer must come from another thread, and `waitResponseOpen` drops an answer (with only a server warning) if no request opens within 30 s.
- **Prompt identity is missing.** A response is just a value: `PlayerResponse` carries no prompt ID. Prompt IDs, expected revisions and deduplication (RULE05, NET06) must be added in the adapter, which must reject stale answers itself.
- **Prompt content.** Events carry XMage objects (permanent lists, card sets, ability lists, options maps), not authorized views. The adapter must build per-seat prompt payloads instead of forwarding them.
- **Timers and stopping.** Priority timers start and stop inside `waitForResponse`. Interrupts are ignored there, so stopping a game with a human seat must go through `abort()` and `game.end()`, not thread interrupts.
- **Validation loops.** Many methods repeat the request after an invalid answer, so the adapter can surface an "invalid answer, please try again" state rather than failing the game.

## Follow-ups

- v0.0.3: a human seat through `HumanPlayer` with a `PlayerQueryEvent` bridge, typed prompts with IDs, and per-seat authorized views.
- An AI hidden-information audit (AI02). The MAD AI simulates on a copy of the full game state.
- A decision journal for replay instead of re-running the AI (RULE02, NET09).
- Dependency hygiene: H2 (upstream), JBoss Remoting exclusion, jsoup, base image refresh, and licence review for SEC06.
- Build `Mage.Tests` selectively if later milestones want XMage's card tests in CI.
