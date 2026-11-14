# Quests, achievements and statistics (v0.5.0)

Since v0.5.0 every player has daily quests (since v0.9.5 a daily and a weekly board), earns achievements as badges for the profile, and has a record: totals that every player sees and a match history that only the player and SysOp see. This is the scope's PROG04 (quests), PROG07 (achievements) and PROG08 (profiles and history). The owner's decisions are in [the v0.5.0 plan](plans/0.5.0.md#decisions-at-the-start-of-v050). The API is `api/stats.py`, `api/quests.py`, `api/achievements.py` and `api/awards.py`; the web app's parts are `web/src/quests/` and `web/src/records/`.

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

## Quest boards (v0.9.5)

Until v0.9.4 every player had three daily quests, all wins in games, with one swap a day. Since v0.9.5 there are two boards (the owner's request, [the plan](plans/0.9.5.md#the-owners-request-quest-boards-2026-11-10-noted-during-v094)). The pools are `api/quest_pool.py`; drawing, counting and paying are `api/quests.py`.

- **The daily board: five quests a day**, numbered from the easiest to the hardest: more wins, a stronger bot, a bigger table. Each pays its own tokens by its number (the owner's choice: 150, 250, 350, 500 and 750, 2,000 a day). The five come from five different families, and every one can be done against bots alone: none asks for another player at the table.
- **Any order (v0.9.7).** The five are no steps to climb: each is judged by itself, so the fifth completes and pays while the first four are open. The screens say "Quest 5" (until v0.9.7 "Step 5", which read as an order; the owner's report, 2026-11-10). The contract keeps the field's name, `step`: the quest's difficulty, 1 to 5.
- **The weekly board: twenty goals a week**, fourteen from outside the games (Leng's card shop, Tivit's Auction House, decks, card sleeves, the campaign) and six from the games, at three tiers: six easy (250 tokens), nine medium (400) and five hard (650), about 8,350 a week. All twenty show at once, easy first, and come from twenty families of the pool of 200 goals; like the daily quests, every goal can be finished by one player alone (the owner's choice): no goal asks for a friend, a human table or a buyer.
- **The periods are Arizona's**: the day from midnight (Mountain Standard Time all year, as for tokens), the week from Sunday's midnight, as the shop's weekly sale. A board is drawn the first time the account asks for its quests in the period (the main menu does), stays the same all period, and counts what happened earlier in the period.
- **No swap.** A quest drawn stays the day's or the week's.
- **Every quest is one player's to finish** (the owner's choice), so a quest is drawn only while what it needs is there (v0.9.7; `reach_of` and `weekly_available` in `api/quests.py`):
  - *A deck of the account's own.* Players play their own decks alone, so a win with a colour's deck, a mono-coloured or many-coloured deck, or in a format is asked only of an account with a playable deck of it (not deleted, not archived), by the deck's format and colours as the deck builder shows them. Two-Headed Giant takes a Legacy deck, King's Table either. Wins of any kind, games played, a bot's skill and a table's game take any deck, so every daily number and the week's six goals from the games always have quests to draw. SysOp plays any deck; an account with no playable deck is asked for anything.
  - *The market.* A goal to win or to bid on other accounts' auctions is drawn only while Tivit's Auction House holds twice what it asks for: to win, live auctions of other accounts without a Buy Now below 50 tokens; to bid, those with more than a day left to run (an unlimited listing takes no bids).
  - *A sleeve* to upload needs room under the 20-sleeve limit, as before.

  Until v0.9.7 the live site's boards asked for three bids with not one auction to bid on, and for a win with a red deck of an account whose every deck was black. A board drawn before the update keeps its quests.
- **What never counts.** A campaign duel writes no result, so only the goals that name the campaign read it. A game whose bots were passive at any point (an administrator's or SysOp's testing switch, [games through the API](games.md#sysops-powers)) counts as any other since v0.9.7. Until then it wrote no result, so no quest and no achievement: that was the owner's report, the day's fifth quest played with passive bots, which did not complete.
- **Completion pays at once, once.** The transaction that records a game's end checks the boards of every player it gave a result (a loss counts for "play games", a win for the rest), and asking for the quests checks again, which is when goals outside the games are counted. Each quest pays through the economy ledger, kind `quest`, keyed `daily:<account>:<day>:<quest>` or `weekly:<account>:<week>:<goal>` (a reset's time after one), under the rule `quests-v2`; a replayed end or a second look pays nothing. A quest completes only within its period.
- **Board bonuses and streaks** (the owner's decisions). A board whose quests are all complete in its period pays a bonus on top: 400 tokens for a daily board, 100 more for each day in a row, up to 1,000 from the seventh; 2,000 for a weekly board, 200 more for each week in a row, up to 5,000 from the sixteenth. A board not finished in its period starts the streak again at 400 or 2,000. The finished board is a row of its own (`quest_boards`, keyed `board:<account>:<board>:<period>`), with its streak, read from the previous period's row: the streak lives in the server's records, never in a request, so nothing replayed can rebuild it. Each board shows its streak, what finishing it pays, and the next period's bonus.
- **Farming** (Claude's rules, taken by the owner). A goal outside the games counts only what the server records, and only real exchanges:
  - an auction won counts only against another account's listing, at 50 tokens or more;
  - a card listed counts once it stayed up an hour, or once it sold (a listing withdrawn at once counts not);
  - a bid counts on another account's auction;
  - a pack counts when it was bought with tokens (a pack given counts not), and on the weekly sale when bought at its price (`packs.sale`);
  - a deck counts when it is legal, has its full list (100 cards in Commander, 60 in Legacy) and lasted a day; it counts in the week its day ends; a campaign spoils deck counts not;
  - a card sleeve counts while it is kept (a sleeve deleted or removed counts not), and is drawn only for an account below the 20-sleeve limit.
- **The bell** tells the player (`quest_completed`) of each quest and each board, with what it paid. Its notice leads to the Quests page.

**The daily pool**, 57 quests (`DAILY`):

| Quest | Pays | Quests |
| :-: | --: | --- |
| 1 | 150 | Win a game; Play two games to the end; Win a Commander game; Win a Legacy game; Beat a bot of skill 2 or higher; Win with a white, blue, black, red or green deck (five quests) |
| 2 | 250 | Win two games; Play three games to the end; Beat a bot of skill 3 or higher; Win with a mono-coloured deck; Win with a deck of two or more colours; Win a four-player Commander game; Win a Two-Headed Giant game; Win a Commander game with a white, blue, black, red or green deck (five quests) |
| 3 | 350 | Win three games; Beat a bot of skill 4 or higher; Win two Commander games; Win two Legacy games; Win with a deck of three or more colours; Win a King's Table game; Play five games to the end; Win two games with a white, blue, black, red or green deck (five quests) |
| 4 | 500 | Beat a bot of skill 5 or higher; Win four games; Beat bots of skill 4 or higher in two games; Win a four-player Commander game against skill 4 or higher; Win a Two-Headed Giant game against skill 4 or higher; Win three Commander games; Beat a skill-4 or higher bot with a white, blue, black, red or green deck (five quests) |
| 5 | 750 | Beat a skill-6 bot; Win five games; Beat bots of skill 5 or higher in two games; Win a four-player Commander game against skill-6 bots; Win a King's Table game against skill 5 or higher; Beat a skill-6 bot in Legacy; Win with a five-colour deck; Beat a skill-6 bot with a white, blue, black, red or green deck (five quests) |

**The weekly pool**, 200 goals in 72 families (`WEEKLY`), each family at up to three targets:
- *In the games:* wins, games played to the end, Commander, Legacy, four-player Commander, Two-Headed Giant and King's Table wins, wins against skill 5 and skill 6, with a mono-coloured or a three-colour deck, with each colour's deck (and in Commander and Legacy), and games finished at a table.
- *Leng's card shop:* packs bought, on the weekly sale, from the Play Booster, Set and Collector Booster, M15-frame and Mythic rare eras (not the first years' packs, which cost tens of thousands of tokens and more), basic land packs, tokens spent, packs opened (of each of those eras too), foils, rares, mythic rares, cards new to the library, cards of each colour and each card type pulled from packs.
- *Tivit's Auction House:* cards listed, rares listed, listings with Buy Now, auctions won, other players' auctions bid on.
- *Decks:* new legal decks, Commander decks, Legacy decks, decks of three or more colours, and of each colour.
- *Sleeves and the campaign:* a card sleeve uploaded; campaign duels won (any ward, replays and Apex Unbound included).

**How a quest is worded** (v0.9.8).
- *One way to write a count:* below ten in words, from ten in digits, on both boards ("Win three games", "Win 12 games", "Pull 15 white cards from packs"). Until v0.9.8 the weekly goals from the games wrote digits ("Win 3 Commander games") and the others words up to six ("Buy two packs"). A bot's skill stays a figure: it is a level, not a count.
- *A table goal says how it is done alone.* Every weekly goal can be finished by one player, and "Finish a game at a table" is the one whose name does not say how: every table but a King's Table one needs two players' seats. Its three targets carry a hint (`hint` in the board's answer, null for every other quest), which the goal's card shows until it is done: "Alone? Open a King's Table table and give every other seat to a bot."

**The old daily quests.** Their rows stay (`daily_quests`, policy `quests-v1`), and what they paid stays in the ledger. The day v0.9.5 reached the live server, the first look drew the new board in their place; quests already paid that day kept their pay.

### Three policies, all off (v0.9.12)

The boards above are as the owner set them in v0.9.5, and stay so. v0.9.12 built three changes behind policies that are off until SysOp sets them ([the economy's foundations](economy.md)):

- **`quest_streaks`**: `forgiving` keeps a streak through up to `grace` periods missed in a row, each costing `penalty` steps (`quests.streak_before`, `carried_streak`). The default, `reset`, is the rule above.
- **`quest_catch_up`**: a finished daily board also pays for one daily board missed earlier that week, the earliest first, at most `days` a week, each under its own key (`catch-up:<account>:<day>`, a `quest` entry under the rule `quest-catch-up-v1`); the bell says "Daily board caught up".
- **`quest_alternatives`**: each daily quest is drawn with a second quest of its own step from a family the board does not have (`daily_quests.alternative`, `quests.choose_alternatives`); completing either completes the slot and pays it once. `GET /api/v1/me/quests` gives it as the quest's `alternative`, null on a board drawn without one.

A game the farming policy withholds quest progress from (`api/farming.py`, off by default) is not counted on that seat's boards.

## Achievements

- **Badges that pay once.** Each achievement earned is a badge on the profile and pays a one-time reward through the economy ledger, kind `achievement`, keyed `achievement:<account>:<achievement>`. The bell tells the player (`achievement_earned`).
- **Definitions by version** (PROG07). The definitions are `ACHIEVEMENTS` in `api/achievements.py`, versioned with the code. Each has a stable ID and a version of its own, raised if its condition ever changes. What an account earned is a row of its own (`player_achievements`) with the version it was earned by; no update removes it.
- **From the server's record only:** the account's results (wins), the daily quests it completed, the packs it opened and the friends it made. Wins are games won; SysOp's settings of an account's wins earn nothing, so SysOp's 100,000 starting wins do not earn "Legendary Planeswalker".
- **Earned when checked, so nothing is missed:** in the transaction that records a game's end, for the winner (only wins earn); when a pack is opened, for its opener; and whenever the account looks at its achievements on Profile. A friend made counts at the next of these.
- **Players with a history.** Migration 0021 pays nothing. A player whose games from before v0.5.0 already qualify earns those achievements at the first check (their next win, or opening Profile), paid then and told by the bell. The same check would give an achievement added in a later version to everyone who already qualifies.
- **Pinned badges.** On Profile a player pins up to three earned badges, in order, to show first on their profile; pinning again replaces them, and none unpins all.
- **The reference game's own achievements are not inventoried** (the scope's reference inventory, `docs/reference_inventory.csv`, has none yet), so none of these maps to one of them. Those about Commander and Legacy are marked as additions (PROG07, `addition`), and Profile labels them "Commander and Legacy addition". When the original list is inventoried, its mapped achievements join this list with IDs of their own.

Since v0.9.5 every reward is four times what v0.5.0 set (the owner: First Victory 400, Seasoned Planeswalker 800, "and so on"; `achievements-v2`), and six achievements count the quest boards: 35 achievements, 32,200 tokens in all (the first 29 are 25,800 of them):

| Group | Achievement | Condition | Tokens | Addition |
| --- | --- | --- | --: | :-: |
| Victories | First Victory | Win a game. | 400 | |
| | Seasoned Planeswalker | Win 10 games. | 800 | |
| | Veteran Planeswalker | Win 100 games. | 1,600 | |
| | Legendary Planeswalker | Win 1,000 games. | 4,000 | |
| Commander | Commander Victor | Win a Commander game. | 400 | ✓ |
| | Commander Captain | Win 25 Commander games. | 1,200 | ✓ |
| | Last One Standing | Win a four-player Commander game. | 600 | ✓ |
| | King of the Table | Win 10 four-player Commander games. | 1,200 | ✓ |
| Legacy | Legacy Victor | Win a Legacy game. | 400 | ✓ |
| | Legacy Master | Win 25 Legacy games. | 1,200 | ✓ |
| Colours | Paragon of White, Blue, Black, Red, Green (five) | Win with a deck of that colour. | 400 each | |
| | Master of the Five | Win with a deck of each colour. | 1,000 | |
| | Five-Colour Triumph | Win with a five-colour deck. | 800 | |
| Bots | Rising Challenger | Beat a bot of skill 4 or higher. | 400 | |
| | Machine Breaker | Beat a skill-6 bot. | 800 | |
| | Master of Machines | Beat skill-6 bots in 10 games. | 1,200 | |
| Players | Worthy Opponent | Win at a human table. | 600 | |
| | Table Champion | Win 10 games against other players. | 1,600 | |
| Quests | First Quest | Complete a daily quest. | 400 | |
| | Quest Seeker | Complete 10 daily quests. | 800 | |
| | Questing Knight | Complete 50 daily quests. | 1,600 | |
| Leng's card shop | Fresh Pack | Open a pack from Leng's card shop. | 400 | |
| | Collector | Open 25 packs. | 1,200 | |
| Friends | Ally | Make a friend. | 400 | |
| | Fellowship | Make 10 friends. | 800 | |
| Quest boards (v0.9.5) | Full Board | Finish every quest on a daily board. | 400 | |
| | Seven Days Strong | Finish the daily board seven days in a row. | 1,200 | |
| | Board Regular | Finish 50 daily boards. | 1,600 | |
| | Goal Getter | Complete 50 weekly goals. | 800 | |
| | A Week's Work | Finish every goal on a weekly board. | 800 | |
| | Month of Mastery | Finish the weekly board four weeks in a row. | 1,600 | |

**Players who had already earned achievements** (the owner's decision, 2026-11-10) got the difference in their token wallet when v0.9.5 reached the live server: migration 0041 pays, for every achievement an account earned since its last reset, the new reward less what was paid, once, as an `achievement` entry keyed `achievement-raise:<the achievement's key>` ("First Victory: reward raised to 400 tokens"), and records the new reward on the earned row. Running it again pays nothing. "Complete N daily quests" counts the daily board's quests and the old three-a-day ones alike.

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

- **The main menu** (since v0.9.5): "Today's quests", a panel under the ally and the tiles, with the daily board's five quests (their number, reward and progress), how many are done, the board's bonus and streak, and a line for the week's goals that leads to the Quests page (`web/src/quests/QuestsPanel.tsx`).
- **The Quests page** (`#quests`, v0.9.5): both boards in full, each with its bonus, its streak and the time until the next one, and how quests count (`web/src/quests/QuestsPage.tsx`).
- **Profile**: "Your record" (the totals), "Achievements" (every achievement by group, earned or not, with its progress, its reward and Pin), and "Your games" (the history, with "Show older games") (`web/src/records/RecordPanels.tsx`).
- **A player's profile** (`#player/<id>`): their pinned badges, every badge they earned and their record; their games one by one only on one's own page and to SysOp (`web/src/records/PlayerRecord.tsx`).
- **The top bar's tokens** are asked for again whenever a look at the quests or the achievements paid something, and after a pack is opened ([the top bar](menus.md#the-top-bar)).
- **Profile's tokens** list each reward as "Daily quest: …" or "Achievement: …", counted with the tokens won.

## The data

Migration `0021_quests_achievements`:
- `player_results` (append-only on PostgreSQL), filled from every game that had ended.
- `daily_quests`: an account's quests of a day, one row per slot (0–2), with its key, the quest, its reward and target, the time its games count from, and when it was swapped and completed. Since v0.9.5 (migration 0041) its `board` is `daily` (slots 0–4) or `weekly` (slots 0–19, its day the Sunday of the week).
- `quest_boards` (v0.9.5): a board finished, with its period, streak and bonus, keyed once per period.
- `player_achievements`: what an account earned, with the version, the key, the reward and its pin (1–3).
- `token_ledger` takes the kinds `quest` and `achievement`; `notifications` the kinds `quest_completed` and `achievement_earned`, with the quest or achievement as their `subject`.

Going back to 0020 drops the three tables. The tokens quests and achievements paid stay in the balances, as SysOp's grants, since the previous version knows no other kind for them; their notifications go. Coming back up finds the ledger's keys taken, so nothing is paid twice.

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /api/v1/me/quests` | any active account | since v0.9.5 the daily and the weekly board (`daily`, `weekly`), each drawn at its period's first look, with progress and streak; pays what already completed a quest or a board (`paid`). The swap route is gone |
| `GET /api/v1/me/achievements` | any active account | every achievement with progress, earned and pin; earns what the account qualifies for (`paid`) |
| `PUT /api/v1/me/achievements/pinned` | any active account | pin up to three earned badges, in order (422 `not_earned`) |
| `GET /api/v1/players/{id}/achievements` | whoever may open the profile | the pinned badges and every badge earned |
| `GET /api/v1/me/stats`, `GET /api/v1/players/{id}/stats` | the account; whoever may open the profile | the totals, and whether you may read the history (`history`) |
| `GET /api/v1/me/history`, `GET /api/v1/players/{id}/history` | the account; its player and SysOp (`players.history`) | the games one by one, `?limit=&cursor=` (403 `history_private`) |

## Tests

`tests/test_quests.py` (SQLite, and PostgreSQL when `CD_TEST_POSTGRES_URL` is set): each player's result from a game's end and the restart's sweep, every outcome, the colours from the revision and the fixture decks, the day's quests drawn once and their day in Arizona, quests completed across games and paid once whatever replays, wins before the first look, the one swap, achievements earned and paid once, pins, packs, quests and friends counted at the next check, a history from before v0.5.0 earning its achievements after migration 0021 and going back to 0020 and up again, the reset's fresh start, the history's privacy (another player gets the totals and 403; SysOp gets the history), account deletion, and on PostgreSQL the append-only results and the downgrade's grants. Since v0.9.7 also: the day's quests completing in any order, a passive-bots game counting for none and saying so, quests drawn only for wins the account's own decks can bring, and auction goals only while the market can supply them. Since v0.9.5 also the boards: drawn once, by number and tier, from the families and the in-game share; Arizona's day and week; quests and boards paid once, the streak growing, capping and starting over; losses counting for games played; the old quests kept; weekly goals from packs, sales, listings, auctions won and decks, and the back pay of migration 0041. `web/src/quests/QuestBoards.test.tsx` and `web/src/records/records.test.tsx` test the screens; the browser journey `web/e2e/quests.spec.ts` sees the five daily quests on the main menu, the twenty goals on the Quests page, and the record and the achievements on Profile.
