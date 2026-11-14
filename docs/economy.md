# The economy: what was decided, and what was taken out (v0.9.13)

The game's economy is the one it had in v0.9.11, and stays so. Tokens come from wins, quests, achievements and the campaign ([tokens](tokens.md), [quests](quests.md), [the campaign](campaign.md)); cards come from packs, products, the auction house and rewards ([the shop](shop.md), [pack prices](pack-prices.md), [auctions](auctions.md), [progression](progression.md)). This page records the decisions that keep it there, and what v0.9.13 removed.

## What the owner decided at the start (2026-11-13)

At v0.9.12's start, of the specification's sections 11 and 22:

- **Dropped: a path to a specific card.** No quotes and no deterministic acquisition: "I've changed my mind on those. I want it to be more realistic." A card comes from a pack, the auction house, a product that holds it or a reward. Nothing sells a named card.
- **Approved: the mode policies** of [game modes](modes.md): the sandbox earns nothing, and a borrowed deck earns as a table's game.
- **To be worked out:** functional basic lands, a starter-staple pool, and a catch-up and forgiving streaks for the quest boards. v0.9.12 built their foundations with every policy off, and put the proposals to him.

## What the owner decided on 2026-11-14

- **None of the proposals is adopted, now or later.** "I want to keep the game pure, as if it were real life (opportunity to get cards, etc)." No functional basic lands, no starter staples, no quest alternatives, no catch-up, no forgiving streak, no farming policy.
- **The foundations are removed**, the recording of farming signals included. That is v0.9.13.
- **The data goes too**, by a migration he approved for this alone.

The approved economy configuration that v1.0.0's handoff names is therefore the economy as it is.

## What v0.9.13 removed

Everything v0.9.12 added for section 11 (its commit, 014f6ef, is the list):

| Removed | What it was |
| --- | --- |
| `api/policies.py`, its routes and `python -m api.cli economy-policy` | Six policies as site settings, read and set by SysOp |
| `api/entitlements.py`, `content/starter-staples.json`, the `entitlements` table | Functional access to a card not owned, and the starter-staple pool's picks |
| Functional copies in `api/library.py`, their sources in the library and My library's labels, the auction house's refusal of them | Basic lands and staples a deck could hold without a grant |
| Quest alternatives, the catch-up and the streak policies in `api/quests.py`; `daily_quests.alternative` | A second quest for a daily slot, pay for a missed day, a streak that survives one |
| `api/farming.py`, the commands counted for each seat, `signals` and `seats` in `games.eligibility` | What a game's end showed of farming, and what an enforced policy would have withheld |
| `api/economy_report.py` and `python -m api.cli economy-report` | The proposals measured against the game's own payouts |

The game pays, grants and sells as v0.9.11 did: the same token payments for a win, the same quest boards and streaks, the same library. `games.eligibility` holds what v0.9.10 put there (the mode, what the game earned and why not) and, since v0.9.13, `settlement_failed` for a game whose end could not be recorded ([modes](modes.md)).

## The data

Migration 0050 (`0050_economy_removed`) is the Preparation Framework's one destructive migration. The framework's rule stays expand-only ([operations](operations.md#migrations)); this one is the owner's decision.

| It | Does |
| --- | --- |
| Drops `entitlements` | The table held nothing: no policy that wrote to it was ever on by default |
| Drops `daily_quests.alternative` | Every board drawn on v0.9.12 wrote "no alternative" there |
| Takes `signals` out of `games.eligibility` | v0.9.12 recorded farming signals with every game that ended on it; the rest of the record stays |
| Deletes the `policy.*` rows of `site_settings` | A policy SysOp looked at and saved left one |

**It refuses a database where a policy was used.** If `entitlements` holds a row, a daily quest holds an alternative, or a game holds a reward the farming policy withheld (`seats`), the migration changes nothing and says which it found. Each can only exist if a policy was switched on by hand. `deploy.sh` then reports that the migrations failed and replaces nothing; what becomes of those rows is the owner's to say before the version is deployed.

**Going back.** v0.9.12's code reads the table and the column, so it does not run on a database at migration 0050. `deploy.sh` dumps the database before it migrates and names that dump when going back needs it ([operations](operations.md#rollback-limits)). The migration's own way back makes the table and the column again, empty; the signals and the settings are gone, and nothing reads them.

Not touched: the token ledger and the audit record, which are append-only. With every policy off, v0.9.12 wrote nothing to the ledger that v0.9.11 would not have; a policy SysOp changed left its `economy.policy_changed` audit event, which stays as the record that it was.

## Checked by

`tests/test_economy_removed.py`: migration 0050 on SQLite and PostgreSQL, on a database as v0.9.12 left it (JSON's null for every alternative, signals on its games, a saved policy) and on each of the three it refuses, where nothing changes; no route of the foundations is left. `tests/test_account_data.py`: the representative account, with v0.9.12's leftovers written at migration 0047, is the same after every migration and back. The suites of what was reverted (`test_quests.py`, `test_economy.py`, `test_progression.py`, `test_library_editions.py`, `test_auctions.py`, `test_modes.py`) pass as they did before v0.9.12.
