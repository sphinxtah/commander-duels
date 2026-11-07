package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Weathered Sentinels (patch 0012, v0.9.0): "can attack players who attacked you during their last
 * turn as though it didn't have defender". At the pin its limit fell on every creature its
 * controller attacked with, and read the watcher the wrong way round; now it limits the Sentinels
 * alone, to the players who attacked you. Scripted human seats, the cards put onto the battlefield
 * in turn 1's main phase (as {@link TwoHeadedGiantAuditTest}'s), in a Legacy duel and in a Commander
 * game of three. Two-Headed Giant's watcher is {@link TwoHeadedGiantRareCardsTest}'s. Needs ./db.
 */
class WeatheredSentinelsTest {
    private static final String SENTINELS = "Weathered Sentinels";

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    private static HumanGameRequest legacyDuel(long seed, int turnCap) {
        return new HumanGameRequest(seed, GameFormat.LEGACY,
            List.of(Tables.human(LegacyDuel.DECKS.get(0)), Tables.human(LegacyDuel.DECKS.get(1))), 1, turnCap, 900, 0, 0);
    }

    private static HumanGameRequest commanderOfThree(long seed, int turnCap) {
        List<HumanGameRequest.Seat> seats = new ArrayList<>();
        for (String deck : GameFormat.COMMANDER.decks().subList(0, 3)) {
            seats.add(Tables.human(deck));
        }
        return new HumanGameRequest(seed, GameFormat.COMMANDER, seats, 1, turnCap, 900, 0, 0);
    }

    private static void play(TwoHeadedGiantAuditTest.Scenario scenario, Tables.Policy policy) throws Exception {
        HumanGame game = Tables.start(scenario.gameRequest, scenario);
        Tables.play(game, policy, 4, new Tables.Coverage());
        scenario.settle();
        assertTrue(scenario.failures.isEmpty(), "leaks or wrong views: " + scenario.failures);
    }

    private static int life(TwoHeadedGiantAuditTest.Scenario scenario, int turn, int seat) {
        Integer value = scenario.life.get(turn + ":" + seat);
        assertTrue(value != null, "no view of seat " + seat + " in turn " + turn + ": " + scenario.life);
        return value;
    }

    private static PromptView.Option toggle(PromptView prompt, String name) {
        return prompt.options().stream()
            .filter(option -> option.action().equals("toggle_attacker") && name.equals(option.label()))
            .findFirst().orElse(null);
    }

    private static String done(PromptView prompt) {
        return ScriptedPlayer.byAction(prompt.options(), "done").get(0).id();
    }

    /**
     * In the given turn, the seat attacks with each named creature it is offered, in order, each at
     * the defender the map names (or the only one); every other decision passes. What it was offered
     * goes to {@code offered} ("turn:seat" to the creatures, "turn:defenders:name" to the defenders' seats).
     */
    private static Tables.Policy attacking(int turn, int attacker, Map<String, Integer> at,
                                           Map<String, Object> offered) {
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        String[] last = new String[1];
        return (seat, prompt, view) -> {
            if (view.turn() != turn || seat != attacker) {
                return pass.choose(seat, prompt, view);
            }
            if (prompt.kind().equals("declare_attackers")) {
                List<String> names = prompt.options().stream()
                    .filter(option -> option.action().equals("toggle_attacker"))
                    .map(PromptView.Option::label).toList();
                offered.putIfAbsent(turn + ":" + seat, names);
                for (String name : at.keySet()) {
                    PromptView.Option option = toggle(prompt, name);
                    if (option != null && !option.selected()) {
                        last[0] = name;
                        return option.id();
                    }
                }
                return done(prompt);
            }
            if (prompt.kind().equals("choose_defender") && last[0] != null) {
                List<Integer> seats = prompt.options().stream()
                    .map(PromptView.Option::seat).filter(found -> found != null).sorted().toList();
                offered.putIfAbsent(turn + ":defenders:" + last[0], seats);
                Integer wanted = at.get(last[0]);
                return prompt.options().stream().filter(option -> wanted.equals(option.seat())).findFirst()
                    .orElse(prompt.options().get(0)).id();
            }
            return pass.choose(seat, prompt, view);
        };
    }

    /** Two policies by turn. */
    private static Tables.Policy turns(Map<Integer, Tables.Policy> byTurn) {
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        return (seat, prompt, view) -> byTurn.getOrDefault(view.turn(), pass).choose(seat, prompt, view);
    }

    @Test
    void theSentinelsAndTheOtherCreaturesAttackAPlayerWhoAttackedYou() throws Exception {
        // Seat 1 attacks seat 0 in turn 2; in turn 3 seat 0 attacks seat 1 with the Sentinels, the
        // Bears and the Elves, and all three deal damage: 5 (the Sentinels' +3/+3), 2 and 1. At the
        // pin, once one creature had attacked seat 1 the others could not.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(legacyDuel(9001L, 4))
            .battlefield(0, SENTINELS, "Grizzly Bears", "Llanowar Elves")
            .battlefield(1, "Grizzly Bears");
        Map<String, Object> offered = new ConcurrentHashMap<>();
        Map<String, Integer> all = new java.util.LinkedHashMap<>();
        all.put("Grizzly Bears", 1);
        all.put(SENTINELS, 1);
        all.put("Llanowar Elves", 1);
        play(scenario, turns(Map.of(
            2, attacking(2, 1, Map.of("Grizzly Bears", 0), offered),
            3, attacking(3, 0, all, offered))));
        System.out.println("Offered " + offered + "; life " + new java.util.TreeMap<>(scenario.life));

        assertEquals(18, life(scenario, 3, 0), "seat 1's Bears hit seat 0 in turn 2");
        assertTrue(((List<?>) offered.get("3:0")).contains(SENTINELS), "the Sentinels may attack: " + offered);
        assertEquals(12, life(scenario, 4, 1), "all three attacked seat 1: " + scenario.life);
    }

    @Test
    void theSentinelsStayHomeWhenNobodyAttackedYouAndTheOthersAttack() throws Exception {
        // Seat 1 does not attack in turn 2: in turn 3 the Sentinels are not offered as an attacker,
        // and the Bears and the Elves attack seat 1 for 3.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(legacyDuel(9002L, 4))
            .battlefield(0, SENTINELS, "Grizzly Bears", "Llanowar Elves")
            .battlefield(1, "Grizzly Bears");
        Map<String, Object> offered = new ConcurrentHashMap<>();
        Map<String, Integer> all = new java.util.LinkedHashMap<>();
        all.put(SENTINELS, 1);
        all.put("Grizzly Bears", 1);
        all.put("Llanowar Elves", 1);
        play(scenario, turns(Map.of(3, attacking(3, 0, all, offered))));
        System.out.println("Offered " + offered + "; life " + new java.util.TreeMap<>(scenario.life));

        assertFalse(((List<?>) offered.get("3:0")).contains(SENTINELS), "the Sentinels may not attack: " + offered);
        assertEquals(17, life(scenario, 4, 1), "the Bears and the Elves attacked seat 1: " + scenario.life);
    }

    @Test
    void inCommanderTheSentinelsAttackOnlyThePlayerWhoAttackedYou() throws Exception {
        // Three players. Seat 1 attacks seat 0 in turn 2, seat 2 does not in turn 3. In turn 4 the
        // Sentinels may attack seat 1 alone, and the Bears either opponent: the Sentinels hit seat 1
        // for 5 and the Bears seat 2 for 2.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(commanderOfThree(9003L, 5))
            .battlefield(0, SENTINELS, "Grizzly Bears")
            .battlefield(1, "Grizzly Bears");
        Map<String, Object> offered = new ConcurrentHashMap<>();
        Map<String, Integer> split = new java.util.LinkedHashMap<>();
        split.put(SENTINELS, 1);
        split.put("Grizzly Bears", 2);
        play(scenario, turns(Map.of(
            2, attacking(2, 1, Map.of("Grizzly Bears", 0), offered),
            4, attacking(4, 0, split, offered))));
        System.out.println("Offered " + offered + "; life " + new java.util.TreeMap<>(scenario.life));

        assertEquals(38, life(scenario, 3, 0), "seat 1's Bears hit seat 0 in turn 2");
        assertTrue(((List<?>) offered.get("4:0")).contains(SENTINELS), "the Sentinels may attack: " + offered);
        // Seat 1 is the one player the Sentinels may attack, so no defender is asked for them.
        assertFalse(offered.containsKey("4:defenders:" + SENTINELS), "only seat 1 attacked seat 0: " + offered);
        assertEquals(List.of(1, 2), offered.get("4:defenders:Grizzly Bears"), "the Bears may attack either: " + offered);
        assertEquals(35, life(scenario, 5, 1), "the Sentinels hit seat 1: " + scenario.life);
        assertEquals(38, life(scenario, 5, 2), "the Bears hit seat 2: " + scenario.life);
    }
}
