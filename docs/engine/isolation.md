# Each game in a process of its own (v0.9.10)

Since v0.9.10 every game runs in a Java process of its own. A game that runs out of memory, or is killed, or hangs, ends its own process and nothing else; every other game plays on. This is the owner's choice for the specification's §6 (bot resource containment and game isolation), the second foundation of [the Preparation Framework](../plans/0.9.10.md), and it stands on [recording and recovery](recovery.md): a game crosses into a new process the way it comes back after the engine's restart, from its recording.

What it proves, each by tests that run:

- **A game whose process dies leaves the others running, and is taken up by a new process.** Two duels in two processes; one process is killed (`SIGKILL`, as the kernel's out-of-memory killer would); the other game is answered by its same process, unchanged, and plays on; the API's next request for the killed game is answered 404, it asks for the game again, and a third process takes the game up from its recording where it stood, every seat's view as before (`GameProcessesTest.aGameWhoseProcessIsKilledLeavesTheOthersRunningAndIsTakenUpByANewProcess`).
- **A full engine refuses in words, and touches nothing running.** With room for one game, a second is answered 429 `games_busy`, "The tables are full; try again in a minute.", with `Retry-After: 60`; the running game is untouched; once it is over and its process has ended, a game is admitted again (`aFullEngineRefusesInWordsAndAdmitsAgainOnceThereIsRoom`). The API shows the engine's words to the player (`tests/test_games.py::test_a_full_engine_tells_the_player_why_in_its_own_words`).
- **A game's process is sized for its format, and reports its memory and its bots** (`aGameRunsInAProcessSizedForItsFormatAndReportsItsBots`), with a weaker bot's habits counted apart from any shortage of time or memory.

## How it works

The engine's container runs one **front process**, as before (`EngineServer`), and beside it one **game process** for each game. The front process keeps the HTTP routes the API calls, the card database, the recordings folder and its sweep; it no longer plays games. A game process is the same engine, started from the same classes (`CD_ENGINE_ROLE=game`): it listens on loopback, on a port it prints for the front process, with a service token of its own, and runs one game.

- **Requests.** The front process forwards every request for a game (`view`, `commands`, `close`, `inspection`, `bots`, `attach`) to the game's process unchanged, the seat's token included, and answers with what it answered (`EngineServer.isolatedGameRoute`). Seat tokens, views, commands, prompts, the spectator view and the recording are exactly what they were in one process; the API does not know the difference.
- **A create** is checked in the front process as before (the request, the decks, the cards, an id in use or cancelled), then given a process sized for its format, which creates the game (`isolatedCreate`).
- **An attach** for a game no process runs is answered from the recording when the game is over or the recording cannot give it back; otherwise a new process takes the game up from its recording (`isolatedAttach`). So a game whose process died comes back exactly as a game of a dead engine did in v0.9.9: the API's next request is answered 404, the API attaches, the game goes on. A game taken up five times with no answer between them is given up, as since v0.9.9 (`Recovery.MAX_FRUITLESS`): the count is in the recording, so it holds across processes.
- **The end of a game.** The front process asks each game's process every two seconds how its game stands (`GET /v1/service/process`, loopback only); thirty seconds after its game is over the process is ended (`CD_ENGINE_GAME_FINISHED_SECONDS`), or at once when a new game needs its room. The game's result stays in its recording, so the API is answered from there. A process whose create or attach was refused is ended at once.
- **Warmed before it is ready.** The first game in a Java process loads and compiles XMage's game, rules and AI code: a player waited 7 to 9 seconds for a Commander game's first question in a fresh process, against half a second for a later game in the same process (measured on two cores). So a game process plays a game of its size (a Legacy duel for a duel's, a four-seat Commander game otherwise) up to its first question, closes it unseen, and only then says it is ready (`EngineServer.warmUp`, 6 to 12 seconds on two cores, in the background for a warm process). A player's first question then came 2.4 to 3.8 seconds after the create, on two busy cores.
- **Warm processes.** A process takes about two seconds to start, and its warm-up the time above. One duel's and one table's process are kept started, so a game rarely waits (`CD_ENGINE_GAME_WARM`, `CD_ENGINE_GAME_WARM_COURT`, none for the court by default). They count against the budget; one of another size is ended to make room when a game needs it.
- **The front process's death** ends every game process (each watches its standard input, which ends with the front process; in Docker the container goes anyway), and Docker restarts the engine: then every game is taken up again as after any restart since v0.9.9.

### The card database

XMage opens its H2 card database with `AUTO_SERVER`: the first process to open the file serves it to the others on loopback. The front process opens it before any game process starts, so each game process reads the cards through the front process and holds no copy, and no page cache, of its own: a game process idles at about 90 MB.

Opening XMage's repositories wrote to the database (a version row, a build row, `CREATE TABLE IF NOT EXISTS`). A process starting while another read the cards took the schema's lock. [XMage patch 0020](../../engine/xmage/patches/README.md) lets a process that reads a database another serves take it as it is: game processes start with `-Dxmage.cardsDatabase.shared=true` and write nothing.

## Memory and admission

Each process has its own heap, so a game that fills it ends its own process (`-XX:+ExitOnOutOfMemoryError`, exit code 3) and nothing else; the front process records why, and the game is taken up again when the API asks. Within its heap, a bot's search stops when the heap fills, as since v0.9.8 ([fair bots](fair-bots.md#a-searchs-memory-v098)), now against that game's heap alone.

| Size | Formats | Heap | Reserved (heap and 512 MB beside it) |
| --- | --- | --- | --- |
| Duel | Legacy, a two-seat Commander game | 1,536 MB | 2,048 MB |
| Table | A three- or four-seat Commander game, Two-Headed Giant | 2,560 MB | 3,072 MB |
| Court | King's Table and the campaign's court (six seats) | 4,096 MB | 4,608 MB |

**Admission.** A game is admitted only when its process's reservation fits what is left of the budget (`CD_ENGINE_GAME_MEMORY_MB`) and fewer than `CD_ENGINE_MAX_GAMES` games run. To make room, the processes of games that are over are ended first, then warm processes; and a game that is over no longer counts against `CD_ENGINE_MAX_GAMES`, though its process stays a moment for its end to be read (`aGameThatIsOverNoLongerTakesASlot`). Otherwise it is refused (429 `games_busy`, "The tables are full; try again in a minute.", `Retry-After: 60`), and nothing that runs is touched. The reservation is the most a process can hold, not what it usually holds, so the budget can never be overrun: the container's memory limit is never reached by games, and so never kills the front process and every game with it.

**On the live site** (`deploy/compose.yaml`): the container's limit is 48 GB of the VM's 96 (`CD_ENGINE_MEMORY`), the front process has a 1.5 GB heap, and the games may reserve 44 GB: 22 duels, or 14 Commander tables, or 9 courts at once, or any mix of them. Each limit is a setting in the VM's `.env`. The development stack (`compose.yaml`) gives the engine 10 GB and its games 9, with the same warm processes.

### Measured (v0.9.10, the cloud workspace: two cores)

| What | Measured |
| --- | --- |
| A game process, from start to its card database open | 1.4 to 2.5 s, 3.2 s with six starting at once (the front process's card database already open); its warm-up game then takes 6 to 12 s more |
| A Commander table's first question after its create | 7 to 9 s in a fresh process; 2.4 to 3.8 s in a warmed one; 0.3 to 0.4 s for a later game in one process (before v0.9.10) |
| A game process, idle and ready | 87 to 93 MB resident |
| A four-seat Commander game (three bots at skill 3, 20 turns) | 0.36 GB of heap at its peak in a 768 MB heap; 0.9 GB resident in all. The same game in a 320 MB heap at skill 6, 30 turns: finished, 69 MB live after a collection, no search stopped by the heap |
| The campaign's court (six seats, five bots at skill 6, seed 14525) | 44 turns in 7 minutes in a 3 GB heap: 1,850 MB live at most after a collection, no full collection, no search stopped by the heap |
| What a process holds beside its heap, once a game has run | about 350 MB: classes 139 MB, metaspace 145 MB, code 28 MB, the collector 49 MB |
| The same game played through a game process and in one process | 22 s and 20 to 23 s: reading the cards through the front process costs nothing measurable |

The heaps above are about twice the most a game of each size was measured to hold live.

## What the operator reads

`GET /v1/service/processes` (the service token): the budget and what is reserved, each size's heap and warm processes, and for each game its process id, how long it has run, how long its process took to start, its memory (heap in use, committed and at most; the old generation after its last collection and that as a share of the heap, the pressure) and its bots' numbers:

| Bots' number | What it counts |
| --- | --- |
| `searches`, `completed` | Searches started and finished within the budget |
| `search_millis`, `longest_search_millis` | Thinking time, added up and the longest: the decision time |
| `cut_off_by_budget` | Searches the clock cut off: the bot played its best line so far |
| `cut_off_by_heap` | Searches a filling heap cut off ([fair bots](fair-bots.md#a-searchs-memory-v098)) |
| `kept_shallow` | Searches kept shallow for a heavy game or a heap under pressure |
| `passed_unsearched` | Decisions where the search could not start or did not stop: the bot passed, a legal move |
| `failed` | Searches XMage's simulation ended with an error |
| `weaker_habits` | A weaker bot's slips, naive plays and the like: its skill, never a shortage |
| `passive_decisions` | Decisions of passive bots (v0.8.6) |

In all: processes started and alive, their start times (average and longest), processes that failed to start, processes ended once their game was over, processes that **ended unasked** by why (`out_of_memory`, `killed`, `terminated`, `exit_<code>`), the last 32 of those with their game, games refused because every slot was taken or the memory was spent, and the bots' numbers of the games that are over. Ids and numbers only, nothing of a game's content. With `CD_ENGINE_ISOLATION=none` the same route answers with the one process's memory and its games.

**A weaker bot and a bot out of budget are told apart.** A bot's skill shows in `weaker_habits`; a shortage of time shows in `cut_off_by_budget`, of memory in `cut_off_by_heap` and `kept_shallow`, and a decision made without a search in `passed_unsearched`. A skill 1 table counts habits and no heap stops (`GameProcessesTest`); a search stopped by a full heap is counted as such (`FairBotMemoryTest`).

## Settings

| Variable | Default | What it sets |
| --- | --- | --- |
| `CD_ENGINE_ISOLATION` | `process` | `none` runs every game in the one process, as before v0.9.10 |
| `CD_ENGINE_GAME_MEMORY_MB` | the container's memory less the front process's heap and 1 GB | What the games' processes may reserve together |
| `CD_ENGINE_GAME_HEAP_DUEL_MB`, `_TABLE_MB`, `_COURT_MB` | 1536, 2560, 4096 | Each size's heap |
| `CD_ENGINE_GAME_OVERHEAD_MB` | 512 | What each process reserves beside its heap |
| `CD_ENGINE_GAME_WARM`, `CD_ENGINE_GAME_WARM_COURT` | 1, 0 | Processes kept started for duels and tables, and for courts |
| `CD_ENGINE_GAME_AI_THREADS` | the cores, from 2 to 4 | Each game's bot search threads (before v0.9.10 all games shared one pool of one thread a core) |
| `CD_ENGINE_GAME_FINISHED_SECONDS` | 30 | How long a game's process stays once its game is over, at most: one is ended sooner when its room is needed |
| `CD_ENGINE_GAME_JAVA_OPTIONS` | none | More options for every game process |

## What is not supported

- **A game's process cannot be moved while it runs.** A game is in one process from its create or attach until its end or its process's death.
- **The front process is still one process.** It holds no game, so no game can fill its heap; if it dies, every game process ends with it, and every game is taken up again from its recording when Docker has restarted the engine, as since v0.9.9.
- **A game recorded by another engine build** is refused, as since v0.9.9: an upgrade still ends the games running at it.
- **`/v1/service/recordings`** answers for the front process: the recordings on disk, the sweep, and the games it answered from a recording. Each running game's recorder (its checkpoints and journal) counts in the game's own process, and v0.9.10 does not gather those counts in the front process.
