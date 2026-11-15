# A game's structured events (v0.9.10)

Every game the engine plays now keeps an ordered record of what happened in it, in the schema's own words: a card drawn, a spell cast, an attack, damage and who dealt it, a life total changed, a counter added, a player eliminated. It is the shared foundation the specification's §7 asks for, which v1.0.0's explainable timeline, replays and spectators will read. The events are made by the engine, kept by the API past the game, and shown to anyone only through one perspective filter.

## Made by the engine

`GameEvents` (engine) listens to XMage's own `GameEvent`s on the game's thread through a watcher in the game's state (`GameEvents.Tap`). A copy of the game keeps the watcher; a bot's simulation is left out (`Game.isSimulation`), and a checkpoint's copy is never played. Each event is:

| Field | What it holds |
| --- | --- |
| `v` | The schema's version: 2 since v1.0.0 ([below](#version-2-v100-what-the-timeline-asks)), 1 before. A reader keeps reading every version it once read |
| `seq` | Its number in the game's sequence, from 1, without a gap |
| `epoch` | How many times the engine had taken the game up when it made the event ([below](#across-a-recovery)) |
| `turn`, `step` | When: the turn's number and the step's name (`untap`, `draw`, `precombat_main`, `declare_attackers`, `combat_damage`, ...) |
| `type` | What: `step`, `zone_change`, `cast`, `activate`, `trigger`, `target`, `resolve`, `countered`, `fizzled` (version 2), `attack`, `block`, `damage`, `life_gained`, `life_lost`, `counters_added`, `counters_removed`, `token_created`, `eliminated`, `won` |
| `player`, `active` | Seats, by number |
| `object`, `target`, `cause` | An object: `ref` (the id the seat views show it under, `o` and sixteen hex digits), `name`, `owner` (a seat), `seen_by` (`"all"` or the seats that may see it), and for a zone change `was` (its id where it was). Or a player: `{"seat": n}` |
| `from`, `to` | A zone change's zones (`library`, `hand`, `battlefield`, `graveyard`, `stack`, `exiled`, `command`) |
| `amount`, `combat`, `counter` | Damage, life and counters: how much, whether combat damage, which counter |
| `tally` | Since v1.0.0, on the events that changed them: every seat's public counts ([below](#every-seats-counts-v100)) |

Nothing XMage keeps for itself reaches an event: no XMage id (`GameEventsTest` checks every event of real games), no presentation text. Objects are named by the seat views' ids (`ObjectRefs`), which are stable across a recovery since v0.9.9.

### Who may see an object

The event's kind, its seats, zones, amounts and turn are public: every seat sees that a card was drawn or put into a library, as at a real table. An object's identity carries `seen_by`, decided by the same rules that build the seat views (`Visibility`): where the object is after the event, and for a zone change also where it was before it. So a card drawn is its owner's to see (and in Two-Headed Giant its owner's teammate's, 810.5); a card discarded, cast face up or put onto the battlefield everyone's; a face-down creature its controller's; a card exiled face down nobody's but a player the rules let look at it. Measured on real games: every draw is its owner's alone at a Commander table, and its owner's and their teammate's in Two-Headed Giant; every spell cast face up is everyone's (`GameEventsTest`).

### How much cause XMage gives

The plan asked for this to be measured before the schema was fixed. Three four-seat Commander games (bots at skill 3, 14 turns each, 539 events; `GameEventsTest.howMuchCauseTheEventsCarry`), counting the events whose cause XMage names:

| Event | With a cause |
| --- | --- |
| Damage | 29 of 29: every damage event names its source |
| Target | 8 of 8 |
| Life gained | 5 of 7 |
| Life lost | 2 of 18: life lost to damage names no source; the damage event before it does |
| A permanent exiled | 2 of 2 |
| A permanent put into a library, a card put onto the battlefield from a library | 1 of 1 each |
| A creature put into a graveyard | 0 of 3: a creature that dies of its damage is put there by the rules (704.5g), not by a source; the damage that killed it is the event before |
| Draws, casting, resolving, attacks, blocks, steps | None, and none to give: the player or the rules did it |

So the schema carries the cause where XMage has one and leaves it out where it has none. An explanation of a death (v1.0.0's timeline) reads the damage events before it; what no event says, the timeline must say it does not know, as the specification asks ("honest fallback"). Version 2 adds what XMage's events do not say and the game still knows as they happen.

## Version 2 (v1.0.0): what the timeline asks

The owner's decision of 2026-11-15 ([the timeline](../timeline.md#the-owners-decisions-2026-11-15)): the events are extended so that a player can understand a cost that changed, a death, and a spell that did not resolve. XMage has no event for any of the three; `GameEvents` reads them from the game as its events pass. Each is told only where the game is sure of it, and a reader of version 1 events finds none of them.

| Addition | On | What it holds |
| --- | --- | --- |
| `cost.paid` | `cast` | The mana the spell's player had to pay, in one line with its generic part first and summed (`{3}{R}`, `{0}` for nothing): the printed cost after X, additional and alternative costs, raises and reductions. Public, as the mana paid is at a table |
| `mana_cost` | a `cast`'s `object` | The card's printed cost. It is part of the object, so it is hidden with it |
| `cost.x`, `cost.mode` | `cast`, for a spell every seat may see | The X chosen for a cost with X; the way it was cast if not the usual one (`flashback`, `madness`, ...) |
| `cost.changes` | `cast`, for a spell every seat may see | What changed the cost. Commander tax as `{"how": "more", "tax": true, "amount": 2}`, by the casts from the command zone before this one (903.8); each cost-changing effect that applies to the spell as `{"how": "more" \| "less" \| "set", "by": <object>}`, by its source, each source once |
| `why` | a `zone_change` from the battlefield | `destroyed` or `sacrificed` (XMage said so before the move); `lethal_damage` or `deathtouch` (destroyed by no source, with damage at least its toughness, or damage from a source with deathtouch: 704.5g, 704.5h); `toughness` (a creature with 0 or less put into the graveyard by no source, 704.5f); `loyalty` (704.5i); `legend_rule` (a legendary permanent whose player still controls another of its name, 704.5j); `unattached` (an Aura, 704.5m). Left out where none is so |
| `immediate` | `resolve` | True for a resolution that never was on the stack: a mana ability, a special action. XMage tells every resolution alike; before version 2 a land tapped for mana read as any spell's |
| `fizzled` | a type of its own | A spell or ability that left the stack without resolving or being countered: `of` (`spell` or `ability`), `player`, `object` (as its cast, activation or trigger named it) and `why`: `targets` (every target illegal, 608.2b) or `condition` (a triggered ability's condition no longer true, 603.4) |

**A spell cast face down** carries `cost.paid` alone. Its `mana_cost` is in its object, which only its controller sees; `x`, `mode` and `changes` are left out, since what applies to the card beneath would tell what it is.

**How each is known.**

- *The cost.* At XMage's `SPELL_CAST` the spell is on the stack with its costs paid: `paid` is its ability's cost to pay, the printed cost its card's. The changes are XMage's cost modification effects that are in force, in a zone where they work, and apply to the spell: the same test the payment prompt's "The cost is raised by …" has used since v0.8.8, here for raises, reductions and set costs alike, each with its source as an event's object (who may see it included). An effect that no longer applies once the spell is cast (one that counts the first spell of a turn) names nothing: the timeline then says that the game recorded no reason for the difference.
- *Commander tax.* The game's own count of each commander's casts from the command zone, kept in the watcher that taps the events (`GameEvents.Tap.commandCasts`), so that it is part of the game's state: right after a recovery and a rollback, and whatever the order XMage asks its watchers in (its own count of the same may or may not include the cast being told).
- *Why a permanent left.* XMage tells `DESTROYED_PERMANENT` and `SACRIFICED_PERMANENT` at once and the zone change at the end of the action, so the first is remembered for the second, by the permanent's count of zone changes: a later departure of the same card is never taken for this one. The state-based reasons are read from the permanent as it left (its damage, toughness, loyalty, name and type), only for a move with no source.
- *A fizzle.* Every spell and ability put onto the stack is followed. One that has left it without a `resolve` or `countered` of its own is judged: a spell XMage marked as countered by the rules (it does so for a spell whose targets are all illegal), an ability whose targets are no longer legal, a triggered ability whose condition no longer holds. Anything else says nothing: a permanent spell that became a permanent, an optional ability its player declined.

**Measured** on games played through the prompts (`TimelineEventsTest`, `CommanderScenarioTest`): Lightning Bolt under Sphere of Resistance is `paid` `{1}{R}` with one change by the Sphere; three Grizzly Bears die by `lethal_damage`, `destroyed` (by Doom Blade) and `toughness` (Disfigure); a Bolt and a Prodigal Pyromancer's ability whose targets were sacrificed in response are `fizzled` by `targets`, and Viscera Seer's own ability is not; the second Isamaru leaves by `legend_rule`; a commander's second cast is `{2}{W}` with a tax of 2 and its first has no change; a Mountain's mana is `immediate` and the Bolt's resolution is not.

**Not told:** the cost of an activated ability; why an optional ability did nothing; which replacement sent a card elsewhere; a cost's change by an effect that stopped applying as the spell was cast. A game the engine takes up again is followed from what its checkpoint had on the stack, so a spell cast before the checkpoint that fizzles after it is told as it was the first time.

### Every seat's counts (v1.0.0)

What [a replay](../replays.md#the-scoreboard)'s scoreboard reads. An event carries `tally` when the counts are no longer what an event last told: one array a seat, in the seats' order, of five numbers:

| Place | Count |
| --- | --- |
| 0 | Life |
| 1 | Cards in hand |
| 2 | Cards in library |
| 3 | Cards in graveyard |
| 4 | Permanents the player controls (phased out ones left out) |

`"tally": [[20, 6, 53, 0, 1], [17, 7, 53, 0, 0]]`: seat 0 at 20 life with six cards in hand, seat 1 at 17 with seven.

- **Public.** Each is what any player may count at a table (402.3, 401.3), and what every seat's view already shows. The perspective filter passes it unchanged.
- **Why the events tell them.** The opening hands and their mulligans are dealt before a game's first event (measured on a real Legacy game: its first event is turn 1's first main phase), so no count of the moves that are told would find a hand's size. Control changes and phasing are not moves either.
- **When.** They are read from the game as the event is made (`GameEvents.tally`), and told only when they differ from the last telling, so the game's first event after its first step marker always carries them and a life change always does. A step's marker carries none: it stands before the event that brought it, and that event tells them.
- **A step ahead within an action.** XMage tells the moves of a simultaneous action after making all of them, so the first of three draws already tells a hand three larger. Life is told exactly: XMage tells each gain and loss as it happens (`GameEventsTest` checks every life event of a Commander game against the counts).
- **Across a recovery.** A game taken up again remembers the last telling among the events it kept, so the events made again carry the counts where the first telling did.

Events made before this (the live site's, up to v0.9.14) carry none; a replay then counts life from each seat's start and says that the other counts are not known.

## Across a recovery

In a recorded game the events are written beside the recording's journal (`events.jsonl`), one JSON line each, and a checkpoint keeps the sequence number it was taken at (`Checkpoint.eventSeq`). A game taken up again keeps the events up to its checkpoint and makes the rest again as the journal is played, under the next `epoch`. A game two people play is made again exactly: the same events, numbered the same (`ServiceRecoveryHttpTest.aGamesEventsGoOnAcrossARecoveryUnderTheNextEpoch`). A game that lost its newest checkpoint may come back as another legal game ([recording and recovery](recovery.md#what-is-not-supported)); its events are then that game's, from the checkpoint on.

## Kept by the API

`GET /v1/service/games/{id}/events?since=N&limit=M` (the service token) answers the events after `since`, oldest first, at most 2,000, with the game's `epoch` and `next`. A game no process runs any more is answered from its recording.

The games' hub (`api/games.py`) reads each running game's new events at most every five seconds, on a task of its own, and once more when the game ends (`GameHub.read_events`); `api/events.py` keeps them in `game_events`, one row an event by game and number, each once. When the engine's epoch is newer than the one kept, the game was taken up again: the whole log is read again and replaces what was kept.

**Retention.** A finished or interrupted game's events are kept 90 days after it ended (an interrupted one from its start), then removed by the worker's daily job (`api/accounts.py` `prune_events`, `events.sweep`). Ninety days was assumed on 2026-11-12 and is the owner's decision since 2026-11-14.

**Read as they are asked for (v1.0.0).** A timeline asked for reads a running game's new events from the engine first, unless they were read within the last second or are being read (`GameHub.events_fresh`): the timeline's reader sees what has just happened, and many readers ask the engine once.

## Read through one filter

`api/events.py` `filtered` is the only way an event leaves the API:

| Perspective | Who | Sees |
| --- | --- | --- |
| A seat | A player of the game, their own seat; a replay is the viewer's own seat's | Every event; an object's identity where the seat is in `seen_by`, or it is everyone's. A teammate is its own seat, and the engine has already put teammates in each other's `seen_by`. The same for the sources of a cost's change (`cost.changes[].by`, version 2) |
| A spectator | (v1.0.0's spectators, through access grants) | Only what every seat may see |
| Inspection | SysOp, and an administrator outside a game they play against people (`games.concealed_for`, as for SysOp's eye) | Everything, with `seen_by`. Each reading is audited (`games.events_inspected`) |

An object a perspective may not see becomes `{"hidden": true, "owner": n}`: its id, its name and its id before a move are all withheld, so nothing in an event's ids or metadata tells which card it was. Outside inspection `seen_by` itself is left out. `tests/test_events.py` checks every perspective against events of every visibility, and that no withheld id or name appears anywhere in what is shown.

`GET /api/v1/games/{id}/timeline?since=&limit=&turn=&type=&view=` reads them: a player of the game through their seat's eyes, SysOp with `view=inspection`; anyone else is answered 404, so that a game's existence is not told either. Retrieval by game and number, by turn and by kind is indexed.

Since v1.0.0, for [the timeline's screen](../timeline.md#narrowing-it): `before=N` answers the last events before a number (still oldest first), `type` takes several kinds with commas, `seat=N` keeps what a seat did, what was done to it and its cards, and `q=` keeps the events that name a card (part of a name, whatever the case). The seat and the name are judged on each event as the reader's perspective shows it, never on the stored rows, so a card hidden from the reader is found by no name. The answer says where to go on (`next`, `first`), whether more fits (`more`), and whose turn each of its events' turns was (`turns`, the turn's number to its active seat), since a narrowed page holds no steps to tell it.

**The developer's timeline viewer** is `python -m api.cli timeline <game id> [--seat N | --spectator | --inspection]`, run where the API's settings are (`docker compose exec api python -m api.cli timeline ...`): one line an event, through the same filter. The first lines of the recovery test's duel, as seat 0 sees them (a card another seat drew reads `a hidden card of seat 1`):

```
    1  T1 precombat_main          -- step (active seat 0)
    2  T1 precombat_main          zone_change seat 0 Mountain [o41998a34e526f6eb] hand -> battlefield
    3  T1 precombat_main          zone_change seat 0 Lava Spike [o56eac26055fadcf3] hand -> stack
```

## What is not supported

- **Events of games before v0.9.10** do not exist: XMage's text log is all they have.
- **Bots' simulations** make no events, by design.
- **An event's cause** is what XMage names (above); the schema invents none.
- **Events outlive a recording**, which the engine sweeps 24 hours after the game; the API's copy is the one that is kept.
