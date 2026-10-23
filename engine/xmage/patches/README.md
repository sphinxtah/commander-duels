# XMage patches

Changes to upstream XMage live here as `NNNN-description.patch` files (`git diff` format, paths relative to the XMage root). `build-xmage.sh` applies them in name order after fetching the pinned commit, and the build fails if one no longer applies.

Each patch needs a header comment that gives the reason, the upstream issue or pull request if there is one, and the condition for removing it.

At the current pin (`xmage_1.4.62V1`) three patches carry Two-Headed Giant (v0.5.0, early; see [the Two-Headed Giant note](../../../docs/engine/two-headed-giant.md)):

| Patch | What it changes | Files |
| --- | --- | --- |
| `0001-two-headed-giant-shared-team-turns.patch` | Shared team turns (rule 805): a game type may name teammates (`Game.getTeammates`, empty by default); the active team takes one turn together, untaps, draws, plays a land each and discards to hand size; each of its players is an active player; teammates are not opponents; the team attacks and blocks together; the human player stops in its team's turn as in its own | 12 core files and `HumanPlayer` |
| `0002-two-headed-giant-shared-life-and-poison.patch` | A team's shared life total (810.9) and team poison (810.10), through overridable methods of `GameImpl` | `PlayerImpl`, `GameImpl` |
| `0003-two-headed-giant-ai-teammates.patch` | The computer player never aims a harmful spell at its teammate, and scores its team's permanents | AI's `PossibleTargetsSelector` and `GameStateEvaluator2`, MAD's `SimulatedPlayer2` |

Every game type other than Two-Headed Giant names no teammates, so XMage behaves as unpatched for Legacy and Commander: all engine tests that predate the patches pass unchanged.
