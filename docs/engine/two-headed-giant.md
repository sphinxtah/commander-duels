# Two-Headed Giant (v0.0.4 feasibility; v0.5.0 spike and early practice game)

v0.0.4 assessed Two-Headed Giant and recommended a time-boxed spike on a patched XMage ([the feasibility note](#the-feasibility-note-v004), below). v0.5.0 ran that spike, option 2 of the note. **It held: go.** Shared team turns, a shared life total, team poison and team results work inside XMage with three small patches, and the first playable slice ships: a practice game in which the player and a bot teammate play two bots, marked "Early" on the Play page. It covers FMT08 and FMT09 as written, FMT10 for one human with an AI teammate and the authorized teammate-hand view, and T09 at the engine level.

What it proves:
- XMage's own turn, combat, life and loss rules can be made team-aware where they live, in 16 files and about 140 lines, without forking the turn loop. Every other game type names no teammates, so Legacy and Commander are unchanged: the 100 engine tests that predate the patches pass, two of their assertions changed only for the new format's name and the views' new `hand` field.
- A scripted game with four human seats and arranged libraries reaches, every time: the team that starts skipping its first draw, each team taking one turn in which both its players draw, play a land and attack together, one life total of 30 a team that damage to either player lowers, and the game ending when a team's life reaches 0, with the other team as the winner. Team poison (15) and a concession are tested too.
- Four bots play whole games to the end as two teams. In 26 measured games none attacked its teammate or aimed a burn or bounce spell at it, after a fix to XMage's AI that the first games showed was needed.
- The practice table's views pass every leak check with a teammate's hand shown to the human, and nothing of the opponents'.

What it does not prove:
- Four humans, or two humans with AI teammates, through the API and the browser (the engine plays them; tables do not offer them yet), team chat, or the full card audit. See [what remains](#what-remains-and-the-revised-estimate).
- That every card plays by rules 805 and 810: a sample of the card pool was read, and [the cards known to misbehave](#cards-known-to-misbehave) are listed.
- Anything about face-down cards between teammates: a teammate's hand is shown, but their face-down permanents and spells stay hidden from them, as from everyone.

The rules quoted are the Comprehensive Rules of 2026-09-25 (rules 805, Shared Team Turns, and 810, Two-Headed Giant) and the Magic Tournament Rules effective 2026-02-27 (sections 8.4 and 9.5).

## The XMage patches

Three patches in `engine/xmage/patches`, applied by `build-xmage.sh` in name order at the pinned commit (`xmage_1.4.62V1`, `eb69d05b`). Each has a header with its reason and its removal condition (upstream implements the format, or Two-Headed Giant is dropped). None is offered upstream yet.

| Patch | Files | Lines (+/−) | What it does |
| --- | --- | --- | --- |
| `0001-two-headed-giant-shared-team-turns` | 12 | +103 / −24 | Shared team turns (805) |
| `0002-two-headed-giant-shared-life-and-poison` | 2 | +44 / −4 | Shared life and team poison (810.9, 810.10) |
| `0003-two-headed-giant-ai-teammates` | 3 | +30 / −6 | The computer player and its teammate |

The hook is one new method of `mage.game.Game`, `getTeammates(playerId)`, empty by default. A game type that names teammates gets the rules below; every other game behaves as unpatched.

| Rule | Where in XMage | Patch |
| --- | --- | --- |
| Teammates are not opponents | `Game.getOpponents` and `Game.isOpponent` (defaults) leave teammates out, so every "opponent" in the card pool and the AI means the other team | 0001 |
| 805.4, 805.8: teams take turns, and an extra turn is the team's | `GameImpl.play`: the next player in turn order takes no turn of their own when their team took the turn just played (a teammate's turn, or their own extra turn). The team's turn is held by one player, XMage's active player | 0001 |
| 805.4a, 805.9: each player on the active team is an active player | `Game.isActivePlayer` (default) is true for the active player's teammates: sorcery timing, land drops, "your turn", summoning sickness and "until your next turn" follow | 0001 |
| 805.4b, 805.4c, 514.1: the team untaps, draws, may play a land each and discards to hand size | `Turn.play` (each teammate's `beginTurn`), `UntapStep`, `DrawStep`, `CleanupStep`; "doesn't untap during its controller's untap step" (`DontUntapInControllersUntapStep*Effect`) | 0001 |
| "At the beginning of your upkeep" and the other step triggers fire for both players of the active team | `AtStepTriggeredAbility` (`YOU`, `NOT_YOU`) | 0001 |
| 805.10b: the active team attacks together | `Combat.selectAttackers` asks each player of the attacking team in turn, each for their own creatures; attacks go to any player of the other team or their planeswalkers (XMage's "attack multiple players") | 0001 |
| 805.10d: the defending team blocks together | `Combat.selectBlockers` asks every player of the defending team, and `CombatGroup.canBlock` lets a creature block an attacker attacking its controller's teammate | 0001 |
| A human player stops in its team's turn as in its own | `HumanPlayer`'s priority stops ("your turn" or "opponent's turn") | 0001 |
| 810.4, 810.9, 810.9a: one life total a team | `PlayerImpl.loseLife` and `gainLife` apply the change to the player and set the teammate's life to the result, so every effect that reads a player's life reads the team's. Life-change events still name the player who gained or lost (810.9) | 0002 |
| 810.9g, 810.9h: if a player can't gain (or lose) life, no one on the team can | `PlayerImpl.loseLife`, `gainLife` | 0002 |
| 810.10, 810.8d: poison counters are the team's; 15 lose | `GameImpl.getPoisonCounters` and `getPoisonCountersToLose`, overridable (the player's own and 10 by default) | 0002 |
| The AI never aims a harmful single-target spell at its teammate | MAD `SimulatedPlayer2` (the search's options), AI `PossibleTargetsSelector` (targets chosen outside a search) | 0003 |
| The AI scores its team's permanents against the other team's | AI `GameStateEvaluator2` | 0003 |

Core classes touched: `Game`, `GameImpl`, `Turn`, `UntapStep`, `DrawStep`, `CleanupStep`, `Combat`, `CombatGroup`, `PlayerImpl`, `AtStepTriggeredAbility` and the two "doesn't untap" effects, plus `HumanPlayer`, two AI classes and one MAD class. XMage reads `getActivePlayerId()` directly in 57 places in Mage core; the patches change the ones above, and the rest read the turn's holder, which is one of the active team's players (see [the cards known to misbehave](#cards-known-to-misbehave)).

## The game type and the engine

`TwoHeadedGiant` (`engine/src/main/java/com/commanderduels/TwoHeadedGiant.java`) extends XMage's `GameImpl` and names the teams. It lives in the engine module, where the note's option 1 put its game type, rather than in an XMage plugin. Seats 0 and 1 play seats 2 and 3, in turn order 0, 1, 2, 3, so team A's turn is held by seat 0 (or seat 1, when seat 1 starts or takes an extra turn) and team B's by seat 2.
- **Setup.** 30 life (810.4), 60-card decks, seven cards, the London mulligan with the first mulligan free (103.5c: a multiplayer game), every player in range, attacks at any opponent.
- **810.6.** The team that plays first skips the draw step of its first turn: the starting player holds that turn, and its draw step is the team's.
- **810.8a, 810.8b.** Players win and lose as a team. When a player loses, or leaves by conceding, the rest of the team loses too; the game ends when one team is left, and both of its players win. Both teams losing at once is a draw. XMage's end of game otherwise keeps a single winner and makes everyone else lose, which would take the win from the winner's teammate: `findWinnersAndLosers` keeps it for the whole team.
- **Team poison**: the team's counters against 15 (the patch's overridable methods).
- **The match** XMage's AI needs for its search is a `TwoHeadedGiant.Match` that is never started.

`GameFormat.TWO_HEADED_GIANT` (`two_headed_giant`, rules profile `two_headed_giant_legacy`) seats exactly four, checks each deck with XMage's Legacy validator, and has four fixture decks. `POST /v1/games` (the development and service routes) takes it like any format: by default a human and three bots, with the fixtures in order. The engine's HTTP API is otherwise unchanged, and plugin loading is untouched.

### Views and results

Each player's state in a view gains two fields, both null outside Two-Headed Giant ([the seat view's contract](../../contracts/engine-seat-view.schema.json)):
- **`team`**: 0 for seats 0 and 1, 1 for seats 2 and 3. Teammates show the same life, the team's.
- **`hand`**: the player's hand, card by card, shown only to their teammate (810.5: teammates may look at each other's hands; FMT10's authorized teammate view). Everyone else, a spectator included, sees the count only. The contract allows a hand on at most one opponent, and only in Two-Headed Giant.

`Visibility` lets a teammate see a card in a hand, so prompts may name it, and the fair bots' search keeps a teammate's real hand instead of re-dealing it ([fair bots](fair-bots.md)): it is information the bot's seat is entitled to.

A result gains `winner_seats`: every winning seat, the winning team in Two-Headed Giant and the winner alone elsewhere. `winner_seat` stays, the winning team's first seat.

### Fixture decks

Two new 60-card Legacy fixtures join the two from v0.0.2, so four bots can play four decks with no card in common (no team ever shares a card, and the leak checks tell concealed cards apart by name):

| Deck | Cards |
| --- | --- |
| `legacy-mono-red-burn` (v0.0.2) | Burn and hasty creatures |
| `legacy-mono-green-creatures` (v0.0.2) | Mana creatures, fatties, pump spells |
| `legacy-mono-white-weenie` (v0.5.0) | Small creatures, first strike and lifelink (Knight of Meadowgrain, Healer's Hawk), Ajani's Pridemate, pump instants |
| `legacy-mono-blue-skies` (v0.5.0) | Flyers, Phantom Warrior, bounce (Mist Raven, Vapor Snag, which also costs its controller life), Remove Soul, Think Twice |

The commander-format starter decks cannot play: they are 100-card singleton decks. In 25 of the 26 measured bot games the red and green team beat the white and blue one, so the new decks are the weaker pair; the API deals the teammate the red deck unless the player's deck shares a card with it.

## The practice game

The practice route (`POST /api/v1/practice-games`, `format: "two_headed_giant"`, `api/games.py`) seats the player and a bot teammate against two bots; `api/teams.py` holds the team rules ([games through the API](../games.md#two-headed-giant-v050-early)):
- **Legacy decks** (FMT09, the default constructed team profile): the player's own Legacy deck, checked as at a Legacy table by the game's rules (casual by default), and Legacy's format version recorded.
- **Per team.** MTR 9.5 makes Two-Headed Giant Constructed use Unified Deck Construction (MTR 8.4): no two decks on a team may hold the same card, by English name, except cards with the basic supertype. The API checks both teams' decks (422 `team_decks`, naming the shared cards). MTR 9.5 also bans Erayo, Soratami Ascendant in Two-Headed Giant Constructed, which a game refusing banned cards refuses. The official format page's wording ("four copies of any non-basic land card ... shared between teammates") is the older four-copies rule; the tournament rules' current text is stricter, and the API follows it. No sideboards (MTR 9.5): a Legacy deck's sideboard, which a Legacy game takes since v0.5.0's best of three, stays out of a Two-Headed Giant game.
- **Bots** with no deck chosen get fixture decks: the teammate the first one that shares no card with the player's deck, the opponents the next two.
- **Results.** The team wins together: the player's win counts once, the tokens pay for the two opponents beaten, never for the teammate (`api/economy.py`), and the records count a win for every seat of the winning team (`api/stats.py`).
- **Data.** Migration `0024_two_headed_giant` lets a game's format be `two_headed_giant`. Decks, human tables and format versions keep Legacy and Commander.

The web app (since v0.5.0):
- **Play page.** Two-Headed Giant is marked "Early" instead of "Coming soon" (`GET /api/v1/formats` says `available` and `early`), and its details say what the early version is.
- **Practice table.** The format reads "Early · a bot teammate against two bots, 30 life a team"; the player's Legacy decks are offered; the bots' decks are labelled the teammate's and the two opponents'.
- **Game screen.** The four seats sit as at any four-player table (the layout is unchanged): you below, your teammate first above. The teammate's plate is titled "Your teammate" with a "Teammate · shared life" pill; life labels say "team life", and seat labels say which players are your teammate and which the other team. The turn line says "Your team's turn" while your teammate holds the team's turn, and a team's win is a victory for both teammates. The teammate's hand count names the cards in that hand (on hover, and to screen readers); the table does not lay them out as cards yet.

## How it was checked

Engine (JUnit, `TwoHeadedGiantTest`, on the patched XMage):
- **Shared turns, shared life, the first draw and the team result.** Four human seats with arranged libraries play the plan of the scenario: team A (seats 0 and 1) plays lands, casts what it can, burns team B's players in turn and attacks with everything; team B plays lands. Asserted: turns 1, 3, 5... are seat 0's and 2, 4, 6... seat 2's, with no turn of seat 1's or 3's own; seat 1 plays a land in team A's first turn and seat 3 in team B's; every library holds 53 cards in turn 1 (team A skipped its draw), team B's 52 in turn 2 and team A's 52 in turn 3; seats 0 and 1 attack in one combat; team B shows one life from 30/30 down to −2/−2, both players lowering it; the game ends `completed` in turn 9 with `winner_seats` [0, 1] and both of team B lost. Every view passes `SeatChecks`.
- **Team poison.** Nine and six poison counters, given to team B's players in turn 2, make the team lose at once though neither player has ten.
- **A concession.** Seat 1 concedes at its first priority: its team loses, seat 0 with it, and seats 2 and 3 win (810.8b).
- **An extra turn.** Seat 1, given an extra turn during team A's first turn, holds turn 2 for team A; team B plays turn 3, and seat 1 takes no turn of its own after its extra one (805.8). The first version of patch 0001 gave team A a second extra turn here; this test came with the fix.
- **Four bots.** Four fair bots at skill 1 play four seeded games to the end: every game ends with a winning team, no error XMage recovered from, and an audit at every table event finds no attack at a teammate and no burn or bounce spell aimed at one.
- **The practice table.** A scripted human and a bot teammate against two bots, under every leak and state check: the teammate's hand is shown to the human card for card, the opponents' never; the settings say `two_headed_giant` and `two_headed_giant_legacy`.
- **The request.** Four seats, two teams, the four fixtures, each Legacy-legal and sharing no card.
- **`SeatChecks`** (every engine test): a teammate's hand is not concealed from the seat, every other hand still is; in a team game each player's team is the format's, teammates show the same life, and a hand is shown only to its owner's teammate, as XMage holds it.

API (pytest, `tests/test_two_headed_giant.py`): the fixture cards are the deck files'; bots get fixture decks their teammate shares no card with; a team whose decks share a card is refused, without regard to case, basic lands (snow-covered too) allowed; Erayo is refused where banned cards are; the formats list and practice options; a practice game sends the engine four seats with the dealt decks and records `two_headed_giant`; a team win records the player's win once and pays for seats 2 and 3 only; the records count a win for both seats of the winning team; a player's own Legacy deck plays without its sideboard, and the teammate gets the green fixture when the deck holds Lightning Bolt; an older engine's result names its winner alone; the seat-view contract accepts a teammate's hand and refuses two hands, your own entry's, a hand outside the format, a third team and a hand to a spectator.

Web (Vitest): the Play page shows "Early" and the dialog's text; the practice table plays the player's Legacy decks with the teammate and opponents labelled; a game the team won reads "Won"; the table model marks the teammate and says "team life"; a team's win is a victory, whoever's flag it was. Browser journeys: the shell journey checks the Early card and its dialog; a game journey (needs the engine, `CD_E2E_GAMES=1`) starts a Two-Headed Giant game and checks the teammate's plate and the shared life.

## Measurements

Taken on 2026-10-22 on the development machine (Docker Desktop, 24 CPUs).

| Item | Result |
| --- | --- |
| Patch size | 3 patches, 16 files, +177 / −34 lines (about 140 net), in Mage core (11 files), the human player (1), the AI (2) and the MAD AI (1) |
| XMage build with the patches | 212 s: fetch 12 s, apply under a second, compile 198 s, peak memory 4.4 GB. v0.0.2 measured 167 s to compile without patches; the patches recompile nothing more than an XMage change always does (the whole stage), and the difference is the machine, which other builds shared |
| Engine module and its JUnit tests | 206 s for 105 tests (`TwoHeadedGiantTest` 33 s, `CommanderGameTest` 121 s); the whole image 7 min 43 s with the XMage stage rebuilt. The extra-turn and concession tests came after this build: 107 tests |
| Four-bot games, skill 1 (seeds 101–120) | 20 of 20 ended with a winning team; 10–18 turns (median 12, six a team); 3.0–15.6 s (median 6.1 s); 496 attacks and 129 burn or bounce targets, none at a teammate; no engine error |
| Four-bot games, skill 4 (seeds 101–106) | 6 of 6 ended with a winning team; 10–14 turns (median 12); 3.0–6.9 s; none at a teammate; no engine error |
| The scripted four-human game | About 8 s for 9 turns and about 250 prompts |

### The AI

- **Teammates are not targets.** XMage's AI kept only itself out of the targets it searched for a harmful spell, and sorted the targets it picks outside a search into its own and everyone else's. The first four-bot games showed it: a red bot shocked and Lava Spiked its teammate three times in one game. While the spell is still on the stack, the search cannot tell those targets from an opponent's. Patch 0003 keeps the teammate out; 26 games since found no harmful target on a teammate.
- **It plays for its team.** With 0003 the AI scores its team's permanents against the other team's. It still compares life with the first opponent only, which in Two-Headed Giant is the other team's shared total, so that part needs nothing.
- **What it still does not do.** It does not plan attacks with its teammate (each bot declares its own attackers, the teammate after the holder of the turn), it blocks only what XMage's heuristics offer it (since the patch, attackers attacking its teammate too), and its lethal-attack check counts ten poison counters, not fifteen. The search simulates one player's actions at a time, as before.
- **Bots think about as long as at four-seat Commander**: no search was cut off by its budget at skill 1.

## Cards known to misbehave

The card pool at the pin (32,498 card classes in `Mage.Sets`) was searched for the patterns rules 805 and 810 change, and the matching cards sampled.

| Pattern | Cards | Plays |
| --- | --- | --- |
| "Each opponent", "an opponent" (`getOpponents`) | 577 | **Right**: the other team's two players, never the teammate. Gray Merchant's drain takes life from both opponents, so twice from the team, as the rules have it |
| "Your turn" (`MyTurnCondition`, `isActivePlayer`) | 198 and 120 | **Right** for both players of the active team |
| "At the beginning of your upkeep" and other steps | (most step triggers) | **Right** for both players of the active team |
| "Not your turn" (`NotMyTurnCondition`) | 19 | **Wrong** for the teammate of the turn's holder, who is told it is not their turn |
| Cards that compare a player with the active player by id | 32 | **Wrong** for the teammate the same way; 134 cards read the active player directly and each needs a look |
| "At the beginning of each player's upkeep, that player..." | 72 | **Wrong**: triggers once, for the turn's holder, not for each player of the active team (805.4d) |
| Skip a turn, a step or a phase | 20 | **Wrong** when the skipping player is not the turn's holder: their team does not skip (805.8) |
| Extra turns | 59 | **Right**: the player's team takes it (805.8) |
| Control another player's turn (Mindslaver and the like) | 48 | **Unchecked**: 805.8 says controlling a player controls their team |
| "You can't lose the game", "your opponents can't win" (Platinum Angel and the like) | 17 and 4 | **Wrong**: 810.8a makes them the team's; today a teammate's loss still loses the team |
| Exchange or set life totals | 2 and 26 | **Right** for one player (810.9c); 810.9d (setting each player's life) and 810.9f (redistributing) are not done |
| Pay life | (most) | **Right** for one player, against the team's total (810.9b); two teammates paying at once are not limited together |
| Poison counter checks ("an opponent with three or more poison counters") | 33 | **Wrong**: they read one player's counters, not the team's (810.10a) |
| Assist (Battlebond) | 16 | **Partly**: the teammate can be chosen to help pay, but XMage counts only opponents' mana when it decides whether help could make the spell payable |
| Friend or foe (Battlebond) | 5 | **Unchecked**: each player chooses for every other player, so it should work |
| "Defending player", "attacking player" | | **Right** for "defending player" (the player attacked, 805.10e); "attacking player" is the turn's holder, not the creature's controller (805.10c) |

Other rules the patches do not follow yet:
- **805.5, 805.6, 805.7: team priority and team choices.** XMage still gives priority to each player in turn order, and each player of a team declares attackers, blockers and triggers in turn rather than together. Each player can still act whenever the rules let their team.
- **805.10b: attacks are legal as a whole.** Attack restrictions are checked after each player's declaration, so "can't attack alone" sees the first player's attackers before the second has declared.

## What remains, and the revised estimate

The note's estimate for the full format was three to five versions after the spike. With the rules in place the remaining work is smaller:

| Work | Estimate |
| --- | --- |
| **Four humans, and two humans with AI teammates** (FMT10): human tables with teams (`api/tables.py`: team seating, readiness by team, a team's concession), the human result paying both winners (today the practice game pays its one human), and the browser's seat layout labels for two humans per team. The engine already plays any mix of humans and bots, as the scripted four-human game does | One version |
| **Cooperative humans against AI** (two humans on a team against two bots): the same tables, with bots in the other team's seats | In the version above |
| **Team chat** (FMT10): the table chat's alliance channel (v0.4.4) as a fixed team channel, and the teammate's hand shown on the table (the view carries it today) | Half a version |
| **The full card audit**: patch the misbehaving patterns above (805.4d step triggers, 805.8 skips and turn control, 810.8a can't-lose, 810.10a poison checks, Assist's mana count, "not your turn"), then review the 134 cards that read the active player directly, with scripted tests for each pattern | One to two versions |
| **The AI**: team attacks and blocks planned together, and the fifteen-counter poison check | Part of the audit |
| **Upstream**: offer the patches to XMage as a team game type | Optional; each XMage pin bump means rebasing them until then |

Two and a half to three and a half versions in all, down from three to five. Every pin bump also re-applies the patches; they touch hot core classes (`GameImpl`, `Combat`, `PlayerImpl`), so a bump may need them rebased.

## The feasibility note (v0.0.4)

Written for v0.0.4, which promised an assessment and no implementation. The findings came from reading XMage's source at the pinned commit (`xmage_1.4.62V1`, `eb69d05b`).

### What the scope asks for

- **FMT08.** An independent team mode: two players per team, shared turns and a shared life model, with individual hands, libraries, mana and control. Official team construction and poison rules apply. Ordinary Two-Headed Giant starts at 30 life, and constructed copy limits apply per team.
- **FMT09.** Legacy-legal decks by default, validated per team. Four independent turns must not be presented as Two-Headed Giant.
- **FMT10.** Four humans, two humans with AI teammates, or cooperative humans against AI. Teammates share information through explicit team permissions: team chat and authorized views of a teammate's hand, inside the team only.
- **T09.** A complete game with team construction, shared turns, separate resources and the correct team result.

### What XMage has at the pin

| Area | Finding |
| --- | --- |
| Game types | The server plugins are Two Player Duel, Free For All, the Commander and Brawl variants, Oathbreaker, Momir, Tiny Leaders, Canadian Highlander, Penny Dreadful and a custom Pillar of the Paruns duel. None is a team game. Cards with "Two-Headed" in their names are only cards |
| Teams | `mage.game.Team` is a stub (a name and a player list) that no rules code uses. `MatchType` has `numTeams` and `playersPerTeam` fields, and every game type sets them to zero |
| Opponents | `Game.isOpponent` is an overridable default that treats every other player as an opponent. Its comment says this holds "as long as no team formats are implemented", so a team game type can redefine opponents |
| Active player | XMage has one active player per turn. `GameImpl.playTurn` is private and sets it. The untap, draw and combat steps act for that one player, and Mage core reads `getActivePlayerId()` directly in 57 places. Card implementations in Mage.Sets add more |
| Life and poison | Life is per player (`Player.getLife`). There is no shared life total and no team poison count |
| AI | The MAD AI's search treats every other player as an opponent and simulates one active player at a time |

The building blocks Commander Duels already had were separate from XMage. Per-seat views and seat tokens, from v0.0.4, could carry a teammate's hand to the other teammate (FMT10) once the engine knew the teams. Team deck validation (FMT09) is a check over two deck lists and needs nothing from XMage.

### Options

#### 1. A game type in the engine module, on XMage's primitives

The engine module could subclass XMage's `GameImpl`, as XMage's own Free For All does:
- override `isOpponent`, so teammates are not opponents;
- override `checkIfGameIsOver`, so the game ends when one team remains;
- add team views and team deck validation on the Commander Duels side.

That makes a 2v2 team game with four separate turns and four life totals, but not Two-Headed Giant. Shared turns would mean replacing XMage's private turn loop and its step classes, and shared life would mean intercepting every life change across the card pool. Doing either outside XMage is a fork in all but name.

- **Delivers:** team identity, team results, teammate information sharing (FMT10). It does not deliver FMT08's shared turns or shared life, so FMT09 forbids calling it Two-Headed Giant.
- **Estimate:** about one version.
- **Risk:** low. The AI would still need checking: it may attack or target its teammate until it understands teams.

#### 2. Two-Headed Giant inside XMage: a patch now, upstream later

Implement the format where the rules live:
- Mage core: a team-aware active player, a turn in which both teammates untap, draw, play sorcery-speed spells and attack together, combat against a defending team, a shared life total and team poison, and the team that plays first skipping its first draw.
- A `Mage.Game.TwoHeadedGiant` plugin with its match type.
- AI awareness of teammates.

The engine build already applies isolated upstream patches from `engine/xmage/patches`, so the work can live there and be offered to XMage upstream.

- **Delivers:** FMT08–FMT10 and T09 as written.
- **Estimate:** large. A time-boxed spike of one version to prove shared turns and shared life on a patched XMage. If the spike holds, about three to five more versions for the full rules, the AI, a card audit (Assist, Surge, Teamwork, "each opponent", "your turn") and tests.
- **Risk:** high. Core changes touch every card that asks "whose turn is it". Every XMage pin bump means rebasing the patch, and upstream acceptance is not in our control.

v0.5.0 took this option, with the game type in the engine module (as in option 1) and the rules in patches; no XMage plugin was needed.

#### 3. A scope decision

- **Defer.** Keep FMT08–FMT10 in M3 and schedule them after the connected Legacy duel (M2).
- **Relabel.** Offer option 1 under an honest name, such as "2v2 team game", and drop Two-Headed Giant itself.
- **Remove.** Take Two-Headed Giant out of scope.

### Recommendation (v0.0.4)

Choose option 2, but not before v0.1.0. Record the scope decision now: Two-Headed Giant stays planned under M3 and nothing is renamed to stand in for it. Then:
1. After v0.1.0, run the one-version spike on a patched XMage at the current pin. It should play a scripted game with shared turns and a shared life total, end with a go or no-go, and give a revised estimate.
2. If the spike fails, fall back to option 3. Decide between relabelling and removing at that point, with the measurements in hand.
3. Teammate permissions and team deck validation can be built on the Commander Duels side at any time. Both options need them.

Option 1 on its own is not recommended. It costs a version, and FMT09 does not allow it to be called Two-Headed Giant.
