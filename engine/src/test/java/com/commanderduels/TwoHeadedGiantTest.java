package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import mage.MageObject;
import mage.cards.Card;
import mage.counters.CounterType;
import mage.game.Game;
import mage.game.combat.CombatGroup;
import mage.game.match.Match;
import mage.game.permanent.Permanent;
import mage.game.stack.StackObject;
import mage.players.Player;
import mage.target.Target;
import mage.util.RandomUtil;
import mage.util.ThreadUtils;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Two-Headed Giant on the patched XMage (v0.5.0 spike, FMT08 and T09 at the engine level): seats 0
 * and 1 against seats 2 and 3, with the four Legacy fixture decks.
 * <ul>
 *   <li>A scripted game with four human seats and arranged libraries: the team that starts skips its
 *       first draw, each team takes one turn together (both players draw, play a land and attack),
 *       one life total of 30 per team falls with damage to either player, and the game ends when
 *       the defending team's life reaches 0, with the attacking team as the winner.</li>
 *   <li>Team poison: 9 and 6 poison counters, neither ten, make a team of 15 lose.</li>
 *   <li>Four bots play whole games to the end, never attacking a teammate or aiming a harmful spell
 *       at one.</li>
 *   <li>The practice table: a human with a bot teammate against two bots, under every leak check,
 *       the teammate's hand shown to the human and nothing of the opponents'.</li>
 * </ul>
 */
class TwoHeadedGiantTest {
    private static final List<String> DECKS = GameFormat.TWO_HEADED_GIANT.decks();
    /** The top of each seat's library (its opening hand first), before the basic lands it draws. */
    private static final List<List<String>> TOPS = List.of(
        List.of("Mountain", "Monastery Swiftspear", "Lightning Bolt", "Lightning Bolt", "Chain Lightning",
            "Lava Spike", "Mountain", "Mountain", "Lightning Bolt", "Mountain", "Incinerate", "Mountain",
            "Chain Lightning", "Searing Spear"),
        List.of("Forest", "Llanowar Elves", "Grizzly Bears", "Forest", "Kalonian Tusker", "Centaur Courser",
            "Forest", "Forest", "Leatherback Baloth", "Forest", "Garruk's Companion", "Forest", "Elvish Mystic"),
        List.of("Plains", "Plains", "Plains", "Plains", "Plains", "Plains", "Plains"),
        List.of("Island", "Island", "Island", "Island", "Island", "Island", "Island"));
    /** Spells in the fixture decks that harm what they target: burn and bounce. */
    private static final Set<String> HARMFUL = Set.of("Lightning Bolt", "Chain Lightning", "Lava Spike",
        "Searing Spear", "Incinerate", "Shock", "Vapor Snag", "Mist Raven");

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    /** Arranges every library and turns off the opening shuffle; records what the views showed. */
    static final class Arranged extends SeatChecks {
        /** By "turn:seat": each player's library size in the first main-phase view of that turn. */
        final Map<String, Integer> libraryAtMain = new ConcurrentHashMap<>();
        /** By turn: the active seat the views showed. */
        final Map<Integer, Set<Integer>> activeSeats = new ConcurrentHashMap<>();
        /** By turn: the seats whose creatures attacked in one combat. */
        final Map<Integer, Set<Integer>> attackedTogether = new ConcurrentHashMap<>();
        /** Team B's life totals, as both of its players showed them, in order. */
        final List<String> teamLife = new CopyOnWriteArrayList<>();
        volatile int[] poison;

        Arranged(HumanGameRequest request) throws Exception {
            super(request);
        }

        @Override
        public void beforeStart(Game game, List<UUID> ids) {
            super.beforeStart(game, ids);
            game.getOptions().skipInitShuffling = true;
            for (int seat = 0; seat < ids.size(); seat++) {
                Player player = game.getPlayer(ids.get(seat));
                List<Card> rest = new ArrayList<>(player.getLibrary().getCards(game));
                LinkedHashSet<Card> ordered = new LinkedHashSet<>();
                for (String name : TOPS.get(seat)) {
                    Card card = rest.stream().filter(candidate -> candidate.getName().equals(name)).findFirst()
                        .orElseThrow(() -> new IllegalStateException(name + " is not in the deck"));
                    rest.remove(card);
                    ordered.add(card);
                }
                String basic = TOPS.get(seat).get(0);
                rest.stream().filter(card -> card.getName().equals(basic)).forEach(ordered::add);
                ordered.addAll(rest);
                player.getLibrary().clear();
                player.getLibrary().addAll(ordered, game);
            }
        }

        @Override
        public void published(Game game, ObjectRefs refs, int seat, SeatView view, PromptView prompt) {
            super.published(game, refs, seat, view, prompt);
            if (view.turn() < 1 || view.activeSeat() == null) {
                return;
            }
            activeSeats.computeIfAbsent(view.turn(), key -> ConcurrentHashMap.newKeySet()).add(view.activeSeat());
            List<SeatView.PlayerState> players = new ArrayList<>(view.opponents());
            players.add(view.you());
            if ("precombat_main".equals(view.step())) {
                for (SeatView.PlayerState player : players) {
                    libraryAtMain.putIfAbsent(view.turn() + ":" + player.seat(), player.libraryCount());
                }
            }
            Map<String, Integer> controllers = new java.util.HashMap<>();
            view.battlefield().forEach(permanent -> controllers.put(permanent.id(), permanent.controllerSeat()));
            for (SeatView.CombatInfo group : view.combat()) {
                for (String attacker : group.attackers()) {
                    Integer controller = controllers.get(attacker);
                    if (controller != null) {
                        attackedTogether.computeIfAbsent(view.turn(), key -> ConcurrentHashMap.newKeySet())
                            .add(controller);
                    }
                }
            }
            int two = players.stream().filter(player -> player.seat() == 2).findFirst().orElseThrow().life();
            int three = players.stream().filter(player -> player.seat() == 3).findFirst().orElseThrow().life();
            String life = two + "/" + three;
            if (teamLife.isEmpty() || !teamLife.get(teamLife.size() - 1).equals(life)) {
                teamLife.add(life);
            }
            if (poison != null && view.turn() == 2 && seat == 2) {
                // Team poison: counters given to each player (test only), on the game thread while
                // XMage waits for an answer. Nine and six: neither player has ten.
                int[] given = poison;
                poison = null;
                for (int index = 0; index < 2; index++) {
                    Player player = game.getPlayer(seatIds.get(2 + index));
                    player.addCounters(CounterType.POISON.createInstance(given[index]), player.getId(), null, game);
                }
            }
        }
    }

    /**
     * Team A (seats 0 and 1) plays lands, casts what it can, aims its burn at team B's players in
     * turn and attacks with everything: seat 0 attacks seat 2, seat 1 attacks seat 3. Team B plays
     * lands and does nothing else. Seat 0 starts.
     */
    static final class Plan implements Tables.Policy {
        /** Turns in which a seat played a land while its teammate was the active seat. */
        final Set<String> teammateLands = ConcurrentHashMap.newKeySet();
        private final AtomicInteger burnTargets = new AtomicInteger();

        @Override
        public String choose(int seat, PromptView prompt, SeatView view) {
            List<PromptView.Option> options = prompt.options();
            boolean teamA = seat < 2;
            boolean ourTurn = view.activeSeat() != null && view.activeSeat() / 2 == seat / 2;
            boolean main = "precombat_main".equals(view.step()) || "postcombat_main".equals(view.step());
            switch (prompt.kind()) {
                case "priority": {
                    if (ourTurn && main) {
                        var lands = byAction(options, "play_land");
                        if (!lands.isEmpty()) {
                            if (view.activeSeat() != seat) {
                                teammateLands.add(view.turn() + ":" + seat);
                            }
                            return lands.get(0).id();
                        }
                        var spells = byAction(options, "cast");
                        if (teamA && !spells.isEmpty()) {
                            return spells.get(0).id();
                        }
                    }
                    return byAction(options, "pass").get(0).id();
                }
                case "choose_target": {
                    if (prompt.message().toLowerCase(java.util.Locale.ROOT).contains("starting player")) {
                        return options.stream().filter(option -> Integer.valueOf(0).equals(option.seat()))
                            .findFirst().orElseThrow().id(); // seat 0 starts
                    }
                    var done = byAction(options, "done");
                    if (options.stream().anyMatch(PromptView.Option::selected) && !done.isEmpty()) {
                        return done.get(0).id();
                    }
                    int wanted = 2 + burnTargets.getAndIncrement() % 2;
                    var opponent = options.stream().filter(option -> Integer.valueOf(wanted).equals(option.seat()))
                        .findFirst();
                    if (opponent.isPresent()) {
                        return opponent.get().id();
                    }
                    return options.stream().filter(option -> option.seat() != null && option.seat() / 2 != seat / 2)
                        .findFirst().orElse(options.get(0)).id();
                }
                case "choose_defender":
                    return options.stream().filter(option -> Integer.valueOf(seat == 0 ? 2 : 3).equals(option.seat()))
                        .findFirst().orElse(options.get(0)).id();
                case "declare_attackers": {
                    var all = byAction(options, "all_attack");
                    boolean fresh = options.stream()
                        .anyMatch(option -> option.action().equals("toggle_attacker") && !option.selected());
                    if (teamA && fresh && !all.isEmpty()) {
                        return all.get(0).id();
                    }
                    return byAction(options, "done").get(0).id();
                }
                case "declare_blockers":
                    return byAction(options, "done").get(0).id();
                case "mulligan":
                    return byAction(options, "keep").get(0).id();
                case "pay_mana": {
                    var sources = byAction(options, "tap_source");
                    return sources.isEmpty() ? byAction(options, "cancel").get(0).id() : sources.get(0).id();
                }
                case "assign_amounts":
                    return byAction(options, "suggested").get(0).id();
                default:
                    return options.stream().filter(option -> !option.action().equals("cancel")).findFirst()
                        .orElse(options.get(0)).id();
            }
        }

        private static List<PromptView.Option> byAction(List<PromptView.Option> options, String action) {
            return ScriptedPlayer.byAction(options, action);
        }
    }

    private static HumanGameRequest fourHumans(long seed, int turnCap) {
        List<HumanGameRequest.Seat> seats = new ArrayList<>();
        for (String deck : DECKS) {
            seats.add(Tables.human(deck));
        }
        return new HumanGameRequest(seed, GameFormat.TWO_HEADED_GIANT, seats, 1, turnCap, 900);
    }

    @Test
    void teamsShareTurnsAndLifeAndWinTogether() throws Exception {
        var request = fourHumans(5005L, 30);
        var check = new Arranged(request);
        var coverage = new Tables.Coverage();
        var plan = new Plan();
        HumanGame game = Tables.start(request, check);
        Tables.Played played = Tables.play(game, plan, 4, coverage);
        coverage.summary().forEach(System.out::println);
        System.out.println("Team B's life: " + check.teamLife);
        System.out.println("Active seats by turn: " + new TreeMap<>(check.activeSeats));
        System.out.println("Attacking seats by turn: " + new TreeMap<>(check.attackedTogether));
        System.out.println("Result: " + played.last().result());

        check.settle();
        assertTrue(check.failures.isEmpty(), "leaks or wrong views: " + check.failures);
        assertTrue(coverage.unsupported.isEmpty(), "unsupported: " + coverage.unsupported);
        assertTrue(check.reached.contains("teammate hand shown"), "each seat saw its teammate's hand");

        // Shared turns: team A (seat 0) takes the odd turns and team B (seat 2) the even ones; no
        // turn of seat 1's or seat 3's own.
        check.activeSeats.forEach((turn, active) ->
            assertEquals(Set.of(turn % 2 == 1 ? 0 : 2), active, "the active seat in turn " + turn));
        assertTrue(check.activeSeats.size() >= 5, "several team turns were played: " + check.activeSeats.keySet());
        assertTrue(plan.teammateLands.contains("1:1"), "seat 1 played a land in team A's first turn: "
            + plan.teammateLands);
        assertTrue(plan.teammateLands.contains("2:3"), "seat 3 played a land in team B's first turn: "
            + plan.teammateLands);

        // 810.6: team A started and skipped its first draw; every later team turn both players drew.
        for (int seat = 0; seat < 4; seat++) {
            assertEquals(53, check.libraryAtMain.get("1:" + seat), "library of seat " + seat + " in turn 1");
        }
        assertEquals(53, check.libraryAtMain.get("2:0"), "team A does not draw in team B's turn");
        assertEquals(52, check.libraryAtMain.get("2:2"), "seat 2 drew in team B's first turn");
        assertEquals(52, check.libraryAtMain.get("2:3"), "seat 3 drew in team B's first turn");
        assertEquals(52, check.libraryAtMain.get("3:0"), "seat 0 drew in team A's second turn");
        assertEquals(52, check.libraryAtMain.get("3:1"), "seat 1 drew in team A's second turn");

        // Both players of team A attacked in one combat.
        assertTrue(check.attackedTogether.values().stream().anyMatch(seats -> seats.equals(Set.of(0, 1))),
            "seats 0 and 1 attacked together: " + check.attackedTogether);

        // 810.4, 810.9: one life total of 30 for team B, which damage to either player lowered.
        assertEquals("30/30", check.teamLife.get(0));
        assertTrue(check.teamLife.stream().allMatch(life -> life.split("/")[0].equals(life.split("/")[1])),
            "both players of team B always showed the same life: " + check.teamLife);
        List<String> lines = wholeLog(game);
        System.out.println("The end of the log: " + lines.subList(Math.max(0, lines.size() - 15), lines.size()));
        assertTrue(lines.stream().anyMatch(line -> line.contains("Human 3 loses")), "seat 2 lost life");
        assertTrue(lines.stream().anyMatch(line -> line.contains("Human 4 loses")), "seat 3 lost life");

        // 810.8: the game ends when team B's life reaches 0, and team A wins together.
        HumanGame.Result result = played.last().result();
        assertEquals("completed", result.kind(), "team B's life reached 0: " + result);
        assertEquals(0, result.winnerSeat());
        assertEquals(List.of(0, 1), result.winnerSeats());
        assertFalse(result.draw());
        assertNull(result.error());
        SeatView last = played.last().view();
        assertTrue(last.you().won(), "seat 0 won");
        for (SeatView.PlayerState player : last.opponents()) {
            assertEquals(player.seat() == 1, player.won(), "seat " + player.seat() + " won");
            assertEquals(player.seat() >= 2, player.lost(), "seat " + player.seat() + " lost");
            if (player.seat() >= 2) {
                assertTrue(player.life() <= 0, "team B's life");
            }
        }
    }

    /** Seat 0's whole log, page by page. */
    private static List<String> wholeLog(HumanGame game) throws InterruptedException {
        List<String> lines = new ArrayList<>();
        while (true) {
            HumanGame.Snapshot page = game.snapshot(0, -1, 0, lines.size());
            page.log().forEach(line -> lines.add(line.text()));
            if (page.log().size() < HumanGame.MAX_LOG_PAGE) {
                return lines;
            }
        }
    }

    @Test
    void aTeamWithFifteenPoisonCountersLoses() throws Exception {
        var request = fourHumans(5006L, 10);
        var check = new Arranged(request);
        check.poison = new int[]{9, 6};
        HumanGame game = Tables.start(request, check);
        Tables.Played played = Tables.play(game, new Plan(), 4, new Tables.Coverage());

        check.settle();
        assertTrue(check.failures.isEmpty(), "leaks or wrong views: " + check.failures);
        HumanGame.Result result = played.last().result();
        assertEquals("completed", result.kind(), "team B lost to poison: " + result);
        assertEquals(List.of(0, 1), result.winnerSeats());
        assertEquals(2, result.turns(), "team B lost in its first turn");
        for (SeatView.PlayerState player : played.last().view().opponents()) {
            if (player.seat() >= 2) {
                assertTrue(player.lost());
                assertTrue(player.life() > 0, "team B still had life");
                assertTrue(player.counters().getOrDefault("poison", 0) < 10, "neither player had ten poison counters");
            }
        }
    }

    /** What a game of four bots did, and what a team's player did to its teammate (nothing, we hope). */
    record BotGame(String kind, List<Integer> winners, int turns, long millis, int engineErrors, String criticalError,
                   int attacks, int harmfulTargets, List<String> violations) {}

    static BotGame playBots(long seed, int skill, int turnCap) throws Exception {
        var outcome = new AtomicReference<BotGame>();
        var failure = new AtomicReference<Throwable>();
        Thread thread = new Thread(() -> {
            try {
                outcome.set(runBots(seed, skill, turnCap));
            } catch (Throwable t) {
                failure.set(t);
            }
        }, ThreadUtils.THREAD_PREFIX_GAME + " two_headed_giant_bots " + seed);
        thread.setDaemon(true);
        thread.start();
        if (!BotMatchRunner.join(thread, TimeUnit.MINUTES.toMillis(5))) {
            BotMatchRunner.stop(thread);
            throw new AssertionError("the bots' game did not finish in five minutes");
        }
        if (failure.get() != null) {
            throw new AssertionError("the bots' game failed", failure.get());
        }
        return outcome.get();
    }

    private static BotGame runBots(long seed, int skill, int turnCap) throws Exception {
        RandomUtil.setSeed(seed);
        GameFormat format = GameFormat.TWO_HEADED_GIANT;
        Game game = format.newGame(TwoHeadedGiant.PLAYERS, turnCap);
        Match match = format.newMatch("Two-Headed Giant bots", TwoHeadedGiant.PLAYERS);
        List<Player> players = new ArrayList<>();
        for (int seat = 0; seat < TwoHeadedGiant.PLAYERS; seat++) {
            players.add(new FairBot("Bot " + (seat + 1), format.range(), skill, FairBot.seedFor(seed, seat)));
        }
        for (int index : HumanGame.additionOrder(players.size())) {
            LegacyDuel.seat(game, match, players.get(index), format.loadDeck(SeatChecks.DECKS, DECKS.get(index)));
        }
        List<UUID> ids = players.stream().map(Player::getId).toList();
        format.seatTeams(game, ids);
        var log = new MatchLog();
        log.attach(game, ids);
        List<String> violations = new CopyOnWriteArrayList<>();
        Set<String> attacks = ConcurrentHashMap.newKeySet();
        Set<String> targets = ConcurrentHashMap.newKeySet();
        game.addTableEventListener(event -> audit(game, attacks, targets, violations));
        long started = System.nanoTime();
        game.start(ids.get(RandomUtil.nextInt(ids.size())));
        long millis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        List<Integer> winners = new ArrayList<>();
        for (int seat = 0; seat < ids.size(); seat++) {
            if (game.getPlayer(ids.get(seat)).hasWon()) {
                winners.add(seat);
            }
        }
        String kind = game.hasEnded() ? "completed" : game.getTurnNum() > turnCap ? "turn_limit" : "stopped";
        return new BotGame(kind, winners, Math.min(game.getTurnNum(), turnCap), millis, log.engineErrors(),
            log.criticalError(), attacks.size(), targets.size(), List.copyOf(violations));
    }

    /**
     * Every attack must be at an opponent, and every burn or bounce spell aimed at an opponent or
     * their permanent. Runs at each of XMage's table events, on the game thread.
     */
    private static void audit(Game game, Set<String> attacks, Set<String> targets, List<String> violations) {
        for (CombatGroup group : game.getCombat().getGroups()) {
            for (UUID attackerId : group.getAttackers()) {
                Permanent attacker = game.getPermanent(attackerId);
                UUID defending = group.getDefendingPlayerId();
                if (attacker == null || defending == null) {
                    continue;
                }
                attacks.add(game.getTurnNum() + ":" + attackerId);
                if (!game.isOpponent(game.getPlayer(attacker.getControllerId()), defending)) {
                    violations.add("turn " + game.getTurnNum() + ": " + attacker.getName() + " attacked its own team");
                }
            }
        }
        for (StackObject object : game.getStack()) {
            // A spell, or a triggered ability by its source's name (Mist Raven's).
            MageObject source = game.getObject(object.getSourceId());
            if (!HARMFUL.contains(source == null ? object.getName() : source.getName())) {
                continue;
            }
            Player controller = game.getPlayer(object.getControllerId());
            for (UUID modeId : object.getStackAbility().getModes().getSelectedModes()) {
                for (Target target : object.getStackAbility().getModes().get(modeId).getTargets()) {
                    for (UUID targetId : target.getTargets()) {
                        Permanent permanent = game.getPermanent(targetId);
                        UUID owner = permanent != null ? permanent.getControllerId() : targetId;
                        if (targets.add(object.getId() + ":" + targetId) && !game.isOpponent(controller, owner)) {
                            Player hit = game.getPlayer(owner);
                            violations.add("turn " + game.getTurnNum() + " " + game.getTurnStepType() + ": "
                                + controller.getName() + "'s " + object.getName() + " aimed at "
                                + (permanent != null ? permanent.getName() + " of " : "")
                                + (hit == null ? owner : hit.getName()));
                        }
                    }
                }
            }
        }
    }

    @Test
    void fourBotsPlayWholeGamesAsTeams() throws Exception {
        int completed = 0;
        for (long seed : new long[]{21L, 22L, 23L, 24L}) {
            BotGame played = playBots(seed, 1, 60);
            System.out.println("Two-Headed Giant bots, seed " + seed + ": " + played);
            assertEquals(0, played.engineErrors(), "XMage recovered from no error: " + played);
            assertNull(played.criticalError());
            assertTrue(played.violations().isEmpty(), "a bot harmed its teammate: " + played.violations());
            assertTrue(played.attacks() > 0, "the bots attacked");
            if (played.kind().equals("completed")) {
                completed++;
                assertTrue(played.winners().equals(List.of(0, 1)) || played.winners().equals(List.of(2, 3))
                    || played.winners().isEmpty(), "a team won together: " + played.winners());
            } else {
                assertEquals("turn_limit", played.kind(), "the game ended or reached the turn limit: " + played);
            }
        }
        assertTrue(completed >= 3, "most bot games end with a winning team");
    }

    @Test
    void aHumanAndABotTeammatePlayTwoBots() throws Exception {
        var request = new HumanGameRequest(5007L, GameFormat.TWO_HEADED_GIANT,
            List.of(Tables.human(DECKS.get(0)), Tables.bot(DECKS.get(1)), Tables.bot(DECKS.get(2)),
                Tables.bot(DECKS.get(3))), 1, 40, 900);
        var check = new SeatChecks(request);
        var scripted = new ScriptedPlayer(5007L);
        var coverage = new Tables.Coverage();
        HumanGame game = Tables.start(request, check);
        Tables.Played played = Tables.play(game, (seat, prompt, view) -> scripted.choose(prompt, view), 4, coverage);
        coverage.summary().forEach(System.out::println);

        check.settle();
        assertTrue(check.failures.isEmpty(), "leaks or wrong views: " + check.failures);
        assertTrue(coverage.unsupported.isEmpty(), "unsupported: " + coverage.unsupported);
        assertTrue(check.reached.contains("teammate hand shown"), "the human saw its teammate's hand");
        assertTrue(check.viewsChecked.get() > 50, "views checked: " + check.viewsChecked.get());
        HumanGame.Snapshot last = played.last();
        assertEquals("two_headed_giant", last.settings().format());
        assertEquals("two_headed_giant_legacy", last.settings().rulesProfile());
        SeatView.PlayerState teammate = last.view().opponents().get(0);
        assertEquals(1, teammate.seat());
        assertEquals(0, teammate.team());
        assertNotNull(teammate.hand(), "the teammate's hand is the human's to see");
        for (SeatView.PlayerState opponent : last.view().opponents().subList(1, 3)) {
            assertEquals(1, opponent.team());
            assertNull(opponent.hand(), "an opponent's hand is never shown");
        }
        HumanGame.Result result = last.result();
        assertTrue(Set.of("completed", "turn_limit").contains(result.kind()), "the game finished: " + result);
        if (result.kind().equals("completed") && !result.draw()) {
            assertTrue(result.winnerSeats().equals(List.of(0, 1)) || result.winnerSeats().equals(List.of(2, 3)),
                "a team won together: " + result);
            assertEquals(result.winnerSeats().get(0), result.winnerSeat());
        }
    }

    @Test
    void theTableTakesFourSeatsInTwoTeams() throws Exception {
        HumanGameRequest request = HumanGameRequest.parse("{\"format\":\"two_headed_giant\",\"seed\":1}", () -> 0L);
        assertEquals(GameFormat.TWO_HEADED_GIANT, request.format());
        assertEquals(List.of("human", "bot", "bot", "bot"),
            request.seats().stream().map(HumanGameRequest.Seat::player).toList());
        assertEquals(DECKS, request.seats().stream().map(HumanGameRequest.Seat::deck).toList());
        assertThrows(JsonRequest.Invalid.class, () -> HumanGameRequest.parse(
            "{\"format\":\"two_headed_giant\",\"seats\":[{\"player\":\"human\"},{\"player\":\"bot\"}]}", () -> 0L));
        assertEquals(0, GameFormat.TWO_HEADED_GIANT.teamOf(1));
        assertEquals(1, GameFormat.TWO_HEADED_GIANT.teamOf(2));
        assertNull(GameFormat.COMMANDER.teamOf(1));
        for (String deck : DECKS) {
            // Every fixture is Legacy-legal, and no two share a card other than basic lands.
            assertEquals(60, GameFormat.TWO_HEADED_GIANT.loadDeck(SeatChecks.DECKS, deck).getMaindeckCards().size());
        }
        for (int first = 0; first < DECKS.size(); first++) {
            for (int second = first + 1; second < DECKS.size(); second++) {
                Set<String> shared = new java.util.HashSet<>(SeatChecks.deckNames(DECKS.get(first)));
                shared.retainAll(SeatChecks.deckNames(DECKS.get(second)));
                assertTrue(shared.isEmpty(), DECKS.get(first) + " and " + DECKS.get(second) + " share " + shared);
            }
        }
    }
}
