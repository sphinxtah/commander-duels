# The economy's foundations, and the proposals awaiting approval (v0.9.12)

The owner's specification asks the Preparation Framework for the economy's next pieces before anyone decides to use them (section 11): "working transactional services behind disabled or test-only policies", "a simulation/reporting tool", and "concrete economy proposals for owner review". This is what v0.9.12 built, what each proposal would do measured by the game's own rules, and how a proposal is switched on. **Every policy is off.** The game pays, grants and sells exactly what it did in v0.9.11 until SysOp sets one, and setting one is what the owner's approval means in practice.

## What the owner decided at the start (2026-11-13)

- **Worked out:** functional basic lands, the starter-staple pool, and the quest boards' catch-up and streaks.
- **Dropped: a path to a specific card.** The specification's "deterministic card acquisition" with its quotes (section 11) and "a predictable path to specific supported cards" (section 22) are not built, in v0.9.12 or v1.0.0: "I've changed my mind on those. I want it to be more realistic." A card comes from a pack, the auction house, a product that holds it or a reward, as it does now. Nothing here sells a named card.
- **Approved:** the three mode policies proposed in v0.9.10 ([game modes](modes.md)): the sandbox earns nothing, a borrowed deck earns as a table's game, and a league keeps its standings and pays nothing until a league reward policy is approved.

## Functional access is not ownership

The specification asks to "separate functional access from collectible edition/finish ownership". The game already had one case of it: an alliance's playset is in a library while the alliance lasts and was never granted ([progression](progression.md)). v0.9.12 makes it a rule with two more cases.

- **Ownership** is a library grant (`library_grants`): a copy of one edition in one finish, counted in its printing's print run, sellable at Tivit's Auction House.
- **Functional access** lets an account build with a card it does not own. The library adds it to what the account builds from, in the card's default printing, with its source named (`functional` for a basic land, `staple` for a starter staple). It is no grant, so:

| | A granted copy | Functional access |
|---|---|---|
| Counts in a deck | Yes, in its own edition | Yes, in the card's default printing |
| A row in `library_grants` | Yes | No |
| Counted in a print run | Yes | No |
| Sellable at the auction house | Yes | No: refused in words (`not_sellable`) |
| An edition or a finish of one's own | Yes | No: those stay something to own |
| Survives the policy being switched off | Yes | A basic land: no. A staple already claimed: yes |

`api/library.py` `functional_cards` is the one place it is read, and every reader of a library (deck validation, the draft's editions, the deck builder, the tables) takes it from there, as they took an alliance's cards. `tests/test_economy_foundations.py` shows a functional copy played in a deck, with no grant made, nothing sellable, and the listing refused.

## The policies

A policy is a small typed record kept as a site setting (`policy.<name>`, `api/policies.py`). Reading one never fails: a missing or malformed setting is the default, and every default is the game as it was.

| Policy | Default | What it changes when set |
|---|---|---|
| `functional_basics` | `{"enabled": false}` | Every account builds with the five basic lands without owning them |
| `starter_staples` | `{"enabled": false, "initial": 0, "per_ward": 0, "per_weekly_board": 0}` | Accounts claim starter staples with picks |
| `quest_streaks` | `{"mode": "reset", "grace": 1, "penalty": 0}` | A board's streak survives missed periods |
| `quest_catch_up` | `{"enabled": false, "tokens": 400, "days": 3}` | A finished daily board also pays for a day missed that week |
| `quest_alternatives` | `{"enabled": false}` | Each daily quest is drawn with a second quest; either completes it |
| `farming` | `{"enforce": false, "short_turns": 3, "repeat_results": 6}` | Flagged seats lose what the game would have paid them |

**Setting one.** SysOp alone (`economy.manage`); administrators read them.

- On the server: `docker compose exec api python -m api.cli economy-policy` lists them, and `python -m api.cli economy-policy functional_basics '{"enabled": true}'` sets one.
- Through the API: `GET /api/v1/admin/policies`, `PUT /api/v1/admin/policies/{name}` with the policy's JSON. A field left out takes its default.

Every change is audited (`economy.policy_changed`, with what it was and what it became; the console's names its source). An unknown name or a value that is not the policy's is refused. No page of the site sets them yet: the workflows are v1.0.0's, and until a policy is on, nothing of it shows anywhere a player looks.

## The proposals

Each is measured by `python -m api.cli economy-report`, which uses the game's own arithmetic (below). The numbers here are from the content at v0.9.12.

### A. Unlimited functional basic lands

**What changes.** Every account builds with Plains, Island, Swamp, Mountain and Forest, as many as a deck may hold, without owning them. Not Wastes, not the snow-covered basics.

**What stays.** Basic lands granted before stay granted and sellable. The basic land packs stay on the shelf: what they sell becomes editions and foils to collect, since the functional copy is each land's default printing. Nothing is minted, so no print run moves.

**Why.** Since v0.6.0 a deck may hold only the basic lands its library holds, so a new player's third deck needs land packs first. The specification's acceptance: "New players can build functional mana bases immediately."

**What it costs.** The land packs' use as a token sink: the report's "Basic land packs sold" line says how many tokens that has been on the live site.

**Switch.** `economy-policy functional_basics '{"enabled": true}'`. Every deck's kept flags are checked again the next time its owner lists their decks. Switching it off again locks the decks that held more than their library does, as they were.

### B. The starter-staple pool

**What changes.** An account claims cards from a pool of forty staples with picks. A claimed staple is one functional copy, bound to the account: built with, never sold, in no print run.

**The pool** (`content/starter-staples.json`), none of it on the Reserved List:

- Colorless: Sol Ring, Arcane Signet, Mind Stone, Commander's Sphere, Fellwar Stone, Thought Vessel, Wayfarer's Bauble, Swiftfoot Boots, Lightning Greaves, Solemn Simulacrum.
- Lands: Command Tower, Exotic Orchard, Evolving Wilds, Terramorphic Expanse, Myriad Landscape, Path of Ancestry, Reliquary Tower, Rogue's Passage, Bojuka Bog, Temple of the False God.
- White: Swords to Plowshares, Generous Gift, Disenchant, Day of Judgment.
- Blue: Counterspell, Negate, Brainstorm, Mulldrifter.
- Black: Doom Blade, Sign in Blood, Read the Bones, Feed the Swarm.
- Red: Lightning Bolt, Chaos Warp, Blasphemous Act, Vandalblast.
- Green: Cultivate, Kodama's Reach, Rampant Growth, Beast Within.

**Proposed picks:** 10 to start, 2 for each campaign ward won, none for weekly boards. That is 40 picks, the whole pool, once the campaign is won; a player who wins two wards a week has it in eight weeks.

**How picks are counted.** From records that already exist (a ward's seal, a finished weekly board), so none is stored and none can be earned twice. A claim is keyed by the account and the card: a retry, or two requests at once, claim once.

**What it costs.** A reason to buy packs for forty common staples. It hands out nothing tradable.

**Switch.** `economy-policy starter_staples '{"enabled": true, "initial": 10, "per_ward": 2}'`. Off, `GET /api/v1/me/staples` and the claim answer as a missing page does. Switching it off later stops new claims and takes nothing claimed.

### C. A forgiving streak

**As it is** (the owner's decisions of v0.9.5): a daily board pays 400 tokens, 100 more for each day in a row, up to 1,000 from the seventh; a weekly board 2,000 to 5,000. A board not finished in its period starts the streak again.

**Proposed:** `{"mode": "forgiving", "grace": 2, "penalty": 0}`: up to two periods missed in a row keep the streak; a third starts it again. `penalty` can take steps off for each missed period instead of none.

### D. The weekly catch-up

**Proposed:** `{"enabled": true, "tokens": 400, "days": 3}`: a finished daily board also pays 400 tokens for one daily board the account missed earlier in the same week, the earliest first, for at most three a week. A day before the account's first, or before its last reset, is no day missed. Each missed day is paid once, under its own ledger key (`catch-up:<account>:<day>`).

### What C and D pay

Tokens from the daily boards alone (five quests, 2,000 tokens, plus the board), over eight weeks, by the days of the week a player finishes the board:

| Who plays | As it is, a settled week | Forgiving streak | Catch-up | Both | Both, against as it is |
|---|---|---|---|---|---|
| Every day | 21,000 | 21,000 | 21,000 | 21,000 | the same |
| Weekdays | 13,000 | 15,000 | 13,400 | 15,400 | +18% |
| Monday, Wednesday, Friday | 7,200 | 9,000 | 8,400 | 10,200 | +42% |
| Weekends | 4,900 | 4,900 | 5,300 | 5,300 | +8% |
| One day a week | 2,400 | 2,400 | 2,800 | 2,800 | +17% |

A player who never misses a day earns the same under every proposal. The proposals move tokens to the players who play some days and not others, and none of it pays for a longer game. For scale: the campaign pays 32,767,000 tokens in all, ward 14 alone 8,192,000, so the boards are small beside it at any setting.

### E. Quest alternatives

**Proposed:** `{"enabled": true}`. Each of a day's five quests is drawn with a second quest of its own step (as hard, the same tokens) from a family no other quest or alternative of the board has, within the account's reach. Completing either completes the slot and pays it once. A board drawn while the policy was off has none, and keeps none.

**Why.** "Win with a blue deck" stops a player with no blue deck; its alternative does not. The weekly board's twenty goals are not changed.

### F. Farming: signals now, enforcement when approved

**Recorded since v0.9.12, whatever the policy says:** the signals of each game's end, by seat, kept with the game (`games.eligibility`, under `signals`).

| Signal | Seen when | Withheld when enforced |
|---|---|---|
| `conceded_early` | The seat conceded before turn 3 | The game counts on none of its quest boards |
| `opponent_conceded_early` | The seat won a two-player game whose other player did | The win's tokens |
| `repeat_opponent` | Its player and another had six results together that day | Tokens and quest progress |
| `idle` | Its player sent no command in a game that reached turn 1 | The game counts on none of its quest boards |
| `short_game` | The game finished before turn 3 with no concession | Nothing: seen only |

**Proposed:** leave `enforce` off through the beta's first weeks, read what the report counts, then set the thresholds from what real games show. A signal is not proof, and a rule that withholds a win should be set from data.

**Its limit.** `idle` needs the commands each seat sent, which the API counts while it follows a game. A game whose end is recorded after an API restart has no count and no `idle` signal. A seat that answers once and then lets its response timer run out all game is not seen: the engine does not report how often a seat's timer ran out.

## The report

```
docker compose exec api python -m api.cli economy-report          # as text
docker compose exec api python -m api.cli economy-report --json   # as JSON
```

It reads and changes nothing. From the database: the players' balances (how many accounts, their total, median and largest; SysOp's and deleted accounts left out, and no account named), the ledger by kind, the basic land packs sold, the farming signals kept, and the policies as they stand. From the content: the campaign's tokens ward by ward, and the quest boards' pay. Then the simulation above, and how long the staple pool takes.

A proposal's numbers are arguments (`--grace`, `--penalty`, `--catch-up-tokens`, `--catch-up-days`, `--initial-picks`, `--picks-per-ward`, `--picks-per-week`, `--weeks`), so another setting is measured before it is chosen. The simulation calls the functions that pay a board (`api/quests.py` `carried_streak` and `bonus_for`), not a copy of them.

## Data

- **`entitlements`** (migration 0047). Functional access to a card, bound to an account. *Ownership:* the account's. *Lifecycle:* made by a claim (kind `staple`) or by SysOp (kind `staff`); ended by SysOp (`revoked_at`, audited); a reset leaves the rows and the library counts those made after it, as it does grants. *Permissions:* an account reads its own through the pool; SysOp reads, gives and ends any (`economy.manage`). *Retention:* kept with the account.
- **`daily_quests.alternative`** (migration 0047): the slot's second quest and its target as they were when the board was drawn; null on a board drawn with the policy off.
- **`site_settings`**: one row a policy, `policy.<name>`.
- **`games.eligibility`**: `signals` (by seat) when a game showed any, and `seats` (by seat, each reward withheld with its reason) when the farming policy withheld something. A game with neither keeps the record it had in v0.9.10.
- **`token_ledger`**: no new kind. A catch-up is a `quest` entry under the rule `quest-catch-up-v1`.

Migration 0047 only adds: a table and a nullable column. v0.9.11's code runs on the migrated database, so a rollback needs no restore.

## Routes

| Route | Who | What |
|---|---|---|
| `GET /api/v1/admin/policies` | staff (`admin.users.read`) | The policies as they stand, with their defaults |
| `PUT /api/v1/admin/policies/{name}` | SysOp (`economy.manage`) | Sets a policy; audited |
| `GET /api/v1/me/staples` | any active account | The pool, the account's picks and its claims; not found while the policy is off |
| `POST /api/v1/me/staples/{card_id}` | any active account | Claims a staple with a pick, once (404 `not_a_staple`, 409 `no_picks`) |
| `GET /api/v1/admin/users/{id}/entitlements` | SysOp | An account's entitlements |
| `POST /api/v1/admin/users/{id}/entitlements` | SysOp | Gives functional access to a card, for testing; audited |
| `DELETE /api/v1/admin/users/{id}/entitlements/{entitlement}` | SysOp | Ends one; audited |

`GET /api/v1/me/quests` gains `alternative` on a quest (null unless drawn with one), and `GET /api/v1/library` the sources `functional` and `staple`.

## Checked by

`tests/test_economy_foundations.py`: every policy off until SysOp sets it, and who may; functional basic lands built with and never owned (no grant, nothing sellable, the listing refused, gone when switched off); the staple pool's picks and claims, once each, ended and reset; the forgiving streak through a real board; the catch-up's keys, its cap and an account's first day; a daily slot completed by its alternative; the farming signals kept, and withheld only when enforced; the report's arithmetic against the rules by hand; the console's commands. `tests/test_account_data.py` writes entitlements at migration 0047 and compares them at the head. The quest, progression, economy and mode suites pass unchanged, which is the evidence that nothing changed by default.
