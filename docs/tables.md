# Human tables (v0.4.0)

Since v0.4.0 approved players play each other. A player opens a table in the lobby, others join it, and the host starts one game with a seat for every player. Bots may fill the seats the players leave. The owner's decisions are in [the v0.4.0 plan](plans/0.4.0.md#decisions-at-the-start-of-v040). Since v0.4.4 the players talk at the table, make alliances and write to their allies alone ([chat](chat.md#the-tables-chat)). Since v0.5.0 players also find each other through public queues, whose games of two players or more are table games, and a table's players may play their game again with Rematch ([queues and rematches](queues.md)). Since v0.5.1 a table may be Two-Headed Giant's: two teams of two ([below](#two-headed-giant-v051)).

## The lobby

- **Tables.** The Tables page, after Play, lists the open tables: format, host and who has joined, with tags for its seats and its rules (since v0.4.5). A table nobody starts closes after 3 hours.
- **Opening a table.** The host chooses:
  - Legacy for two players, or Commander for two to four seats;
  - how many of the seats bots fill, after the players' seats, and their skill (1–6);
  - public (listed in the lobby) or private (reached by its invite link only);
  - since v0.4.5, which cards its decks may hold ([the table's rules](#the-tables-rules-v045));
  - since v0.5.0, in Legacy, one game or a best-of-three match with sideboards ([matches](matches.md)). The lobby tags a best-of-three table.
  The host takes the first seat with one of their decks.
- **The invite link.** Every table has an unguessable code, and its page is `#tables/<code>`. A private table is never listed, so the link is the only way in. Its players see the link and can copy it. SysOp sees every table, private ones included.
- **Seats.** A player joins with one of their own decks and takes the first free seat. They may change deck (which makes them not ready again), mark themselves ready, or leave. The host leaving closes the table for everyone.
- **One table at a time.** A player sits at one open table at a time, and since v0.5.0 not while waiting in a public queue (`409 in_queue`, [queues](queues.md#joining-and-waiting)). Joining, or opening a table, also needs room under the account's limit of running games (`CD_GAMES_PER_ACCOUNT`, 1 by default; SysOp has none).
- **Starting.** The host starts once every player's seat is taken and every other player is ready. Each player's limit of running games is checked again then. The other players' pages follow the table into its game.

## The table's rules (v0.4.5)

The owner's decision at the start of v0.4.5 ([plan](plans/0.4.5.md#decisions-at-the-start-of-v045)): no card leaves the game for its legality; the table's host chooses.

- **Two options.** The host chooses whether the table's decks may hold:
  - **banned cards**: banned in the format by Scryfall's legality or the format version's banned list, Lutri as a Commander companion included;
  - **cards not legal in the format**: Un-cards, playtest and digital-only cards.
- **Casual by default.** A new table allows both. **Tournament rules** turns both off; unticking it goes back to casual. There is no option for restricted cards: no Legacy or Commander card is restricted, and a restricted card still counts as one allowed copy.
- **The format's deck rules always apply:** deck size, copy limits, Commander's singleton and colour identity, commanders, partners and companions, and no card that is not out yet, not a deck card, or gone from Scryfall.
- **Tags.** The lobby shows each table's seats and rules as tags: "Casual" when both are allowed, "Tournament rules" when neither is, otherwise the one it allows ("Banned cards allowed", or "Cards not legal in Commander allowed"). The table's own page, which its invite link opens, shows them too, with a sentence that spells them out.
- **Tables open at the upgrade** became casual. They took only legal decks, so allowing more takes nothing away.

## Decks

- **Any deck the table's rules take.** A deck the player can play: legal by the format's deck rules, every copy in their library ([the library](progression.md#the-library)), and, since v0.4.5, no banned card or card not legal in the format unless the table allows it ([decks](decks.md#validation-deck08-t03t05)). A collection-locked deck is refused, as at the practice table. Administrators' whole-catalog decks play too, and SysOp's need only cards the engine implements, whatever the table's rules.
- **Checked as it sits down.** Opening a table (the host's own deck), joining one and changing deck all check the deck. A deck the rules do not take is refused (`422 deck_not_allowed`), and its player is told which cards and why: "This table does not allow banned cards: Black Lotus is banned in Legacy." The deck choices grey out such decks, with the reason.
- **Bound when the game starts.** Each player's deck is bound to an immutable revision of it then (DECK01), and every deck is checked again, rules included. If a player's deck can no longer be played at the start (edited since, or a card banned since), the host is told whose it is, never what it holds, and that player is no longer ready. The host's own deck is named to the host, with its cards.
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

## Two-Headed Giant (v0.5.1)

The owner's decision at the start of v0.5.1 ([plan](plans/0.5.1.md#decisions-at-the-start-of-v051)): Two-Headed Giant at human tables (FMT10), four players or players with bots, both winners paid. The game itself is the engine's ([Two-Headed Giant](engine/two-headed-giant.md)): shared team turns, 30 life a team, team poison.

- **Opening.** The host chooses Two-Headed Giant: four seats in two teams, seats 0 and 1 (Team 1, the host's) against seats 2 and 3 (Team 2). The host chooses whether their teammate is a bot, and whether the other team is two players, a player and a bot, or two bots. A table keeps at least two players' seats, so a bot teammate leaves the other team at least one player. That covers four players, three players and a bot, two players on a team against two bots, and a player and a bot on each side. The table records which seats are its bots' (`game_tables.bot_seats`); bots sit in the other team's last seat first.
- **Choosing a team.** A player joins a team (`team`), or takes the first free seat. A player may move to a free seat of the other team. The lobby lists a Two-Headed Giant table with its teams ("Team 1: ada and an open seat · Team 2: bob and a bot"), and its page shows the seats by team, with "Join Team 2" or "Move to Team 1".
- **Decks.** Each deck is a Legacy deck, checked as at a Legacy table by the table's rules (casual by default; "Cards not legal in Legacy" is Legacy's legality). Two-Headed Giant Constructed has no sideboard (MTR 9.5): a deck's stays out of the game. A table refusing banned cards also refuses Erayo, Soratami Ascendant, banned in Two-Headed Giant itself (MTR 9.5); SysOp's decks play whatever the rules say, as everywhere.
- **The team's decks** follow Unified Deck Construction (MTR 8.4): no two decks on a team may hold the same card, by English name, except basic lands. Checked when a player gets ready, against their teammate's deck as it stands: a refusal (`422 team_decks`) names the shared cards to the player, whose teammate may see them in the game's hands anyway (810.5): "Your deck and ada's share Lightning Bolt. In Two-Headed Giant teammates' decks may share only basic lands: one of you needs another deck." Changing deck or team makes the player, and the teammate they then have, not ready again, so two teammates who are both ready were checked together. Bots get one of the engine's four Legacy fixture decks, a different one each, sharing no card with their teammate's deck.
- **Readiness and the start follow the teams.** The host starts once every player's seat is taken and every other player is ready, as at any table. At the start every deck is bound and checked again, and each team's two decks together (`409 team_decks`): the host's own team is told the cards, another team is named without its cards ("bob's and dan's decks share a card…"), and both of its players are made not ready.
- **Conceding is the team's** (810.8b: "If a player concedes, their team leaves the game immediately. That team loses the game."). One player's concession loses the game for their team, and with two teams the game ends at once with the other team's win. The game screen says so before a player concedes ([the game screen](game-screen.md)).
- **Away players.** The vote works as at any table: the other players still in the game vote, the teammate among them, and a majority removes the away player. A removal concedes the seat in the engine, so in Two-Headed Giant the away player's team loses. A player whose teammate is a bot is voted on by the other team's players alone.
- **Results.** The engine's result names the winning team (`winner_seats`). Every player of the winning team counts a win, and each is paid for each seat of the other team, a player by their wins and a bot by its skill, under their own daily limits ([wins](progression.md#wins-and-levels), [tokens](tokens.md)); a teammate is never a seat beaten. Each player's quests, achievements and record count their own result, with the other team as their opponents ([quests and records](quests.md#results)).
- **Chat.** The table chat's allies channel is the team's, fixed for the whole game ([the team's channel](chat.md#the-teams-channel-v051)).
- **Rematch.** A Two-Headed Giant table's rematch keeps the teams: every player keeps their seat, and bots take the seats bots or removed players held ([rematches](queues.md#rematches)).

## Routes

| Route | What |
| --- | --- |
| `GET /api/v1/tables` | Open tables, newest first: the public ones and your own (SysOp: every one) |
| `POST /api/v1/tables` | Open a table: `format` (since v0.5.1 also `two_headed_giant`), `seats` (2 in Legacy, 2–4 in Commander, 4 in Two-Headed Giant), `bots`, `bot_teammate` (since v0.5.1, Two-Headed Giant: one of the bots is your teammate), `bot_skill`, `turn_cap`, `visibility`, `rules` (since v0.4.5: `{"banned": bool, "not_legal": bool}`, both true by default), `best_of` (since v0.5.0: 1, or 3 in Legacy), `deck_id` |
| `GET /api/v1/tables/{code}` | A table by its invite code: its rules, its seats (handles, portraits, ready, since v0.5.1 each seat's `team`), your own deck, and its game once started (for its players and SysOp) |
| `POST /api/v1/tables/{code}/join` | Take the first free seat with `deck_id`, or since v0.5.1 the first free seat of `team` (0 or 1) |
| `PATCH /api/v1/tables/{code}/seat` | Change `deck_id`, `ready`, or since v0.5.1 `team` |
| `POST /api/v1/tables/{code}/leave` | Leave; the host closes the table |
| `POST /api/v1/tables/{code}/start` | The host starts the game |

Every route needs `games.play`, and seats need `decks.edit`. Refusals:
- 404 for a code no table has.
- 409 `at_a_table` (another open table), `in_queue` (since v0.5.0: waiting in a public queue), `game_limit` (no room for another running game, naming the player at the start), `table_full`, `table_closed`, `already_seated`, `not_seated`, `not_ready`, `table_not_full`, `deck_not_playable` (another player's deck at the start), `player_unavailable`, `table_changed` (a player left as it started); since v0.5.1 `team_full` (no free seat in that team) and, at the start, `team_decks` (a team's decks share a card).
- 403 `not_host` for a start by anyone but the host.
- 422 `invalid_table`, the practice table's deck refusals (`invalid_deck`, `deck_not_playable`), and since v0.4.5 `deck_not_allowed`: your deck holds cards the table's rules do not allow, named in the message; since v0.5.1 `team_decks` as you get ready: your deck and your teammate's share cards, named.
- 429 `games_busy` and 503 as for practice games.

Away players and votes go over the game's WebSocket: the `presence` message and the `vote` message ([games](games.md#the-websocket)).

## Data

Migration `0009_tables` adds:
- **`game_tables`.** The code, host, format, seats, bots, bot skill, turn cap, visibility, status (`open`, `started` or `closed`), the game, and when it was opened, started and closed.
- **`table_seats`.** Each player's seat at a table in the lobby, with their deck and whether they are ready. One seat per player per table.
- **`games.kind`** may be `table`.
- **`game_seats.left_at` and `left_reason`.** A seat out of a game that went on without it: `conceded`, `removed` or `eliminated`.

Going back to 0008 keeps every game, with its wins and tokens, as a practice game, and drops the tables.

Migration `0022_queues` (v0.5.0) marks the tables the public queue makes, and their rematches' (`game_tables.queued`), started at once and private, with every seat taken and ready ([queues](queues.md#data)).

Migration `0019_table_rules` (v0.4.5) adds each table's rules, `game_tables.allow_banned` and `allow_not_legal`, true for the tables already there, and each deck's needs ([decks](decks.md#validation-deck08-t03t05)). Going back drops them: tables take legal decks only again.

Migration `0023_matches` (v0.5.0) adds `game_tables.best_of`, 1 for the tables already there, and the matches a best-of-three table plays ([matches](matches.md#data)).

Migration `0026_two_headed_giant_tables` (v0.5.1) lets a table's format be `two_headed_giant` and adds `game_tables.bot_seats`, the seats its bots fill when they are not the last ones (null for every table already there). It also makes the Two-Headed Giant queue's places and invitations possible ([queues](queues.md#data)). It only adds. Going back deletes the Two-Headed Giant tables that never started, with their seats, and marks those that started as Legacy tables; their games stay recorded as Two-Headed Giant games.

## Verification

- **API tests (`tests/test_tables.py`).** Against a fake engine with a token and a view for each player's seat:
  - the lobby, privacy (no deck of another player in any answer), seats, ready, the start, and the engine's request with the hour's idle timeout;
  - each player's connections seeing only their own seat, with no token in any message;
  - a concession, the winner's win and the 50 tokens it paid;
  - the vote: refused before 2 minutes, a majority of two, a removal with the seat's own token, its audit entry, and the removed player coming back;
  - the opponent alone removing in a two-player game;
  - one open table at a time, private tables, collection-locked decks, leaving, the host closing, and a stale table closing;
  - every player's limit of running games at the start, and another player's deck named by its player only;
  - a concession freeing the seat, SysOp observing the first seat and closing, and the migration going back;
  - since v0.4.5, the table's rules: a tournament table refusing the host's banned deck, a join and a deck change with the cards named, a deck edited after it sat down stopped at the start with its player named only, the host's own named with its cards, casual by default, one option alone, SysOp's deck at any table, and the tables open at the upgrade becoming casual.
- **API tests (`tests/test_team_play.py`, v0.5.1).** Against the tables' fake engine taught that a concession is the team's:
  - a four-player table from the lobby: the seats by team, a Commander deck refused, a player choosing a team and another taking the first free seat, a full team refused, the lobby listing the teams without a deck, Unified Deck Construction as a player gets ready with the shared card named, the host's deck change making only her teammate not ready, the start sending four Legacy decks without sideboards;
  - the fixed team channel at that game: the teams as the alliances, offering or ending one refused, a team's lines received by its other player and by no connection of the other team, a tab connecting late told its own team's lines only, SysOp watching and its reader reading both;
  - one player conceding for the team: both winners counting a win and paid 50 for each player of the other team, nothing for the losers, each player's result with the other team as opponents, both earning "First Victory", a replayed end and the win and pay counted again adding nothing, and the history marking the teammate;
  - a bot teammate and a player and bot opposite: bots dealt fixture decks their teammate shares no card with, the team channel refused beside a bot, the winner paid for a player and a bot of skill 5; two players against two bots, both paid for the bots and neither counted as beating a player; refused configurations;
  - the start checking each team again after two players edited their decks: the host told whose decks, not which card, and both made not ready;
  - Erayo refused at a tournament table, SysOp's deck aside; a rematch keeping the teams, with a bot in a removed player's seat.
- **Engine (`CommanderGameTest`).** A concession that leaves one player ends the game without that player's answer.
- **Web tests.** The lobby, a table's page (seating, ready, following the start into the game, the host's start), the away players and their votes, and the game screen at a table (handles, the vote, the tokens paid, the way back to the lobby). Since v0.4.5: each table's rules as tags, the host's two boxes and Tournament rules, and the decks the rules do not take greyed with the reason, in the lobby and on a table's page.
- **Browser journey (`web/e2e/tables.spec.ts`).** SysOp and a second account in two browsers: SysOp opens a Legacy table, the player finds it in the lobby, joins by its invite link and gets ready, and SysOp starts. Both play their own seats for a few turns, the player concedes, and both see the result, SysOp with the 50 tokens the win paid. Every frame of each browser is checked for the other's concealed cards. It needs the engine, SysOp and `CD_E2E_PLAYER_SESSION` from `scripts/e2e_player.py`.

**Run on 2026-10-21** against a throwaway stack: its own network and PostgreSQL, the engine, API and web images built from the work, the test catalog, a generated SysOp and a second player from `scripts/e2e_player.py` (`CD_BOT_DECKS=fixtures`). Playwright shared the web container's network, so the browsers came from loopback.
- The table journey passed: 3 turns, the player conceded while SysOp held priority, and the game ended at once (55 and 57 frames, no concealed card). With the engine from before the fix, SysOp's game waited for its next answer.
- The 7 practice game journeys and CI's two scripted games through the API (`scripts/api_practice_game.py`) passed unchanged.
- An away check with the real engine: the player never connected, SysOp's vote passed 120 seconds after the start, the API conceded the player's seat, and the game ended with SysOp's win, the seat recorded as removed and 50 tokens paid.
