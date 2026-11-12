# The v0.9.9 audit: what exists, what each v1.0.0 feature stands on, and in what order

The owner's specification (2026-11-11) asks v0.9.9 to begin with an audit of the code as it is (§4). This is it, made against the code at v0.9.8 and kept current through v0.9.9. Its three tests: every v1.0.0 feature has a foundation and a path; the technical unknowns are told apart from ordinary work; nothing that exists is built twice.

The specification's own assessment was made at v0.9.7. What v0.9.8 already did that it asked for: the bots' search memory bounded while a search runs, a legal move when the budget is out, and eighteen six-seat court games without running out of memory ([fair bots](../engine/fair-bots.md#a-searchs-memory-v098)).

## How the work is staged

The owner chose on 2026-11-11 to deliver the Preparation Framework in stages, each published and deployable, before v1.0.0:

| Release | Foundations |
| --- | --- |
| **v0.9.9** | The audit (this document); game recording and recovery, end to end ([recording and recovery](../engine/recovery.md)); the pack window (the owner's request) |
| **v0.9.10** | Bot containment and game isolation (a process per game, the owner's choice); structured game events and perspectives; game modes and reward eligibility; access, consent and temporary entitlement |
| **v0.9.11** | Economy and acquisition; the deck workshop; Rule Zero profiles; playgroups, scheduling and leagues; large boards; rollout and operations; the release gate and the v1.0.0 backlog |

Ten foundations are more than any version so far. If v0.9.11 cannot close all six of its foundations to their exit criteria, a v0.9.12 takes the rest: the owner's call when v0.9.10 closes, with its measured pace in hand. The order follows the dependencies below: isolation and events change the engine and the game's protocol, which everything after them builds on; modes and access are the two decisions every later model consults.

**Why isolation moved out of v0.9.9.** Recovery is what makes isolation safe to build: a game moved into its own process needs its state to cross a process boundary, and the recording is that state. With recovery in place, the containment v0.9.9 has is coarse but real: an engine that runs out of memory exits (`-XX:+ExitOnOutOfMemoryError`), Docker restarts it, and the API asks for each game again, which the engine takes up from its recording. A game that keeps killing the engine is given up after five recoveries with no answer between them, so it cannot take the others down for good. What it does not have: one game's memory cannot be bounded on its own, and while the engine restarts (a few seconds) every game waits.

## The inventory: each v1.0.0 feature

"Exists" is what the code does at v0.9.9. "Unknown" marks a technical question whose answer is not yet known, as against ordinary work whose shape is clear.

| v1.0.0 feature (spec §) | What exists | Foundation | Path | Unknowns |
| --- | --- | --- | --- | --- |
| **Recoverable games and save/resume** (§17) | Since v0.9.9: every service game is recorded and survives a restart of the engine or the API; the WebSocket reconnects by itself (close code 4503 while a game is being asked for again); results settle once, keyed by game and seat | Recording and recovery (v0.9.9) | Screens for reconnecting, recovering and unrecoverable (the API knows each state today; the page shows only "interrupted"); save: close a solo game into its recording and attach it later (the engine's attach route takes up any recording); a table's consensual suspension is a vote, as the away vote is; the expiry is the retention sweep's | Keeping an old engine build alive for games recorded by it, so an upgrade need not end them: a second engine container per build, routed by the recording's build key. Not yet tried |
| **Rule Zero profiles and table discovery** (§18) | A table's rules options (banned cards, cards not legal, stand-ins), King's Table settings, lobby filters, the live lobby; a King's Table setting change clears readiness | Rule Zero profiles (v0.9.11) | A versioned profile in the table's `settings` JSON with its schema, presets saved per account, lobby search over the profile's fields, the profile bound to the game row at start | None. Deck analysis "with its limits" needs a decision on what is reported (fast mana, tutors, extra turns are card lists; loops are not detectable in general) |
| **All-card practice sandbox** (§19) | SysOp builds from the whole catalog (`library.unlimited`); stand-ins; the bots' passive switch (v0.8.6); practice games | Access and temporary entitlement, game modes (v0.9.10) | A `sandbox` game mode whose deck validation reads functional access instead of the library; its games pay nothing, by the eligibility module, with a reason code | None |
| **Friend deck lending** (§20) | Decks shared by link (read only), immutable revisions bound to games, friends and blocks, table invitations | Access and temporary entitlement (v0.9.10) | An access grant (deck, borrower, expiry, revoked) consulted where a table validates a seat's deck; the game binds the revision as today, so a revoked loan cannot change a started game | None |
| **Explainable game timeline** (§21) | The table's log as XMage's text lines; the campaign's barks read it with patterns | Structured events (v0.9.10) | Events from XMage's `GameEvent`s, numbered, stored beside the recording's journal, filtered by the same `Visibility` rules the seat views use | How much cause XMage's events carry: a damage event names its source, a zone change its cause only sometimes. To be measured on real games before the schema is fixed |
| **Progression and acquisition** (§22) | The token ledger (keyed, append-only), packs with print runs and supply, auctions, the weekly sale, starter decks, basic land packs, quest boards with swaps, achievements | Economy and acquisition (v0.9.11) | Functional access for basic lands, never a `LibraryGrant`; quotes as rows with a price and an expiry, charged through the ledger with the quote's key | None technical; the policies are the owner's |
| **Native replays and post-game review** (§23) | The recording's journal and checkpoints (v0.9.9); a finished recording keeps its manifest and journal, not its state | Recording (v0.9.9), events (v0.9.10) | Replays from events, not by playing the game again: a bot's decisions are not reproducible, so a replay that re-ran the game would show another game | Retention: a replay outlives the 24 hours a recording is kept. Events are small; their retention is a decision for v0.9.10 |
| **Spectator and coaching mode** (§24) | The engine's spectator token and public view with an optional delay; SysOp observing any game; leak checks for spectators since v0.0.4 | Access and consent (v0.9.10), events (v0.9.10) | The API hands spectator seats under an access grant; coaching is a consented grant to one seat's hand, shown through the seat's own filter | None |
| **Persistent playgroups** (§25) | Friends, alliances, tables, queues, invitations, notifications, the chat bar | Playgroups (v0.9.11) | New tables (group, membership, event), access by membership, reminders through the notification bell | Daylight-saving and time zones are ordinary work with known libraries |
| **Deck workshop** (§26) | Decks with immutable revisions, archive, trash, import, export, sharing, maybeboard; results name the revision played | Deck workshop (v0.9.11) | Folders and tags as deck columns; a diff of two revisions' entries; restore copies a revision into the draft; aggregates over `player_results` by revision | None |
| **Faster large-board play** (§27) | The table, its stops and pass modes, the response timer | Large boards (v0.9.11) | Token grouping in the view (an equivalence key over the visible fields); batch attack and block commands checked by XMage's own combat rules | Whether XMage's declare-attackers loop accepts a whole declaration at once, or must be fed one attacker at a time with the batch checked first |
| **Private Sealed leagues** (§28) | Packs and collations from MTGJSON, deck validation, matches, standings nowhere | Playgroups and leagues (v0.9.11) | Pools as their own card lists apart from libraries; validation against the pool; standings from recorded results | None |

## The dependency map

```
recording and recovery (v0.9.9) ──► isolation (v0.9.10) ──► large boards' fixtures (v0.9.11)
            │                                 
            └──► structured events (v0.9.10) ──► timeline, replays, spectators (v1.0.0)
access and consent (v0.9.10) ──► sandbox, lending, spectators, coaching, playgroups, leagues
game modes and eligibility (v0.9.10) ──► economy (v0.9.11), deck analytics (v0.9.11), sandbox, leagues
Rule Zero profiles (v0.9.11) ──► table discovery (v1.0.0), playgroups' saved profiles (v0.9.11)
playgroups (v0.9.11) ──► leagues (v0.9.11) ──► Sealed leagues (v1.0.0)
rollout and operations (v0.9.11) ── every foundation's metrics and gates
```

## Design decisions

**Recovery: a checkpoint and a journal.** Built in v0.9.9; [recording and recovery](../engine/recovery.md) says why neither a replay nor a snapshot alone could do it, what a recording holds and binds to, and what is not supported. The decisions that bind later work: a recording is played on only by the engine build that made it; the engine takes nothing up unasked; a recording that stopped, or lost every checkpoint, gives back no game rather than another game.

**Event recording (v0.9.10).** Events are made from XMage's own `GameEvent`s on the game thread, numbered in the game's sequence, and written beside the journal in the recording's folder, then kept by the API past the game's end. Every event names objects by the ids the seat views use (`ObjectRefs`, stable across a recovery since v0.9.9), so no XMage id reaches anyone. Each event carries its visibility (public, a seat's, a team's), decided by the rules that build the seat views today, and one filter serves the seat view, the spectator, the replay and the export. SysOp's inspection stays its own type, as it is.

**Permissions and temporary access (v0.9.10).** One table of grants: the grantor, the subject (an account, a group), the resource (a deck, a game's spectator seat, a seat's hand, a group, a pool), the scope, an expiry, a revocation time, and the consent that made it, each change audited as role grants are (`RoleGrant`, `AuditEvent`). Grants are read where access is decided today (deck validation at a table, the game's WebSocket hello, the deck routes), never copied into a game: a started game holds its deck revision, so a revoked grant cannot change it.

**Temporary card access (v0.9.10).** Never a `LibraryGrant`, so it can reach neither a collection nor the auction house: validation accepts a card the account owns, or one a mode or a grant lets it use for that game alone. The auction house and the shop read libraries only, so they are untouched.

**Reward eligibility (v0.9.10).** Today what a game pays is decided in `economy`, `progression`, `quests`, `awards`, `campaign` and `stats`, each reading `games.kind` and its own rules. A `mode` column on `games` (practice, table, campaign, sandbox, borrowed, league, testing) is set at creation, and one function returns, for a mode and a seat, what it may earn (tokens, quests, achievements, statistics, competitive records), with a reason code for each withheld. The existing modules ask it instead of their own checks, and a matrix test pins today's behaviour first, so nothing changes by default.

## Versioning conventions

- **The public API** is `/api/v1`. Changes within v1 add: a new field, a new route, a new value of an enumeration a client already ignores when unknown. Anything else is a `/api/v2` route beside the first. The OpenAPI document is generated (`contracts/openapi.json`), and CI fails when it drifts from the code.
- **The game protocol.** Commands carry `"v": 1` (`contracts/engine-command.schema.json`); the seat view, the spectator view and SysOp's inspection have closed JSON schemas, and every snapshot in CI's games is validated against them. A WebSocket message type the page does not know is ignored, so new ones are added freely; a changed meaning is a new type.
- **The engine's service routes** are the API's alone (the service token) and change with it in one release: the API and the engine of a version are deployed together.
- **Recordings** carry a layout version (`Recording.FORMAT`, 1) and the engine build's key; another layout is refused as incompatible, as another build is. Journal records are typed, and a reader skips a type it does not play.
- **Events** (v0.9.10) will carry a schema version per event, and their reader will keep reading every version it once wrote, since events outlive engine builds.
- **Content** (`content/*.json`) is validated by its own schema at start-up; the campaign's rules carry their own version (`campaign-v1`).

## Migrations and rollback

The rule since v0.8.3 holds: a migration only adds what the previous version can ignore (tables, nullable columns, columns with defaults, indexes), and a drop or rename waits for a later version that no longer uses it ([deployment](../deployment.md#deploying-a-version)). `deploy.sh` dumps the database before migrating, migrates while the old version serves, and brings the previous version back when the new one does not start.

- **v0.9.9 adds no migration.** It adds the `engine_recordings` volume. Rolling back to v0.9.8 needs no restore: v0.9.8's engine ignores the volume, and the games running at the rollback end interrupted as at any upgrade.
- **v0.9.10's and v0.9.11's** tables (grants, modes, events, profiles, groups, leagues, quotes) are new tables and nullable columns. `games.mode` is filled for old rows from `kind` and the campaign's link in the same migration, and read with a default until it is.
- **Account data.** Each migration is run in CI against a database holding a representative account (a library, decks with revisions, ledgers, quests, achievements, campaign progress, auctions), and the account's totals are compared before and after. This test is v0.9.10's first piece of work, before its first migration.

## The engine's known limits, each with something that runs

| Limit | Evidence |
| --- | --- |
| An upgrade ends running games: a recording is played on only by its own build | `RecordingDamageTest.aRecordingThatIsMissingDamagedOrAnotherBuildsIsRefusedInWords`, `ServiceRecoveryHttpTest.whatCannotBeGivenBackIsRefusedInWords` |
| A game that loses its newest checkpoint and has bots may come back as another legal game | `RecoveryTest` (its lost-checkpoint Commander games) |
| An object made since the last checkpoint may come back under another id | `RecoveryTest`'s situation counts; [recording and recovery](../engine/recovery.md#what-is-not-supported) |
| A recording that stopped gives back no game | `RecordingDamageTest.aRecordingThatStoppedIsNotPlayedOn`, `aGameWhoseStateCannotBeWrittenStopsItsRecordingAndIsNotPlayedOn` |
| One engine process: a game that exhausts the heap restarts the engine for every game (each is then taken up) | `ServiceRecoveryHttpTest.aGameOfADeadEngineIsGivenBackByTheNextOne`; isolation is v0.9.10's |
| A game taken up five times with no answer between is given up | `ServiceRecoveryHttpTest.aGameThatKeepsBeingInterruptedIsGivenUp` |
| Bots are not reproducible: a search is cut off by the clock and the heap | `RecoveryTest` checkpoints after every decision for this reason; [fair bots](../engine/fair-bots.md) |
| A six-seat court game peaks at 3 to 4.5 GB of heap | The campaign difficulty workflow's court runs ([fair bots](../engine/fair-bots.md#a-searchs-memory-v098)) |
| The text changers, Spy Kit and other cards need engine pieces XMage lacks | `docs/plans/0.9.9.md`, "Carried from v0.9.8"; the stand-in tests |
| XMage gives a gained ability a new id at each effects application | `RecoveryTest`'s King's Table game; the journal names such choices by their object and words |

## Stale descriptions corrected in v0.9.9

- [Deployment](../deployment.md): "Restarting the API interrupts every running game" now says an upgrade ends them and a restart does not.
- [Games through the API](../games.md): the restart paragraph, the `interrupted` message, and "Recovery and replay journals remain later work".
- [The backlog](../backlog.md): recovery (NET08–NET09) is done.
- [The human seat](../engine/human-seat.md): its open item on recovery.
- [The v0.9.9 plan](0.9.9.md): the foundations' last column was a first reading; it now says what was checked.
- `EngineBuild` said a release that changes nothing in the engine keeps its build key. An image built anew has another (a jar carries the times its files were built), so every release's engine has its own.

The "Not yet" lists of old versions' documents (v0.0.6's games, v0.3.0's game screen) describe those versions and are left as they were.
