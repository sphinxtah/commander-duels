# Scope and remaining work

The user requested v0.0.1 as the initial framework, the foundation before M0. v0.0.2 is the first slice of M0: the XMage engine builds from a pinned commit on Java 21 and plays internal bot-versus-bot Legacy games ([findings](engine/xmage-spike.md)). Document content supplies requirements, not permission to claim investigations or product functionality have been completed.

| Priority | Milestone | Required next work | Exit evidence |
| --- | --- | --- | --- |
| P0 | M0 | Legitimate reference-installation audit; complete reference inventory | Captures and traceable feature/test mapping |
| P0 | M0 | Human seat through XMage's `HumanPlayer`: `PlayerQueryEvent` bridge, typed prompts with IDs and stale-answer rejection, per-seat authorized views (v0.0.3) | Browser Legacy game against a bot, no concealed-state leaks |
| P0 | M0 | Four-seat Commander and Two-Headed Giant choices on the same bridge | Four-seat choices |
| P0 | M0 | AI hidden-information audit (the MAD AI searches a copy of the full game state) and AI budgets per decision | AI02/AI05 evidence |
| P0 | M0 | Recovery, deterministic RNG, fencing and replay proof; XMage is not reproducible from a seed alone (random object IDs, global RNG), so journal decisions and draws | Worker-kill/restart fixtures with matching state and views |
| P0 | M0 | Browser-local compilation proof and asset/licensing inventory | Measured offline feasibility report, explicit blockers |
| P1 | M0 | Engine dependency hygiene: H2 1.4.197 CVEs (upstream pin), JBoss Remoting exclusion, jsoup, base image refresh, licence review of undeclared jars | SEC06 scan and notice set |
| P1 | M1 | Google verification, CSRF, private sessions, roles, approval policy | AUTH01–07, T01/T02/T29 |
| P1 | M1 | Streaming Scryfall imports, durable scheduling, revisions, identity mappings | CAT01–10, T17–20 |
| P1 | M1 | Deck lifecycle, versioning, format validation, import/export, search | DECK01–11, T03–05 |
| P1 | M2 | Authoritative game UI and protocol, Legacy BO1/BO3, bots and recovery | T06/T10–16/T21–22 |
| P1 | M3 | Multiplayer Commander, Two-Headed Giant, lobbies/social controls | T07–09/T13–15 |
| P1 | M4 | Complete authorized campaign, lessons, quests, economy and cosmetics | T23/T24/T30 |
| P1 | M5 | PWA lifecycle, real browser-local play, gamepad and translations | T25–28/T30 |
| P1 | M6 | Full card coverage, performance, security and release provenance | All acceptance cases and signed parity matrix |

These are unaccepted gaps, not deleted scope. The reference CSV seeds all 18 scope feature families as unresolved. The scenario example is a draft schema fixture and cannot be played. The engine's XMage card database (93,992 printings) is not a certified catalog: no Scryfall cards are imported, mapped or certified; a coverage percentage would be misleading before a catalog snapshot is selected.

Follow-up tickets should include requirement IDs, dependencies, acceptance fixtures, diagnostic telemetry, migration effects and documentation changes. Add durable result/outbox processing before granting any rewards. Add per-user authorization before exposing user-owned domain records. Never unlock play on the basis of an imported card or a successful engine health response.
