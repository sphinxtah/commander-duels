package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import mage.abilities.keyword.DeathtouchAbility;
import mage.cards.Card;
import mage.cards.repository.CardInfo;
import mage.constants.PhaseStep;
import mage.constants.RangeOfInfluence;
import mage.constants.TurnPhase;
import mage.counters.CounterType;
import mage.game.Game;
import mage.game.PutToBattlefieldInfo;
import mage.game.command.Dungeon;
import mage.game.match.Match;
import mage.game.permanent.Permanent;
import mage.game.permanent.PermanentToken;
import mage.game.turn.TurnMod;
import mage.player.ai.ComputerPlayer6;
import mage.player.ai.ComputerPlayer7;
import mage.players.Player;
import mage.util.RandomUtil;
import mage.util.ThreadUtils;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The v0.5.1 card audit of Two-Headed Giant (patches 0004 to 0006): each rule pattern it fixes, in a
 * scripted game of four human seats (seats 0 and 1 against seats 2 and 3, seat 0 starting) that pass
 * and never block, with the cards put onto the battlefield at the start of turn 1 (XMage's cheat).
 * Turn 1 is team A's, turn 2 team B's, turn 3 team A's again. A Legacy duel with the same cards
 * checks that the patches change nothing outside team games. Needs ./db (the card database).
 */
class TwoHeadedGiantAuditTest {
    private static final List<String> DECKS = GameFormat.TWO_HEADED_GIANT.decks();

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    /** Called on the game thread with each view published to a human seat, after the setup. */
    interface Probe {
        void probe(Game game, List<UUID> seatIds, int seat, SeatView view);
    }

    /**
     * A game whose seats get cards on the battlefield (and in hand) in turn 1's precombat main phase,
     * after its upkeep and draw step, and whose views are recorded at the first view of each turn's
     * precombat main phase.
     */
    static final class Scenario extends SeatChecks {
        final HumanGameRequest gameRequest;
        private final Map<Integer, List<String>> battlefield = new ConcurrentHashMap<>();
        private final Map<Integer, List<String>> hands = new ConcurrentHashMap<>();
        private final List<Probe> setups = new CopyOnWriteArrayList<>();
        private final List<Probe> probes = new CopyOnWriteArrayList<>();
        private final AtomicBoolean ready = new AtomicBoolean();
        /** By "turn:seat": the player's life, library and hand at the first precombat main view of the turn. */
        final Map<String, Integer> life = new ConcurrentHashMap<>();
        final Map<String, Integer> library = new ConcurrentHashMap<>();
        /** By "turn:name": the permanent's type line at the first precombat main view of the turn. */
        final Map<String, String> typeLine = new ConcurrentHashMap<>();
        /** By "turn:name:seat": how many permanents of that name the seat controls at that view. */
        final Map<String, Integer> count = new ConcurrentHashMap<>();
        /** By turn: the active seat the views showed. */
        final Map<Integer, Set<Integer>> activeSeats = new ConcurrentHashMap<>();
        /** Whatever a probe recorded. */
        final Map<String, Object> seen = new ConcurrentHashMap<>();

        Scenario(HumanGameRequest request) throws Exception {
            super(request);
            this.gameRequest = request;
        }

        Scenario battlefield(int seat, String... names) {
            battlefield.computeIfAbsent(seat, key -> new CopyOnWriteArrayList<>()).addAll(List.of(names));
            return this;
        }

        Scenario hand(int seat, String... names) {
            hands.computeIfAbsent(seat, key -> new CopyOnWriteArrayList<>()).addAll(List.of(names));
            return this;
        }

        /** Runs once, after the cards are put onto the battlefield. */
        Scenario setup(Probe setup) {
            setups.add(setup);
            return this;
        }

        Scenario probe(Probe probe) {
            probes.add(probe);
            return this;
        }

        @Override
        public void published(Game game, ObjectRefs refs, int seat, SeatView view, PromptView prompt) {
            super.published(game, refs, seat, view, prompt);
            if (view.turn() < 1 || (view.turn() == 1 && !"precombat_main".equals(view.step()) && !ready.get())) {
                return;
            }
            if (ready.compareAndSet(false, true)) {
                for (int index = 0; index < seatIds.size(); index++) {
                    List<PutToBattlefieldInfo> permanents = new ArrayList<>();
                    battlefield.getOrDefault(index, List.of()).forEach(name -> permanents.add(
                        new PutToBattlefieldInfo(card(name), false)));
                    List<Card> inHand = new ArrayList<>();
                    hands.getOrDefault(index, List.of()).forEach(name -> inHand.add(card(name)));
                    game.cheat(seatIds.get(index), new ArrayList<>(), inHand, permanents, new ArrayList<>(),
                        new ArrayList<>(), new ArrayList<>());
                }
                setups.forEach(setup -> setup.probe(game, seatIds, seat, view));
            }
            if (view.activeSeat() != null) {
                activeSeats.computeIfAbsent(view.turn(), key -> ConcurrentHashMap.newKeySet()).add(view.activeSeat());
            }
            if ("precombat_main".equals(view.step())) {
                List<SeatView.PlayerState> players = new ArrayList<>(view.opponents());
                players.add(view.you());
                for (SeatView.PlayerState player : players) {
                    life.putIfAbsent(view.turn() + ":" + player.seat(), player.life());
                    library.putIfAbsent(view.turn() + ":" + player.seat(), player.libraryCount());
                }
                if (!seen.containsKey("counted:" + view.turn())) {
                    seen.put("counted:" + view.turn(), true);
                    Map<String, Integer> counts = new ConcurrentHashMap<>();
                    for (SeatView.PermanentInfo permanent : view.battlefield()) {
                        typeLine.putIfAbsent(view.turn() + ":" + permanent.card().name(), permanent.card().typeLine());
                        counts.merge(view.turn() + ":" + permanent.card().name() + ":" + permanent.controllerSeat(),
                            1, Integer::sum);
                    }
                    count.putAll(counts);
                }
            }
            probes.forEach(probe -> probe.probe(game, seatIds, seat, view));
        }
    }

    static Card card(String name) {
        CardInfo info = DeckLists.find(name);
        assertNotNull(info, name);
        return info.createCard();
    }

    /**
     * Passes priority, keeps every hand, declares no attackers (or, with {@code attack}, team A
     * attacks with everything) and no blockers, and otherwise takes the first option.
     */
    static Tables.Policy passing(boolean attack) {
        return (seat, prompt, view) -> {
            List<PromptView.Option> options = prompt.options();
            switch (prompt.kind()) {
                case "priority":
                    return ScriptedPlayer.byAction(options, "pass").get(0).id();
                case "mulligan":
                    return ScriptedPlayer.byAction(options, "keep").get(0).id();
                case "declare_attackers": {
                    var all = ScriptedPlayer.byAction(options, "all_attack");
                    boolean fresh = options.stream()
                        .anyMatch(option -> option.action().equals("toggle_attacker") && !option.selected());
                    if (attack && seat < 2 && fresh && !all.isEmpty()) {
                        return all.get(0).id();
                    }
                    return ScriptedPlayer.byAction(options, "done").get(0).id();
                }
                case "declare_blockers":
                    return ScriptedPlayer.byAction(options, "done").get(0).id();
                case "choose_defender":
                    return options.stream().filter(option -> Integer.valueOf(2).equals(option.seat())).findFirst()
                        .orElse(options.get(0)).id();
                case "assign_amounts":
                    return ScriptedPlayer.byAction(options, "suggested").get(0).id();
                default: {
                    // Choosing cards or targets (a discard to hand size, a sacrifice): the first that is
                    // not chosen yet, then done
                    var done = ScriptedPlayer.byAction(options, "done");
                    var fresh = options.stream()
                        .filter(option -> option.action().equals("choose") && !option.selected()).toList();
                    if ((options.stream().anyMatch(PromptView.Option::selected) || fresh.isEmpty()) && !done.isEmpty()) {
                        return done.get(0).id();
                    }
                    if (!fresh.isEmpty()) {
                        return fresh.get(0).id();
                    }
                    return options.stream().filter(option -> !option.action().equals("cancel")).findFirst()
                        .orElse(options.get(0)).id();
                }
            }
        };
    }

    /**
     * {@link #passing}, with the attack in the given turn only (XMage's cheat puts creatures onto the
     * battlefield able to attack in turn 1 already).
     */
    static Tables.Policy attackingIn(int turn) {
        Tables.Policy attack = passing(true);
        Tables.Policy pass = passing(false);
        return (seat, prompt, view) -> (view.turn() == turn ? attack : pass).choose(seat, prompt, view);
    }

    private static HumanGameRequest fourHumans(long seed, int turnCap) {
        List<HumanGameRequest.Seat> seats = new ArrayList<>();
        for (String deck : DECKS) {
            seats.add(Tables.human(deck));
        }
        return new HumanGameRequest(seed, GameFormat.TWO_HEADED_GIANT, seats, 1, turnCap, 900, 0, 0);
    }

    record Run(HumanGame game, Tables.Played played) {
        HumanGame.Result result() {
            return played.last().result();
        }

        /** Seat 0's whole log, page by page. */
        List<String> log() throws InterruptedException {
            List<String> lines = new ArrayList<>();
            while (true) {
                HumanGame.Snapshot page = game.snapshot(0, -1, 0, lines.size());
                page.log().forEach(line -> lines.add(line.text()));
                if (page.log().size() < HumanGame.MAX_LOG_PAGE) {
                    return lines;
                }
            }
        }
    }

    private static Run play(Scenario scenario, Tables.Policy policy) throws Exception {
        HumanGame game = Tables.start(scenario.gameRequest, scenario);
        Tables.Played played = Tables.play(game, policy, 4, new Tables.Coverage());
        scenario.settle();
        assertTrue(scenario.failures.isEmpty(), "leaks or wrong views: " + scenario.failures);
        return new Run(game, played);
    }

    private static int at(Map<String, Integer> values, int turn, int seat) {
        Integer value = values.get(turn + ":" + seat);
        assertNotNull(value, "no view of seat " + seat + " in turn " + turn + "'s main phase: " + values);
        return value;
    }

    @Test
    void eachPlayersStepTriggersForEachPlayerOfTheActiveTeam() throws Exception {
        // 805.4d: "each player's upkeep ... that player" triggers for both players of the active team
        // (Sulfuric Vortex, and Howling Mine's own trigger class); an ability that does not refer to
        // that player triggers once (The Theorist: "each opponent's draw step, you draw a card"); and
        // an effect that reads "the active player" acts for the player whose step it is (805.9: Citadel
        // of Pain counts each player's untapped lands).
        var scenario = new Scenario(fourHumans(5101L, 4))
            .battlefield(0, "Sulfuric Vortex", "Howling Mine", "The Theorist, Jace Beleren", "Citadel of Pain")
            .battlefield(2, "Plains", "Plains")
            .battlefield(3, "Island", "Island", "Island");
        play(scenario, passing(false));
        System.out.println("Life by turn and seat: " + new java.util.TreeMap<>(scenario.life));
        System.out.println("Libraries by turn and seat: " + new java.util.TreeMap<>(scenario.library));

        // Team B's upkeep: two damage to each of its players, 4 from the team's 30.
        assertEquals(26, at(scenario.life, 2, 2));
        assertEquals(26, at(scenario.life, 2, 3));
        assertEquals(30, at(scenario.life, 2, 0));
        // Team B's draw step: each of its players draws once more (53, then a draw and Howling Mine's).
        assertEquals(51, at(scenario.library, 2, 2));
        assertEquals(51, at(scenario.library, 2, 3));
        // Team B's end step: Citadel of Pain deals 2 to seat 2 and 3 to seat 3 for their untapped lands.
        assertEquals(21, at(scenario.life, 3, 2));
        // Team A's upkeep in turn 3: two damage to each of its players.
        assertEquals(26, at(scenario.life, 3, 0));
        assertEquals(26, at(scenario.life, 3, 1));
        // The Theorist draws seat 0 one card in team B's draw step, not one for each of its players.
        assertEquals(52, at(scenario.library, 2, 0));
    }

    @Test
    void aTeammatesOwnStepsAndTheMonarchsEndStep() throws Exception {
        // "At the beginning of your upkeep" of the player who does not hold the team's turn triggers
        // once (Phyrexian Arena on seat 1), and the monarch's end step is the monarch's even when their
        // teammate holds the turn (seat 3): the trigger reads the step of each player of the team.
        var scenario = new Scenario(fourHumans(5102L, 4))
            .battlefield(1, "Phyrexian Arena")
            .setup((game, ids, seat, view) -> game.setMonarchId(null, ids.get(3)));
        play(scenario, passing(false));

        // Seat 3 drew in team B's draw step and again as the monarch at its end step.
        assertEquals(51, at(scenario.library, 3, 3));
        assertEquals(52, at(scenario.library, 3, 2));
        // Seat 1 drew in team A's draw step and once for Phyrexian Arena, losing the team one life.
        assertEquals(51, at(scenario.library, 3, 1));
        assertEquals(52, at(scenario.library, 3, 0));
        assertEquals(29, at(scenario.life, 3, 0));
    }

    @Test
    void notYourTurnIsNotYourTeamsTurn() throws Exception {
        // NotMyTurnCondition (805.9): Warden of the Wall, on seat 1, is a creature only while it is not
        // its controller's team's turn: in team B's turn 2, not in team A's turn 3 that seat 0 holds.
        var scenario = new Scenario(fourHumans(5103L, 4)).battlefield(1, "Warden of the Wall");
        play(scenario, passing(false));

        assertTrue(scenario.typeLine.get("2:Warden of the Wall").contains("Creature"),
            "a creature in the other team's turn: " + scenario.typeLine);
        assertFalse(scenario.typeLine.get("3:Warden of the Wall").contains("Creature"),
            "not a creature in its team's turn: " + scenario.typeLine);
    }

    @Test
    void skipsAndExtraPhasesAreTheTeams() throws Exception {
        // 805.8: a step, phase or turn a player skips, or an extra phase they get, is their team's.
        // Necropotence on seat 1 makes team A skip its draw step; seat 3 skipping its next turn makes
        // team B skip turn 2; an extra combat phase given to seat 1 is team A's.
        var scenario = new Scenario(fourHumans(5104L, 3))
            .battlefield(1, "Necropotence")
            .setup((game, ids, seat, view) -> {
                game.getState().getTurnMods().add(new TurnMod(ids.get(3)).withSkipTurn());
                game.getState().getTurnMods().add(new TurnMod(ids.get(1)).withExtraPhase(TurnPhase.COMBAT));
            });
        List<String> log = play(scenario, passing(false)).log();
        System.out.println("Active seats by turn: " + scenario.activeSeats);

        // Team B skipped its turn: team A played turns 1 and 2, then team B turn 3.
        assertEquals(Set.of(0), scenario.activeSeats.get(2), "team A played turn 2: " + scenario.activeSeats);
        assertEquals(Set.of(2), scenario.activeSeats.get(3), "team B played turn 3: " + scenario.activeSeats);
        // Team A skipped its draw steps: neither seat 0 nor seat 1 drew in turn 2.
        assertEquals(53, at(scenario.library, 2, 0));
        assertEquals(53, at(scenario.library, 2, 1));
        // Team B drew in turn 3.
        assertEquals(52, at(scenario.library, 3, 2));
        assertTrue(log.stream().anyMatch(line -> line.contains("skips their turn")), "a skipped turn in the log");
        assertTrue(log.stream().anyMatch(line -> line.contains("starts an additional")),
            "team A's extra combat phase in the log");
    }

    /** XMage's computer player, which XMage lets control another player's turn (it refuses bots). */
    static final class ControllingBot extends ComputerPlayer7 {
        private static final long serialVersionUID = 1L;

        ControllingBot(String name) {
            super(name, RangeOfInfluence.ALL, 1);
        }

        private ControllingBot(ControllingBot player) {
            super(player);
        }

        @Override
        public boolean isComputer() {
            return false;
        }

        @Override
        public ControllingBot copy() {
            return new ControllingBot(this);
        }
    }

    @Test
    void controllingAPlayerControlsTheirTeam() throws Exception {
        // 805.8: seat 0 controlling seat 3's next turn controls team B's turn 2: both seat 2, who holds
        // it, and seat 3; then the control ends. Played by XMage's own bots on the game thread: the
        // engine does not hand a controlled player's decisions to the controlling seat (in any format;
        // see docs/engine/two-headed-giant.md), so human seats are not used here.
        Map<String, Integer> controller = controlled(5105L,
            ids -> List.of(new TurnMod(ids.get(3)).withNewController(ids.get(0))));
        assertEquals(0, controller.get("2:2"), "seat 0 controlled seat 2 in turn 2: " + controller);
        assertEquals(0, controller.get("2:3"), "seat 0 controlled seat 3 in turn 2: " + controller);
        assertEquals(2, controller.get("3:2"), "control ended with turn 2: " + controller);
        assertEquals(3, controller.get("3:3"), "control ended with turn 2: " + controller);
    }

    @Test
    void theNewerControlOfATeamWins() throws Exception {
        // 805.8, 723.1a: seat 0 comes to control seat 2's next turn, then seat 1 seat 3's. Both effects
        // control team B's turn 2, and the newer one works: seat 1 controls seat 2 and seat 3. (The
        // first version of patch 0004 used each player's modifications before reading the next one's
        // position, so the older effect won.)
        Map<String, Integer> controller = controlled(5122L, ids -> List.of(
            new TurnMod(ids.get(2)).withNewController(ids.get(0)),
            new TurnMod(ids.get(3)).withNewController(ids.get(1))));
        assertEquals(1, controller.get("2:2"), "seat 1 controlled seat 2 in turn 2: " + controller);
        assertEquals(1, controller.get("2:3"), "seat 1 controlled seat 3 in turn 2: " + controller);
        assertEquals(2, controller.get("3:2"), "control ended with turn 2: " + controller);
    }

    /**
     * Plays a game of XMage's bots, seats 0 and 1 able to control a turn, with the given turn
     * modifications added before it starts. By "turn:seat" for team B's seats: the seat whose player
     * controlled that seat in that turn's first main phase.
     */
    private static Map<String, Integer> controlled(long seed, java.util.function.Function<List<UUID>, List<TurnMod>> mods)
            throws Exception {
        var outcome = new AtomicReference<Map<String, Integer>>();
        var failure = new AtomicReference<Throwable>();
        Thread thread = new Thread(() -> {
            try {
                outcome.set(playControlled(seed, mods));
            } catch (Throwable t) {
                failure.set(t);
            }
        }, ThreadUtils.THREAD_PREFIX_GAME + " two_headed_giant_control");
        thread.setDaemon(true);
        thread.start();
        assertTrue(BotMatchRunner.join(thread, TimeUnit.MINUTES.toMillis(3)), "the game finished");
        if (failure.get() != null) {
            throw new AssertionError("the game failed", failure.get());
        }
        return outcome.get();
    }

    private static Map<String, Integer> playControlled(long seed, java.util.function.Function<List<UUID>, List<TurnMod>> mods)
            throws Exception {
        RandomUtil.setSeed(seed);
        GameFormat format = GameFormat.TWO_HEADED_GIANT;
        Game game = format.newGame(TwoHeadedGiant.PLAYERS, 3);
        Match match = format.newMatch("Two-Headed Giant control", TwoHeadedGiant.PLAYERS);
        List<Player> players = new ArrayList<>();
        players.add(new ControllingBot("Bot 1"));
        players.add(new ControllingBot("Bot 2"));
        for (int seat = 2; seat < TwoHeadedGiant.PLAYERS; seat++) {
            players.add(new ComputerPlayer7("Bot " + (seat + 1), RangeOfInfluence.ALL, 1));
        }
        for (int index : HumanGame.additionOrder(players.size())) {
            LegacyDuel.seat(game, match, players.get(index), format.loadDeck(SeatChecks.DECKS, DECKS.get(index)));
        }
        List<UUID> ids = players.stream().map(Player::getId).toList();
        format.seatTeams(game, ids);
        Map<String, Integer> controller = new ConcurrentHashMap<>();
        game.addTableEventListener(event -> {
            if (game.getTurnStepType() != PhaseStep.PRECOMBAT_MAIN) {
                return; // control changes as a turn begins
            }
            for (int index = 2; index < 4; index++) {
                controller.put(game.getTurnNum() + ":" + index,
                    ids.indexOf(game.getPlayer(ids.get(index)).getTurnControlledBy()));
            }
        });
        mods.apply(ids).forEach(game.getState().getTurnMods()::add);
        game.start(ids.get(0));
        return controller;
    }

    @Test
    void cantLoseIsTheTeams() throws Exception {
        // 810.8a: with Platinum Angel on seat 1, neither player of team A can lose; with Phyrexian
        // Unlife on seat 3, team B doesn't lose for having 0 or less life. Both teams are put at 0 life
        // in turn 1 and are still in the game when the turns run out.
        var scenario = new Scenario(fourHumans(5106L, 3))
            .battlefield(1, "Platinum Angel")
            .battlefield(3, "Phyrexian Unlife")
            .setup((game, ids, seat, view) -> {
                game.getPlayer(ids.get(0)).loseLife(30, game, null, false);
                game.getPlayer(ids.get(2)).loseLife(30, game, null, false);
            });
        HumanGame.Result result = play(scenario, passing(false)).result();
        assertEquals("turn_limit", result.kind(), "no team lost: " + result);
        assertEquals(0, at(scenario.life, 2, 0));
        assertEquals(0, at(scenario.life, 2, 3));
    }

    @Test
    void poisonChecksAndChangesAreTheTeams() throws Exception {
        // 810.10a: Bonepicker Skirge has deathtouch while an opponent has three poison counters, which
        // team B has (two and one). 810.10c: with Melira, Sylvok Outcast on seat 2, seat 3 can't get
        // poison counters. 810.10b: seat 3 losing three poison counters takes the team's to none.
        Map<String, Object> seen = new ConcurrentHashMap<>();
        var scenario = new Scenario(fourHumans(5107L, 3))
            .battlefield(0, "Bonepicker Skirge")
            .setup((game, ids, seat, view) -> {
                game.getPlayer(ids.get(2)).addCounters(CounterType.POISON.createInstance(2), ids.get(0), null, game);
                game.getPlayer(ids.get(3)).addCounters(CounterType.POISON.createInstance(1), ids.get(0), null, game);
            })
            .probe((game, ids, seat, view) -> {
                if (view.turn() != 2 || !"precombat_main".equals(view.step()) || seen.containsKey("done")) {
                    return;
                }
                seen.put("done", true);
                Permanent skirge = game.getBattlefield().getAllActivePermanents().stream()
                    .filter(permanent -> permanent.getName().equals("Bonepicker Skirge")).findFirst().orElseThrow();
                seen.put("deathtouch", skirge.getAbilities(game).containsKey(DeathtouchAbility.getInstance().getId()));
                seen.put("team poison", game.getPoisonCounters(ids.get(3)));
                // Melira, Sylvok Outcast ("You can't get poison counters") joins seat 2 only now, after
                // the counters above
                game.cheat(ids.get(2), new ArrayList<>(), new ArrayList<>(),
                    List.of(new PutToBattlefieldInfo(card("Melira, Sylvok Outcast"), false)), new ArrayList<>(),
                    new ArrayList<>(), new ArrayList<>());
                Player seat3 = game.getPlayer(ids.get(3));
                seat3.addCounters(CounterType.POISON.createInstance(2), ids.get(0), null, game);
                seen.put("after Melira", game.getPoisonCounters(ids.get(3)));
                seat3.loseCounters(CounterType.POISON.getName(), 3, null, game);
                seen.put("after losing three", game.getPoisonCounters(ids.get(2)));
            });
        play(scenario, passing(false));

        assertEquals(true, seen.get("deathtouch"), "corrupted by the team's counters: " + seen);
        assertEquals(3, seen.get("team poison"));
        assertEquals(3, seen.get("after Melira"), "Melira kept seat 3 from getting counters");
        assertEquals(0, seen.get("after losing three"), "the team lost three");
    }

    @Test
    void assistCountsTheTeammatesMana() throws Exception {
        // Assist: seat 0 holds Huddle Up ({2}{U}) with one Island; seat 1 has two untapped Islands and
        // the other team none. The spell is castable only because the teammate can help pay.
        var scenario = new Scenario(fourHumans(5108L, 3))
            .battlefield(0, "Island")
            .battlefield(1, "Island", "Island")
            .hand(0, "Huddle Up");
        Set<Integer> castable = ConcurrentHashMap.newKeySet();
        Tables.Policy policy = passing(false);
        play(scenario, (seat, prompt, view) -> {
            if (seat == 0 && prompt.kind().equals("priority") && "precombat_main".equals(view.step())
                && ScriptedPlayer.byAction(prompt.options(), "cast").stream()
                .anyMatch(option -> "Huddle Up".equals(option.label()))) {
                castable.add(view.turn());
            }
            return policy.choose(seat, prompt, view);
        });
        assertTrue(castable.contains(3), "Huddle Up was castable in team A's turn 3: " + castable);
    }

    @Test
    void youAttackWithTheCreaturesYouControl() throws Exception {
        // 805.10a: each player of the active team is an attacking player, and "you attack with" counts
        // the creatures you control. Seat 1 attacks with three creatures and Overwhelming Instinct draws
        // it a card; seat 0 attacks with two and its own Overwhelming Instinct does not.
        var scenario = new Scenario(fourHumans(5109L, 4))
            .battlefield(0, "Overwhelming Instinct", "Grizzly Bears", "Grizzly Bears")
            .battlefield(1, "Overwhelming Instinct", "Llanowar Elves", "Llanowar Elves", "Llanowar Elves");
        // By seat: the library at the first view of team A's turn 3 postcombat main phase, after its attack.
        Map<Integer, Integer> afterAttack = new ConcurrentHashMap<>();
        scenario.probe((game, ids, seat, view) -> {
            if (view.turn() == 3 && "postcombat_main".equals(view.step())) {
                List<SeatView.PlayerState> players = new ArrayList<>(view.opponents());
                players.add(view.you());
                players.forEach(player -> afterAttack.putIfAbsent(player.seat(), player.libraryCount()));
            }
        });
        play(scenario, passing(true));
        System.out.println("Libraries by turn and seat: " + new java.util.TreeMap<>(scenario.library)
            + "; after team A's attack in turn 3: " + afterAttack);

        assertEquals(at(scenario.library, 3, 0), afterAttack.get(0), "seat 0 attacked with two creatures: no card");
        assertEquals(at(scenario.library, 3, 1) - 1, afterAttack.get(1), "seat 1 attacked with three creatures: a card");
    }

    // The review of the audit (v0.5.1): one test for each finding it confirmed

    /** By seat: the library at the first view of team A's turn 3 postcombat main phase, after its attack. */
    private static Map<Integer, Integer> afterTurn3Attack(Scenario scenario) {
        Map<Integer, Integer> afterAttack = new ConcurrentHashMap<>();
        scenario.probe((game, ids, seat, view) -> {
            if (view.turn() == 3 && "postcombat_main".equals(view.step())) {
                List<SeatView.PlayerState> players = new ArrayList<>(view.opponents());
                players.add(view.you());
                players.forEach(player -> afterAttack.putIfAbsent(player.seat(), player.libraryCount()));
            }
        });
        return afterAttack;
    }

    /**
     * Records, by "turn:seat", the largest value the function gives for each seat in the views of each
     * turn's precombat main phase.
     */
    private static Map<String, Integer> mostInMainPhase(Scenario scenario, java.util.function.BiFunction<Game, UUID, Integer> value) {
        Map<String, Integer> most = new ConcurrentHashMap<>();
        scenario.probe((game, ids, seat, view) -> {
            if ("precombat_main".equals(view.step())) {
                for (int index = 0; index < ids.size(); index++) {
                    most.merge(view.turn() + ":" + index, value.apply(game, ids.get(index)), Math::max);
                }
            }
        });
        return most;
    }

    @Test
    void aStepTriggerThatDoesNotReferToThatPlayerTriggersOnce() throws Exception {
        // 805.4d: "they", "them" and "their" alone do not make a step trigger refer to the player whose
        // step it is. Smuggler's Share ("each end step" in its Oracle text, built for each player's)
        // triggers once at team B's end step and draws seat 0 a card for each opponent who drew two
        // cards (Howling Mine); Roiling Vortex, whose "them" is that player, says so by hand and deals
        // 1 damage to each player of the active team.
        var scenario = new Scenario(fourHumans(5111L, 4))
            .battlefield(0, "Smuggler's Share", "Howling Mine", "Roiling Vortex");
        play(scenario, passing(false));
        System.out.println("Life by turn and seat: " + new java.util.TreeMap<>(scenario.life));
        System.out.println("Libraries by turn and seat: " + new java.util.TreeMap<>(scenario.library));

        assertEquals(28, at(scenario.life, 2, 2), "team B's upkeep: one damage to each of its players");
        assertEquals(28, at(scenario.life, 3, 0), "team A's upkeep: one damage to each of its players");
        // Seat 0: 53 cards, two drawn once at team B's end step, then two in its own draw step.
        assertEquals(49, at(scenario.library, 3, 0));
        assertEquals(51, at(scenario.library, 3, 1));
    }

    @Test
    void eachPlayerOfTheActiveTeamAdvancesTheirSagas() throws Exception {
        // 714.3c, 805.4: as the precombat main phase of each player of the active team begins, they put a
        // lore counter on each of their Sagas. History of Benalia on seat 1 advances in team A's turn 3,
        // which seat 0 holds, like seat 0's; neither does in team B's turn 2.
        var scenario = new Scenario(fourHumans(5112L, 4))
            .battlefield(0, "History of Benalia")
            .battlefield(1, "History of Benalia");
        Map<String, Integer> lore = mostInMainPhase(scenario, (game, playerId) -> game.getBattlefield()
            .getAllActivePermanents(playerId).stream()
            .filter(permanent -> permanent.getName().equals("History of Benalia"))
            .mapToInt(permanent -> permanent.getCounters(game).getCount(CounterType.LORE)).max().orElse(-1));
        play(scenario, passing(false));
        System.out.println("Lore counters by turn and seat: " + new java.util.TreeMap<>(lore));

        assertEquals(lore.get("1:0"), lore.get("2:0"), "seat 0's Saga waits in team B's turn: " + lore);
        assertEquals(lore.get("1:1"), lore.get("2:1"), "seat 1's Saga waits in team B's turn: " + lore);
        assertEquals(lore.get("2:0") + 1, lore.get("3:0"), "seat 0's Saga advances in turn 3: " + lore);
        assertEquals(lore.get("2:1") + 1, lore.get("3:1"), "seat 1's Saga advances in turn 3: " + lore);
    }

    @Test
    void eladamrisVineyardGivesEachPlayerOfTheActiveTeamTwoGreen() throws Exception {
        // 805.4d: "at the beginning of each player's precombat main phase, that player adds {G}{G}"
        // triggers for each player of the active team (XMage's text leaves "that player" out, so the
        // card says so by hand).
        var scenario = new Scenario(fourHumans(5113L, 4)).battlefield(0, "Eladamri's Vineyard");
        Map<String, Integer> green = mostInMainPhase(scenario,
            (game, playerId) -> game.getPlayer(playerId).getManaPool().getGreen());
        play(scenario, passing(false));
        System.out.println("Green mana by turn and seat: " + new java.util.TreeMap<>(green));

        assertEquals(2, green.get("2:2"), "seat 2 added {G}{G} in team B's turn: " + green);
        assertEquals(2, green.get("2:3"), "seat 3 added {G}{G} in team B's turn: " + green);
        assertEquals(0, green.get("2:0"), "not team A's turn: " + green);
        assertEquals(2, green.get("3:0"), "seat 0 added {G}{G} in team A's turn: " + green);
        assertEquals(2, green.get("3:1"), "seat 1 added {G}{G} in team A's turn: " + green);
    }

    @Test
    void theTeammateWithTheInitiativeVenturesInTheTeamsUpkeep() throws Exception {
        // The initiative's "at the beginning of your upkeep, venture into Undercity" is the upkeep of the
        // player who has it (805.4d). Seat 1 takes it in turn 1 and ventures; in team A's upkeep in turn
        // 3, which seat 0 holds, seat 1 ventures again and seat 0 does not; team B never does.
        var scenario = new Scenario(fourHumans(5114L, 4))
            .setup((game, ids, seat, view) -> game.takeInitiative(null, ids.get(1)));
        Map<String, String> rooms = new ConcurrentHashMap<>();
        scenario.probe((game, ids, seat, view) -> {
            if ("precombat_main".equals(view.step())) {
                for (int index = 0; index < ids.size(); index++) {
                    Dungeon dungeon = game.getPlayerDungeon(ids.get(index));
                    rooms.put(view.turn() + ":" + index,
                        dungeon == null || dungeon.getCurrentRoom() == null ? "none" : dungeon.getCurrentRoom().getName());
                }
            }
        });
        play(scenario, passing(false));
        System.out.println("Undercity rooms by turn and seat: " + new java.util.TreeMap<>(rooms));

        assertFalse("none".equals(rooms.get("2:1")), "seat 1 ventured as it took the initiative: " + rooms);
        assertFalse(rooms.get("2:1").equals(rooms.get("3:1")), "seat 1 ventured in team A's upkeep: " + rooms);
        assertEquals("none", rooms.get("3:0"), "seat 0 never ventured: " + rooms);
        assertEquals("none", rooms.get("3:2"), "team B never ventured: " + rooms);
        assertEquals("none", rooms.get("3:3"), "team B never ventured: " + rooms);
    }

    @Test
    void noExchangeOfLifeTotalsWhenATeammateCantLoseLife() throws Exception {
        // 810.9g, 810.9h: with Platinum Emperion ("your life total can't change") on seat 1, no player of
        // team A can lose life, so team B at 5 exchanges life totals with team A at 30 neither when seat
        // 2 starts it nor when seat 0 does.
        Map<String, Object> seen = new ConcurrentHashMap<>();
        var scenario = new Scenario(fourHumans(5115L, 3))
            .battlefield(1, "Platinum Emperion")
            .setup((game, ids, seat, view) -> {
                game.processAction();
                seen.put("seat 1 can lose life", game.getPlayer(ids.get(1)).isCanLoseLife());
                Player seat0 = game.getPlayer(ids.get(0));
                Player seat2 = game.getPlayer(ids.get(2));
                seat2.loseLife(25, game, null, false);
                seat2.exchangeLife(seat0, null, game);
                seen.put("after seat 2's exchange", List.of(seat0.getLife(), seat2.getLife()));
                seat0.exchangeLife(seat2, null, game);
                seen.put("after seat 0's exchange", List.of(seat0.getLife(), seat2.getLife()));
            });
        play(scenario, passing(false));

        assertEquals(false, seen.get("seat 1 can lose life"), "Platinum Emperion applies: " + seen);
        assertEquals(List.of(30, 5), seen.get("after seat 2's exchange"));
        assertEquals(List.of(30, 5), seen.get("after seat 0's exchange"));
        assertEquals(30, at(scenario.life, 2, 1));
        assertEquals(5, at(scenario.life, 2, 3));
    }

    @Test
    void eachPlayerWhoAttacksIsTheAttackingPlayer() throws Exception {
        // 805.10a, 805.10c: Norn's Decree on seat 2 ("whenever a player attacks, if one or more players
        // being attacked are poisoned, the attacking player draws a card"), team B poisoned. When seat 1
        // attacks alone in team A's turn 3, seat 1 draws and seat 0, who holds the turn, does not; when
        // both attack, each draws one card.
        assertEquals(List.of(0, 1), nornsDecreeDraws(5116L, false), "seat 1 attacked alone");
        assertEquals(List.of(1, 1), nornsDecreeDraws(5117L, true), "both attacked");
    }

    @Test
    void mirkwoodTrapperReadsEachAttackingPlayersOwnAttack() throws Exception {
        // 805.10c: Mirkwood Trapper on seat 2 ("whenever a player attacks, if they aren't attacking you,
        // that player chooses an attacking creature; it gets +2/+0"). In team A's turn 3 seat 0 attacks
        // seat 2 and seat 1 attacks seat 3: the ability triggers for seat 1 only, and seat 1 chooses.
        var scenario = new Scenario(fourHumans(5121L, 4))
            .battlefield(0, "Grizzly Bears")
            .battlefield(1, "Llanowar Elves")
            .battlefield(2, "Mirkwood Trapper");
        Tables.Policy policy = attackingIn(3);
        List<String> log = play(scenario, (seat, prompt, view) -> {
            if (prompt.kind().equals("choose_defender") && seat < 2) {
                Integer defender = seat == 0 ? 2 : 3;
                return prompt.options().stream().filter(option -> defender.equals(option.seat())).findFirst()
                    .orElse(prompt.options().get(0)).id();
            }
            return policy.choose(seat, prompt, view);
        }).log();
        List<String> chose = log.stream().filter(line -> line.matches("Human \\d chose .*")).toList();
        System.out.println("Mirkwood Trapper's choices: " + chose);

        assertEquals(1, chose.size(), "one attacking player was not attacking seat 2: " + chose);
        assertTrue(chose.get(0).startsWith("Human 2 chose"), "seat 1 chose: " + chose);
    }

    /** The cards seats 0 and 1 drew in team A's turn 3 attack, with Norn's Decree on seat 2. */
    private static List<Integer> nornsDecreeDraws(long seed, boolean bothAttack) throws Exception {
        var scenario = new Scenario(fourHumans(seed, 4))
            .battlefield(1, "Grizzly Bears")
            .battlefield(2, "Norn's Decree")
            .setup((game, ids, seat, view) -> game.getPlayer(ids.get(3))
                .addCounters(CounterType.POISON.createInstance(1), ids.get(0), null, game));
        if (bothAttack) {
            scenario.battlefield(0, "Grizzly Bears");
        }
        Map<Integer, Integer> afterAttack = afterTurn3Attack(scenario);
        play(scenario, attackingIn(3));
        System.out.println("Libraries by turn and seat: " + new java.util.TreeMap<>(scenario.library)
            + "; after team A's attack in turn 3: " + afterAttack);
        return List.of(at(scenario.library, 3, 0) - afterAttack.get(0), at(scenario.library, 3, 1) - afterAttack.get(1));
    }

    @Test
    void aTeammatesTokensPutOntoTheBattlefieldAttackingAreAimedByTheirController() throws Exception {
        // 508.4: Hero of Bladehold on seat 1 attacks in team A's turn 3 and makes two Soldiers tapped and
        // attacking. Seat 1, their controller, chooses which player of team B each attacks, not seat 0,
        // who holds the turn and controls nothing.
        var scenario = new Scenario(fourHumans(5118L, 4)).battlefield(1, "Hero of Bladehold");
        Map<String, Integer> tokens = new ConcurrentHashMap<>();
        scenario.probe((game, ids, seat, view) -> {
            if (view.turn() != 3) {
                return;
            }
            for (UUID attackerId : game.getCombat().getAttackers()) {
                Permanent attacker = game.getPermanent(attackerId);
                if (attacker instanceof PermanentToken && attacker.isControlledBy(ids.get(1))) {
                    tokens.put(attackerId.toString(), ids.indexOf(game.getCombat().getDefenderId(attackerId)));
                }
            }
        });
        Map<Integer, Integer> defenderPrompts = new ConcurrentHashMap<>();
        Tables.Policy policy = attackingIn(3);
        play(scenario, (seat, prompt, view) -> {
            if (prompt.kind().equals("choose_defender")) {
                defenderPrompts.merge(seat, 1, Integer::sum);
            }
            return policy.choose(seat, prompt, view);
        });
        System.out.println("Defender choices by seat: " + defenderPrompts + "; the tokens' defenders: " + tokens);

        assertEquals(2, tokens.size(), "two Soldiers attacked: " + tokens);
        assertTrue(tokens.values().stream().allMatch(defender -> defender == 2 || defender == 3),
            "each attacked a player of team B: " + tokens);
        assertEquals(null, defenderPrompts.get(0), "seat 0 chose nothing: " + defenderPrompts);
        // Seat 1 chose once for the creatures it attacked with, then once for each token
        assertTrue(defenderPrompts.getOrDefault(1, 0) >= 3, "seat 1 chose for its tokens: " + defenderPrompts);
    }

    @Test
    void aBotsLethalCheckCountsItsTeammatesAttacksOnTheDefendingTeamOnly() throws Exception {
        // The computer player's lethal-attack check (patch 0005) counts the creatures its teammate
        // attacks a player of the defending team with: those attacking a planeswalker or a battle deal
        // the team no damage. Seat 0 attacks seat 2's Ajani Goldmane with two Grizzly Bears and seat 2
        // with Llanowar Elves; the bot on seat 1 counts the Elves only.
        List<HumanGameRequest.Seat> seats = new ArrayList<>();
        for (int seat = 0; seat < DECKS.size(); seat++) {
            seats.add(seat == 1 ? Tables.bot(DECKS.get(seat)) : Tables.human(DECKS.get(seat)));
        }
        var scenario = new Scenario(new HumanGameRequest(5119L, GameFormat.TWO_HEADED_GIANT, seats, 1, 4, 900, 0, 0))
            .battlefield(0, "Grizzly Bears", "Grizzly Bears", "Llanowar Elves")
            .battlefield(2, "Ajani Goldmane");
        Map<String, Object> seen = new ConcurrentHashMap<>();
        scenario.probe((game, ids, seat, view) -> {
            long seat0Attackers = game.getCombat().getAttackers().stream().map(game::getPermanent)
                .filter(attacker -> attacker != null && attacker.isControlledBy(ids.get(0))).count();
            if (view.turn() != 3 || seat0Attackers < 3 || seen.containsKey("counted")) {
                return;
            }
            try {
                Method teamAttackers = ComputerPlayer6.class.getDeclaredMethod("teamAttackers", List.class,
                    UUID.class, Game.class);
                teamAttackers.setAccessible(true);
                @SuppressWarnings("unchecked")
                List<Permanent> counted = (List<Permanent>) teamAttackers.invoke(game.getPlayer(ids.get(1)),
                    new ArrayList<Permanent>(), ids.get(2), game);
                seen.put("counted", counted.stream().map(Permanent::getName).sorted().toList());
            } catch (ReflectiveOperationException e) {
                seen.put("counted", e.toString());
            }
        });
        Tables.Policy policy = passing(false);
        play(scenario, (seat, prompt, view) -> {
            if (seat == 0 && view.turn() == 3 && prompt.kind().equals("declare_attackers")) {
                return prompt.options().stream()
                    .filter(option -> option.action().equals("toggle_attacker") && !option.selected())
                    .findFirst().orElse(ScriptedPlayer.byAction(prompt.options(), "done").get(0)).id();
            }
            if (seat == 0 && prompt.kind().equals("choose_defender")) {
                boolean elves = prompt.detail() != null && prompt.detail().contains("Llanowar Elves");
                return prompt.options().stream()
                    .filter(option -> elves ? Integer.valueOf(2).equals(option.seat())
                        : option.label() != null && option.label().contains("Ajani"))
                    .findFirst().orElse(prompt.options().get(0)).id();
            }
            return policy.choose(seat, prompt, view);
        });

        assertEquals(List.of("Llanowar Elves"), seen.get("counted"), "the attack on seat 2 only: " + seen);
    }

    @Test
    void aLegacyDuelPlaysAsBefore() throws Exception {
        // The same patterns between two players, where every rule is XMage's own: each upkeep and draw
        // step triggers once, for the active player; Warden of the Wall is a creature in its
        // opponent's turn only.
        var request = new HumanGameRequest(5110L, GameFormat.LEGACY,
            List.of(Tables.human(LegacyDuel.DECKS.get(0)), Tables.human(LegacyDuel.DECKS.get(1))), 1, 4, 900, 0, 0);
        var scenario = new Scenario(request)
            .battlefield(0, "Sulfuric Vortex", "Howling Mine", "The Theorist, Jace Beleren", "Warden of the Wall");
        play(scenario, passing(false));

        assertEquals(18, at(scenario.life, 2, 1), "seat 1 took two in its upkeep");
        assertEquals(51, at(scenario.library, 2, 1), "seat 1 drew two in its draw step");
        assertEquals(52, at(scenario.library, 2, 0), "seat 0 drew one in its opponent's draw step");
        assertTrue(scenario.typeLine.get("2:Warden of the Wall").contains("Creature"));
        assertFalse(scenario.typeLine.get("3:Warden of the Wall").contains("Creature"));
        assertEquals(18, at(scenario.life, 3, 0), "seat 0 took two in its upkeep");
    }

    @Test
    void aLegacyDuelPlaysTheReviewsPatternsAsBefore() throws Exception {
        // The patterns the review of the audit changed, between two players: a Saga gets its lore counter
        // in its controller's turn only; Eladamri's Vineyard gives the active player {G}{G}; the player
        // with the initiative ventures in their own upkeep; Hero of Bladehold's tokens attack the one
        // opponent and Norn's Decree draws the attacking player one card; life totals are exchanged.
        var request = new HumanGameRequest(5120L, GameFormat.LEGACY,
            List.of(Tables.human(LegacyDuel.DECKS.get(0)), Tables.human(LegacyDuel.DECKS.get(1))), 1, 4, 900, 0, 0);
        Map<String, Object> seen = new ConcurrentHashMap<>();
        var scenario = new Scenario(request)
            .battlefield(0, "History of Benalia", "Eladamri's Vineyard", "Norn's Decree", "Hero of Bladehold")
            .setup((game, ids, seat, view) -> {
                Player seat0 = game.getPlayer(ids.get(0));
                Player seat1 = game.getPlayer(ids.get(1));
                seat0.loseLife(5, game, null, false);
                seat0.exchangeLife(seat1, null, game);
                seen.put("exchanged", List.of(seat0.getLife(), seat1.getLife()));
                seat1.addCounters(CounterType.POISON.createInstance(1), ids.get(0), null, game);
                game.takeInitiative(null, ids.get(0));
            });
        Map<String, Integer> lore = mostInMainPhase(scenario, (game, playerId) -> game.getBattlefield()
            .getAllActivePermanents(playerId).stream()
            .filter(permanent -> permanent.getName().equals("History of Benalia"))
            .mapToInt(permanent -> permanent.getCounters(game).getCount(CounterType.LORE)).max().orElse(-1));
        Map<String, Integer> green = mostInMainPhase(scenario,
            (game, playerId) -> game.getPlayer(playerId).getManaPool().getGreen());
        Map<String, String> rooms = new ConcurrentHashMap<>();
        Map<String, Integer> tokens = new ConcurrentHashMap<>();
        scenario.probe((game, ids, seat, view) -> {
            if ("precombat_main".equals(view.step())) {
                for (int index = 0; index < ids.size(); index++) {
                    Dungeon dungeon = game.getPlayerDungeon(ids.get(index));
                    rooms.put(view.turn() + ":" + index,
                        dungeon == null || dungeon.getCurrentRoom() == null ? "none" : dungeon.getCurrentRoom().getName());
                }
            }
            if (view.turn() == 3) {
                for (UUID attackerId : game.getCombat().getAttackers()) {
                    if (game.getPermanent(attackerId) instanceof PermanentToken token && token.getName().contains("Soldier")) {
                        tokens.put(attackerId.toString(), ids.indexOf(game.getCombat().getDefenderId(attackerId)));
                    }
                }
            }
        });
        Map<Integer, Integer> afterAttack = afterTurn3Attack(scenario);
        play(scenario, attackingIn(3));
        System.out.println("Lore " + new java.util.TreeMap<>(lore) + "; green " + new java.util.TreeMap<>(green)
            + "; rooms " + new java.util.TreeMap<>(rooms) + "; tokens " + tokens + "; " + seen);

        assertEquals(List.of(20, 15), seen.get("exchanged"), "seat 0 at 15 and seat 1 at 20 exchanged");
        assertEquals(lore.get("1:0"), lore.get("2:0"), "the Saga waits in the opponent's turn: " + lore);
        assertEquals(lore.get("2:0") + 1, lore.get("3:0"), "the Saga advances in its controller's turn: " + lore);
        assertEquals(2, green.get("2:1"), "seat 1 added {G}{G} in its turn: " + green);
        assertEquals(0, green.get("2:0"), green.toString());
        assertEquals(2, green.get("3:0"), "seat 0 added {G}{G} in its turn: " + green);
        assertEquals(0, green.get("3:1"), green.toString());
        assertFalse("none".equals(rooms.get("1:0")), "seat 0 ventured as it took the initiative: " + rooms);
        assertEquals(rooms.get("1:0"), rooms.get("2:0"), "not in its opponent's upkeep: " + rooms);
        assertFalse(rooms.get("2:0").equals(rooms.get("3:0")), "seat 0 ventured in its upkeep: " + rooms);
        assertEquals("none", rooms.get("3:1"), rooms.toString());
        assertEquals(2, tokens.size(), "two Soldiers attacked: " + tokens);
        assertTrue(tokens.values().stream().allMatch(defender -> defender == 1), "the opponent: " + tokens);
        assertEquals(at(scenario.library, 3, 0) - 1, afterAttack.get(0), "seat 0 attacked: Norn's Decree drew one");
    }
}
