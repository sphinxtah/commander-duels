# Best-of-three matches (v0.5.0)

Since v0.5.0 Legacy is played best of three, with sideboards: the scope's FMT05 (matches), FMT06 (the play/draw choice for later games) and FMT07 (wishes). The owner's decisions are in [the v0.5.0 plan](plans/0.5.0.md#decisions-at-the-start-of-v050): best of three at Legacy human tables, Legacy practice games and in a public queue of its own ([queues](queues.md)); every game won counts as a win and pays its tokens as a single game does; the match result is recorded for the statistics.

## Starting a match

- **Where.** A Legacy human table's host chooses best of one game or best of three when opening the table ([human tables](tables.md)). A player at the practice table chooses the same for a Legacy game against the bot ([games](games.md#practice-games)). Commander plays one game.
- **The first game** starts as any game does: the table's start, or the practice table's. Each player's deck is bound then to an immutable revision (DECK01), and the whole match plays that revision. The engine draws who chooses to play first in it, as for any game.
- **For whatever starts games.** `api/matches.py: begin(db, game, best_of)` makes a newly recorded first game a match's, in the same transaction. The practice table and the tables call it, and so does the best-of-three Legacy queue (its tables through `add_table_game`, a player alone with a bot through its practice game).

## Winning

- **Two game wins take the match.** Each game is its own game in the engine and in the API's records, numbered in its match.
- **A game without a winner adds a game.** A draw, the turn limit, an engine error or a game the engine lost (a restart) counts for nobody, and the match plays another game.
- **At most five games.** After the fifth, the player with more game wins takes the match; with as many, the match is a draw.
- **A closed game ends the match without a result.** So does a game the engine closed because nobody did anything for its idle timeout (15 minutes at the practice table, an hour at a table). The match is then `closed`.
- **Conceding or removal.** A player who concedes the match, or whom the other player removes while away, loses it, whatever the score ([below](#leaving)).

## Between games

- **Sideboarding.** Each human player swaps cards between the main deck and the sideboard of the revision bound at the start, one copy at a time. The pool is locked: an arrangement holds exactly that revision's main-deck and sideboard cards, no others and no more copies. The companion and the maybeboard stay where they are.
- **Validated as a deck.** Every arrangement is checked as Legacy's deck rules check a deck: 60 cards at least in the main deck, 15 at most in the sideboard, the copy limits, and the copies the player's library holds now, over both. A refusal says what is wrong, in the deck rules' own words, and nothing is saved. SysOp's arrangements need only keep to the pool.
- **Private.** A player's arrangement is in no answer and no WebSocket frame that another player receives: the match page shows each player their own, the opponent only as ready or sideboarding. SysOp sees every arrangement, under its full access.
- **Bots keep their deck** and are always ready. A deck with no sideboard to swap with (a fixture deck, SysOp's deck list) plays as it is.
- **Play or draw (FMT06).** The loser of a game chooses whether they play first or draw first in the next. After a game without a winner, whoever chose for it chooses again; after a first game without one, a player is drawn to choose. A bot that lost plays first. The API tells the engine which seat starts, and the engine asks nobody.
- **Ready.** The next game starts as soon as every player is ready. Saving an arrangement makes a player not ready again.
- **The clock.** Sideboarding lasts 5 minutes at most (`SIDEBOARD_SECONDS`). Then the next game starts with every deck as it is saved; a chooser who has not chosen plays first. The clock survives a restart of the API.
- **Waiting for a slot.** When every game slot is in use (`CD_GAMES_MAX`), or the engine does not answer, the next game waits and the match page says why; it asks again every 5 seconds while the slots are full, and every 30 while the engine does not answer. If the engine refuses the decks (a card it no longer knows), the match ends without a result (`failed`).

## Leaving

- **Conceding a game** (the game's Concede) loses that game: the other player's win counts, and the match goes on.
- **Conceding the match** (the Game menu's "Concede the match", or the match page's) concedes the game in play with the seat's own token and ends the match with the other player's win. Between games it ends the match at once. The games already won still count.
- **Away players.** At a table, a player voted out while away ([human tables](tables.md#away-players)) loses the game and the match.
- **One running game.** A match counts as one running game against each player's limit (`CD_GAMES_PER_ACCOUNT`), between its games too, until it ends or the player leaves it. Account deletion and resets wait for it, as for a running game.

## Wins and tokens

Every game of a match is recorded by `record_end` as any game is, and in the same transaction its match counts it. So every game won counts as one win and pays its tokens exactly as a single game does, once: a replayed end records nothing twice. The match itself pays nothing more; it records each player's game wins, its winner (or a draw) and why it ended, for the statistics: a profile's record counts each match once, beside its games ([quests and records](quests.md)).

## Wishes (FMT07)

A Legacy deck of a player's own goes to the engine with its sideboard, in every game, best of one included. XMage keeps those cards outside the game, where an effect that fetches a card from outside the game (Burning Wish, Living Wish) finds them, as Magic's rules say. No seat's view, the player's own included, shows a sideboard. Companions stay out of it, because XMage would offer a sideboard's companion as one: the companion location stays out of the game as before. The bots plan with each opponent's deck list ([fair bots](engine/fair-bots.md)), and the sideboard is part of that list.

## On screen

- **The match page** (`#match/<id>`, under Play) shows the score, each game's result and what it paid you, and between games the sideboarding: every card of the pool with its copies in the main deck and the sideboard, the counts against Legacy's limits, what the rules say of them, the play/draw choice for the loser, the clock, and Ready. A valid arrangement saves by itself a moment after the last change; Ready saves it at once. The page follows the match into each new game.
- **The game screen** shows the game's number and the score ("Game 2 · 1–0") on the table. The Game menu offers "Concede the game" and "Concede the match". The result says where the match stands ("Match 1–1. Game 3 is next") and leads to sideboarding; after 6 seconds the screen goes there by itself, unless the player chose to review the board.
- **The Play page** lists the running matches, with Resume and Concede the match, and marks each game of a match in the list of games. Since v0.5.1 its Concede the match asks first, as the match page's and the Game menu's do (the owner's change to a v0.5.0 decision).
- **Opening a table and the practice table** offer "One game" or "Best of three" in Legacy. The lobby tags a best-of-three table.
- **The deck editor** always shows a Legacy deck's sideboard, and says what it is for.

## Routes

| Route | What |
| --- | --- |
| `POST /api/v1/practice-games`, `POST /api/v1/tables` | Since v0.5.0 take `best_of`: 1 (the default) or, in Legacy, 3 |
| `GET /api/v1/matches` | Your matches, newest first (20), without decks |
| `GET /api/v1/matches/{id}` | The match: its players (handle, portrait, game wins, ready, left), its games (result, what each paid you), the game in play, the chooser and the choice, the clock, the end; and your own seat's arrangement (`deck_cards`; SysOp: every seat's) |
| `PUT /api/v1/matches/{id}/sideboard` | Your arrangement for the next game: `cards`, each `card_id`, `printing_id`, `main` and `sideboard` |
| `POST /api/v1/matches/{id}/ready` | `ready` (true or false), and for the chooser `play_first` |
| `POST /api/v1/matches/{id}/concede` | Concede the match, and the game in play |

A game's summary (`GET /api/v1/games/{id}`) carries its `match`: the match's ID, its game number, status, each seat's game wins, its winner and whether it is a draw. A table's view carries `best_of`; the practice table's options list each format's `best_of`.

Every route needs `games.play`. Refusals:
- 404 for a match you do not play (SysOp sees every one).
- 409 `match_over`, `not_in_match` (you conceded or were removed), `not_sideboarding` (a game is in play), `not_chooser` (`play_first` from the player who won).
- 422 `invalid_table` for best of three outside Legacy; `invalid_sideboard` for an arrangement that leaves the locked pool, or a deck with no sideboard; `sideboard_not_legal` with the deck rules' words.
- 503 `engine_unavailable` when the engine does not take a concession.

## Data

Migration `0023_matches` adds:
- **`matches`.** Kind (practice or table), format, best of, status (`playing`, `sideboarding`, `finished` or `closed`), creator, bot skill, turn cap and idle timeout for its games, the game number, the chooser and the starting seat chosen, the sideboarding's deadline, the winner's seat or a draw, why it ended (`games`, `conceded`, `removed`, `closed`, `failed`), and when it began and ended.
- **`match_players`.** Each seat's player and account, the deck revision bound at the start, the deck the engine took for a seat that never sideboards, the private arrangement, ready, game wins, and when and why the player left (`conceded` or `removed`).
- **`games.match_id` and `match_game`**, and **`game_tables.best_of`** (1 for the tables open at the upgrade).

Going back to 0020 drops them: every game stays, with its win and its tokens, as a game of its own. Account deletion keeps a deleted player's matches, as it keeps their games; the arrangements hold card IDs only.

## The engine

- **`starting_seat`** (v0.5.0) in a game request names the seat that takes the first turn: the engine sets XMage's starting player before the game starts, and XMage asks nobody. Without it a seat drawn at random chooses in the game, as before.
- **A Legacy deck list's `sideboard`**, `[{"name", "count"}]`, becomes the player's XMage sideboard. Commander lists have none.

## Verification

- **API tests (`tests/test_matches.py`)**, against the tables' fake engine: a practice match won 2–0 (the first game's request with the sideboard, the bot choosing to play first, a sideboarded second game, its request and its starting seat, the bot's deck kept, each game won counted and paid once, a replayed end paying nothing more); a table match won 2–1 with the loser choosing to draw, and sideboarding's clock starting the third game; nothing another player receives (the match, the list, the game, the table and every WebSocket frame) naming a player's sideboard or deck, SysOp seeing every arrangement and a stranger getting 404; draws, the turn limit and an engine error adding games up to a drawn fifth; a closed game closing its match; conceding a game, conceding the match during a game and between games; an away player removed losing the match; the locked pool and Legacy's limits; the library over both; a match holding its player's running game between games; best of three refused outside Legacy; the next game waiting for a free slot; a restart counting a game without a result; and the migration going back.
- **Engine tests (`MatchGameTest`).** `starting_seat` is read and checked; the named seat starts in a real game, for the human's seat and the bot's, and nobody is asked who starts; a Legacy list's sideboard is the player's XMage sideboard and never reaches another seat's views; only Legacy lists have one.
- **Web tests.** The match page (sideboarding with the counts and the rules' words, Ready saving then readying with the choice, following into the next game, waiting for the other player, the clock, a deck without a sideboard, a finished match, conceding, a missing match), the game screen's match (the score, the two concessions, the way on to sideboarding), following on after a game, and best of three at the practice table and in the lobby.
