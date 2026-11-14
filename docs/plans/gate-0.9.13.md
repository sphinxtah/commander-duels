# The Preparation Framework's release gate (v0.9.13)

The owner's specification closes the framework with a gate (section 16): nine conditions, checked here one by one at the framework's last stage, each with what shows it. The framework was delivered in four versions, [v0.9.9](0.9.9.md), [v0.9.10](0.9.10.md), [v0.9.12](0.9.12.md) and [v0.9.13](0.9.13.md), with v0.9.11 between them for a game's start; [the audit](audit-0.9.9.md) is its inventory.

**The gate is met**, with the scope as the owner changed it: of the specification's ten foundations, eight are in the game and exercised, one was built and then removed on his decision (the economy's, section 11), and one was dropped before it was built (playgroups, scheduling and leagues, section 13). Two decisions of his are carried to v1.0.0's start; neither is an unknown, and each has a working default ([below](#carried-to-v100s-start)).

## The scope, as the owner set it

| Date | Decision | Effect on the gate |
| --- | --- | --- |
| 2026-11-11 | The framework in stages, each published and deployable | Four versions |
| 2026-11-13 | No path to a specific card (§11, §22); no Rule Zero disclosures or deck analysis (§9, §18) | Neither is a criterion |
| 2026-11-13 | The mode policies: the sandbox earns nothing, a borrowed deck earns as a table game | Approved, in `api/modes.py` |
| 2026-11-14 | No economy changes, ever; the foundations v0.9.12 built for them removed, their data included | Condition 4 reads: the economy is v0.9.11's |
| 2026-11-14 | No playgroups, no scheduling, no leagues (§13, §25, §28) | Condition 5 has nothing to check |

## The foundations, each against its exit criteria

| Foundation (spec §) | Built in | Its acceptance | Shown by |
| --- | --- | --- | --- |
| **Architecture and dependency audit** (4) | v0.9.9 | Every v1.0.0 feature has a foundation and a path; unknowns told apart from ordinary work; nothing built twice | [The audit](audit-0.9.9.md): the inventory, the dependency map, the design decisions, the versioning conventions, the engine's limits each with a test |
| **Game recording and recovery** (5) | v0.9.9 | An interrupted game resumes legally from what was kept; seat views are equivalent afterwards; nothing is doubled; damaged or incompatible data fails safely and in words | Engine: `RecoveryTest` (every format; combat, the stack, hidden zones, teams, commanders, pending choices), `RecoveryStructureTest`, `RecordingDamageTest`, `ServiceRecoveryHttpTest`, `RecordingToolTest`, `SerializableCardsTest`, `RecordingCostTest`. API: `tests/test_recovery.py`. [Recording and recovery](../engine/recovery.md), with its guarantees and what is not supported |
| **Bot containment and game isolation** (6) | v0.9.8, v0.9.10, v0.9.11 | Search time and memory bounded; a legal fallback; one failed game ends no other; a full engine refuses in words; low skill told apart from a budget's fallback | Engine: `FairBotMemoryTest`, `GameProcessesTest` (a killed game's process leaves the others running and the game is taken up by a new one; admission; reuse), `WarmUpTest`, the campaign difficulty workflow's court runs. [Isolation](../engine/isolation.md), [fair bots](../engine/fair-bots.md) |
| **Structured events and perspectives** (7) | v0.9.10 | Public and seat views show only what they may; events explain outcomes without parsing text; usable for long games | Engine: `GameEventsTest` (visibility by object, how much cause XMage gives, a recovery's events). API: `tests/test_events.py` (public, seat, team, spectator and inspection perspectives; retention; retrieval by turn and type), `python -m api.cli timeline`. [Events](../engine/events.md) |
| **Access, consent and temporary entitlement** (8) | v0.9.10, gated in v0.9.13 | Expired or revoked access retrieves nothing new; temporary cards reach no collection or auction; revocation changes no started game; cross-account tests for every kind | `tests/test_access.py`, `tests/test_rollout.py`. [Access](../access.md). Of the seven kinds the specification names, five are built (a borrowed deck, the sandbox's cards, a shared replay, a spectator, a coach's view of a hand); playgroup membership and league pools were dropped |
| **Rule Zero profiles** (9) | v0.9.12 | Profiles made, validated, read and attached to real tables; material changes clear readiness; enforced rules checked at readiness and start; no opponent's list disclosed | `tests/test_table_profiles.py`. [Tables](../tables.md#rule-zero-table-profiles-v0912). Without disclosures and deck analysis (dropped) |
| **Game modes and reward eligibility** (10) | v0.9.10 | A matrix proves access and settlement by mode; sandbox and temporary access make no transferable asset; staff testing told apart; existing rewards unchanged | `tests/test_modes.py` (the matrix; a game of each kind that exists settled as before; nothing settled twice). [Modes](../modes.md). The leagues' two modes went with the leagues |
| **Economy and acquisition** (11) | v0.9.12, removed in v0.9.13 | The owner's: none of it is adopted | `tests/test_economy_removed.py`; the suites of the code that was reverted pass as before v0.9.12. [The economy](../economy.md) |
| **Deck workshop and analytics** (12) | v0.9.12 | Restoring rewrites no played game; aggregates match recorded results; substitutions respect identity, legality, ownership and implementation; existing decks migrate without loss | `tests/test_workshop.py`, `tests/test_account_data.py` (decks through migration 0048). [Decks](../decks.md#the-deck-workshops-foundations-v0912) |
| **Playgroups, scheduling and leagues** (13) | Not built | Dropped by the owner | Nothing in the code but two words the access table still takes and never writes |
| **Large boards** (14) | v0.9.12 | Grouping hides no meaningful difference; batch commands keep combat legal; yields stop when decisions change; baselines recorded; keyboard access | Engine: `LargeBoardsTest`, `AutomationTest`. API: `tests/test_table_profiles.py` (pace policies). [Large boards](../engine/large-boards.md), with its three fixtures' baselines |
| **Rollout and operations** (15) | v0.9.13 | Disabled workflows unreachable through unguarded routes; maintenance safe to retry; failures diagnosed without exposing what is concealed; existing play runs while the foundations operate | `tests/test_rollout.py` (the API does not start with an unguarded route of a workflow), `tests/test_operations.py`, `tests/test_maintenance.py`, `tests/test_jobs.py`, `tests/test_fixtures.py`. [Operations](../operations.md) |

## The gate's nine conditions

| # | Condition (spec §16) | Result | Evidence |
| --- | --- | --- | --- |
| 1 | The foundations are implemented and exercised | Met, for the eight that remain | The table above. Each has a consumer that runs: a test suite, a route in use, or a console tool |
| 2 | Recovery works across supported formats under documented conditions | Met | `RecoveryTest` plays Legacy, Commander, Two-Headed Giant and King's Table games through interruptions; the conditions and the cases not supported are in [recording and recovery](../engine/recovery.md#what-is-not-supported) |
| 3 | Event perspective filtering and temporary-access tests pass | Met | `tests/test_events.py`, `tests/test_access.py`, `tests/test_rollout.py`, and the engine's `GameEventsTest`, in the hosted checks of every push |
| 4 | Economy foundations preserve existing policy by default | Met another way: there are none | The owner removed them. The game pays, grants and sells as v0.9.11 did; `tests/test_economy.py`, `test_quests.py`, `test_progression.py`, `test_library_editions.py`, `test_auctions.py` and `test_modes.py` pass as they did before v0.9.12 |
| 5 | Group and league services complete executable integration scenarios | Not applicable | Dropped by the owner on 2026-11-14 |
| 6 | Existing gameplay passes regression checks | Met | The hosted checks on the release's commit: the API's suite on PostgreSQL, the engine's suite, the web's unit tests, and the browser journeys against the real engine (practice, tables, team tables, matches, the campaign, the shop, auctions, the pack window). Their runs are in [the release notes](../releases/0.9.13.md#verification) |
| 7 | Migrations preserve representative account data | Met | `tests/test_account_data.py` on SQLite and PostgreSQL: the account written at v0.9.9's schema, with each later migration's rows and what v0.9.12 left on the live site, is the same after every migration to 0050, back to v0.9.9's and forward again |
| 8 | Operational documentation and a precise v1.0.0 backlog exist | Met | [Operations](../operations.md) (the numbers, the gates, jobs and retention, migrations, compatibility, rollback limits, fixtures) beside [deployment](../deployment.md); [the v1.0.0 backlog](1.0.0.md) |
| 9 | No major architectural unknown is merely postponed under the label "framework" | Met | [Below](#the-unknowns-the-audit-named) |

## The unknowns the audit named

| Unknown | Answer | Where |
| --- | --- | --- |
| Can a game be given back after a process dies, in every format? | Yes: a checkpoint and a journal, bound to the engine build | v0.9.9, [recovery](../engine/recovery.md) |
| Can one game's memory be bounded on its own? | Yes: a process a game, sized by format, admitted against a budget | v0.9.10, [isolation](../engine/isolation.md) |
| Does a process a game cost a slow start? | It did (29 s on the live site); a copy of the card database, reuse and a warm-up brought it to seconds | v0.9.11, [a game's start](../engine/isolation.md#a-games-start-v0911) |
| How much cause do XMage's events carry? | Measured on real games: damage and targets always, deaths by the rules never. The schema carries a cause where XMage has one, and the timeline must say when it has none | v0.9.10, [events](../engine/events.md#how-much-cause-xmage-gives) |
| Can a batch of attackers be checked by XMage's own combat rules? | Yes: checked whole against the open prompt, then fed one at a time | v0.9.12, [large boards](../engine/large-boards.md#batch-declarations) |
| Can a replay be made by playing the game again? | No: a bot's decisions are not reproducible. A replay is made from the events | The audit's decision; the events are kept for it |
| Can an old engine build be kept alive for the games it recorded, so an upgrade need not end them? | Not tried, and not needed by the framework: the rule that is built and documented is that an upgrade ends the games running then. What it means for a saved game is the first decision below | [Recovery](../engine/recovery.md#what-is-not-supported) |

## Carried to v1.0.0's start

Two decisions are the owner's and shape v1.0.0's first feature and its replays. Each has a default that works today.

1. **What an upgrade does to a saved game.** A recording is played on only by the engine build that made it, so as built, a save lasts until the next upgrade and says so. The alternative is a second engine container for the previous build, kept until its games are over: untried, and it would hold that build's memory beside the new one's. v1.0.0's save and resume can ship on the default.
2. **How long a game's events are kept.** 90 days after the game ended, assumed on 2026-11-12 when the events were built. A replay lives exactly as long.

## What remains a risk

- **The live site has not run under load.** Its operating envelope is v1.0.0's capacity test to set; the numbers to watch are now in one place ([operations](../operations.md#the-sites-numbers)).
- **The owner's private cards** are not in the public repository, and the public suites do not read them. The private engine image is built from each version's public image and smoke-tested; their recovery was checked by hand once, in v0.9.9.
- **Migration 0050 is the one migration that the previous version cannot ignore.** For a few seconds of the v0.9.13 deploy the v0.9.12 API still running cannot read quest boards or libraries ([operations](../operations.md#migrations)). After it, going back to v0.9.12 needs the dump taken before the deploy.
- **A gate is only as good as its use.** v1.0.0's routes must be made on their workflow's router, under its reserved paths; the API refuses to start otherwise, and a route made somewhere else would not be caught.
