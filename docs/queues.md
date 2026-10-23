# Public queues and rematches (v0.5.0)

Since v0.5.0 players find a game without an invite: they join a public queue with a deck, and the queue seats them with other players, or with bots after a minute. At the end of a game, Rematch plays it again. The owner's decisions are in [the v0.5.0 plan](plans/0.5.0.md#decisions-at-the-start-of-v050). The API is `api/queues.py` and `api/rematches.py`; the web app's part is `web/src/queues/`. A queue's game of two players or more is a [human table's](tables.md) game.

## Decisions taken while building

The owner's answers left these open; each may be revisited:
- **A player alone with bots plays a practice game,** not a table's: a table needs two players' seats, and alone there is nobody to chat with or vote. Its wins and tokens count as any practice game's.
- **Bots play at skill 4,** the practice table's and the lobby's default.
- **Once the minute has passed,** every player waiting who takes bots is seated together, not only the one who waited longest.
- **A queue and a table exclude each other:** a player in a queue may not sit at a table, and the reverse. A practice game is not refused, but a player who starts one while waiting is taken out of the queue when a match finds them.
- **A place the app stops asking about goes after 150 seconds,** so a closed app is never matched.
- **A table's rematch waits 2 minutes** for every answer. Players the vote removed are not asked, and bots take their seats. Leaving the result screen declines.
- **Resetting an account** takes it out of its queue, rather than being refused as at a table.

## The queues

- **Four queues.** Legacy for two players, and Commander for two, three or four, each size its own queue. The player picks the size.
- **A queue is a key.** In the code a queue is `QueueKey(format, seats)`. Best-of-three would join it as a third field.
- **Casual only.** There is no ranked queue and no rating. Every queue's game takes the casual table's rules: decks may hold banned cards and cards not legal in the format ([the table's rules](tables.md#the-tables-rules-v045)). The format's deck rules always apply.

## Joining and waiting

- **Find a game.** The Play page's first section (`#find`): the format, Commander's number of players, one of your decks, and **Players only**. Each format and size says how many players wait in it. Decks that cannot play are greyed with the reason, as at a table.
- **The deck is checked as a table checks it:** yours, of the format, playable with your library, and refused (`422`) with the table's own refusals otherwise.
- **One place at a time.** A player waits in one queue at a time, and never while they sit at an open table. Joining a queue from a table is refused (`409 at_a_table`), and so are opening or joining a table while waiting (`409 in_queue`). Joining also needs room under the account's limit of running games (`409 game_limit`, `CD_GAMES_PER_ACCOUNT`); SysOp has none.
- **The wait.** The section shows how long you have waited, counted on each second, your place in line, how many others wait, and when bots may come, with **Leave the queue**. You may leave at any time. The main menu's Play tile says "Looking for a Legacy game" and leads back to the wait. Friends who may see your presence see "Looking for a Commander game" ([presence](social.md#presence)).
- **The app keeps the place.** While you wait, the app asks about your place every 2 seconds, from any page of the app. A place nobody has asked about for 150 seconds (the app was closed) leaves the queue. A hidden tab's timers may run only once a minute, and that still keeps it.
- **Following.** Once the queue finds your game, the page you are on opens it, whichever page of the app it is. A game found before the page opened is not opened again; the Play tile leads to it.

## Matching

- **When.** On every join, and on a tick every 2 seconds in the API process, which runs as one process. One queue is matched at a time.
- **In order.** Players are seated in the order they joined.
- **A full table** of players starts at once, players only or not.
- **Bots after a minute.** Once a player who takes bots has waited 60 seconds with too few players, every player waiting in that queue who takes bots is seated, and bots fill the empty seats. A player who chose players only keeps waiting until enough players join.
- **Never seated twice.** A match claims its players by marking their places `starting`, in one transaction that locks their rows (`FOR UPDATE`) and claims nothing unless its update took every one. Another match waits for the lock and then finds them taken. Within the process, a queue's joins and ticks also run one at a time.
- **Checked again at the start.** Every player's account, limit of running games and deck are checked again as the game starts, as at a table's start. A player they stop is taken out of the queue with the reason (for example "You left the queue as your game started: You started another game."), and the others wait on in their places.
- **Busy.** When every game slot is in use (`CD_GAMES_MAX`) or the engine does not answer, everyone waits on, and the wait says "Every game slot is in use. Your game starts as soon as one frees up." The tick tries again.
- **Leaving as it starts.** A player who leaves while their game is being made ends it: the engine's game is closed, and the others wait on.
- **After a restart,** places that were being made into games wait again.
- **Without games set up** (no `CD_ENGINE_SERVICE_TOKEN`, development only), players may join and wait, but no game starts.

## The games

- **Two players or more** play a table's game, made through the human tables' path: a table started at once, marked `queued` and private, so never listed, with a seat for each player (`tables.add_table_game`). The game's kind is `table`, so the table's chat and alliances, away players and the vote to remove them, concessions, wins and tokens all work as at any table ([human tables](tables.md#playing)). The player who waited longest is its host in the records.
- **A player alone with bots** plays a practice game. It records its request, as the practice table's games do, so its rematch plays it again.
- **Bots** play at skill 4, the practice table's and the lobby's default (14 tokens each when beaten), with the starter decks in Commander (`CD_BOT_DECKS`) and the engine's fixture decks in Legacy. The turn limit is 60.
- **Audit.** A queue's games are audited as any table's: a removal (`table.player_removed`), SysOp observing, inspecting or closing. Joining and leaving a queue are not audited, as taking a seat at a table is not.

## Rematches

- **Where.** On the game's result screen, in its dialog and in the panel beside the board, for the game's players.
- **A practice game** (a queue's game alone with bots too) starts again at once with the same request: the same deck, bots, skill, format, turn limit and rules. The deck is checked again. A practice game from before v0.5.0 recorded no request, so it has no Rematch.
- **A table's game** (from the lobby or a queue): Rematch offers the players still there the same seats and decks, and the table's rules. Players the vote removed are not asked, and bots take their seats, as bots take the seats they filled.
  - **The others hear of it** on their result screen ("ada offers a rematch: the same seats and decks", with each player's answer) and through the bell: a `rematch` notification, which opens the game's result screen.
  - **It starts once every player asked has accepted,** within 2 minutes. Every page follows into the new game.
  - **It ends** when a player declines (or withdraws their own offer), when a player leaves the result screen while it stands, or when 2 minutes pass. The others then go back with the result screen's own link: **Find another game** for a queue's game (and its rematches), **Back to the lobby** for a table's.
  - **Checked again at the start,** as at a table's start: every deck, as it stands now, with the table's rules, and every player's limit. A deck or a limit that stops it ends the rematch for everyone, naming whose ("bob's deck cannot be played now."), never what the deck holds. The player whose own deck stopped it is told why in full.
  - **The new table** keeps the old one's visibility, rules, bots' skill, turn limit and whether the queue made it.
- **Free to play.** Offering or accepting needs room under the account's limit of running games, and no open table or queue of your own: the rematch is your one table.
- **One rematch a game.** Asking again answers with the first.
- **Busy.** If the last answer comes while every game slot is in use, or the engine does not answer, the offer stands and that answer is asked again.

## Routes

| Route | What |
| --- | --- |
| `GET /api/v1/queues` | The four queues: `format`, `seats`, `name` and how many players wait in each |
| `GET /api/v1/queue` | Your place: `status` (`none`, `waiting`, `matched`, `left`, `refused`), the queue, your deck, `waited_seconds`, `position`, `waiting`, `bots_in_seconds` (null for players only), `game_id` once matched, and `reason` and `message` when you were taken out or your match waits. Asking keeps the place |
| `POST /api/v1/queue` | Join: `format`, `seats`, `deck_id`, `humans_only`. The answer is your place, or the game found at once |
| `DELETE /api/v1/queue` | Leave. A game found a moment before stays, and the answer names it |
| `GET /api/v1/games/{id}/rematch` | The game's rematch for its players (and SysOp): `status` (`none`, `open`, `started`, `declined`, `lapsed`, `failed`), `kind`, `origin` (`practice`, `lobby` or `queue`), `can_offer`, the players asked with their answers, `your_answer`, `expires_in`, the new `game_id`, `offered_by`, `declined_by` and `message` |
| `POST /api/v1/games/{id}/rematch` | Rematch: a practice game starts again; at a table this offers the rematch or accepts it, and the last answer starts it |
| `POST /api/v1/games/{id}/rematch/decline` | Decline the offer, or withdraw your own |

Every route needs `games.play`, and joining needs `decks.edit`. Refusals:
- 422 `invalid_queue` (no such queue), and the table's deck refusals (`invalid_deck`, `deck_not_playable`).
- 409 `in_queue`, `at_a_table`, `game_limit` for a queue; for a rematch also `game_running` (the game has not ended), `not_asked` (the vote removed you), `rematch_unavailable` (too few players left, or a practice game from before v0.5.0), `rematch_closed` (declined, lapsed or failed), and at its start `deck_not_playable` and `player_unavailable`, naming whose.
- 403 `not_a_player` for a rematch asked by someone who did not play the game (SysOp may read it). Others' games are not found (404), as anywhere.
- 429 `games_busy` and 503 as for practice games, at a rematch's start.

## Data

Migration `0022_queues` adds:
- **`queue_entries`.** One row an account: its queue (format and seats), deck, players only, status (`waiting`, `starting` while a match makes its game, `matched`, `left` or `refused`), when it joined and when its app last asked, the game it found, and why it was taken out.
- **`rematches`** and **`rematch_players`.** At most one rematch a game: who asked, its status, when it lapses, the new game, who declined and why it failed; and each player it asks, by their seat, with their answer.
- **`games.settings`.** A practice game's request, for its rematch; null for a table's game.
- **`game_tables.queued`.** A table the queue made, or a rematch of one.
- **`notifications.game_id`** and the `rematch` notification.

Going back to 0020 drops them, with every place in a queue, every rematch and the rematch notifications. Queue games stay recorded as the table games they are.

Deleting an account takes it out of its queue and forgets its last wait ([accounts](../api/accounts.py)); so does resetting it ([resetting an account](identity.md#resetting-an-account-v045)). Its rematch answers stay, as its games do.

## Verification

- **API tests (`tests/test_queues.py`).** Against the human tables' fake engine, with the queues' clock injected:
  - joining, the place and the queues' counts, a second join refused, leaving, and joining again;
  - the refusals: no such queue, another's deck, a deck of another format, a deck the library cannot play, a player at a table, and a table refusing a queued player, joining or opening it;
  - two players meeting at once in a table's game: casual, private, never listed, the engine's hour of idle time, each seat seeing only its own cards and no token, the table's chat, a concession, the win and its 50 tokens;
  - bots after a minute: alone, a practice game with three bots at skill 4 that records its request; two players who take bots, a table with two bots;
  - players only: waiting on while another player gets bots, then a full table of players in the order they joined;
  - a place nobody asks about leaving after 150 seconds, the tick running on its own, and players waiting without games set up;
  - every limit and deck checked again: a player who started a practice game taken out while the other waits on, a deck trashed while it waits, and SysOp joining with a game running;
  - a player leaving while the engine makes the game: the game closed, the other waiting on;
  - five players and five matches at once, each player seated once, in order;
  - presence in a queue, deleting and resetting an account, and the migration going back;
  - on PostgreSQL (`CD_TEST_POSTGRES_URL`), eight claims at once in their own connections: four pairs, no player claimed twice.
- **API tests (`tests/test_rematches.py`).** A practice game played again with the same request, once, and refused while it runs and for a game from before v0.5.0; a table's rematch offered, told through the bell, accepted, with the same decks, rules and visibility and the notification read; a decline and a lapse; a removed player's seat taken by a bot; a trashed deck and another game's limit ending a rematch, named; a player in a queue refused; a queue's rematch going back to the queue; SysOp reading but not playing it.
- **Web tests (`web/src/queues/queues.test.tsx`).** Joining Commander for three with players only, the wait's words, leaving and the form keeping the choices; the wait counted on, the bots' countdown and following into the game found; following from another page, never into a game found before; a refusal and the last wait's reason; no deck, and an account that cannot build decks; presence and the bell's words; Rematch for a practice game; a table's offer with its answers and countdown, opened once everyone accepts; accepting or declining, and the way back; leaving the result screen declining; a failed and a lapsed rematch.
- **Browser journey (`web/e2e/queues.spec.ts`).** SysOp imports a Legacy deck, finds a game with players only, watches the wait count up, sees the main menu's Play tile say so and lead back, and leaves the queue. It needs no engine. The deck journeys now look for the practice table's choices inside it, since "Find a game" above it has a deck and a format of its own.

**Run on 2026-10-23** in the queues' branch, as CI's verify job runs the journeys: an API from the branch's source on its own PostgreSQL, the test catalog and a generated SysOp, without the engine. Of the whole suite, 44 passed, the queue's among them, and 14 that need the engine were skipped; two deck journeys failed on the Play page's new choices, and passed on a second run once scoped to the practice table. The engine-backed journeys and a match between two browsers were not run.
