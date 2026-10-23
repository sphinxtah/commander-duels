# XMage patches

Changes to upstream XMage live here as `NNNN-description.patch` files (`git diff` format, paths relative to the XMage root). `build-xmage.sh` applies them in name order after fetching the pinned commit, and the build fails if one no longer applies.

Each patch needs a header comment that gives the reason, the upstream issue or pull request if there is one, and the condition for removing it.

At the current pin (`xmage_1.4.62V1`) six patches carry Two-Headed Giant: three from v0.5.0's spike and three from v0.5.1's card audit (see [the Two-Headed Giant note](../../../docs/engine/two-headed-giant.md), and [the audit's review](../../../docs/engine/two-headed-giant-audit.csv) for every card it looked at):

| Patch | What it changes | Files |
| --- | --- | --- |
| `0001-two-headed-giant-shared-team-turns.patch` | Shared team turns (rule 805): a game type may name teammates (`Game.getTeammates`, empty by default); the active team takes one turn together, untaps, draws, plays a land each and discards to hand size; each of its players is an active player; teammates are not opponents; the team attacks and blocks together; the human player stops in its team's turn as in its own | 12 core files and `HumanPlayer` |
| `0002-two-headed-giant-shared-life-and-poison.patch` | A team's shared life total (810.9) and team poison (810.10), through overridable methods of `GameImpl` | `PlayerImpl`, `GameImpl` |
| `0003-two-headed-giant-ai-teammates.patch` | The computer player never aims a harmful spell at its teammate, and scores its team's permanents | AI's `PossibleTargetsSelector` and `GameStateEvaluator2`, MAD's `SimulatedPlayer2` |
| `0004-two-headed-giant-rules-audit.patch` (v0.5.1) | The rules the audit found missing: a step of the team's turn is each of its players' (805.4d, `TeamStepEvent`), and "the active player" of an ability triggered there is that player (805.9, `Game.asActivePlayer`); "not your turn" and the core's "your turn" checks; skips, extra phases and steps, and turn control are the team's (805.8); each player of the active team is an attacking player (805.10a, 805.10c); can't lose and can't win are the team's (810.8a); life totals set for each player or exchanged between teammates (810.9d, 810.9e); poison checks and losses are the team's (810.10a, 810.10b; the poison methods become public `Game` methods, replacing 0002's); Assist counts the teammate's mana | 31 core files |
| `0005-two-headed-giant-ai-team-combat.patch` (v0.5.1) | The computer player attacks with its team's attackers in mind, blocks with the defending team's, leaves its teammate's blocks alone, and counts the team's poison against 15 | MAD's `ComputerPlayer6` and `CombatUtil` |
| `0006-two-headed-giant-card-audit.patch` (v0.5.1) | The cards whose own code the audit fixed one by one: "your turn" by player id, custom "each player's step" triggers, watchers of the turn's beginning, "you attack with", poison checks, Melira, and the life-setting cards | 82 card classes in `Mage.Sets` |

Every game type other than Two-Headed Giant names no teammates, so XMage behaves as unpatched for Legacy and Commander: each change reduces to XMage's own code without teammates, all engine tests that predate the patches pass unchanged, and `TwoHeadedGiantAuditTest.aLegacyDuelPlaysAsBefore` plays the audited patterns in a Legacy duel.
