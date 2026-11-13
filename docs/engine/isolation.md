# Each game in a process of its own (v0.9.10, v0.9.11)

Since v0.9.10 every game runs in a Java process of its own. A game that runs out of memory, or is killed, or hangs, ends its own process and nothing else; every other game plays on. This is the owner's choice for the specification's §6 (bot resource containment and game isolation), the second foundation of [the Preparation Framework](../plans/0.9.10.md), and it stands on [recording and recovery](recovery.md): a game crosses into a new process the way it comes back after the engine's restart, from its recording.

What it proves, each by tests that run:

- **A game whose process dies leaves the others running, and is taken up by a new process.** Two duels in two processes; one process is killed (`SIGKILL`, as the kernel's out-of-memory killer would); the other game is answered by its same process, unchanged, and plays on; the API's next request for the killed game is answered 404, it asks for the game again, and a third process takes the game up from its recording where it stood, every seat's view as before (`GameProcessesTest.aGameWhoseProcessIsKilledLeavesTheOthersRunningAndIsTakenUpByANewProcess`).
- **A full engine refuses in words, and touches nothing running.** With room for one game, a second is answered 429 `games_busy`, "The tables are full; try again in a minute.", with `Retry-After: 60`; the running game is untouched; once it is over and its process has ended, a game is admitted again (`aFullEngineRefusesInWordsAndAdmitsAgainOnceThereIsRoom`). The API shows the engine's words to the player (`tests/test_games.py::test_a_full_engine_tells_the_player_why_in_its_own_words`).
- **A game's process is sized for its format, and reports its memory and its bots** (`aGameRunsInAProcessSizedForItsFormatAndReportsItsBots`), with a weaker bot's habits counted apart from any shortage of time or memory.
- **A process whose game is over plays the next game of its size, until it has played its share** (v0.9.11, `aProcessWhoseGameIsOverPlaysTheNextGameUntilItHasPlayedItsShare`): the game that is over is dropped from it and answered from its recording, never taken up again; the next game is given the same process and plays as any game does; once the process has played its share it is ended with its last game.

## A game's start (v0.9.11)

On the live site, v0.9.10 kept a player 29 seconds from "start" to a four-seat Commander table with its cards dealt: 13.0 seconds for the create, 16.1 more to the table's first state (measured through the owner's browser on 2026-11-12, a practice table against three bots). The VM's cores (Xeon E5-2687W v3, 2014) take about three times as long as the cloud workspace's on this work, which is one thread's work: no core, disk or memory was busy while it waited (the owner's Proxmox graphs, lined up with the engine's log). Three causes, each fixed:

| Cause | v0.9.10 | v0.9.11 |
| --- | --- | --- |
| Every card of four decks looked up in the front process's card database over loopback, one query at a time | 4 to 5 s of the table's start on two cores | Each game process opens a read-only copy of the database on its own ([below](#the-card-database)) |
| Every game paid a fresh Java process: XMage's game, rules and AI code loaded and compiled anew | 2 to 4 s more after the warm-up | A process plays up to 40 games one after another ([below](#one-process-many-games-v0911)) |
| The warm-up's game played the engine's fixture decks, so the next game's own cards and the code they need were still cold | 1.5 to 2 s of the first game | A process warms up with the decks of the newest recorded game of its size and main format |

A four-deck Commander table's first question, after its create, on two cores: 8.6 to 10.5 s in v0.9.10's warmed process; 2.5 to 3.0 s in a fresh v0.9.11 process; 0.5 to 1.4 s in a process that has played a game, as every game after the engine's first did before v0.9.10 (0.4 s). On the live VM, about three times these: some 8 s for a process's first game, 2 to 4 s after.

## How it works

The engine's container runs one **front process**, as before (`EngineServer`), and beside it one **game process** for each game. The front process keeps the HTTP routes the API calls, the card database, the recordings folder and its sweep; it no longer plays games. A game process is the same engine, started from the same classes (`CD_ENGINE_ROLE=game`): it listens on loopback, on a port it prints for the front process, with a service token of its own, and runs one game at a time.

- **Requests.** The front process forwards every request for a game (`view`, `commands`, `close`, `inspection`, `bots`, `attach`) to the game's process unchanged, the seat's token included, and answers with what it answered (`EngineServer.isolatedGameRoute`). Seat tokens, views, commands, prompts, the spectator view and the recording are exactly what they were in one process; the API does not know the difference.
- **A create** is checked in the front process as before (the request, the decks, the cards, an id in use or cancelled), then given a process sized for its format, which creates the game (`isolatedCreate`).
- **An attach** for a game no process runs is answered from the recording when the game is over or the recording cannot give it back; otherwise a new process takes the game up from its recording (`isolatedAttach`). So a game whose process died comes back exactly as a game of a dead engine did in v0.9.9: the API's next request is answered 404, the API attaches, the game goes on. A game taken up five times with no answer between them is given up, as since v0.9.9 (`Recovery.MAX_FRUITLESS`): the count is in the recording, so it holds across processes.
- **The end of a game.** The front process asks each game's process every two seconds how its game stands (`GET /v1/service/process`, loopback only); thirty seconds after its game is over (`CD_ENGINE_GAME_FINISHED_SECONDS`) the process takes the next game ([below](#one-process-many-games-v0911)) or is ended, and at once when a new game needs its room. The game's result stays in its recording, so the API is answered from there. A process whose create or attach was refused is ended at once.
- **Warmed before it is ready.** The first game in a Java process loads and compiles XMage's game, rules and AI code: a player waited 7 to 9 seconds for a Commander game's first question in a fresh process, against half a second for a later game in the same process (measured on two cores). So a game process plays a game of its size up to its first question, closes it unseen, and only then says it is ready (`EngineServer.warmUp`, 4 to 8 seconds on two cores, in the background for a warm process). A duel's process warms up with a Legacy duel, any other with a four-seat Commander game: the formats most of their games are. Since v0.9.11 that game is played with the decks of the newest recorded game of that size and format (`EngineServer.recentRequest`: of the last fifty recordings, the newest whose request parses, is of the size and the format, has a human seat and names only cards this engine has), so the cards a player brings and the bots' starter decks are what the process has loaded; read from the recording's manifest, played by no one and shown to no one. With no such recording (an engine's first games, or a court's process), it plays the engine's fixture decks. Never another format: the first build took the newest game of the size, and a table's process warmed with a Two-Headed Giant game kept a Commander table's first view waiting five to seven seconds in the hosted browser journeys (`WarmUpTest`).
- **Warm processes.** A process takes about two seconds to start, and its warm-up the time above. One duel's and one table's process are kept started, so a game rarely waits (`CD_ENGINE_GAME_WARM`, `CD_ENGINE_GAME_WARM_COURT`, none for the court by default), and one more of a size when a process whose game is over comes back. A game takes the warm process that has played the most games, else one still warming up. They count against the budget; to make room for a game, the warm process that has played the fewest is ended first.
- **The front process's death** ends every game process (each watches its standard input, which ends with the front process; in Docker the container goes anyway), and Docker restarts the engine: then every game is taken up again as after any restart since v0.9.9.

### One process, many games (v0.9.11)

Thirty seconds after a game is over, the front process asks its process to drop it (`POST /v1/service/process/release`, loopback only, refused while a game runs or its thread is still ending): the process forgets the game, whose end is in its recording, and goes back to the warm processes of its size, the first to be taken. The next game it is given finds the code its last games loaded and compiled. A process is ended with its game instead when it has played its share (`CD_ENGINE_GAME_REUSE`, 40 games), when its old generation was half its heap or more after its last collection, or when it has lived 24 hours; and when one more than the warm processes wanted would be kept, the one that has played the fewest games is ended.

Nothing of one game reaches the next: each game has its own random generator ([XMage patch 0010](../../engine/xmage/patches/README.md)), its own seats, tokens, recording and events, and the process holds no game while it waits. One process played every game before v0.9.10, many at once; a reused process plays one at a time. Twelve four-seat Commander tables played one after another in one process on two cores: the first question 0.45 to 0.78 s each, 30 threads throughout, 480 MB resident after the seventh and no more after, the old generation at 1% of the heap.

### The card database

XMage opens its H2 card database with `AUTO_SERVER`: the first process to open the file serves it to the others on loopback. The front process opens it before any game process starts. In v0.9.10 each game process read the cards through it, and held no copy of its own. That cost a game's start: a Commander table's four decks are looked up card by card, each lookup a query over loopback, 4 to 5 seconds of the table's start on two cores.

Since v0.9.11 the front process copies the database's file (`db/cards.h2.mv.db`, about 75 MB) into the system's temporary folder before it opens it (`GameProcesses.prepareCards`: `cd-cards-<build>/`, kept for the engine's build, so a restart in the same container uses it again; made under another name and moved into place). Each game process opens that copy on its own, read-only and with no server (`-Dxmage.cardsDatabase.snapshot=<folder>`), so every lookup stays in the process; the operating system keeps one page cache of the file for all of them. If the copy cannot be made, game processes read through the front process as before, and the engine says so as it starts.

Opening XMage's repositories wrote to the database (a version row, a build row, `CREATE TABLE IF NOT EXISTS`). A process starting while another read the cards took the schema's lock. [XMage patch 0020](../../engine/xmage/patches/README.md) lets a process that reads a database another serves take it as it is: game processes start with `-Dxmage.cardsDatabase.shared=true` and write nothing; with the copy's folder too, they open the copy.

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
| The same game played through a game process and in one process | 22 s and 20 to 23 s: reading the cards through the front process cost nothing measurable in a game's play, but 4 to 5 s of its start (v0.9.11, [above](#a-games-start-v0911)) |

The heaps above are about twice the most a game of each size was measured to hold live.

### Measured (v0.9.11, the cloud workspace: two cores)

A four-deck Commander table, each seat's deck one of the campaign's, from the create to the first question:

| Process | First question |
| --- | --- |
| v0.9.10: warmed with the fixture decks, the cards read through the front process | 8.6 to 10.5 s (the create alone 4.4 to 5.0 s) |
| Warmed with the fixture decks, its own copy of the cards | 2.1 to 4.1 s |
| v0.9.11: warmed with a recent game's decks, its own copy of the cards | 2.5 to 3.0 s |
| v0.9.11: a process that has played a game (decks it had not seen) | 0.5 to 1.4 s |
| Before v0.9.10: one process for every game, after its first | 0.4 s |

The live site's v0.9.10, from the owner's browser: 13.0 s for the practice game's create, 29.2 s to the table's first state.

## What the operator reads

`GET /v1/service/processes` (the service token): the budget and what is reserved, each size's heap and warm processes (since v0.9.11 with each warm process's games so far, `warm_games`: 0 for one that has only warmed up), and for each game its process id, the games its process has been given, this one included (`games_in_process`), how long it has run, how long its process took to start, its memory (heap in use, committed and at most; the old generation after its last collection and that as a share of the heap, the pressure) and its bots' numbers:

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

In all: processes started and alive, their start times (average and longest), processes that failed to start, processes ended once their game was over, processes given back for another game (`reused`) and how many games a process may play (`games_per_process`), processes that **ended unasked** by why (`out_of_memory`, `killed`, `terminated`, `exit_<code>`), the last 32 of those with their game, games refused because every slot was taken or the memory was spent, and the bots' numbers of the games that are over. Ids and numbers only, nothing of a game's content. With `CD_ENGINE_ISOLATION=none` the same route answers with the one process's memory and its games.

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
| `CD_ENGINE_GAME_FINISHED_SECONDS` | 30 | How long a game's process keeps its game once it is over, at most, before it takes another or is ended: sooner when its room is needed |
| `CD_ENGINE_GAME_REUSE` | 40 | Games a process plays one after another before it is ended (v0.9.11); 1 ends each process with its first game, as in v0.9.10 |
| `CD_ENGINE_GAME_JAVA_OPTIONS` | none | More options for every game process |

## What is not supported

- **A game's process cannot be moved while it runs.** A game is in one process from its create or attach until its end or its process's death.
- **A process plays one game at a time.** It takes another only once its game is over and dropped; two games are never in one process.
- **The front process is still one process.** It holds no game, so no game can fill its heap; if it dies, every game process ends with it, and every game is taken up again from its recording when Docker has restarted the engine, as since v0.9.9.
- **A game recorded by another engine build** is refused, as since v0.9.9: an upgrade still ends the games running at it.
- **`/v1/service/recordings`** answers for the front process: the recordings on disk, the sweep, and the games it answered from a recording. Each running game's recorder (its checkpoints and journal) counts in the game's own process, and v0.9.10 does not gather those counts in the front process.
