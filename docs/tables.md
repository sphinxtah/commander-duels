# Human tables (v0.4.0)

Since v0.4.0 approved players play each other. A player opens a table in the lobby, others join it, and the host starts one game with a seat for every player. Bots may fill the seats the players leave. The owner's decisions are in [the v0.4.0 plan](plans/0.4.0.md#decisions-at-the-start-of-v040). Friends, blocks, presence lists and queues come later.

## The lobby

- **Tables.** The Tables page, after Play, lists the open tables: format, seats, host and who has joined. A table nobody starts closes after 3 hours.
- **Opening a table.** The host chooses:
  - Legacy for two players, or Commander for two to four seats;
  - how many of the seats bots fill, after the players' seats, and their skill (1–6);
  - public (listed in the lobby) or private (reached by its invite link only).
  The host takes the first seat with one of their decks.
- **The invite link.** Every table has an unguessable code, and its page is `#tables/<code>`. A private table is never listed, so the link is the only way in. Its players see the link and can copy it. SysOp sees every table, private ones included.
- **Seats.** A player joins with one of their own decks and takes the first free seat. They may change deck (which makes them not ready again), mark themselves ready, or leave. The host leaving closes the table for everyone.
- **One table at a time.** A player sits at one open table at a time. Joining, or opening a table, also needs room under the account's limit of running games (`CD_GAMES_PER_ACCOUNT`, 1 by default; SysOp has none).
- **Starting.** The host starts once every player's seat is taken and every other player is ready. Each player's limit of running games is checked again then. The other players' pages follow the table into its game.

## Decks

- **Anything goes.** Any deck the player can play: legal in the format, and every copy in their library ([the library](progression.md#the-library)). A collection-locked deck is refused, as at the practice table. Administrators' whole-catalog decks play too, and SysOp's need only cards the engine implements.
- **Bound when the game starts.** Each player's deck is bound to an immutable revision of it then (DECK01). If a player's deck can no longer be played at the start, the host is told whose it is, never what it is, and that player is no longer ready.
- **Bots** in Commander play the starter decks, a different one each, as at the practice table (`CD_BOT_DECKS`).
- **Privacy.** Others see a player's handle and portrait (their alliance), never their deck. At the table the other players go by their handles, on the board, in the turn line, the result and the log. SysOp sees every deck, as for any game.

## Playing

- **One game, a seat each.** The game is one engine game with every player's seat first, then the bots'. Each player's seat has its own engine token, its own views, its own controller lease and its own connections ([games](games.md)). The engine shows each seat only what that seat may see.
- **Conceding.** A player may concede their own seat at any time, from the Game menu. The game goes on for the others. When it leaves one player, it ends at once with their win.
- **Closing.** A table's game goes on for the other players, so its players cannot close it; they concede instead. SysOp may close it.
- **Results.** The winner's win counts once, as for any game ([wins](progression.md#wins-and-levels)). Each player beaten pays the winner `50 + 90 × log10(1 + wins)` tokens by their own wins, at most 500, and each bot by its skill. Wins over the same player pay for the first 3 a day, in Arizona time. The result screen shows what the game paid you.
- **Out of the game.** A seat that conceded, was removed or lost while the game goes on no longer counts against its player's running games. They may start or join another.

## Away players

There are no turn timers.

- **Away.** A player with no tab of the game open for 2 minutes is away. The other players see who is away, and for how long.
- **The vote.** Any other player still in the game may then vote to remove them, or to keep waiting. The vote passes when a majority of the other players still in the game vote yes: both of two, two of three. In a two-player game the one opponent decides alone.
- **Removal.** The API concedes the away seat in the engine with that seat's own token, and the game goes on. It records the seat as removed, and the audit log records `table.player_removed` with the game, the seat, the voters, and who cast the deciding vote.
- **Coming back.** A player who comes back before the vote passes ends it. A removed player who comes back sees that the others removed them, and how the game ended.
- **The engine's backstop.** The engine closes a game in which nothing has happened for an hour (`idle_timeout`, the engine's longest). A player thinking for a few minutes keeps the game; an away player is voted out long before. Practice games keep the engine's 15 minutes.

## Routes

| Route | What |
| --- | --- |
| `GET /api/v1/tables` | Open tables, newest first: the public ones and your own (SysOp: every one) |
| `POST /api/v1/tables` | Open a table: `format`, `seats` (2 in Legacy, 2–4 in Commander), `bots`, `bot_skill`, `turn_cap`, `visibility`, `deck_id` |
| `GET /api/v1/tables/{code}` | A table by its invite code: its seats (handles, portraits, ready), your own deck, and its game once started (for its players and SysOp) |
| `POST /api/v1/tables/{code}/join` | Take the first free seat with `deck_id` |
| `PATCH /api/v1/tables/{code}/seat` | Change `deck_id`, or `ready` |
| `POST /api/v1/tables/{code}/leave` | Leave; the host closes the table |
| `POST /api/v1/tables/{code}/start` | The host starts the game |

Every route needs `games.play`, and seats need `decks.edit`. Refusals:
- 404 for a code no table has.
- 409 `at_a_table` (another open table), `game_limit` (no room for another running game, naming the player at the start), `table_full`, `table_closed`, `already_seated`, `not_seated`, `not_ready`, `table_not_full`, `deck_not_playable` (another player's deck at the start), `player_unavailable`, `table_changed` (a player left as it started).
- 403 `not_host` for a start by anyone but the host.
- 422 `invalid_table`, and the practice table's deck refusals (`invalid_deck`, `deck_not_playable`).
- 429 `games_busy` and 503 as for practice games.

Away players and votes go over the game's WebSocket: the `presence` message and the `vote` message ([games](games.md#the-websocket)).

## Data

Migration `0009_tables` adds:
- **`game_tables`.** The code, host, format, seats, bots, bot skill, turn cap, visibility, status (`open`, `started` or `closed`), the game, and when it was opened, started and closed.
- **`table_seats`.** Each player's seat at a table in the lobby, with their deck and whether they are ready. One seat per player per table.
- **`games.kind`** may be `table`.
- **`game_seats.left_at` and `left_reason`.** A seat out of a game that went on without it: `conceded`, `removed` or `eliminated`.

Going back to 0008 keeps every game, with its wins and tokens, as a practice game, and drops the tables.

## Verification

- **API tests (`tests/test_tables.py`).** Against a fake engine with a token and a view for each player's seat:
  - the lobby, privacy (no deck of another player in any answer), seats, ready, the start, and the engine's request with the hour's idle timeout;
  - each player's connections seeing only their own seat, with no token in any message;
  - a concession, the winner's win and the 50 tokens it paid;
  - the vote: refused before 2 minutes, a majority of two, a removal with the seat's own token, its audit entry, and the removed player coming back;
  - the opponent alone removing in a two-player game;
  - one open table at a time, private tables, collection-locked decks, leaving, the host closing, and a stale table closing;
  - every player's limit of running games at the start, and another player's deck named by its player only;
  - a concession freeing the seat, SysOp observing the first seat and closing, and the migration going back.
- **Engine (`CommanderGameTest`).** A concession that leaves one player ends the game without that player's answer.
- **Web tests.** The lobby, a table's page (seating, ready, following the start into the game, the host's start), the away players and their votes, and the game screen at a table (handles, the vote, the tokens paid, the way back to the lobby).
- **Browser journey (`web/e2e/tables.spec.ts`).** SysOp and a second account in two browsers: SysOp opens a Legacy table, the player finds it in the lobby, joins by its invite link and gets ready, and SysOp starts. Both play their own seats for a few turns, the player concedes, and both see the result, SysOp with the 50 tokens the win paid. Every frame of each browser is checked for the other's concealed cards. It needs the engine, SysOp and `CD_E2E_PLAYER_SESSION` from `scripts/e2e_player.py`.

**Run on 2026-10-21** against a throwaway stack: its own network and PostgreSQL, the engine, API and web images built from the work, the test catalog, a generated SysOp and a second player from `scripts/e2e_player.py` (`CD_BOT_DECKS=fixtures`). Playwright shared the web container's network, so the browsers came from loopback.
- The table journey passed: 3 turns, the player conceded while SysOp held priority, and the game ended at once (55 and 57 frames, no concealed card). With the engine from before the fix, SysOp's game waited for its next answer.
- The 7 practice game journeys and CI's two scripted games through the API (`scripts/api_practice_game.py`) passed unchanged.
- An away check with the real engine: the player never connected, SysOp's vote passed 120 seconds after the start, the API conceded the player's seat, and the game ended with SysOp's win, the seat recorded as removed and 50 tokens paid.
