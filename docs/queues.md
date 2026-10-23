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

Taken while building v0.5.1's Two-Headed Giant queue, each open to the owner too:
- **Players alone are paired only when their decks share no card**, judged from the decks as they stand, so the check never refuses a stranger; two players who cannot be teammates and wait a minute play on opposite sides, each with a bot.
- **A team's place in line starts when the friend accepts**, not when the invitation was sent, and takes the inviter's "Players only".
- **An invitation stands while its inviter waits**, with no time limit of its own; it goes when they withdraw it, their app stops asking, or the friend declines.
- **A shared card is named to the friend accepting** an invitation, as teammates see each other's hands in the game.

## The queues

- **Six queues.** Legacy for two players, one game or best of three ([matches](matches.md)), Commander for two, three or four, each size its own queue, and since v0.5.1 Two-Headed Giant, two teams of two ([below](#two-headed-giant-v051)). The player picks the size, and in Legacy the games.
- **A queue is a key.** In the code a queue is `QueueKey(format, seats, best_of)`. The best-of-three queue seats its players at a best-of-three table, or a player alone with a bot at a practice match, whose first game begins the match ([matches](matches.md)).
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

## Two-Headed Giant (v0.5.1)

The owner's decision at the start of v0.5.1 ([plan](plans/0.5.1.md#decisions-at-the-start-of-v051)): a Two-Headed Giant queue beside Legacy and Commander, with bots after a minute as the others, whose teams form solo or with a friend, a pair never split.

- **Decks.** A Legacy deck, checked as at a Two-Headed Giant table with the casual rules ([tables](tables.md#two-headed-giant-v051)). No sideboard plays.
- **Alone.** A player alone is paired with another player alone: the first who waited before them whose deck shares no card with theirs but basic lands (Unified Deck Construction), read from the decks as they stand. Two players whose decks share a card are never paired, so no player learns a card of a stranger's deck.
- **With a friend.** **Your teammate: A friend** picks one of your friends ([friends](social.md#friends)), and **Invite bob** sends the invitation: your place says "Waiting for bob to join your team…", with **Withdraw the invitation**. The friend hears of it through the bell (a `team_invite` notification, "ada invites you to play Two-Headed Giant as their teammate.", which leads to Find a game) and sees it above the form, with a deck choice, **Accept** and **Decline**. Accepting checks the friend's deck as joining does, and the two decks together: a shared card is named to the friend, as teammates see each other's hands in the game anyway (`422 team_decks`). From then on the two wait as one team, in line from the moment they accepted, with the inviter's "Players only". Inviting a friend who has invited you accepts their invitation. Declining tells the inviter who declined. An invitation is in no line: nothing is matched until it is accepted.
- **Never split.** When either player of a team leaves the queue, is taken out as the game starts (their deck or limit), or their app stops asking, the other leaves too, told why ("bob left the queue, so your team did too."). Deleting or resetting an account ends its team, and every invitation it sent or was sent.
- **Matching.** Two teams make a full table at once: a pair of friends is a team, and players alone pair up as above, in the order they joined. Once a player who takes bots has waited a minute, the first two sides of the players who take bots are seated, a side of two players first, and bots take every empty seat: a pair or two paired players against two bots, a team against a player with a bot teammate, two players whose decks share a card on opposite sides each with a bot, and a player alone with three bots a practice game, as in the other queues.
- **The game** is a Two-Headed Giant table's ([tables](tables.md#two-headed-giant-v051)), marked queued and private, with the team's fixed chat channel ([chat](chat.md#the-teams-channel-v051)). Every deck and each team's two decks are checked again at the start: friends whose decks now share a card are taken out together, told which; two paired players simply wait on, to be paired apart.

## Rematches

- **Where.** On the game's result screen, in its dialog and in the panel beside the board, for the game's players.
- **A practice game** (a queue's game alone with bots too) starts again at once with the same request: the same deck, bots, skill, format, turn limit and rules. The deck is checked again. A practice game from before v0.5.0 recorded no request, so it has no Rematch.
- **A table's game** (from the lobby or a queue): Rematch offers the players still there the same seats and decks, and the table's rules. Players the vote removed are not asked, and bots take their seats, as bots take the seats they filled.
  - **The others hear of it** on their result screen ("ada offers a rematch: the same seats and decks", with each player's answer) and through the bell: a `rematch` notification, which opens the game's result screen.
  - **It starts once every player asked has accepted,** within 2 minutes. Every page follows into the new game.
  - **It ends** when a player declines (or withdraws their own offer), when a player leaves the result screen while it stands, or when 2 minutes pass. The others then go back with the result screen's own link: **Find another game** for a queue's game (and its rematches), **Back to the lobby** for a table's.
  - **Checked again at the start,** as at a table's start: every deck, as it stands now, with the table's rules, and every player's limit. A deck or a limit that stops it ends the rematch for everyone, naming whose ("bob's deck cannot be played now."), never what the deck holds. The player whose own deck stopped it is told why in full.
  - **The new table** keeps the old one's visibility, rules, bots' skill, turn limit, whether the queue made it, and whether it plays best of three.
- **Two-Headed Giant's rematch keeps the teams** (v0.5.1): every player keeps their seat, bots take the seats bots or removed players held, and each team's decks are checked together again (a failure names the two players, never a card). A table refusing banned cards refuses Erayo, Soratami Ascendant, banned in Two-Headed Giant itself, again, as at its start: a deck that took it in after the game stops the rematch, its player named as for any deck.
- **A best-of-three match's rematch** is a whole new match: it is offered only once the match is over (`409 match_running` before), and replays the match's request or table.
- **Free to play.** Offering or accepting needs room under the account's limit of running games, and no open table or queue of your own: the rematch is your one table.
- **One rematch a game.** Asking again answers with the first.
- **Busy.** If the last answer comes while every game slot is in use, or the engine does not answer, the offer stands and that answer is asked again.

## Routes

| Route | What |
| --- | --- |
| `GET /api/v1/queues` | The queues: `format`, `seats`, `best_of`, `name` and how many players wait in each |
| `GET /api/v1/queue` | Your place: `status` (`none`, since v0.5.1 `inviting`, `waiting`, `matched`, `left`, `refused`), the queue, your deck, `waited_seconds`, `position`, `waiting`, `bots_in_seconds` (null for players only), `game_id` once matched, and `reason` and `message` when you were taken out or your match waits; since v0.5.1 `partner` (the friend you invited or wait with: `id`, `handle`, `portrait`) and `invites` (friends inviting you: `player`, `humans_only`, `invited_at`). Asking keeps the place |
| `POST /api/v1/queue` | Join: `format`, `seats`, `deck_id`, `humans_only`, `best_of`, and since v0.5.1 `partner_id` (Two-Headed Giant: a friend to invite). The answer is your place, or the game found at once |
| `POST /api/v1/queue/invites/{player_id}` | Since v0.5.1: accept a friend's invitation with `deck_id`. The answer is your place, or the game found at once |
| `POST /api/v1/queue/invites/{player_id}/decline` | Since v0.5.1: decline a friend's invitation |
| `DELETE /api/v1/queue` | Leave, or withdraw your invitation; your team leaves too. A game found a moment before stays, and the answer names it |
| `GET /api/v1/games/{id}/rematch` | The game's rematch for its players (and SysOp): `status` (`none`, `open`, `started`, `declined`, `lapsed`, `failed`), `kind`, `origin` (`practice`, `lobby` or `queue`), `can_offer`, the players asked with their answers, `your_answer`, `expires_in`, the new `game_id`, `offered_by`, `declined_by` and `message` |
| `POST /api/v1/games/{id}/rematch` | Rematch: a practice game starts again; at a table this offers the rematch or accepts it, and the last answer starts it |
| `POST /api/v1/games/{id}/rematch/decline` | Decline the offer, or withdraw your own |

Every route needs `games.play`, and joining needs `decks.edit`. Refusals:
- 422 `invalid_queue` (no such queue, or a teammate outside Two-Headed Giant), the table's deck refusals (`invalid_deck`, `deck_not_playable`), and since v0.5.1 `team_decks` (your deck and the inviting friend's share cards, named).
- 409 `in_queue`, `at_a_table`, `game_limit` for a queue; since v0.5.1 `not_friends` (only a friend may be invited, or accepted) and `invite_gone` (the invitation was withdrawn, declined or lapsed with its inviter's app); 404 for a friend who is not an active player; for a rematch also `game_running` (the game has not ended), `not_asked` (the vote removed you), `rematch_unavailable` (too few players left, or a practice game from before v0.5.0), `rematch_closed` (declined, lapsed or failed), and at its start `deck_not_playable` and `player_unavailable`, naming whose.
- 403 `not_a_player` for a rematch asked by someone who did not play the game (SysOp may read it). Others' games are not found (404), as anywhere.
- 429 `games_busy` and 503 as for practice games, at a rematch's start.

## Data

Migration `0022_queues` adds:
- **`queue_entries`.** One row an account: its queue (format and seats; since `0023_matches` also `best_of`), deck, players only, status (`waiting`, `starting` while a match makes its game, `matched`, `left` or `refused`), when it joined and when its app last asked, the game it found, and why it was taken out.
- **`rematches`** and **`rematch_players`.** At most one rematch a game: who asked, its status, when it lapses, the new game, who declined and why it failed; and each player it asks, by their seat, with their answer.
- **`games.settings`.** A practice game's request, for its rematch; null for a table's game.
- **`game_tables.queued`.** A table the queue made, or a rematch of one.
- **`notifications.game_id`** and the `rematch` notification.

Going back to 0020 drops them, with every place in a queue, every rematch and the rematch notifications. Queue games stay recorded as the table games they are.

Deleting an account takes it out of its queue and forgets its last wait ([accounts](../api/accounts.py)); so does resetting it ([resetting an account](identity.md#resetting-an-account-v045)). Its rematch answers stay, as its games do. Since v0.5.1 its team leaves the queue with it, and the invitations it sent or was sent end.

Migration `0026_two_headed_giant_tables` (v0.5.1) lets a place's format be `two_headed_giant`, adds the status `inviting` and `queue_entries.partner_id` (the friend invited, then each of a team's two rows names the other), and the notification kind `team_invite` ([tables](tables.md#data)). Going back deletes every place in the Two-Headed Giant queue, every invitation and their notifications.

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
- **API tests (`tests/test_team_play.py`, v0.5.1).** Four players alone paired into teams whose decks share no card; friends: inviting only a friend and only in Two-Headed Giant, the bell's invitation and the invitee's place, the invitation in no line, accepting refused for a shared card named to the two and then waiting as a team with the inviter's players only, and two players alone making the other team; a decline told to the inviter, inviting back accepting, one leaving taking the other out, a team whose app stopped asking going together, a player refused at the start taking their friend out; bots after a minute (alone, a practice game with a bot teammate dealt a fixture deck sharing no card; two players who cannot be teammates on opposite sides with a bot each; friends against two bots); deleting an account ending its team and the invitations; the pairing rules on their own; the migration going back; and on PostgreSQL eight players alone claimed in parallel into two tables, none twice.
- **Web tests (`web/src/queues/queues.test.tsx`, v0.5.1).** Inviting a friend from Find a game (the friends asked for only then, the request, the wait for the answer, withdrawing it); accepting an invitation with another deck after a shared card was named, and waiting with the friend; declining, and the team's last wait in words; the bell's words and link.
- **Browser journey (`web/e2e/queues.spec.ts`).** SysOp imports a Legacy deck, finds a game with players only, watches the wait count up, sees the main menu's Play tile say so and lead back, and leaves the queue. Since v0.5.1 also a Two-Headed Giant table with a bot teammate and a player and a bot opposite, seen by team on its page and in the lobby, then closed, and Two-Headed Giant's queue with players only, on the Play tile, then left. It needs no engine. The deck journeys now look for the practice table's choices inside it, since "Find a game" above it has a deck and a format of its own.

**Run on 2026-10-23** in the teams' branch (v0.5.1): an API from the branch's source on its own PostgreSQL, the test catalog and a generated SysOp, without the engine, Vite in the Playwright container. Of the whole suite, 47 passed, the two queue journeys and the Two-Headed Giant one among them, and 16 that need the engine were skipped; the shop's pack journey failed on its pack picture, which that throwaway setup lacked.

**Run on 2026-10-23** in the queues' branch, as CI's verify job runs the journeys: an API from the branch's source on its own PostgreSQL, the test catalog and a generated SysOp, without the engine. Of the whole suite, 44 passed, the queue's among them, and 14 that need the engine were skipped; two deck journeys failed on the Play page's new choices, and passed on a second run once scoped to the practice table. The engine-backed journeys and a match between two browsers were not run.
