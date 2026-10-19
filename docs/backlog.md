# Scope and remaining work

The user requested v0.0.1 as the initial framework, the foundation before M0. v0.0.2 is the first slice of M0: the XMage engine builds from a pinned commit on Java 21 and plays internal bot-versus-bot Legacy games ([findings](engine/xmage-spike.md)). v0.0.3 adds a human seat through XMage's `HumanPlayer`, with typed prompts, stale-answer refusal and authorized per-seat views, on development engine endpoints driven by scripts ([the human seat](engine/human-seat.md)). v0.0.4 generalizes that bridge to Commander tables of two to four seats, any mix of humans and bots, with per-seat tokens, commander tax and damage in the views, and leak checks for every human seat ([Commander tables](engine/commander-tables.md)). [The v0.0.4 plan](plans/0.0.4.md) sets out the route to v0.1.0, the first version with a testing UI: identity next (v0.0.5), then authenticated routing (v0.0.6). Document content supplies requirements, not permission to claim investigations or product functionality have been completed.

| Priority | Milestone | Required next work | Exit evidence |
| --- | --- | --- | --- |
| P0 | M0 | Legitimate reference-installation audit; complete reference inventory | Captures and traceable feature/test mapping |
| P0 | M0 | Browser control of the v0.0.3 human seat (engine side done: typed prompts, stale-answer refusal, per-seat views, scripted leak checks). Remaining: authenticated routing through the API and a testing UI (v0.1.0) | Browser Legacy game against a bot, no concealed-state leaks |
| P0 | M0 | Prompt families the fixture decks never reach: modes, X and amounts, named choices longer than 64 entries, trigger ordering, piles. Each pauses the game as `unsupported` today (ability choice, short choices and defender choice are typed since v0.0.4) | Typed prompts with fixtures that reach them |
| P0 | M0 | Two-Headed Giant (FMT08–10, T09). Four-seat Commander is done on the engine side (v0.0.4). XMage has no team game type: the [feasibility note](engine/two-headed-giant.md) recommends a one-version spike on a patched XMage after v0.1.0, then a go or no-go | Spike result with a revised estimate, then T09 |
| P0 | M0 | AI hidden-information audit (the MAD AI searches a copy of the full game state, including every human seat's hand) and AI budgets per decision; at four seats the AI already logs "thinks too long" on large boards | AI02/AI05 evidence |
| P0 | M0 | Recovery, deterministic RNG, fencing and replay proof; XMage is not reproducible from a seed alone (random object IDs, global RNG), so journal decisions and draws | Worker-kill/restart fixtures with matching state and views |
| P0 | M0 | Browser-local compilation proof and asset/licensing inventory | Measured offline feasibility report, explicit blockers |
| P1 | M0 | Engine dependency hygiene: H2 1.4.197 CVEs (upstream pin), JBoss Remoting exclusion, jsoup, base image refresh, licence review of undeclared jars | SEC06 scan and notice set |
| P1 | M1 | Google verification, CSRF, private sessions, roles, approval policy | AUTH01–07, T01/T02/T29 |
| P1 | M1 | SysOp local administrator (requested 2026-10-18): a local account, separate from Google sign-in, that signs in only from the operator's production network and holds every root-level ability in the interface. Open questions in [the plan](plans/0.0.4.md#sysop-local-administrator), including how it fits SEC05 and NET14, which forbid viewing concealed live-game information | Sign-in refused outside the allowed network; every SysOp action audited; AUTH/SEC tests |
| P1 | M1 | Streaming Scryfall imports, durable scheduling, revisions, identity mappings | CAT01–10, T17–20 |
| P1 | M1 | Deck lifecycle, versioning, format validation, import/export, search | DECK01–11, T03–05 |
| P1 | M2 | Authoritative game UI and protocol, Legacy BO1/BO3, bots and recovery | T06/T10–16/T21–22 |
| P1 | M3 | Multiplayer Commander in the product (the engine bridge exists since v0.0.4: tables, seats, views and scripted T07/T08 evidence), Two-Headed Giant, lobbies and readiness (NET02–03), Rule Zero settings (FMT03–04), spectators, social controls | T07–09/T13–15 |
| P1 | M4 | Complete authorized campaign, lessons, quests, economy and cosmetics | T23/T24/T30 |
| P1 | M5 | PWA lifecycle, real browser-local play, gamepad and translations | T25–28/T30 |
| P1 | M6 | Full card coverage, performance, security and release provenance | All acceptance cases and signed parity matrix |

These are unaccepted gaps, not deleted scope. The reference CSV seeds all 18 scope feature families as unresolved. The scenario example is a draft schema fixture and cannot be played. The engine's XMage card database (93,992 printings) is not a certified catalog: no Scryfall cards are imported, mapped or certified; a coverage percentage would be misleading before a catalog snapshot is selected.

Follow-up tickets should include requirement IDs, dependencies, acceptance fixtures, diagnostic telemetry, migration effects and documentation changes. Add durable result/outbox processing before granting any rewards. Add per-user authorization before exposing user-owned domain records. Never unlock play on the basis of an imported card or a successful engine health response.
