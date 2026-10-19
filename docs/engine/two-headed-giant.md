# Two-Headed Giant feasibility (v0.0.4)

Written for v0.0.4, which promised an assessment and no implementation. It covers scope requirements FMT08–FMT10 and acceptance test T09. The findings come from reading XMage's source at the pinned commit (`xmage_1.4.62V1`, `eb69d05b`).

## What the scope asks for

- **FMT08.** An independent team mode: two players per team, shared turns and a shared life model, with individual hands, libraries, mana and control. Official team construction and poison rules apply. Ordinary Two-Headed Giant starts at 30 life, and constructed copy limits apply per team.
- **FMT09.** Legacy-legal decks by default, validated per team. Four independent turns must not be presented as Two-Headed Giant.
- **FMT10.** Four humans, two humans with AI teammates, or cooperative humans against AI. Teammates share information through explicit team permissions: team chat and authorized views of a teammate's hand, inside the team only.
- **T09.** A complete game with team construction, shared turns, separate resources and the correct team result.

## What XMage has at the pin

| Area | Finding |
| --- | --- |
| Game types | The server plugins are Two Player Duel, Free For All, the Commander and Brawl variants, Oathbreaker, Momir, Tiny Leaders, Canadian Highlander, Penny Dreadful and a custom Pillar of the Paruns duel. None is a team game. Cards with "Two-Headed" in their names are only cards |
| Teams | `mage.game.Team` is a stub (a name and a player list) that no rules code uses. `MatchType` has `numTeams` and `playersPerTeam` fields, and every game type sets them to zero |
| Opponents | `Game.isOpponent` is an overridable default that treats every other player as an opponent. Its comment says this holds "as long as no team formats are implemented", so a team game type can redefine opponents |
| Active player | XMage has one active player per turn. `GameImpl.playTurn` is private and sets it. The untap, draw and combat steps act for that one player, and Mage core reads `getActivePlayerId()` directly in 57 places. Card implementations in Mage.Sets add more |
| Life and poison | Life is per player (`Player.getLife`). There is no shared life total and no team poison count |
| AI | The MAD AI's search treats every other player as an opponent and simulates one active player at a time |

The building blocks Commander Duels already has are separate from XMage. Per-seat views and seat tokens, from v0.0.4, can carry a teammate's hand to the other teammate (FMT10) once the engine knows the teams. Team deck validation (FMT09) is a check over two deck lists and needs nothing from XMage.

## Options

### 1. A game type in the engine module, on XMage's primitives

The engine module could subclass XMage's `GameImpl`, as XMage's own Free For All does:
- override `isOpponent`, so teammates are not opponents;
- override `checkIfGameIsOver`, so the game ends when one team remains;
- add team views and team deck validation on the Commander Duels side.

That makes a 2v2 team game with four separate turns and four life totals, but not Two-Headed Giant. Shared turns would mean replacing XMage's private turn loop and its step classes, and shared life would mean intercepting every life change across the card pool. Doing either outside XMage is a fork in all but name.

- **Delivers:** team identity, team results, teammate information sharing (FMT10). It does not deliver FMT08's shared turns or shared life, so FMT09 forbids calling it Two-Headed Giant.
- **Estimate:** about one version.
- **Risk:** low. The AI would still need checking: it may attack or target its teammate until it understands teams.

### 2. Two-Headed Giant inside XMage: a patch now, upstream later

Implement the format where the rules live:
- Mage core: a team-aware active player, a turn in which both teammates untap, draw, play sorcery-speed spells and attack together, combat against a defending team, a shared life total and team poison, and the team that plays first skipping its first draw.
- A `Mage.Game.TwoHeadedGiant` plugin with its match type.
- AI awareness of teammates.

The engine build already applies isolated upstream patches from `engine/xmage/patches`, so the work can live there and be offered to XMage upstream.

- **Delivers:** FMT08–FMT10 and T09 as written.
- **Estimate:** large. A time-boxed spike of one version to prove shared turns and shared life on a patched XMage. If the spike holds, about three to five more versions for the full rules, the AI, a card audit (Assist, Surge, Teamwork, "each opponent", "your turn") and tests.
- **Risk:** high. Core changes touch every card that asks "whose turn is it". Every XMage pin bump means rebasing the patch, and upstream acceptance is not in our control.

### 3. A scope decision

- **Defer.** Keep FMT08–FMT10 in M3 and schedule them after the connected Legacy duel (M2).
- **Relabel.** Offer option 1 under an honest name, such as "2v2 team game", and drop Two-Headed Giant itself.
- **Remove.** Take Two-Headed Giant out of scope.

## Recommendation

Choose option 2, but not before v0.1.0. Record the scope decision now: Two-Headed Giant stays planned under M3 and nothing is renamed to stand in for it. Then:
1. After v0.1.0, run the one-version spike on a patched XMage at the current pin. It should play a scripted game with shared turns and a shared life total, end with a go or no-go, and give a revised estimate.
2. If the spike fails, fall back to option 3. Decide between relabelling and removing at that point, with the measurements in hand.
3. Teammate permissions and team deck validation can be built on the Commander Duels side at any time. Both options need them.

Option 1 on its own is not recommended. It costs a version, and FMT09 does not allow it to be called Two-Headed Giant.
