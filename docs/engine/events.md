# A game's structured events (v0.9.10)

Every game the engine plays now keeps an ordered record of what happened in it, in the schema's own words: a card drawn, a spell cast, an attack, damage and who dealt it, a life total changed, a counter added, a player eliminated. It is the shared foundation the specification's §7 asks for, which v1.0.0's explainable timeline, replays and spectators will read. The events are made by the engine, kept by the API past the game, and shown to anyone only through one perspective filter.

## Made by the engine

`GameEvents` (engine) listens to XMage's own `GameEvent`s on the game's thread through a watcher in the game's state (`GameEvents.Tap`). A copy of the game keeps the watcher; a bot's simulation is left out (`Game.isSimulation`), and a checkpoint's copy is never played. Each event is:

| Field | What it holds |
| --- | --- |
| `v` | The schema's version, 1. A reader keeps reading every version it once read |
| `seq` | Its number in the game's sequence, from 1, without a gap |
| `epoch` | How many times the engine had taken the game up when it made the event ([below](#across-a-recovery)) |
| `turn`, `step` | When: the turn's number and the step's name (`untap`, `draw`, `precombat_main`, `declare_attackers`, `combat_damage`, ...) |
| `type` | What: `step`, `zone_change`, `cast`, `activate`, `trigger`, `target`, `resolve`, `countered`, `attack`, `block`, `damage`, `life_gained`, `life_lost`, `counters_added`, `counters_removed`, `token_created`, `eliminated`, `won` |
| `player`, `active` | Seats, by number |
| `object`, `target`, `cause` | An object: `ref` (the id the seat views show it under, `o` and sixteen hex digits), `name`, `owner` (a seat), `seen_by` (`"all"` or the seats that may see it), and for a zone change `was` (its id where it was). Or a player: `{"seat": n}` |
| `from`, `to` | A zone change's zones (`library`, `hand`, `battlefield`, `graveyard`, `stack`, `exiled`, `command`) |
| `amount`, `combat`, `counter` | Damage, life and counters: how much, whether combat damage, which counter |

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

So the schema carries the cause where XMage has one and leaves it out where it has none. An explanation of a death (v1.0.0's timeline) reads the damage events before it; what no event says, the timeline must say it does not know, as the specification asks ("honest fallback").

## Across a recovery

In a recorded game the events are written beside the recording's journal (`events.jsonl`), one JSON line each, and a checkpoint keeps the sequence number it was taken at (`Checkpoint.eventSeq`). A game taken up again keeps the events up to its checkpoint and makes the rest again as the journal is played, under the next `epoch`. A game two people play is made again exactly: the same events, numbered the same (`ServiceRecoveryHttpTest.aGamesEventsGoOnAcrossARecoveryUnderTheNextEpoch`). A game that lost its newest checkpoint may come back as another legal game ([recording and recovery](recovery.md#what-is-not-supported)); its events are then that game's, from the checkpoint on.

## Kept by the API

`GET /v1/service/games/{id}/events?since=N&limit=M` (the service token) answers the events after `since`, oldest first, at most 2,000, with the game's `epoch` and `next`. A game no process runs any more is answered from its recording.

The games' hub (`api/games.py`) reads each running game's new events at most every five seconds, on a task of its own, and once more when the game ends (`GameHub.read_events`); `api/events.py` keeps them in `game_events`, one row an event by game and number, each once. When the engine's epoch is newer than the one kept, the game was taken up again: the whole log is read again and replaces what was kept.

**Retention.** A finished or interrupted game's events are kept 90 days after it ended (an interrupted one from its start), then removed by the worker's daily job (`api/accounts.py` `prune_events`, `events.sweep`). Ninety days is Claude's choice, 2026-11-12: the owner left the question open.

## Read through one filter

`api/events.py` `filtered` is the only way an event leaves the API:

| Perspective | Who | Sees |
| --- | --- | --- |
| A seat | A player of the game, their own seat; a replay is the viewer's own seat's | Every event; an object's identity where the seat is in `seen_by`, or it is everyone's. A teammate is its own seat, and the engine has already put teammates in each other's `seen_by` |
| A spectator | (v1.0.0's spectators, through access grants) | Only what every seat may see |
| Inspection | SysOp, and an administrator outside a game they play against people (`games.concealed_for`, as for SysOp's eye) | Everything, with `seen_by`. Each reading is audited (`games.events_inspected`) |

An object a perspective may not see becomes `{"hidden": true, "owner": n}`: its id, its name and its id before a move are all withheld, so nothing in an event's ids or metadata tells which card it was. Outside inspection `seen_by` itself is left out. `tests/test_events.py` checks every perspective against events of every visibility, and that no withheld id or name appears anywhere in what is shown.

`GET /api/v1/games/{id}/timeline?since=&limit=&turn=&type=&view=` reads them: a player of the game through their seat's eyes, SysOp with `view=inspection`; anyone else is answered 404, so that a game's existence is not told either. Retrieval by game and number, by turn and by kind is indexed.

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
