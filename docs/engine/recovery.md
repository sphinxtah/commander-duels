# Recording and recovery (v0.9.9)

Every game people play keeps a recording of itself, on disk, in the engine. A game whose engine process is gone (it ran out of memory, the container was restarted, the host went down) is taken up again from its recording, where it stood, and no seat can tell the two apart. A game the API has lost track of (its own restart) is followed again. Before v0.9.9 both ended every running game as interrupted.

This is the first foundation of [the Preparation Framework](../plans/0.9.9.md), and v1.0.0's reconnecting screens, save and resume, and replays stand on it.

What it proves, each by tests that run:

- **An interrupted game goes on legally from what was stored.** In every format a real game was left as a dead process leaves it and taken up again, 587 times in one run of the suite, in the middle of whatever it was doing: with spells and responses on the stack, attackers and blockers declared, a payment half made, a target half chosen, mulligans, teammates, commanders in every zone with their tax and damage (`RecoveryTest`).
- **Each seat sees what it saw.** After each of those interruptions every seat's whole view, the question it was asked with every choice, its log, and every hand and library in order were compared with before. At a priority prompt, where a game rests nearly all the time, they are identical, the ids objects are shown under included. The same checks that watch a game's views for concealed information watched each game across all its interruptions (`SeatChecks`).
- **The turn goes on as the rules have it.** A game built to have an extra step, two extra phases and an extra turn, interrupted before every one of its 134 answers, comes to the same log line for line as the same game played straight through (`RecoveryStructureTest`).
- **Nothing is done twice.** An answer sent again after the recovery is answered as it was and not given a second time; a concession stays one concession; a game with a result is never taken up, so its result cannot be reached twice (`RecordingDamageTest`, `ServiceRecoveryHttpTest`, `tests/test_recovery.py`).
- **Bad data fails safely and says so.** A checkpoint that fails its checksum, is cut short, is not a checkpoint, holds another state than the one saved, or is another build's is passed over for the one before it, and what was wrong is reported in words. A recording that cannot give back the game that was played gives back none: one whose checkpoints are all lost, and one that stopped while its game went on (`RecordingDamageTest`).

What it does not prove, and what is not supported, is [below](#what-is-not-supported).

## Why a checkpoint and a journal

The specification asked for snapshots, deterministic replay of events, or both. Neither alone can do it here.

**A replay from the seed cannot.** A bot's search is cut off by the clock and by the heap, and does not decide the same twice. XMage names every object by a random id, so a game dealt again has other objects. And XMage's rules are Java code that walks hash tables: nothing promises the same order twice.

**A snapshot alone cannot.** XMage's state is whole only between decisions. In the middle of one (a spell half cast, a blocker half declared, a search effect half resolved) the rest of what is happening is on the game thread's call stack, not in the state, and a state saved there could not be resumed. Yet that is exactly where a person is most often asked something.

So a recording has both:

- **Checkpoints**: the game's whole state, taken at each point XMage can later go on from. There are three: as a player is about to receive priority (before the state-based actions and triggers of rule 117.5, so that whatever they ask is asked again); once more after those, if they changed anything (so that what they put on the stack is not made a second time); and as every player has passed in succession, before the stack's top resolves or the step ends. Between two such points lies at most one decision at priority.
- **A journal**: every answer and command a seat sends, in order, forced to disk before the engine acts on it or tells the seat it was accepted.

Recovery takes the newest checkpoint and plays the journal's later records on top of it, each as the answer to the question the game asks again.

**No bot's search is ever run again to get back to a question.** A checkpoint is taken after every decision at priority, and the one a seat's question stands on is written to disk when the question is asked. What a bot's search found in the time it had is in that checkpoint. What lies between a checkpoint and the next question is only what XMage does without searching (declaring attackers and blockers by its rules of thumb, choosing targets as an effect resolves), and each bot's own random generator is kept in the checkpoint as it stood, so it draws what it drew.

**An answer is never applied to a question it was not the answer to.** Each journal record carries a fingerprint of the question it answered: its kind, whose decision it is, every choice, the limits of its amounts. A game taken up again that asks something else (it should not, and the tests found the two cases where it did, [below](#what-the-tests-found)) drops the rest of the journal and goes on, legally, from there; the engine's log says which question and which record.

## What a recording is

A folder named for the game, under `CD_ENGINE_RECORDINGS` (`/var/lib/commander-duels/recordings` in the engine's image, the `engine_recordings` volume in both Compose files).

| File | What it holds |
| --- | --- |
| `manifest.json` | Written once, before the game begins: the game's id, the request it was made from (with its seed and its decks), each seat (a person's or a bot's, its deck's name and a digest of the deck) and what the recording is bound to |
| `journal.bin` | One record for each answer, concession, change of a seat's priority settings and change of the bots' switch, with the reply the seat was given, appended in order. Each is framed with its length and a checksum. Also the recorder's own notes: that the game has had its first checkpoint, that it was taken up, how playing the journal again went |
| `checkpoint-NNNNNNNNNN.bin` | A header (which checkpoint, the journal record it stands on, turn and step, sizes, a checksum, a digest of the state, the engine's build) and the state, serialized and compressed. The newest two are kept |
| `result.json` | The game's result, once it has one. A recording with a result is over: its checkpoints are removed, and no game is ever made from it |
| `stopped.json` | Only if the recording could not be kept up ([below](#what-is-not-supported)): when it stopped and why. The game went on without it, and no game is ever made from it |

**What a checkpoint holds.** XMage's own copy of the game (the copy it makes for its saved states and its searches), so the game plays on untouched while the checkpoint is written on another thread; the generator the game's shuffles and coin flips draw from, as it stood; each bot's generator, budget, habits and statistics; the ids every seat has been shown objects under; the log; each seat's revision and messages; who has conceded; the bots' switch.

**What it is bound to.** One key for the engine's build: a digest of everything on its class path, which is the engine's own classes, XMage with the patches it was built with, every card's implementation and any plugin's cards (`EngineBuild`). A saved state is those classes' objects, and another build's rules and cards would not play the same game, so a game goes on only in an engine with the same key. The manifest also names the XMage version and commit, the format and the rules profile, and a digest of each seat's deck, for a person reading it. Two engines started from the same image have the same key.

**Sequence numbers.** Journal records are numbered from 1 and checked in order. A checkpoint is numbered and names the journal record it stands on: every record up to that one is in its state, and the ones after it are played again. A seat's revisions go on across a recovery: each recovery starts a new stretch a million further on, so a seat waiting for something newer than what it last saw is always answered.

**Object ids.** A seat never sees XMage's ids. Since v0.9.9 the id an object is shown under is a keyed digest of the object under a secret the game alone holds, in place of a random number, and the secret is in the checkpoint: a game taken up again names every object by the id it had, also the ones a seat was first shown after the checkpoint was taken. To a client an id is as good as random, as before.

## What a recording costs

Measured by `RecordingCostTest` on a two-core machine, each game played by a script that answers at once, 150 answers:

| Game | A state taken, on the game's thread | A checkpoint written, on its own thread | A journal record | On disk while it runs |
| --- | --- | --- | --- | --- |
| Legacy duel, two people | 2.0 ms | 84 KiB in 35 ms | 0.3 ms | about 0.2 MiB |
| Two-Headed Giant, two people and two bots | 1.4 ms | 161 KiB in 57 ms | 0.2 ms | 0.4 MiB |
| Commander, one person and three bots | 2.8 ms | 264 KiB in 106 ms | 0.2 ms | 0.6 MiB |
| King's Table, one person and five bots | 2.5 ms | 378 KiB in 138 ms | 0.1 ms | 0.8 MiB |

A state is taken each time a player is about to receive priority and each time all have passed: a few milliseconds beside a bot's search of tens to hundreds. A checkpoint is written when a seat is asked something and, while only bots play, every `CD_ENGINE_CHECKPOINT_SECONDS` (3). An answer is not accepted until the checkpoint its question stands on is on disk, which by the time a person has read the question it is; the script, which answers at once, waited about a tenth of a second each time. Sixty-four games at once keep under 100 MiB of recordings.

Taking a game up took 0.1 to 0.4 seconds from the request to the seat being asked.

## What the API does

The engine takes nothing up by itself: a game nobody asks for is nobody's game. The API asks, with `POST /v1/service/games/{id}/attach` ([the routes](../games.md#recordings-and-attaching-v099)):

- **The engine was restarted or died.** The API's follower finds the game unknown and asks for it again, once for all of its seats. The engine takes the game up from its recording and hands out new seat tokens. The players' tabs, which never disconnected from the API, get the game's view again at a revision far on, and play on. While the engine is down or still loading its cards, the API goes on asking for three minutes.
- **The API was restarted.** At its start it asks for every game it still counts as running. A game still running in the engine gets new tokens (the old ones were the old process's alone, and stop working); a game the engine also lost is taken up; a game that ended meanwhile is answered with its result, which is recorded as a follower would have recorded it, with its win, its pay and its rewards, once. A tab that connects while its game is still being asked for is told to try again (close code 4503), not that the game is gone.
- **The engine cannot give the game back.** It has no recording of it, or the recording is damaged or another build's. The game ends interrupted and is closed in the engine, as every running game did after a restart before v0.9.9. No result is recorded and nobody loses.

What the API kept only in memory is gone with its process: which tab held each seat's controller lease (the tabs reconnect and take it again), the votes on an away player, and a table's alliances and offers other than its teams'. The away clock starts again.

## What is not supported

- **An upgrade ends the running games**, as before. A new version is a new engine build, and a recording is played on only by the build that made it: the API is told the recording is incompatible and records the game interrupted. To spare the players, upgrade while no game is running, or let games finish first ([deployment](../deployment.md#recordings-v099)). Keeping an old engine alive beside a new one for its games is v1.0.0's question.
- **The fraction of a second while a checkpoint is being written.** A process that dies between a question being asked and its checkpoint reaching the disk goes back to the checkpoint before, and the same if the newest checkpoint is damaged. Between people the journal then brings the game back to the same question (`RecoveryTest`'s lost-checkpoint games: 50 of 50). With bots at the table a bot may decide otherwise than it did the first time: the game is legal, shows no seat anything it may not see and ends with one result (23 of 23), but it need not be the game that was being played, and an answer given since that older checkpoint may be asked for again.
- **Bots playing alone.** While no person is asked anything, a checkpoint reaches the disk every three seconds. A process that dies then takes the game back up to three seconds, and the bots decide again from there.
- **An object made since the last checkpoint.** Inside an action or a resolution the game is taken up from the checkpoint before it and the journal plays the seat's answers again; an object that came into being on the way (a token, a triggered ability, a copy) is made a second time, and XMage gives it a new identity. It is the same object in the same place under another id, and everything else is identical. If such an object was among the choices of a question the seat had already answered in that same action, that question no longer matches its record, and the action's questions are asked again from there. In the runs made while this was built, more than a thousand interruptions, an object came back under another id once, and no question was asked again for it.
- **A game that lost every checkpoint** is refused, whoever sits at it: dealt again from its seed it would be another game, at its first turn. Only a game that never had a checkpoint (it was interrupted in its mulligans) is dealt again, which is exact: the seed deals the same hands, and the journal's keeps and mulligans are played on them.
- **A game that keeps being interrupted.** Taken up five times in a row with no seat answering in between, a game is given up: what interrupts it (a board no heap holds, most likely) would come back each time and take the engine's other games down with it.
- **A state that cannot be written.** XMage copies its objects and never serializes them, so nothing had ever noticed that some classes cannot be written by Java. Writing every card of the card database once found 37 of 33,612 that could not be; patch 0019 made them writable, and `SerializableCardsTest` now fails if a card is not. What a card makes only while it is played (an effect, a watcher) is not covered by that test. A state that cannot be written costs that one checkpoint: the one before it stands, the next is tried, the engine's log names the class, and the count is in the numbers below. Eight in a row stop the game's recording.
- **A recording that stopped.** A disk that refuses a write (it is full, or failing) stops that game's recording, as eight unwritable states in a row do. The game plays on: it is not ended because its insurance lapsed. But from then on the recording is behind its game, and a game taken up from it would put its seats back to wherever it stopped, turns ago perhaps, as if that were the game. So the recording says that it stopped (`stopped.json`, written after its checkpoints are removed, whose room a full disk may need for it), and it is refused from then on: if the engine loses that game, the game ends interrupted, as every game did before v0.9.9. If even the note cannot be written, the manifest is removed, which needs no room and leaves no recording. A game that ends after its recording stopped still has its result written, and is answered as over. One case is left: a disk that refuses the note and the removal both, and then works again by the time the engine is restarted. Nothing on that disk can tell that recording from a good one.
- **The owner's private cards** are not in this repository, and neither test above reads them. Their nine scripted games (each card, and the seven emblems) were played once against this engine with recording on: 485 checkpoints were read back at the questions asked, and no state was skipped. That was a check made while v0.9.9 was built, not a test that runs with every build.
- **Rolling a game back, saving one to play later, and replays** are not here. v1.0.0 builds save and resume on this, and replays on the event framework.

## What the tests found

Building it with the tests running found these, each fixed:

- **XMage could not resume in the middle of a turn.** Its own resume is for a game paused in memory: it finds its place by "the phase after this one", fires the step's and the turn's events again, and knows nothing of extra steps, phases or turns. Patch 0018 adds an exact resume, with the turn and the phase keeping in the state where their loops are.
- **A game read back could not run.** Several fields XMage cannot do without are left out of what is saved and were set only when the object was made. Patch 0018 makes them anew.
- **A checkpoint held the table's own players.** XMage's copy of a player keeps references to the player it was copied from (its match entry, and a field the copy constructor sets to its original), and a bot keeps its search's whole tree. A Commander checkpoint was 6 MB instead of 1.5, and writing it failed while the game went on changing those objects on another thread. Patch 0018 leaves the three out of what is saved.
- **A concession XMage had been handed and not yet applied was lost.** XMage keeps those beside its state and applies one the next time a player would receive priority. A game taken up now hands them over again.
- **An ability's id does not last.** XMage gives an ability that a permanent gains from an effect a new id each time it applies its effects: King's Table's Deploy on every creature, an Equipment's activated ability. The question "which ability?" never matched its journal record. The journal now names such a choice by its object, its words and its place among the like ones.
- **A result was told before it was kept.** The seats heard a game's result before the recording had it, so a process that died in between left a game whose result was known and which could be played on to another. The recording has it first.
- **A seat's log** shows the lines up to its last view, and after a recovery up to then: a line that changed nothing on its board, which the seat would have been shown with its next view, is shown at once. No line is lost, shown twice or made up.
- **A recording that had stopped would have been played on.** The first design let a game whose recording had failed be taken up from the last thing written: a game at its tenth turn would have come back at its fifth, or at its first hand. A recording that stops now says so and is refused ([above](#what-is-not-supported)).
- **An answer asked for a state that was already being written.** An answer that arrived while its checkpoint was on its way to the disk marked the next state as wanted too, so the state after every such answer was written unasked: twice the writing, and two checkpoints kept that stood on the same answer. An answer now waits for the one being written and asks for nothing more.

## For the operator

**The numbers**: `GET /v1/service/recordings`, with the service token. Counts and game ids only, nothing of any game:

```json
{
  "enabled": true,
  "retention_hours": 24,
  "checkpoint_interval_seconds": 3,
  "engine_build": "39269bd7a4e937c90bba7459eb055a44",
  "running": [{"game_id": "…", "journal_records": 61, "checkpoints": 14, "checkpoint_bytes": 3698000, "stopped": null, "replaying": false}],
  "games": {"recorded": 12, "not_recorded": 0},
  "written": {
    "states_taken": 4210, "states_taken_micros": 10946000, "longest_state_taken_micros": 48087,
    "checkpoints": 612, "checkpoints_skipped": 0, "checkpoint_bytes": 161568000,
    "checkpoint_millis": 64872, "longest_checkpoint_millis": 294,
    "journal_records": 733, "journal_millis": 154, "longest_journal_millis": 8,
    "answers_that_waited": 9, "answers_waited_millis": 610, "recordings_stopped": 0
  },
  "asked_for_again": {"attached": 0, "recovered": 3, "recovery_millis": 512, "longest_recovery_millis": 277, "finished": 1, "refused": {"incompatible": 2}},
  "on_disk": {"recordings": 5, "bytes": 2874000, "removed": 31}
}
```

`checkpoints_skipped` counts states that could not be written and `recordings_stopped` recordings that stopped; both should be 0. When they are not, a running game's `stopped` says why in a few words (a full disk, states that could not be written), and the engine's log says it in full. `refused` counts recordings that could not give their game back, by reason: `incompatible` after every upgrade under a running game, `unreadable` for damage, `unrecoverable` for a game given up after five recoveries and for one whose recording had stopped.

**Looking at recordings**, without seeing anything of a game:

```sh
docker compose exec engine java -cp '/app/engine.jar:/app/lib/*:/app/plugins/*' \
  com.commanderduels.RecordingTool /var/lib/commander-duels/recordings
```

```text
This engine's build: 39269bd7a4e937c90bba7459eb055a44
2 recordings in /var/lib/commander-duels/recordings
48ff93e9-…  finished    legacy         2 seats  turn ?      21 records  0 checkpoints        8 KiB  changed 0 s ago
bdd58a56-…  resumable   commander      4 seats  turn 7      61 records  2 checkpoints      538 KiB  changed 0 s ago
Total 546 KiB; every recording is whole
```

A recording is `resumable` (this engine could take its game up), `finished`, `other build` (another engine build made it), `stopped` (it could not be kept up, and its game went on without it), `lost` (it had checkpoints and none can be used) or `unreadable`.

With a game's id it reports on that recording: who sat where (a person or a bot, the deck's name, a digest of the deck), the journal's record counts, each checkpoint's turn, step, size and whether its checksum holds, and whether this engine could take the game up. `--verify` also reads each checkpoint's state back and checks that it is the game that was saved. It names no card, hand, library or answer; `--show-private` prints the journal in full, what each seat answered, and what stopped a recording that stopped in the error's own words (which may name a card), and says that it is private. It exits with 1 when a recording is not whole. It only reads, so a running engine's recordings can be looked at.

**Retention.** A recording is removed once nothing in it has changed for `CD_ENGINE_RECORDING_RETENTION_HOURS` (24): a finished game's, whose result was there for the API to ask for all that time, and one nobody came back for. A running game keeps its recording however quiet it is. The sweep runs every five minutes and is safe to run twice. A finished game's recording holds no state of the game, only who played, what they answered and how it ended.

**Privacy.** A recording holds everything about a game: every hand, library and deck. It lives in the engine's own folder, no route reads it, the API never sees it, and it is not in the site's backups. Treat the volume as you treat the database.

**Finding out why a game asked something else.** `CD_ENGINE_JOURNAL_CHOICES=1` makes every journal record list the choices its question had, and the engine's log then says which choices only one of the two questions had. Off by default: a priority question has dozens of choices, and every record is forced to disk.

## The pieces

| Piece | Where |
| --- | --- |
| The recording's files, read and written with nothing trusted | `Recording` |
| The journal first, checkpoints written when needed | `Recorder` |
| What a checkpoint holds, and the state's digest | `Checkpoint` |
| Taking a game up, with everything checked | `Recovery` |
| The game's part: states taken, answers journalled, the journal played again | `HumanGame` (`atResumable`, `submit`, `replayNext`, `resume`) |
| What a question's fingerprint is | `Prompts.Prompt.print` |
| The engine's build key | `EngineBuild` |
| The registry: recording service games, attach, retention, the numbers | `HumanGames` |
| The routes | `EngineServer` (`attach`, `recordings`) |
| The tool | `RecordingTool` |
| XMage: resuming in the middle of a turn, and what a saved state needs | `engine/xmage/patches/0018-resume-from-saved-state.patch` |
| XMage: the cards a saved state could not hold | `engine/xmage/patches/0019-serializable-cards.patch` |
| The API: attaching after either restart | `api/games.py` (`GameHub.revive_all`, `reattach`, `attach_in_engine`, `revived`) |
