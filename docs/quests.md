# Quests, achievements and statistics (v0.5.0)

Since v0.5.0 every player has three daily quests, earns achievements as badges for the profile, and has a record: totals that every player sees and a match history that only the player and SysOp see. This is the scope's PROG04 (quests), PROG07 (achievements) and PROG08 (profiles and history). The owner's decisions are in [the v0.5.0 plan](plans/0.5.0.md#decisions-at-the-start-of-v050). The API is `api/stats.py`, `api/quests.py`, `api/achievements.py` and `api/awards.py`; the web app's parts are `web/src/quests/` and `web/src/records/`.

Everything here is judged from the server's own record of a game that ended and the deck the seat played, as wins and tokens are ([progression](progression.md#wins-and-levels), [tokens](tokens.md)). The browser never reports a result, and nothing that happens inside a game counts: no quest asks for twenty spells cast.

## Results

- **One row per player and game** (`player_results`). When the API records a game's end (`api/games.py`, `record_end`), the same transaction counts the win, pays the tokens and then writes each human seat's result: its outcome, the game's format, kind and seats, how many other players and bots sat there and the bots' skill, the colours of the deck the seat played, the turns, and when the game began and ended. Since the result is written with the game's end, a replayed end, a retry or a restart finds the game no longer active and writes nothing; a seat's row is unique anyway. PostgreSQL refuses updates and deletes.
- **Games interrupted by a restart** of the API get their rows too, with no result, when the restart's sweep marks them interrupted.
- **Outcomes** (`results-v1`, recorded on each row):

| Outcome | When |
| --- | --- |
| Win | The engine reports the game completed with the seat as the winning seat, as wins count. |
| Loss | A completed game that another seat (a player or a bot) won; a game that ended with every human out (`humans_eliminated`); or a game the seat left by conceding, being eliminated or being voted out, however the game then ended. |
| Draw | The engine reports the game drawn. |
| No result | Anything else: a turn limit, an idle timeout, a closed game, a game the API interrupted. |

- **The deck's colours.** A Commander deck's colours are its commanders' color identity, a Legacy deck's the colors of its cards, as the deck builder shows them, from the revision the game played (DECK01). The engine's fixture decks have their colour in their names. A deck list SysOp typed has none recorded. A "red deck" is a deck whose colours include red: a red and green deck is a red deck and a green deck.
- **Every kind of game counts:** practice games against bots, human tables, and any kind of game added later (the public queues), since a row copies the game's kind and format without a list to check them against. "Against players" means at least one other human sat at the table; "against bots" means every other seat was a bot.
- **Two-Headed Giant's teams** (since v0.5.1, when both of a team may be players). A team wins together: each of its players' rows is a win, and each completes their own quests and earns their own achievements, paid once each. A row's other players and bots are the other team's only: a teammate, a player or a bot, is never an opponent. So two players beating two bots played "against bots" and did not "win at a human table", and a player with a bot teammate who beat two players beat no bot. The history marks the teammate (`teammate` on the seat; "against bob and dan, with cara"). A bot teammate is named by its skill, the game's, even when the row counts no bot ("against bob and dan, with a skill-5 bot").
- **Games before v0.5.0.** Migration 0021 entered every game that had ended, from the result the API had recorded and the deck each seat played, judged by the same rule. A deck's Godlike custom cards add no colour to those rows; games after v0.5.0 count them.

## Daily quests

- **Three a day.** The day is a calendar day in Arizona, from midnight (Mountain Standard Time all year, as for tokens). The day's three are drawn the first time the account asks for its quests that day, which the main menu does, and stay the same all day. Each comes from a group of its own (wins, formats, colours, bots, players), so no two ask much the same thing.
- **Read from results.** A quest counts the account's wins that day: a game it won, as its result row says, finished that day and since its last reset. Wins from earlier in the day count, even those before the day's first look.
- **One swap a day** replaces one quest not yet completed with another, drawn from a group the other two do not hold. Only games finished after the swap count towards the new one, so a swap cannot pick a quest already won. A quest completed cannot be swapped (409 `quest_completed`); a second swap is refused (409 `swap_used`).
- **Completion pays at once, once.** The transaction that records a game's end checks the winner's quests of that day and completes those its wins now meet; asking for the quests checks again, so wins from before the day's first look pay then. There is nothing to claim: completing is claiming, keyed so that it happens once (the scope's "completion claims"). Each quest pays through the economy ledger, kind `quest`, keyed `quest:<account>:<day>:<quest>`; a replayed end, a second look or two games ending at once pay nothing more. A quest's reward and the wins it needs are recorded when it is drawn, under the rule `quests-v1`.
- **The bell** tells the player (`quest_completed`), with the quest and what it paid ([notifications](social.md#notifications-and-the-bell)).

The pool (`QUESTS` in `api/quests.py`):

| Quest | Wins | Tokens | Group |
| --- | :-: | --: | --- |
| Win a game | 1 | 100 | wins |
| Win three games | 3 | 200 | wins |
| Win a Commander game | 1 | 125 | formats |
| Win two Commander games | 2 | 200 | formats |
| Win a Legacy game | 1 | 150 | formats |
| Win a four-player Commander game | 1 | 200 | formats |
| Win with a white, blue, black, red or green deck (five quests) | 1 | 150 | colours |
| Win with a mono-coloured deck | 1 | 150 | colours |
| Win with a deck of three or more colours | 1 | 175 | colours |
| Beat a bot of skill 4 or higher | 1 | 150 | bots |
| Beat a skill-6 bot | 1 | 250 | bots |
| Win at a human table (beat at least one other player) | 1 | 250 | players |

## Achievements

- **Badges that pay once.** Each achievement earned is a badge on the profile and pays a one-time reward through the economy ledger, kind `achievement`, keyed `achievement:<account>:<achievement>`. The bell tells the player (`achievement_earned`).
- **Definitions by version** (PROG07). The definitions are `ACHIEVEMENTS` in `api/achievements.py`, versioned with the code. Each has a stable ID and a version of its own, raised if its condition ever changes. What an account earned is a row of its own (`player_achievements`) with the version it was earned by; no update removes it.
- **From the server's record only:** the account's results (wins), the daily quests it completed, the packs it opened and the friends it made. Wins are games won; SysOp's settings of an account's wins earn nothing, so SysOp's 100,000 starting wins do not earn "Legendary Planeswalker".
- **Earned when checked, so nothing is missed:** in the transaction that records a game's end, for the winner (only wins earn); when a pack is opened, for its opener; and whenever the account looks at its achievements on Profile. A friend made counts at the next of these.
- **Players with a history.** Migration 0021 pays nothing. A player whose games from before v0.5.0 already qualify earns those achievements at the first check (their next win, or opening Profile), paid then and told by the bell. The same check would give an achievement added in a later version to everyone who already qualifies.
- **Pinned badges.** On Profile a player pins up to three earned badges, in order, to show first on their profile; pinning again replaces them, and none unpins all.
- **Magic Duels' own achievements are not inventoried** (the scope's reference inventory, `docs/reference_inventory.csv`, has none yet), so none of these maps to one of them. Those about Commander and Legacy are marked as additions (PROG07, `addition`), and Profile labels them "Commander and Legacy addition". When the original list is inventoried, its mapped achievements join this list with IDs of their own.

The first set, 29 achievements worth 6,450 tokens in all:

| Group | Achievement | Condition | Tokens | Addition |
| --- | --- | --- | --: | :-: |
| Victories | First Victory | Win a game. | 100 | |
| | Seasoned Planeswalker | Win 10 games. | 200 | |
| | Veteran Planeswalker | Win 100 games. | 400 | |
| | Legendary Planeswalker | Win 1,000 games. | 1,000 | |
| Commander | Commander Victor | Win a Commander game. | 100 | ✓ |
| | Commander Captain | Win 25 Commander games. | 300 | ✓ |
| | Last One Standing | Win a four-player Commander game. | 150 | ✓ |
| | King of the Table | Win 10 four-player Commander games. | 300 | ✓ |
| Legacy | Legacy Victor | Win a Legacy game. | 100 | ✓ |
| | Legacy Master | Win 25 Legacy games. | 300 | ✓ |
| Colours | Paragon of White, Blue, Black, Red, Green (five) | Win with a deck of that colour. | 100 each | |
| | Master of the Five | Win with a deck of each colour. | 250 | |
| | Five-Colour Triumph | Win with a five-colour deck. | 200 | |
| Bots | Rising Challenger | Beat a bot of skill 4 or higher. | 100 | |
| | Machine Breaker | Beat a skill-6 bot. | 200 | |
| | Master of Machines | Beat skill-6 bots in 10 games. | 300 | |
| Players | Worthy Opponent | Win at a human table. | 150 | |
| | Table Champion | Win 10 games against other players. | 400 | |
| Quests | First Quest | Complete a daily quest. | 100 | |
| | Quest Seeker | Complete 10 daily quests. | 200 | |
| | Questing Knight | Complete 50 daily quests. | 400 | |
| Leng's card shop | Fresh Pack | Open a pack from Leng's card shop. | 100 | |
| | Collector | Open 25 packs. | 300 | |
| Friends | Ally | Make a friend. | 100 | |
| | Fellowship | Make 10 friends. | 200 | |

The badges are generated medallions drawn as SVG in the page (`web/src/records/Badge.tsx`), gold once earned and dark iron before, with the group's emblem struck in the middle, until the owner's own art arrives.

## Statistics and the match history

- **Totals for everyone who may open the profile** (the owner's decision): games, wins, losses, draws and games with no result, in all, by format, and against bots alone or with another player; best-of-three matches ([matches](matches.md)), each once beside its games, as won, lost, drawn or closed with no result; the share of games won; the achievements earned and the pinned badges. Whoever may open a player's profile ([profiles](social.md#profiles)) sees them.
- **The history for the player and SysOp alone:** each game with its date, format and kind, the opponents (a player by handle, a bot by its skill, and which seat won), the player's own deck with its revision, the outcome, the turns and the length, newest first, 20 at a time. Another player asking answers 403 `history_private`. SysOp reads anyone's (permission `players.history`, SysOp's alone, [identity](identity.md#roles-and-permissions-auth06-auth07-sec05)); the reading is not audited, since the history holds nothing hidden.
- **What it never shows** (PROG08): another seat's deck, at any time, to anyone; a table's code; an email address. A history names only the player's own deck, as its seat names it.
- **Replays.** No game is recorded for replay yet, so the history offers none (PROG08's "replay availability").

## After a reset, and deleting an account

- **A reset is a fresh start** ([resetting an account](identity.md#resetting-an-account-v045)). Results, quests and achievements are kept recorded, as the ledgers are, and count only what came after the reset's time (`users.reset_at`): the totals and the history start again at nothing, the day's quests are drawn again, and the achievements earned before no longer show or count. Earned again, each pays again, under a key with the reset's time, as starter decks granted again are.
- **Deleting an account** ([deleting an account](identity.md#deleting-an-account-v041)) keeps its results, quests and achievements, as it keeps the ledgers: they hold no contact data, and other players' histories refer to its seats, which then show "a player who has left". Its notifications go, as before.

## Where it shows

- **The main menu**: "Today's quests", a panel under the ally and the tiles, with each quest's reward and progress, the time until the next day's quests, and Swap while the day's swap is unused (`web/src/quests/DailyQuests.tsx`).
- **Profile**: "Your record" (the totals), "Achievements" (every achievement by group, earned or not, with its progress, its reward and Pin), and "Your games" (the history, with "Show older games") (`web/src/records/RecordPanels.tsx`).
- **A player's profile** (`#player/<id>`): their pinned badges, every badge they earned and their record; their games one by one only on one's own page and to SysOp (`web/src/records/PlayerRecord.tsx`).
- **The top bar's tokens** are asked for again whenever a look at the quests or the achievements paid something, and after a pack is opened ([the top bar](menus.md#the-top-bar)).
- **Profile's tokens** list each reward as "Daily quest: …" or "Achievement: …", counted with the tokens won.

## The data

Migration `0021_quests_achievements`:
- `player_results` (append-only on PostgreSQL), filled from every game that had ended.
- `daily_quests`: an account's quests of a day, one row per slot (0–2), with its key, the quest, its reward and target, the time its games count from, and when it was swapped and completed.
- `player_achievements`: what an account earned, with the version, the key, the reward and its pin (1–3).
- `token_ledger` takes the kinds `quest` and `achievement`; `notifications` the kinds `quest_completed` and `achievement_earned`, with the quest or achievement as their `subject`.

Going back to 0020 drops the three tables. The tokens quests and achievements paid stay in the balances, as SysOp's grants, since the previous version knows no other kind for them; their notifications go. Coming back up finds the ledger's keys taken, so nothing is paid twice.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /api/v1/me/quests` | any active account | today's three quests, drawn at the day's first look, with progress; pays what earlier wins completed (`paid`) |
| `POST /api/v1/me/quests/{slot}/swap` | any active account | today's swap (409 `swap_used`, `quest_completed`) |
| `GET /api/v1/me/achievements` | any active account | every achievement with progress, earned and pin; earns what the account qualifies for (`paid`) |
| `PUT /api/v1/me/achievements/pinned` | any active account | pin up to three earned badges, in order (422 `not_earned`) |
| `GET /api/v1/players/{id}/achievements` | whoever may open the profile | the pinned badges and every badge earned |
| `GET /api/v1/me/stats`, `GET /api/v1/players/{id}/stats` | the account; whoever may open the profile | the totals, and whether you may read the history (`history`) |
| `GET /api/v1/me/history`, `GET /api/v1/players/{id}/history` | the account; its player and SysOp (`players.history`) | the games one by one, `?limit=&cursor=` (403 `history_private`) |

## Tests

`tests/test_quests.py` (SQLite, and PostgreSQL when `CD_TEST_POSTGRES_URL` is set): each player's result from a game's end and the restart's sweep, every outcome, the colours from the revision and the fixture decks, the day's quests drawn once and their day in Arizona, quests completed across games and paid once whatever replays, wins before the first look, the one swap, achievements earned and paid once, pins, packs, quests and friends counted at the next check, a history from before v0.5.0 earning its achievements after migration 0021 and going back to 0020 and up again, the reset's fresh start, the history's privacy (another player gets the totals and 403; SysOp gets the history), account deletion, and on PostgreSQL the append-only results and the downgrade's grants. `web/src/quests/DailyQuests.test.tsx` and `web/src/records/records.test.tsx` test the screens; the browser journey `web/e2e/quests.spec.ts` sees a new player's quests on the main menu, swaps one, and finds the record and the achievements on Profile.
