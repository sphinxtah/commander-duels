# Tokens (v0.4.0)

Since v0.4.0 every win pays tokens, and tokens buy packs in Leng's card shop ([the shop](shop.md)). Tokens are virtual currency only: there is no payment, cash store, cash-out or trading (PROG03, PAR18). The owner's decisions are in [the v0.4.0 plan](plans/0.4.0.md#decisions-at-the-start-of-v040).

## What a win pays

A game pays only its winner, and only for a game the engine reports as `completed` with a player's seat as the winning seat, as for wins ([the Planeswalker Alliance](progression.md#wins-and-levels)). A turn limit, a concession with no winner, an idle timeout, a closed game or a draw pays no one. The winner is paid for every seat it beat:

| Beaten seat | Tokens |
| --- | --- |
| A bot of skill 1, 2, 3, 4, 5 or 6 | 5, 8, 11, 14, 17 or 20 |
| A player with *w* wins | 50 + 90 × log₁₀(1 + *w*), rounded, at most 500 |

- **Several at once.** A Commander win over three skill-4 bots pays 3 × 14 = 42 tokens. A table with players and bots pays each seat its own amount.
- **A team wins together** (Two-Headed Giant). Every player of the winning team is paid for each seat of the other team, never for their teammate, each under their own limits below; since v0.5.1 at tables and in the queue, where both winners may be players. Two players beating two new players earn 100 tokens each. Each entry is keyed by its own winning seat, so each winner is paid once.
- **The player curve** pays 50 for a new player, 144 at 10 wins, 204 at 50, 230 at 100, 320 at 1,000, 410 at 10,000 and 500 from 100,000. A player's wins are the profile's, SysOp's settings included.
- **Three a day per opponent.** Wins over the same player pay tokens for the first 3 each day; later ones still count as wins and are recorded with nothing paid, and the entry says why.
- **A daily cap on bots.** SysOp may cap the tokens bots pay one account in a day, in Administration, under Tokens. It is off unless SysOp sets it; a win past the cap is recorded with what was left of it.
- **A day** is a calendar day in Arizona time (Mountain Standard Time all year).

## Quests and achievements (v0.5.0)

Daily quests pay 100 to 250 tokens each, and each achievement a one-time reward ([quests, achievements and statistics](quests.md)). Both are judged from the server's own record of the games that ended, and paid through this ledger: kind `quest`, keyed `quest:<account>:<day>:<quest>`, and kind `achievement`, keyed `achievement:<account>:<achievement>`, each with a reset's time after one, under the rules `quests-v1` and `achievements-v1`. A quest a game completes and an achievement a win earns are paid in the transaction that records the game's end, after the win's own pay. The profile counts them with the tokens won, and lists each as "Daily quest: …" or "Achievement: …". The limits above apply to wins only: a quest or an achievement pays its reward whatever today's cap on bots.

## The ledger

- **Paid once, from the server's own record** (PROG04, PROG05, NET10). When the API records a finished game, the same database transaction records its result, counts the win and pays the tokens, one entry per beaten seat, keyed `tokens:<game>:<winning seat>:<beaten seat>`. A replayed end, a retry or a restart finds the game no longer active and the keys taken, and pays nothing. The browser never reports a result.
- **Append-only** (`token_ledger`): PostgreSQL refuses updates and deletes. Each entry records its kind, the amount, its unique key, the game and the seat beaten (and that seat's player), the rule it was paid under (`tokens-v1`), and for a grant its reason and who gave it; since v0.5.0 a quest's or an achievement's entry names it in its reason. A balance is the sum of the account's entries.
- **The welcome grant.** Every account gets 1,000 tokens once, enough for two current packs: new accounts when they are created, existing ones through migration 0008.
- **Back pay.** Migration 0008 paid every win recorded before v0.4.0, by the game's bot skill, under the same keys as pay at the end of a game.
- **Spending.** Buying locks the account's row for the rest of the transaction, so two purchases at once cannot spend the same tokens, and a balance never goes below zero.

## SysOp and administrators

- **SysOp gives tokens** to any account, its own included, or takes them back with a negative amount, never below zero (permission `economy.manage`, SysOp's alone). Each grant needs a reason, is audited (`economy.tokens_granted`) and is kept apart from tokens won: the profile counts won, given and spent separately.
- **A reset** (v0.4.5, [resetting an account](identity.md#resetting-an-account-v045)) brings the balance back to the welcome's 1,000 with a grant of the difference, given or taken back, whose reason is "Account reset by SysOp"; it is audited with the reset. The earlier entries stay, so the profile's totals of won, given and spent keep counting them.
- **Administrators** see every account's balance in Administration and its latest entries through the API, and read the economy's settings; they cannot change them.

## Where it shows

- **Profile:** the balance; how much was won (since v0.5.0 with quests and achievements), given and spent; the latest entries, each with what it was for and, for a win paid nothing, why.
- **The top bar's balance** is asked for again after a purchase or a grant on the page (v0.5.0), and after a pack opened or a look at the quests or the achievements that paid something.
- **Administration:** each account's balance, SysOp's "Give tokens" form, and the Tokens section with the rules and the daily cap.
- **The game's result:** what the game paid you (the game summary's `tokens`).

## Routes

| Route | Who | What |
| --- | --- | --- |
| `GET /api/v1/me/tokens` | any active account | balance, totals, the latest 50 entries |
| `GET /api/v1/me/quests`, `GET /api/v1/me/achievements` | any active account | pay what the account's recorded games already completed or earned (v0.5.0, [quests](quests.md#routes)) |
| `GET /api/v1/admin/users/{id}/tokens` | administrators, SysOp | the same for an account |
| `POST /api/v1/admin/users/{id}/tokens` | SysOp (`economy.manage`) | give or take back tokens, with a reason |
| `GET /api/v1/admin/economy` | administrators, SysOp | the settings (the daily cap on bots) |
| `PUT /api/v1/admin/economy` | SysOp (`economy.manage`) | change them, audited (`economy.settings_changed`) |
