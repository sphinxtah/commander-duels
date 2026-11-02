package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import mage.constants.RangeOfInfluence;
import mage.player.ai.ComputerPlayerControllableProxy;
import mage.players.Player;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Passive bots (v0.8.6), for SysOp's tests of campaign and card mechanics: with the game's switch
 * on, a bot draws, passes, keeps its hand and discards to seven, and nothing else; switched back, it
 * plays again. Needs ./db (the card database) and ./decks.
 */
class PassiveBotsTest {
    private static final int BOT = 1;
    /** The turn whose first prompt switches the bots back to normal: from then on the bot plays. */
    private static final int NORMAL_FROM = 7;
    private static final int FORESTS = 6;

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    /**
     * A Legacy game the human seat starts. In turn 1 the human seat gets Grizzly Bears, which
     * attack in every one of its turns, and the bot gets Craw Wurm (6/4) and six
     * Forests: a bot that plays would block the Bears, attack the human seat, which never blocks,
     * and cast creatures from its hand. The game starts with the bots passive and is switched back
     * to normal at the first prompt of turn 7.
     */
    @Test
    void aPassiveBotOnlyDrawsAndDiscardsUntilItIsSwitchedBack() throws Exception {
        var request = new HumanGameRequest(8601L, GameFormat.LEGACY,
            List.of(Tables.human("legacy-mono-red-burn"), Tables.bot("legacy-mono-green-creatures")), 1, 10, 900,
            0, 0);
        List<FairBot> bots = new CopyOnWriteArrayList<>();
        // By turn: whether the bot's permanents attacked or blocked, what it put on the stack, the
        // names of its permanents, and its hand and graveyard at the turn's first precombat main view.
        Map<Integer, Boolean> combat = new ConcurrentHashMap<>();
        Map<Integer, Boolean> cast = new ConcurrentHashMap<>();
        Map<Integer, List<String>> permanents = new ConcurrentHashMap<>();
        Map<Integer, Integer> hand = new ConcurrentHashMap<>();
        Map<Integer, Integer> graveyard = new ConcurrentHashMap<>();
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request)
            .battlefield(0, "Grizzly Bears")
            .battlefield(BOT, "Craw Wurm", "Forest", "Forest", "Forest", "Forest", "Forest", "Forest")
            .bots((seat, name, range, skill, seed) -> {
                var bot = new FairBot(name, range, skill, FairBot.seedFor(seed, seat));
                bots.add(bot);
                return bot;
            })
            .probe((game, seatIds, seat, view) -> {
                int turn = view.turn();
                List<String> names = new ArrayList<>();
                for (SeatView.PermanentInfo permanent : view.battlefield()) {
                    if (permanent.controllerSeat() == BOT) {
                        names.add(permanent.card().name());
                        if (permanent.attacking() || permanent.blocking()) {
                            combat.put(turn, true);
                        }
                    }
                }
                names.sort(null);
                permanents.merge(turn, names, (known, now) -> now.size() > known.size() ? now : known);
                if (view.stack().stream().anyMatch(item -> item.controllerSeat() == BOT)) {
                    cast.put(turn, true);
                }
                if ("precombat_main".equals(view.step())) {
                    view.opponents().stream().filter(player -> player.seat() == BOT).findFirst()
                        .ifPresent(bot -> {
                            hand.putIfAbsent(turn, bot.handCount());
                            graveyard.putIfAbsent(turn, bot.graveyard().size());
                        });
                }
            });
        var game = new HumanGame(UUID.randomUUID().toString(), request, SeatChecks.DECKS, finished -> {}, scenario);
        scenario.game = game;
        // Before the game starts: the bot is passive from its first decision, the mulligan.
        assertEquals(Boolean.TRUE, game.setPassiveBots(true));
        assertTrue(game.passiveBots());
        game.start();

        AtomicBoolean switched = new AtomicBoolean();
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(true);
        Tables.Played played = Tables.play(game, (seat, prompt, view) -> {
            if (view.turn() >= NORMAL_FROM && switched.compareAndSet(false, true)) {
                assertEquals(Boolean.FALSE, game.setPassiveBots(false));
                assertEquals(Boolean.FALSE, game.setPassiveBots(false), "setting it again changes nothing");
                assertFalse(game.passiveBots());
                // XMage waits for this seat's answer, so its log already reached the end: the line is
                // in the seat's log at once.
                try {
                    HumanGame.Snapshot now = game.snapshot(seat, -1, 0, -1);
                    assertEquals(HumanGame.BOTS_NORMAL, now.log().get(now.log().size() - 1).text());
                } catch (InterruptedException e) {
                    throw new IllegalStateException(e);
                }
            }
            return pass.choose(seat, prompt, view);
        }, 6, new Tables.Coverage());
        scenario.settle();
        assertTrue(scenario.failures.isEmpty(), "XMage errors, leaks or wrong views: " + scenario.failures);
        HumanGame.Result result = played.last().result();
        assertEquals("turn_limit", result.kind(), result.toString());
        assertNull(result.error());
        assertTrue(switched.get(), "the game never reached turn " + NORMAL_FROM);
        assertTrue(BotMatchRunner.join(game.thread(), 10_000), "game thread still running");

        // Passive, turns 1 to 6.
        List<String> cheated = new ArrayList<>(List.of("Craw Wurm"));
        for (int i = 0; i < FORESTS; i++) {
            cheated.add("Forest");
        }
        cheated.sort(null);
        for (int turn = 1; turn < NORMAL_FROM; turn++) {
            assertFalse(combat.containsKey(turn), "the passive bot attacked or blocked in turn " + turn);
            assertFalse(cast.containsKey(turn), "the passive bot put something on the stack in turn " + turn);
            if (permanents.containsKey(turn) && turn > 1) {
                assertEquals(cheated, permanents.get(turn), "the passive bot played a permanent by turn " + turn);
            }
        }
        // It kept its seven (no mulligan) and drew in turn 2, then discarded to seven at each cleanup.
        assertEquals(Integer.valueOf(8), hand.get(2), "the bot's hand in turn 2: " + hand);
        for (int turn : new int[]{3, 5, 7}) {
            assertEquals(Integer.valueOf(7), hand.get(turn), "the bot's hand after its cleanup, turn " + turn + ": "
                + hand);
        }
        assertEquals(Integer.valueOf(3), graveyard.get(NORMAL_FROM), "one discard in each of turns 2, 4 and 6: "
            + graveyard);
        assertEquals(Integer.valueOf(scenario.library.get("2:" + BOT) - 2), scenario.library.get("6:" + BOT),
            "the bot drew in turns 4 and 6: " + scenario.library);
        // The Wurm never attacked, and the Bears (put onto the battlefield without summoning sickness)
        // were never blocked: each of the human seat's turns took 2 of the bot's life.
        assertEquals(Integer.valueOf(20), scenario.life.get(NORMAL_FROM + ":0"), scenario.life.toString());
        for (int turn = 1; turn < NORMAL_FROM; turn += 2) {
            assertEquals(Integer.valueOf(scenario.life.get(turn + ":" + BOT) - 2),
                scenario.life.get((turn + 1) + ":" + BOT), "turn " + turn + ": " + scenario.life);
        }

        // Normal again from turn 7: it blocks, attacks, plays a land or casts something.
        boolean playedAgain = false;
        for (int turn = NORMAL_FROM; turn <= 10; turn++) {
            List<String> now = permanents.getOrDefault(turn, cheated);
            playedAgain |= combat.containsKey(turn) || cast.containsKey(turn) || !now.equals(cheated);
        }
        assertTrue(playedAgain, "the bot did nothing once it was normal again: " + permanents);

        assertEquals(1, bots.size());
        FairBot.Stats stats = bots.get(0).stats();
        assertTrue(stats.passive() > 0, "no passive decisions: " + stats);
        assertTrue(stats.searches() > 0, "the bot never searched once it was normal again: " + stats);

        // The log has one line for each change, in order, in the seat's log like XMage's own.
        List<String> notes = new ArrayList<>();
        for (HumanGame.LogLine line : allLog(game, 0)) {
            if (Set.of(HumanGame.BOTS_PASSIVE, HumanGame.BOTS_NORMAL).contains(line.text())) {
                notes.add(line.text());
            }
        }
        assertEquals(List.of(HumanGame.BOTS_PASSIVE, HumanGame.BOTS_NORMAL), notes);
        System.out.printf("Passive bots: %s; permanents by turn %s%n", stats, permanents);
    }

    /** A bot other than the fair bot ignores the switch, and the switch still works. */
    @Test
    void theSwitchIsHarmlessForOtherBots() throws Exception {
        var request = new HumanGameRequest(8602L, GameFormat.LEGACY,
            List.of(Tables.human("legacy-mono-red-burn"), Tables.bot("legacy-mono-green-creatures")), 1, 2, 900);
        var hooks = new HumanGame.Hooks() {
            @Override
            public Player bot(int seat, String name, RangeOfInfluence range, int skill, long seed) {
                return new ComputerPlayerControllableProxy(name, range, skill);
            }
        };
        HumanGame game = Tables.start(request, hooks);
        Tables.nextPrompt(game, 0, -1);
        assertEquals(Boolean.TRUE, game.setPassiveBots(true));
        assertEquals(Boolean.FALSE, game.setPassiveBots(false));
        game.close("closed");
        Tables.finalSnapshot(game, 0);
        assertNull(game.setPassiveBots(true), "a finished game's switch does not change");
        assertFalse(game.passiveBots());
        assertTrue(BotMatchRunner.join(game.thread(), 10_000));
    }

    static List<HumanGame.LogLine> allLog(HumanGame game, int seat) throws InterruptedException {
        List<HumanGame.LogLine> lines = new ArrayList<>();
        while (true) {
            HumanGame.Snapshot page = game.snapshot(seat, -1, 0, lines.size());
            lines.addAll(page.log());
            if (page.log().isEmpty() || lines.size() >= page.logCount()) {
                return lines;
            }
        }
    }
}
