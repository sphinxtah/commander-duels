# Two-Headed Giant (v0.0.4 feasibility; v0.5.0 spike and early practice game; v0.5.1 card audit)

v0.0.4 assessed Two-Headed Giant and recommended a time-boxed spike on a patched XMage ([the feasibility note](#the-feasibility-note-v004), below). v0.5.0 ran that spike, option 2 of the note. **It held: go.** Shared team turns, a shared life total, team poison and team results work inside XMage with three small patches, and the first playable slice ships: a practice game in which the player and a bot teammate play two bots, marked "Early" on the Play page. It covers FMT08 and FMT09 as written, FMT10 for one human with an AI teammate and the authorized teammate-hand view, and T09 at the engine level.

What it proves:
- XMage's own turn, combat, life and loss rules can be made team-aware where they live, in 16 files and about 140 lines, without forking the turn loop. Every other game type names no teammates, so Legacy and Commander are unchanged: the 100 engine tests that predate the patches pass, two of their assertions changed only for the new format's name and the views' new `hand` field.
- A scripted game with four human seats and arranged libraries reaches, every time: the team that starts skipping its first draw, each team taking one turn in which both its players draw, play a land and attack together, one life total of 30 a team that damage to either player lowers, and the game ending when a team's life reaches 0, with the other team as the winner. Team poison (15) and a concession are tested too.
- Four bots play whole games to the end as two teams. In 26 measured games none attacked its teammate or aimed a burn or bounce spell at it, after a fix to XMage's AI that the first games showed was needed.
- The practice table's views pass every leak check with a teammate's hand shown to the human, and nothing of the opponents'.

What it does not prove:
- Four humans, or two humans with AI teammates, through the API and the browser (the engine plays them; tables do not offer them yet), team chat, or the full card audit. See [what remains](#what-remains-and-the-revised-estimate).
- That every card plays by rules 805 and 810: a sample of the card pool was read, and the cards known to misbehave were listed (v0.5.1 audited them: [the card audit](#the-card-audit-v051)).
- Anything about face-down cards between teammates: a teammate's hand is shown, but their face-down permanents and spells stay hidden from them, as from everyone.

v0.5.1 ran the full card audit ([the card audit](#the-card-audit-v051), below): three more patches make the rest of rules 805 and 810 that cards rely on team-aware ("each player's upkeep", "not your turn", skips and turn control, can't lose, poison checks, Assist, the attacking player), the AI attacks and blocks with its team in mind, and a review of 836 card-and-pattern pairs records each verdict in [two-headed-giant-audit.csv](two-headed-giant-audit.csv). The bot decks were re-paired after measuring every pairing ([the fixture decks](#fixture-decks)).

The rules quoted are the Comprehensive Rules of 2026-09-25 (rules 805, Shared Team Turns, and 810, Two-Headed Giant) and the Magic Tournament Rules effective 2026-02-27 (sections 8.4 and 9.5).

## The XMage patches

Six patches in `engine/xmage/patches`, applied by `build-xmage.sh` in name order at the pinned commit (`xmage_1.4.62V1`, `eb69d05b`): three from v0.5.0's spike and three from v0.5.1's card audit, kept apart so the spike's stay as they were reviewed. Each has a header with its reason and its removal condition (upstream implements the format, or Two-Headed Giant is dropped). None is offered upstream yet.

| Patch | Files | Lines (+/−) | What it does |
| --- | --- | --- | --- |
| `0001-two-headed-giant-shared-team-turns` | 12 | +103 / −24 | Shared team turns (805) |
| `0002-two-headed-giant-shared-life-and-poison` | 2 | +44 / −4 | Shared life and team poison (810.9, 810.10) |
| `0003-two-headed-giant-ai-teammates` | 3 | +30 / −6 | The computer player and its teammate |
| `0004-two-headed-giant-rules-audit` (v0.5.1) | 31 | +602 / −84 | The rules the audit found missing, in Mage core (the table below) |
| `0005-two-headed-giant-ai-team-combat` (v0.5.1) | 2 | +70 / −5 | The computer player attacks and blocks as a team |
| `0006-two-headed-giant-card-audit` (v0.5.1) | 82 | +238 / −106 | The cards whose own code the audit fixed one by one |

The hook is one new method of `mage.game.Game`, `getTeammates(playerId)`, empty by default. A game type that names teammates gets the rules below; every other game behaves as unpatched.

| Rule | Where in XMage | Patch |
| --- | --- | --- |
| Teammates are not opponents | `Game.getOpponents` and `Game.isOpponent` (defaults) leave teammates out, so every "opponent" in the card pool and the AI means the other team | 0001 |
| 805.4, 805.8: teams take turns, and an extra turn is the team's | `GameImpl.play`: the next player in turn order takes no turn of their own when their team took the turn just played (a teammate's turn, or their own extra turn). The team's turn is held by one player, XMage's active player | 0001 |
| 805.4a, 805.9: each player on the active team is an active player | `Game.isActivePlayer` (default) is true for the active player's teammates: sorcery timing, land drops, "your turn", summoning sickness and "until your next turn" follow | 0001 |
| 805.4b, 805.4c, 514.1: the team untaps, draws, may play a land each and discards to hand size | `Turn.play` (each teammate's `beginTurn`), `UntapStep`, `DrawStep`, `CleanupStep`; "doesn't untap during its controller's untap step" (`DontUntapInControllersUntapStep*Effect`) | 0001 |
| "At the beginning of your upkeep" and the other step triggers fire for both players of the active team | `AtStepTriggeredAbility` (`YOU`, `NOT_YOU`); since v0.5.1 through the step of each player (805.4d, below) | 0001, 0004 |
| 805.10b: the active team attacks together | `Combat.selectAttackers` asks each player of the attacking team in turn, each for their own creatures; attacks go to any player of the other team or their planeswalkers (XMage's "attack multiple players") | 0001 |
| 805.10d: the defending team blocks together | `Combat.selectBlockers` asks every player of the defending team, and `CombatGroup.canBlock` lets a creature block an attacker attacking its controller's teammate | 0001 |
| A human player stops in its team's turn as in its own | `HumanPlayer`'s priority stops ("your turn" or "opponent's turn") | 0001 |
| 810.4, 810.9, 810.9a: one life total a team | `PlayerImpl.loseLife` and `gainLife` apply the change to the player and set the teammate's life to the result, so every effect that reads a player's life reads the team's. Life-change events still name the player who gained or lost (810.9) | 0002 |
| 810.9g, 810.9h: if a player can't gain (or lose) life, no one on the team can | `PlayerImpl.loseLife`, `gainLife` | 0002 |
| 810.10, 810.8d: poison counters are the team's; 15 lose | v0.5.0: `GameImpl.getPoisonCounters` and `getPoisonCountersToLose`, overridable. v0.5.1: public `Game` methods instead (`getPoisonCounters(playerId)` counts the player's team, `getPoisonCountersToLose()` is 10 unless the game type says otherwise), so cards and the AI can ask | 0002, 0004 |
| The AI never aims a harmful single-target spell at its teammate | MAD `SimulatedPlayer2` (the search's options), AI `PossibleTargetsSelector` (targets chosen outside a search) | 0003 |
| The AI scores its team's permanents against the other team's | AI `GameStateEvaluator2` | 0003 |
| 805.4d: a step of the team's turn is each of its players' step. A trigger worded for "each player's" (or "each opponent's") step that refers to "that player" triggers for each player of the active team; any other step trigger triggers once, at the first of the team's players it applies to: "your upkeep" for the holder's teammate, an enchanted player's or the monarch's own step | `TeamStepEvent`: `TriggeredAbilities` and `DelayedTriggeredAbilities` check the beginning of a step once more for each of the active team's other players; `TriggeredAbility.triggersForEachTeamPlayer` (for `AtStepTriggeredAbility`, from the rules text: "that player", "that opponent", "they"...) | 0004 |
| 805.9: "the active player" in an ability is one of the active team's players, chosen by its controller | `Game.asActivePlayer`: while an ability triggered at a teammate's step triggers, goes on the stack and resolves (`TriggeredAbilityImpl`), `getActivePlayerId()` names that player. Views and logs show the turn's holder (`GameState.getActivePlayerId()`) | 0004 |
| 805.9: "not your turn" and the core's other "your turn" checks are the team's | `NotMyTurnCondition`, `IsPhaseCondition`, `CardsLeaveGraveyardTriggeredAbility`, `GainLoseLifeYourTurnTriggeredAbility`, `CrewsVehicleSourceTriggeredAbility`, `SkipUntapOptionalSourceEffect`, tokens put onto the battlefield attacking, abilities only the active player may activate, "until your next turn" delayed triggers, `EndStepCountWatcher`, `AttackedLastTurnWatcher`; `PlayAdditionalLandsAllEffect` gives each player of the active team the extra land | 0004 |
| 805.8: a turn, phase or step a player skips, or an extra phase or step a player gets, is the team's | `TurnMods.useNextForTeam` (skip turn, skip and extra phases and steps, from `Turn` and `Phase`); `Step.skipStep` and `Phase.skipPhase` check the skip for each player of the active team (Necropotence, Stasis); `GameImpl.isTeamTurnSkipped` (Time Vault) | 0004 |
| 805.8: controlling a player controls their team | `Turn.checkTurnIsControlledByOtherPlayer`: the last player-controlling effect on any player of the active team gives its controller the whole team | 0004 |
| 805.10a, 805.10c: each player of the active team is an attacking player | `Combat.isAttackingPlayer`, `getAttackers(player)` (the creatures that player attacks with), `getAttackingPlayerOf(defender)`; `AttacksWithCreaturesTriggeredAbility` and `WhenYouAttackDelayedTriggeredAbility` count your creatures; `CombatGroup` asks the attacking creature's controller when the attacking player assigns a blocker's damage | 0004 |
| 810.8a: if an effect says a player can't lose (or can't win), no one on the team can; "you don't lose for having 0 or less life" keeps the team in | `PlayerImpl.canLose` and `won` (`teamAllowsResult`), `GameImpl.losesForZeroOrLessLife` | 0004 |
| 810.9d: an effect that sets each player's life total sets one player's of each team, whom the team chooses | `Game.chooseLifeTotalsToSet` (the team's first player chooses when the totals differ), used by Biorhythm and Shaman of Forgotten Ways | 0004, 0006 |
| 810.9e, 810.9f: no exchange of life totals between teammates; a redistribution affects one player of each team | `PlayerImpl.exchangeLife`; Reverse the Sands | 0004, 0006 |
| 810.10a, 810.10b: an effect that checks a player's poison counters counts the team's; poison counters a player loses beyond their own come off their teammates' | `CorruptedCondition` and 17 cards (`Game.getPoisonCounters`); `PlayerImpl.loseCounters`, `loseAllCounters` | 0004, 0006 |
| Assist: the teammate's mana counts as help | `AssistAbility` counts the teammates with the opponents; a bot teammate asked to help pays as much as its untapped mana allows | 0004 |
| The AI plans its team's attack and blocks with the defending team, against 15 poison | MAD `ComputerPlayer6` (the lethal attack counts the teammate's attackers, declared or still to declare; the defending team's blockers; a teammate's blocks are left alone), `CombatUtil.canKillOpponent` (the team's poison against `getPoisonCountersToLose`) | 0005 |

Core classes touched: `Game`, `GameImpl`, `Turn`, `TurnMods`, `Phase`, `Step`, `UntapStep`, `DrawStep`, `CleanupStep`, `Combat`, `CombatGroup`, `PlayerImpl`, `TriggeredAbility`, `TriggeredAbilityImpl`, `TriggeredAbilities`, `DelayedTriggeredAbilities`, `AtStepTriggeredAbility`, the new `TeamStepEvent`, and the conditions, triggers, effects and watchers named above, plus `HumanPlayer`, two AI classes and two MAD classes. XMage reads `getActivePlayerId()` directly in 55 places in Mage core at the pin; v0.5.1 reviewed every one (each either reads the team's turn now, acts for the player whose step it is, or names one of the active team's players, which 805.9 allows).

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

The commander-format starter decks cannot play: they are 100-card singleton decks.

**The pairing (v0.5.1).** In v0.5.0's measured bot games the red and green team beat the white and blue one 25 times in 26, mostly at skill 1. v0.5.1 measured every way of pairing the four decks, four fair bots at skill 4 (the practice and queue bots'), on the audited XMage with the team-aware AI, each team starting half the games (`TwoHeadedGiantPairingTest`, opt-in):

| Pairing (team A against team B) | Team A's wins |
| --- | --- |
| Red and green against white and blue (v0.5.0's) | 25 of 40, then 37 of 60 more: 62 of 100 (62 %) |
| **Red and white against green and blue** | 19 of 40, then 27 of 60 more: **46 of 100 (46 %)** |
| Red and blue against green and white | 30 of 40 (75 %) |

Red and white against green and blue is the even pairing: 46 and 54 of 100 games are as close to even as 100 games can tell (a two-sided binomial test against 50 % gives p = 0.48), where v0.5.0's pairing won 62 of 100 (p = 0.02) and red and blue three games in four. The team-aware AI narrowed v0.5.0's gap (25 of 26 at mostly skill 1) without closing it. No deck needed changing. The engine seats its fixtures in that order (`GameFormat.TWO_HEADED_GIANT`), and the API deals the pairs: two bots on a team play red and white, or green and blue (`api/teams.py`, `PAIRS`), and a bot beside a player plays the first fixture left that shares no card with the player's deck. In a practice game whose player plays red, the bots are white for the teammate and green and blue for the opponents.

## The practice game

The practice route (`POST /api/v1/practice-games`, `format: "two_headed_giant"`, `api/games.py`) seats the player and a bot teammate against two bots; `api/teams.py` holds the team rules ([games through the API](../games.md#two-headed-giant-v050-early)):
- **Legacy decks** (FMT09, the default constructed team profile): the player's own Legacy deck, checked as at a Legacy table by the game's rules (casual by default), and Legacy's format version recorded.
- **Per team.** MTR 9.5 makes Two-Headed Giant Constructed use Unified Deck Construction (MTR 8.4): no two decks on a team may hold the same card, by English name, except cards with the basic supertype. The API checks both teams' decks (422 `team_decks`, naming the shared cards). MTR 9.5 also bans Erayo, Soratami Ascendant in Two-Headed Giant Constructed, which a game refusing banned cards refuses. The official format page's wording ("four copies of any non-basic land card ... shared between teammates") is the older four-copies rule; the tournament rules' current text is stricter, and the API follows it. No sideboards (MTR 9.5): a Legacy deck's sideboard, which a Legacy game takes since v0.5.0's best of three, stays out of a Two-Headed Giant game.
- **Bots** with no deck chosen get fixture decks: since v0.5.1 two bots on a team play one of the measured pairs, red and white or green and blue (`PAIRS`, [the fixture decks](#fixture-decks)), the opponents green and blue unless the player's deck is one of them; a bot beside a player gets the first fixture left that shares no card with the player's deck. v0.5.0 gave the teammate the first and the opponents the next two (green and white).
- **Results.** The team wins together: the player's win counts once, the tokens pay for the two opponents beaten, never for the teammate (`api/economy.py`), and the records count a win for every seat of the winning team (`api/stats.py`).
- **Data.** Migration `0024_two_headed_giant` lets a game's format be `two_headed_giant`. Decks, human tables and format versions keep Legacy and Commander.

The web app (since v0.5.0):
- **Play page.** Two-Headed Giant is marked "Early" instead of "Coming soon" (`GET /api/v1/formats` says `available` and `early`), and its details say what the early version is.
- **Practice table.** The format reads "Early · a bot teammate against two bots, 30 life a team"; the player's Legacy decks are offered; the bots' decks are labelled the teammate's and the two opponents'.
- **Game screen.** The four seats sit as at any four-player table (the layout is unchanged): you below, your teammate first above. The teammate's plate is titled "Your teammate" with a "Teammate" pill (v0.5.0 first said "Teammate · shared life", which the plate cut short); life labels say "team life", and seat labels say which players are your teammate and which the other team. The turn line says "Your team's turn" while your teammate holds the team's turn, and a team's win is a victory for both teammates. The teammate's hand count names the cards in that hand (on hover, and to screen readers); the table does not lay them out as cards yet.

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

The card audit (v0.5.1, `TwoHeadedGiantAuditTest`): four human seats that pass and never block (seat 0 starts), with the cards put onto the battlefield in turn 1's main phase by XMage's cheat, every view under `SeatChecks`:
- **805.4d, 805.9: each player's step.** Sulfuric Vortex deals 2 to each player of team B in its upkeep (the team at 26) and of team A in turn 3; Howling Mine, whose trigger is its own class, draws each of team B's players a card (51 cards each in turn 2); Citadel of Pain, whose effect reads "the active player", deals 2 and 3 for seat 2's and seat 3's untapped lands (the team at 21); The Theorist's "each opponent's draw step, you draw a card" draws seat 0 one card, not two.
- **A teammate's own step and the monarch's.** Phyrexian Arena on seat 1 draws it one card and costs the team one life in team A's turn; seat 3, the monarch while seat 2 holds the turn, draws at team B's end step.
- **Not your turn.** Warden of the Wall on seat 1 is a creature in team B's turn and not in team A's turn that seat 0 holds.
- **805.8: skips and extra phases.** Necropotence on seat 1: neither seat 0 nor seat 1 draws in team A's turn 2. Seat 3 skipping its next turn: team B skips its turn, and team A plays turn 2. An extra combat phase given to seat 1: team A has it.
- **805.8: turn control.** Seat 0 controlling seat 3's next turn controls seat 2 and seat 3 in team B's turn 2, and neither in turn 3 (played by XMage's bots, see [the audit](#the-card-audit-v051) for why).
- **810.8a.** With Platinum Angel on seat 1 and Phyrexian Unlife on seat 3, both teams put at 0 life in turn 1 are still in the game when the turns run out.
- **810.10.** Bonepicker Skirge has deathtouch while team B has two and one poison counters; with Melira, Sylvok Outcast on seat 2, seat 3 gets none; seat 3 losing three takes the team's to none.
- **Assist.** Huddle Up ({2}{U}) is castable by seat 0 with one Island because seat 1 has two.
- **805.10a.** Seat 1 attacks with three creatures and its Overwhelming Instinct draws it a card; seat 0 attacks with two in the same combat and its own does not.
- **Outside team games.** A Legacy duel with Sulfuric Vortex, Howling Mine, The Theorist and Warden of the Wall plays as XMage always did: one trigger each, for the active player, and the Warden a creature in the opponent's turn only.

The patches reproduce the audited XMage tree exactly when applied in order to the pin, and the whole engine suite (122 tests) passes on it, in the development container and in a cold build of the engine image. Of the 112 tests that predate the audit, one assertion changed: the fixtures' new order (`TwoHeadedGiantTest` keeps its scripted games on the old order, whose cards they name).

API (pytest, `tests/test_two_headed_giant.py`): the fixture cards are the deck files'; bots get fixture decks their teammate shares no card with; a team whose decks share a card is refused, without regard to case, basic lands (snow-covered too) allowed; Erayo is refused where banned cards are; the formats list and practice options; a practice game sends the engine four seats with the dealt decks and records `two_headed_giant`; a team win records the player's win once and pays for seats 2 and 3 only; the records count a win for both seats of the winning team; a player's own Legacy deck plays without its sideboard, and the teammate gets the white fixture when the deck holds Lightning Bolt, the opponents the green and blue pair (v0.5.1; the green fixture and green and white opponents in v0.5.0); an older engine's result names its winner alone; the seat-view contract accepts a teammate's hand and refuses two hands, your own entry's, a hand outside the format, a third team and a hand to a spectator.

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

v0.5.1's card audit, taken on 2026-10-23 on the same machine:

| Item | Result |
| --- | --- |
| Patch size | 6 patches; the audit's three: 115 files, +910 / −195 lines (core 31 files, the MAD AI 2, cards 82) |
| Rebuilding the patched XMage in a development container | Mage core 15 s, `Mage.Sets` 93 s, the AI and human player plugins 4 s each |
| Engine module and its JUnit tests | 122 tests in 3 min 25 s in the development container (`TwoHeadedGiantAuditTest` 36 s, `TwoHeadedGiantTest` 42 s, `CommanderGameTest` 87 s) |
| The whole engine image to `engine-build` from a cold XMage stage | 8 min 19 s: XMage 225 s (fetch 14 s, the six patches applied in under a second, compile 209 s, peak memory 4.4 GB), the card database 26 s, the engine module and its 123 tests 224 s (one skipped: the opt-in pairing measurement) |
| Four-bot games, skill 1 (`TwoHeadedGiantTest`, seeds 21–24) | 4 of 4 ended with a winning team in 11–16 turns; no attack or burn at a teammate; no engine error |
| Four-bot games, skill 4, the pairings (seeds 7000–7039 and 9000–9059, four games at a time) | 240 games, every one ended with a winning team in 7 to 24 turns (median 14 to 16 by pairing); 40 games took about 2 minutes. See [the fixture decks](#fixture-decks) |

### The AI

- **Teammates are not targets.** XMage's AI kept only itself out of the targets it searched for a harmful spell, and sorted the targets it picks outside a search into its own and everyone else's. The first four-bot games showed it: a red bot shocked and Lava Spiked its teammate three times in one game. While the spell is still on the stack, the search cannot tell those targets from an opponent's. Patch 0003 keeps the teammate out; 26 games since found no harmful target on a teammate.
- **It plays for its team.** With 0003 the AI scores its team's permanents against the other team's. It still compares life with the first opponent only, which in Two-Headed Giant is the other team's shared total, so that part needs nothing.
- **It attacks and blocks as a team (v0.5.1, patch 0005).** Each bot still declares its own attackers, the holder of the turn first, but its lethal-attack check now counts its teammate's attackers: those already attacking and, when it declares first, those its teammate could attack with; the teammate then sees the holder's attackers and joins an all-out attack the same way. The defenders it plans against are the defending team's blockers together (805.10d). A defending bot leaves alone the attackers its teammate has already blocked, and the poison part of the lethal check counts the defending team's counters against fifteen.
- **What it still does not do.** The search simulates one player's actions at a time, as before, so a bot does not plan a spell with its teammate's; the attack plan above is XMage's heuristic lethal check made team-wide, not a search of the team's attacks. A blocking bot does not double-block with its teammate on purpose. Neither uses Assist to ask its teammate for mana (XMage's AI never uses Assist), though a bot teammate pays when a human asks.
- **Bots think about as long as at four-seat Commander**: no search was cut off by its budget at skill 1.

## The card audit (v0.5.1)

v0.5.0 searched the card pool at the pin (32,498 card classes in `Mage.Sets`) for the patterns rules 805 and 810 change, sampled the matches and listed the cards known to misbehave. v0.5.1 fixed those patterns where XMage's rules live (patch 0004), fixed the cards whose own code reads one active player, one attacking player or one player's poison counters (0006), and reviewed every matching card: [two-headed-giant-audit.csv](two-headed-giant-audit.csv) has one row for each card and pattern (836 rows, by card name and XMage class), with its verdict (right, fixed, still wrong or not applicable), the change that fixed it and a note. Each pattern has a scripted test (`TwoHeadedGiantAuditTest`, [how it was checked](#how-it-was-checked)).

| Pattern | Reviewed | Plays since v0.5.1 |
| --- | --- | --- |
| "Each opponent", "an opponent" (`getOpponents`) | 577 (v0.5.0) | **Right**, as before: the other team's two players, never the teammate |
| "Your turn" (`MyTurnCondition`, `isActivePlayer`) | 198 and 120 (v0.5.0) | **Right**, as before, for both players of the active team |
| "Not your turn" (`NotMyTurnCondition`) | 19 | **Fixed** (0004): not while the teammate holds the team's turn |
| A step trigger worded for "each player's", "each opponent's" or "each other player's" step | 166 | **Fixed** for the 151 that refer to "that player": they trigger for each player of the active team, and an effect that reads "the active player" acts for that player (805.4d, 805.9). **Right** for the 15 that don't (Luminarch Ascension, The Theorist's draw): once a team step. Five were built as "each step" though worded for each player's (Belbe, Burning Cinder Fury, Impatience, Kuon's Essence, Energy Vortex's chosen player): fixed in 0006 |
| A step trigger for an enchanted player, an enchanted creature's controller or the monarch | 48 | **Fixed** (0004): at that player's own step. Before, it triggered at the turn holder's, and "that player" was the holder even when the curse was on the teammate |
| "Each upkeep", "the next end step" | 200 | **Right**: once a team step |
| Custom step triggers in card code ("your upkeep", "the chosen player's upkeep", Howling Mine's "each player's draw step") | 79 | **Fixed** 38: the step is checked for each player of the active team, and 10 that say "that player" trigger for each (0006). **Right** 40. **Still wrong** 1 (Territorial Hellkite: the attacking player) |
| Cards that read the active player directly | 134 | **Fixed** 92: the 32 that compared a player with it by id read the team's turn now (0006), most of the rest are step triggers that act for the player whose step it is (0004), and four watchers and three combat effects cover each player of the active team (0006). **Right** 29 (805.9 lets an ability name one active player, and the turn's holder is one). **Still wrong** 12, listed below. One is Planechase |
| Skip a turn, a step or a phase | 48 | **Fixed** 46 (0004): the team skips it. **Right**: Fatespinner (everyone skips the chosen step). **Still wrong**: Brine Elemental (below) |
| Extra turns, phases and steps | 59 and more | **Right**: the team takes them; extra phases and steps given to the holder's teammate now count too (0004) |
| Control another player's turn (Mindslaver, Emrakul, Sorin Markov's −7 and the like) | 9 | **Fixed** in XMage (0004): the controller controls the whole team. The engine does not route a controlled player's prompts, see below |
| "You can't lose the game", "your opponents can't win", "you don't lose for 0 life" | 24 | **Fixed** 21 (0004): the team can't lose (or win). **Right** 3 (they trigger when a player loses) |
| Set or exchange life totals | 41 | **Right** 37 (810.9c: one player's total, which the team follows; every player's to the same number; an exchange with an opponent). **Fixed**: Biorhythm and Shaman of Forgotten Ways (810.9d, the team chooses whose number), Psychic Transfer (810.9e, no exchange with a teammate), Reverse the Sands (810.9f, one player of each team) |
| Pay life | (most) | **Right** for one player, against the team's total (810.9b); two teammates paying at once are still not limited together |
| Poison counter checks | 33 | **Fixed** (0004 for `CorruptedCondition`'s 16 cards, 0006 for 17): the team's counters (810.10a). Losing poison counters is the team's (810.10b), and Melira, Sylvok Outcast keeps the whole team from getting them (810.10c) |
| Assist | 16 | **Fixed** (0004): the teammate's mana counts, and a bot teammate helps pay |
| Friend or foe | 5 | **Unchecked** since v0.5.0: each player chooses for every other player, so it should work |
| "Defending player", "attacking player" | 17 and the core | **Right** for "defending player" (805.10e). "Attacking player" (805.10c): **fixed** in the core and 11 cards ("you attack with" counts your creatures; "that attacking player" is the one attacking the enchanted player); **still wrong** in 4 (below) |

Still wrong after the audit (each row of the review says why):
- **The turn's holder taken as the attacking player** (805.10c): Contested Game Ball, Ellie (Brick Master), Emberwilde Captain, Tahngarth (First Mate), War's Toll, Invasion Plans, Master Warcraft, Tenuous Truce and Territorial Hellkite. Each picks the holder where the rules want the controller of a particular attacking creature, which matters only when the holder's teammate attacks alone or the card cares whose creatures they are. A fix needs each card's own reading of 805.10c.
- **Watchers keyed by the turn's holder**: O-Kagachi, Weathered Sentinels, Arboria and Invasion of Fiora remember "attacked you during their last turn" (or cast a spell during it) for the holder only, so the holder's teammate is treated as not having attacked.
- **Storage Matrix**: the holder makes one choice for both players' untap steps, and the teammate's permanents untap freely.
- **Elkin Lair and Urabrask's** delayed parts (the next end step, the next draw) read the turn's holder.
- **Brine Elemental** ("each opponent skips their next untap step") makes the team skip two untap steps: 805.8 says one effect skipping a step for several players of a team skips it once. XMage's turn modifications do not record which effect made them, so the patch cannot tell one effect for two players from two effects.

Other rules the patches do not follow yet:
- **805.5, 805.6, 805.7: team priority and team choices** (the stretch goal, not done). XMage gives priority to each player in turn order and asks each player of a team to declare attackers, blockers and the order of their triggers in turn rather than together. Doing it means a team priority state in XMage's priority loop (`GameImpl.playPriority`), shared passing, and a team prompt in the engine (two seats answering one decision), which reaches the turn loop, the stack and both players' prompts; it is a version of its own. Each player can still act whenever the rules let their team, so no play is lost, only the order is the turn order.
- **805.10b: attacks are legal as a whole** (the stretch goal, not done). Attack restrictions and requirements are checked after each player's declaration (`Combat.checkAttackRestrictions` for one player), so "can't attack alone" sees the first player's attackers before the second has declared. Checking the team's attack as one needs the declaration split from the check across the team, in `Combat`.
- **810.9b** (two teammates paying life at once) and **810.10d** (a player counts as poisoned when the team has a poison counter, for proliferate and the like) are not done; the review found no Legacy card where it changes the result except proliferate's choice of players.
- **Turn control in the engine**: XMage asks the controlling player to make the controlled player's decisions (`firePriorityEvent` and the like go to the controller), but the engine sends each prompt to the seat it names and gives the answer to that seat's player, so the controlled player keeps waiting. This holds in every format (Mindslaver in a Legacy game too), predates v0.5.1, and a fix (answers routed to the controlled player, and the controller shown what that player may see) touches the hidden-information rules: left for the owner to decide. `TwoHeadedGiantAuditTest` checks control with XMage's own bots.

## What remains, and the revised estimate

The note's estimate for the full format was three to five versions after the spike, and v0.5.0 revised it to two and a half to three and a half. The owner kept all of it in v0.5.1 ([the plan](../plans/0.5.1.md#decisions-at-the-start-of-v051)):

| Work | Status (v0.5.1) |
| --- | --- |
| **Four humans, and two humans with AI teammates** (FMT10): human tables with teams (`api/tables.py`: team seating, readiness by team, a team's concession), the human result paying both winners, and the browser's seat layout for two humans per team. The engine already plays any mix of humans and bots, as the scripted four-human game does | Being built in v0.5.1 (the teams and teamview agents) |
| **Cooperative humans against AI** (two humans on a team against two bots): the same tables, with bots in the other team's seats | Being built in v0.5.1 (the teams agent) |
| **A Two-Headed Giant queue**, solo or with a friend | Being built in v0.5.1 (the teams agent) |
| **Team chat** (FMT10): the table chat's alliance channel (v0.4.4) as a fixed team channel, and the teammate's hand shown on the table (the view carries it) | Being built in v0.5.1 (the teams and teamview agents) |
| **The full card audit**: the misbehaving patterns patched (805.4d step triggers, 805.8 skips and turn control, 810.8a can't lose, 810.9d and 810.9f, 810.10a poison checks, Assist's mana count, "not your turn", 805.10c), the 134 cards that read the active player reviewed, with scripted tests for each pattern | Done in v0.5.1 ([the card audit](#the-card-audit-v051)); 17 cards still wrong, each with its reason in the review |
| **The AI**: team attacks and blocks planned together, and the fifteen-counter poison check | Done in v0.5.1 as heuristics (patch 0005); the search still simulates one player at a time |
| **805.5 to 805.7, team priority and team choices; 805.10b, attacks legal as a whole** | Not done: about a version (XMage's priority loop and the engine's prompts for two seats deciding together) |
| **Turn control for human seats in the engine** (all formats) | Not done: a decision for the owner (the controller would see the controlled player's hand) |
| **Upstream**: offer the patches to XMage as a team game type | Optional; each XMage pin bump means rebasing them until then |

Every pin bump also re-applies the patches; six now, touching hot core classes (`GameImpl`, `Combat`, `PlayerImpl`, `TriggeredAbilities`) and 82 card classes, so a bump may need them rebased. `TwoHeadedGiantAuditTest` and the review's verdicts are what to re-check.

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
