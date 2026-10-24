# Fair bots: hidden information and decision budgets (v0.3.1)

The bots no longer plan with cards their seat cannot see (AI02), and every decision that searches has a bounded budget with a valid fallback (AI05). Difficulty still comes from XMage's search depth, node limit and think time for the skill, not from knowing future draws or other players' hands (AI01).

Every bot seat, at the practice table and in bot matches, is now a `FairBot` (`engine/src/main/java/com/commanderduels/FairBot.java`): XMage's "Computer - mad" AI (`ComputerPlayerControllableProxy`, which extends `ComputerPlayer7` and `ComputerPlayer6`) with five of its protected methods overridden: `createSimulation`, `getNextAction`, `addActionsTimed`, `chooseCreatureType` and `printBattlefieldScore`. The search copies are dealt by `Determinizer` (same folder). No XMage patch was needed: every hook is a protected method of XMage's AI classes, and `engine/xmage/patches` stays empty. (Since v0.5.0 a patch teaches XMage's AI about teammates for Two-Headed Giant, and a fair bot keeps its teammate's real hand in its search copy, which its seat may see: [Two-Headed Giant](two-headed-giant.md).)

What it proves:
- The copy a bot searches never holds another player's real hand, nor any library in its real order. Pools and zone sizes are preserved, the real game is untouched, and samples follow the game's seed (`DeterminizerTest`).
- In a real game arranged so that knowing the next card changes the right play, XMage's own bot plays as if it knew the card and the fair bot does not (`FairBotTest`).
- A bot whose every search is cut off still plays a legal game, and each decision returns within its budget plus a fixed grace period (`FairBotTest`).

What it does not prove:
- That the bot's model of an opponent is what a human would know: a sample is dealt from the opponent's real remaining cards, so the bot still knows each opponent's deck list (see [Limits](#limits)).
- Anything about face-down cards: they keep their real identity in the copy (see [Limits](#limits)). None of the fixture decks has one.
- That decisions made without a search (targets, attackers, blockers and the like) are bounded by a clock: they are bounded by the number of options.

## The audit

The pinned XMage (`xmage_1.4.62V1`, commit `eb69d05b88142b5c4eec4869bcb23a0fec13c091`) was read in `Mage.Server.Plugins/Mage.Player.AI` and `Mage.Server.Plugins/Mage.Player.AI.MAD`, with the core methods they call in `Mage`. The question for every read of game state: can a bot's decision depend on an opponent's hand, a library's contents or order, a face-down card's identity, or cards another player looked at? Paths below are relative to the XMage root; AI is `Mage.Server.Plugins/Mage.Player.AI/src/mage/player/ai`, MAD is `Mage.Server.Plugins/Mage.Player.AI.MAD/src/mage/player/ai`.

| # | Where | What it reads | What we did |
| --- | --- | --- | --- |
| 1 | MAD `ComputerPlayer7.calculateActions` → MAD `ComputerPlayer6.createSimulation` | The root of every search: `game.createSimulationForAI()` (a deep copy of the whole game) with each player replaced by a `SimulatedPlayer2` restored from a copy of the real player. Every hand and library holds the real cards in the real order. | **Fixed.** `FairBot.createSimulation` deals the copy's concealed zones again before the search starts ([below](#determinized-search-copies)). |
| 2 | MAD `ComputerPlayer6.addActions`, `simulatePriority`, `resolve`, `minimaxAB`; MAD `SimulatedPlayer2.simulatePriority`, `triggerAbility`, `addAbilityNode` | The search itself. Every node is a copy of its parent, so all of them descend from the root. Before the fix, draws and "reveal the top card" effects resolved against the real library order, `resolve`'s hint for search effects branched on every card a library search could find, and discard and hand effects acted on real hands. | **Fixed by 1.** No node descends from anything but the determinized root. |
| 3 | MAD `SimulatedPlayer2.simulateOptions` → `Mage/.../players/PlayerImpl.getPlayable(game, hidden)` | The options of each player in the search. `hidden` is false for every player but the bot, so other players never cast from their hands in the search (XMage's own choice). Their other options remain: graveyard, exile (including face-down exiled cards they may cast, such as foretold cards), the top of a library when an effect lets them play it, and special actions, including turning a face-down permanent face up. | **Limit** for face-down cards: they keep their real identity in the copy. Everything else these options read is public, or dealt by 1. |
| 4 | MAD `ComputerPlayer6.getNextAction`, with the fingerprint `simulatePriority` stores in each node | XMage continues a planned chain of actions when `GameState.getValue(true)` of the real game equals the fingerprint recorded in the search. That string includes every player's hand by card id. | **Replaced.** With determinized copies the fingerprints would never match, and the comparison read other hands. `FairBot.getNextAction` compares `getValue(false)` (hands as counts) plus its own hand, for the real game and for the copy kept in the node XMage expanded. Only that node is fingerprinted: the string renders every permanent's rules text, and a first version that computed a second one at every node doubled the time of the three-bot Commander game (8 s to 17 s) and pushed a search to its budget. |
| 5 | AI `ComputerPlayer.chooseCreatureType` | Choosing a creature type for its own benefit: the first creature type in the bot's hand, then in its library walked from the top, so the choice followed the library's concealed order. | **Fixed.** `FairBot.chooseCreatureType` walks the library in card-name order. The choice against opponents reads only battlefields and graveyards and stays XMage's. |
| 6 | MAD `ComputerPlayer6.printBattlefieldScore(Game, UUID)` | Logs every player's hand card names at INFO. Not a decision. | **Changed.** The engine logs at WARN, so it never ran; `FairBot` logs other players' hand counts only. |
| 7 | MAD `ComputerPlayer6.declareAttackers`, `declareBlockers` → MAD `util/CombatUtil.canKillOpponent`, `blockWithGoodTrade2`, `willItSurviveSimple` | Copies of the real (not determinized) game for each attacker and blocker pair. They read battlefields, life, poison counters and hand sizes, and resolve nothing on the stack (`processAction` applies effects and state triggers only), so a concealed card cannot change the result. | **Unchanged**, no leak. `willItSurviveSimulation`, which would resolve the stack, is not called. `SimulatedPlayer2.addAttackers` and `addBlockers` are dead code. |
| 8 | AI `score/GameStateEvaluator2.evaluate`, AI `score/ArtificialScoringSystem` | The score of every position: life, permanents and the number of cards in each hand. A face-down permanent is scored with its face-down characteristics (a 2/2 with no name or mana cost). | **Unchanged**, public information only. |
| 9 | AI `ComputerPlayer.makeChoice` (through `chooseTarget`, `choose`, `chooseTargetAmount`), AI `PossibleTargetsSelector`, `PossibleTargetsComparator`; AI `ComputerPlayer.chooseMulligan`, `choosePile`, `makeChoiceAmount`, `chooseMode` | Choices the real game asks for. They rank the targets or cards XMage offers in that request, which a card's effect passes to whichever player decides, human or bot (a library while searching it, an opponent's hand once the effect has revealed it), or read the bot's own hand and permanents. | **Unchanged**, the seat's own entitlement. |
| 10 | `Mage/.../players/PlayerImpl.getPlayable` in the real game | The bot's own playable actions, from the same function a human seat's options come from. It looks at the top card of a library only when an effect lets the player play that card. | **Unchanged.** |
| 11 | MAD `ComputerPlayer6(ComputerPlayer6)` (copy constructor) | Not a read: copies leave `maxThinkTimeSecs` and `maxNodes` at zero, so a copy would never search. The real game keeps its original player objects when it restores a state, so this did not bite. | **Fixed** in `FairBot`'s copy constructor. |
| 12 | MAD `SimulationNode2.nodeCount` | Not a read: the node count is a static shared by every bot in the process, reset at the start of each search. Bots searching at the same time in different games disturb each other's node limit. | **Limit**; the wall-clock budget still bounds every search. |
| 13 | `Mage/.../util/RandomUtil` in the search | Not a read: the search draws from XMage's one process-wide generator (tie-breaks, coin flips and shuffles inside copies), so how far a search gets changes the real game's later shuffles. | **Limit** for reproducibility (AI03): a seeded game repeats exactly only when every search finishes within its budget. The determinizer uses the bot's own seeded generator. |

`ComputerPlayerControllableProxy` hands a choice to the controlling player when another player controls the bot (Mindslaver effects); that is the controller's seat, not an AI read. Since v0.5.1 a human seat's player makes that stand-in itself, keeping the bot's zones and land count on the bot, and the engine asks the controlling seat ([turn control](human-seat.md#turn-control-v051)).

## Determinized search copies

`FairBot.createSimulation` lets XMage build the root copy, then `Determinizer.redeal` changes only the copy:
- **Every other player** (opponents, and other bots at a Commander table): the cards in their hand and library are pooled and dealt again, a hand and a library of the same sizes, in random order.
- **Cards the seat knows** keep what is known about them. A card whose identity the seat may see under the same rules as its view (`Visibility`: revealed to everyone, or looked at by this bot, while XMage keeps them listed), or that is the player's commander, stays in the zone it is in: in that hand, or in the library at a random position. A library whose top card an effect keeps revealed (`Player.isTopCardRevealed`, for example Courser of Kruphix) keeps that card on top.
- **The bot itself** keeps its hand as it is. Its library keeps its contents, which the bot knows from its deck list and the cards it has seen, and is shuffled.
- **Reproducible.** Each pool is put in card-name order before it is shuffled, so a sample depends only on the cards in the pool and the random source, never on the real order. The random source is the bot's own, seeded with `FairBot.seedFor(game seed, seat)`, so bots at one table draw different samples and the same seed deals the same samples. Copies of a bot share its source.
- **One sample per search.** Each search plays out one sample. A new search, with a new sample, starts for every decision that does not continue a planned chain.

Copies made further down the search are copies of this root, so the whole search sees the sample. Zones are written through XMage's own calls (`Card.setZone` for each hand card, so the halves of split and double-faced cards follow; `Library.putOnBottom` for each library card). A player whose hand or library holds a card it does not own is left as it is.

## Limits

- **The pool is the opponent's real remaining cards.** A sample is dealt from the cards actually in an opponent's hand and library, which is their deck list minus their cards in public zones. A human at the table does not know another seat's deck list. A fairer model would deal from a prior: the format's card pool, the deck's colours, or a guessed archetype.
- **Face-down cards keep their identity.** A face-down permanent (morph, manifest, disguise, cloak), a face-down spell, or a face-down exiled card (foretell, hideaway) is the real card in the copy. A simulated opponent may turn its face-down permanent face up or cast its foretold card in the search, and the search then sees what it is. Hiding them would mean rebuilding permanents and the effects that refer to them in the copy, which XMage offers no way to do. None of the fixture decks has a face-down card; a SysOp deck list may.
- **Positions the seat could know are forgotten.** After Time Ebb, Condemn or a scry, a seat may know where a card is in a library; the copy shuffles it anyway. A card that went from a public zone to a hand (bounced, for instance) is dealt like any other unless XMage still lists it as revealed. The bot knows less than its seat may, never more.
- **One sample.** A single sample per search can make a decision follow an unlikely deal. Averaging several samples would cost a search each.
- **Other hidden values.** Values XMage stores in its state for secret choices are copied as they are. None of the fixture decks has such a card.

## Decision budget (AI05)

XMage's own bounds on a search, at the pinned commit (MAD `ComputerPlayer6`):

| Bound | Value |
| --- | --- |
| Depth | `max(4, skill)` actions deep |
| Nodes | 5,000 per search (`MAX_SIMULATED_NODES_PER_CALC`); past 5,100 the search throws, which is caught |
| Think time | 3 seconds × skill per search: 3 s at skill 1, 18 s at skill 6 |
| Cancellation | The search runs on a pool thread; on time-out XMage cancels it with an interrupt, which the search checks at every node |
| Fallback | `ComputerPlayer7.calculateActions` plays the best action the search has recorded, or passes when there is none |

Only priority decisions in the main phases and the declare attackers and blockers steps search; the bot passes in the other steps. What XMage leaves open: after a time-out it reads the search tree while the cancelled search may still be writing it, because cancelling only interrupts the thread. It also swallows the game thread's interrupt while waiting, which the stop path has to repeat.

`FairBot.addActionsTimed` keeps XMage's search, depth, node limit and think time (`FairBot.Budget.forSkill`) and changes how a search ends:
- The search runs on the bots' own pool, shared by every bot in the engine, with threads named with XMage's AI prefix as XMage requires. It had five threads, as XMage's own pool does; since v0.4.1 it has one per processor the engine sees, or `CD_ENGINE_AI_THREADS` (1–256). The engine's start-up line says how many.
- **The budget is thinking time** (since v0.4.1). It starts when a pool thread takes the search, not when the bot asks for one. Before, a search that waited for a thread spent its budget waiting, so with many games at once the bots ran out of time before they began and passed. A search still waiting after `QUEUE_WAIT_MILLIS` (60 seconds) is claimed so it never starts, and the bot passes.
- When the budget runs out, the bot cancels the search and waits up to `STOP_GRACE_MILLIS` (2 seconds) for it to stop. A search that never started is claimed so it cannot start late.
- Once the search has stopped, the bot plays the best action it found, as XMage does. That action was legal in the copy, and XMage checks it again when the bot plays it in the real game.
- If the search does not stop within the grace period, the bot drops its tree and passes. Passing is always legal.
- An interrupt of the game thread (the game is being stopped) cancels the search the same way, makes the bot pass, and stays set so XMage stops the game.
- `FairBot.Stats` counts samples, searches, completions, time-outs, failures, abandoned searches, searches that never found a thread and continued chains, and keeps the longest decision and the longest wait for a thread. Since v0.4.1 the engine logs each bot's counts when its game ends ("Human game … bot …").
- XMage's "AI player thinks too long" warning, which filled the engine log on large Commander boards, no longer appears: running out of budget is an expected end to a search and is only counted. The bot logs a warning for a search that fails or has to be abandoned.

A decision that searches therefore returns within its think time plus 2 seconds, plus the time to copy the game for the root. `CommanderGameTest` checks this for every bot of every table it plays, and that no search was abandoned.

Measured in the engine image build on the development machine, with skill 1 (3 s budget), against the same tests before the change:

| Table (seed) | XMage's bot | Fair bot |
| --- | --- | --- |
| Human and three bots (321) | humans eliminated after 35 turns, 8 s | the same game, 8 s: 457 searches, 27 continued chains, no time-out, longest search 664 ms |
| Two humans and two bots (322) | turn limit after 38 turns, 12 s | humans eliminated after 37 turns, 15 s: 342 searches, no time-out, longest 1,110 ms |
| All of `CommanderGameTest` (17 tests) | 80.6 s | 87.6 s |

The four-human tables, which have no bot, took 1 s longer in the second run too, so part of the difference is the machine. Table 322 played a different game because the fair bots, which see less, chose differently along the way; the search also shares XMage's random generator with the game (audit row 13).

Decisions that do not search (targets, modes, X, mulligans, attackers and blockers, mana payment) run XMage's heuristics on the game thread: their work is bounded by the number of options, not by a clock, and they cannot be cancelled. Choosing blockers copies the game once per attacker and blocker pair, the slowest of them on a large Commander board.

## Tests

- `DeterminizerTest`, on seated but unstarted tables with hands dealt by the test:
  - The copy holds a sample, not the opponent's hand: an opponent holds the only Llanowar Elves in a pool of 59 Forests. Across 40 copies the hand size, library size and pool are always preserved, every card's zone matches where it was dealt, the bot's own hand is unchanged and its library is reordered every time, and the Elves lands in the copied hand in some samples but not most (about 7 in 60). The real game's hands, libraries and zones are unchanged afterwards.
  - Cards the seat has seen stay where they are: the Elves stays in the copied hand in every sample once the bot has looked at it, or once it is revealed; looked at by its owner only, it is dealt like any other card.
  - A top card revealed by an effect stays on top, for the bot's library and the opponent's.
  - The same seed deals the same samples; another seed deals others.
  - Four bots at a Commander table: in one bot's copies, each of the other three bots' hands differs from the real one, pools preserved; the viewer keeps its own hand.
- `FairBotTest`:
  - **Peeking fixture.** A human seat with only Plains, which plays nothing, against a skill-6 bot with an arranged library. On turn 3, with a Forest and an Island, the bot can cast Coral Merfolk (a 2/1) or Coiling Oracle (a 1/1 whose trigger puts the top card onto the battlefield if it is a land, or into the hand). The real top card is Enormous Baloth, the only nonland card among the 52 left in the library. XMage's evaluation prefers the Merfolk unless the Oracle brings a land. XMage's own bot, run as a baseline in the same fixture, casts the Merfolk: it sees the Baloth. The fair bot casts the Oracle, expecting a land from its library's contents. The baseline run shows that the fixture tells the two apart; it is deterministic for the seed, because the fair bot's sample is seeded. The fair bot also continues its planned chain after the land drop, so the seat's fingerprint of the real game matches the one recorded in a determinized search.
  - **Exhausted budget.** A bot with a 1 ms budget plays a Legacy game against the scripted player under every leak and state check. Searches are cut off (in the last run all 32 of them, the longest decision taking 22 ms), the game finishes with no error XMage recovered from, and the longest decision stays within the budget plus the grace period and a second of slack.
- `CommanderGameTest` collects every bot's statistics at each scripted table: no search abandoned, and no decision longer than the budget plus the grace period and a second of slack.
- Every existing engine test now plays against `FairBot`, and all 95 engine tests pass.
