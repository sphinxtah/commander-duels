# Game modes and reward eligibility (v0.9.10)

Every game has a **mode**, and one function decides what a game of a mode may earn its players. Before v0.9.10 that decision was spread over six modules (`economy`, `progression`, `quests`, `awards`, `campaign`, `stats`), each reading `games.kind` and its own rules. This is the specification's §10, the foundation the sandbox, borrowed decks and leagues will ask (`api/modes.py`).

## Modes

| Mode | What it is | Since |
| --- | --- | --- |
| `practice` | Against bots: the practice game, the practice table, a queue's game against bots | v0.1.0 |
| `table` | People at a table: a table's game, a queue's, a match's | v0.4.0 |
| `campaign` | A campaign duel, the Unbound Court, Apex Unbound | v0.8.0 |
| `testing` | A result SysOp grants for testing; no game is played | v0.8.8 |
| `sandbox` | Any implemented card, owned or not | v1.0.0 (proposed) |
| `borrowed` | A seat plays a friend's lent deck | v1.0.0 (proposed) |
| `league_practice` | A league's pool, outside its standings | v1.0.0 (proposed) |
| `league` | A league's match, for its standings | v1.0.0 (proposed) |

`games.mode` is set when the game is made: `practice` or `table` from its kind, and `campaign` when a campaign duel links it (a link always makes it the campaign's). `player_results.mode` is its game's, and `testing` for a granted result. Migration 0045 gave every game and result made before v0.9.10 its mode from what it is; results are append-only in PostgreSQL, so their guard is lifted for that one statement.

## What each mode earns

| Mode | Tokens for a win | The win | Quests | Achievements | Statistics and history | Competitive records |
| --- | --- | --- | --- | --- | --- | --- |
| practice | yes | yes | yes | yes | yes | `not_competitive` |
| table | yes | yes | yes | yes | yes | `not_competitive` |
| campaign | `campaign_pays_its_own` | `campaign_pays_its_own` | `campaign_pays_its_own` | `campaign_pays_its_own` | `campaign_pays_its_own` | `not_competitive` |
| testing | `granted_for_testing` | yes | yes | yes | `granted_for_testing` | `granted_for_testing` |
| sandbox | `sandbox_cards_not_owned` | `sandbox_cards_not_owned` | `sandbox_cards_not_owned` | `sandbox_cards_not_owned` | `sandbox_cards_not_owned` | `sandbox_cards_not_owned` |
| borrowed | yes | yes | yes | yes | yes | `not_competitive` |
| league practice | `league_practice` | `league_practice` | `league_practice` | `league_practice` | yes | `league_practice` |
| league | `league_rewards_not_approved` | `league_rewards_not_approved` | `league_rewards_not_approved` | `league_rewards_not_approved` | yes | yes |

The words in the table are the reason codes recorded for a reward withheld. A game that ends with no result (interrupted, or closed with no winner) earns nothing whatever its mode (`no_result`), and its players' results are still kept, as "no result", as before. A mode the code does not know earns nothing (`unknown_mode`): a game it cannot classify pays out nothing rather than the wrong thing.

**Nothing changed for the modes that exist.** practice, table, campaign and testing earn exactly what they earned before v0.9.10: a campaign duel's own rewards (spoils, chapter tokens, decks) are still `api/campaign.py`'s, and passive bots still count as any other game (the owner, v0.9.7). `tests/test_modes.py` pins the matrix and settles a game of each kind that exists to show it; the suites of the six modules pass unchanged.

**The modes v1.0.0 will make are proposals**, for the owner to approve before any game is made in them: the sandbox earns nothing, so that unowned cards create no asset; a borrowed deck earns as a table does, since its player plays the game; a league keeps its standings and statistics, and pays nothing until a league reward policy is approved (the specification: "persistent collection rewards require an approved policy").

## How it is asked, and recorded

`games.record_end` asks `modes.eligibility(game.mode, result=...)` once, as the game's end is recorded, and acts on it in the same transaction: the win is counted only if earned, the tokens paid only if earned, and `awards.settle` records the results only if statistics are earned, then fills quests and achievements only if those are. A campaign duel is still settled by the campaign. The answer is kept with the game, `games.eligibility`:

```json
{"mode": "practice", "earns": ["tokens", "wins", "quests", "achievements", "statistics"],
 "withheld": {"competitive": "not_competitive"}}
```

so it can always be told why a game paid what it did. Since v0.9.12 the record also holds the game's farming signals by seat (`signals`), when it showed any, and what the farming policy withheld from a seat for them (`seats`), which is nothing until that policy is enforced ([the economy](economy.md#f-farming-signals-now-enforcement-when-approved)). Settling a game twice settles nothing twice: its end is recorded once (`record_end` acts only on an active game), and every grant is keyed by the game and its seats, as before (`test_a_practice_game_pays_counts_and_records_as_before`).
