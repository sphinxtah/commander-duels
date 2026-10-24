package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Two-Headed Giant's team priority and team choices (805.5 to 805.7, v0.6.1, patch 0007) and the
 * team's combined attack and block (805.10b, 805.10d), each in a scripted game whose cards are put
 * onto the battlefield (or into a hand) in turn 1's precombat main phase by XMage's cheat, as in
 * {@link TwoHeadedGiantAuditTest}. Seats 0 and 1 are team A, seats 2 and 3 team B; seat 0 starts
 * unless a test says otherwise. Every view and prompt goes through {@link SeatChecks}. Needs ./db.
 */
class TeamPriorityTest {
    private static final List<String> DECKS = GameFormat.TWO_HEADED_GIANT.decks();

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    private static HumanGameRequest request(long seed, int turnCap, Integer startingSeat, boolean... humans) {
        List<HumanGameRequest.Seat> seats = new ArrayList<>();
        for (int seat = 0; seat < DECKS.size(); seat++) {
            boolean human = humans.length == 0 || humans[seat];
            seats.add(human ? Tables.human(DECKS.get(seat)) : Tables.bot(DECKS.get(seat)));
        }
        return new HumanGameRequest(seed, GameFormat.TWO_HEADED_GIANT, seats, 1, turnCap, 900, 0,
            startingSeat == null ? 0 : startingSeat);
    }

    private static Tables.Played play(TwoHeadedGiantAuditTest.Scenario scenario, Tables.Policy policy)
            throws Exception {
        HumanGame game = Tables.start(scenario.gameRequest, scenario);
        Tables.Played played = Tables.play(game, policy, 4, new Tables.Coverage());
        scenario.settle();
        assertTrue(scenario.failures.isEmpty(), "leaks or wrong views: " + scenario.failures);
        assertNotNull(played.last().result(), "the game finished");
        assertFalse("error".equals(played.last().result().kind()), "no engine error: " + played.last().result());
        return played;
    }

    private static PromptView.Option option(PromptView prompt, String action, String label) {
        return prompt.options().stream()
            .filter(option -> option.action().equals(action) && label.equals(option.label())).findFirst()
            .orElse(null);
    }

    private static String done(PromptView prompt) {
        return ScriptedPlayer.byAction(prompt.options(), "done").get(0).id();
    }

    /** The defender choice of an attack: seat 2. */
    private static String seatTwo(PromptView prompt) {
        return prompt.options().stream().filter(option -> Integer.valueOf(2).equals(option.seat())).findFirst()
            .orElse(prompt.options().get(0)).id();
    }

    @Test
    void theTeamHoldsPriorityUntilEachOfItsPlayersHasPassed() throws Exception {
        // 805.5: seat 1 casts Lightning Strike in team A's turn, after seat 0 has passed. Team A keeps
        // priority: seat 1, then seat 0 (whose prompt says its teammate has passed), and only then
        // team B, seat 2 and seat 3. In XMage's own order seat 0 came last, after team B.
        List<String> order = new CopyOnWriteArrayList<>();
        Map<Integer, Boolean> teammatePassed = new ConcurrentHashMap<>();
        List<String> problems = new CopyOnWriteArrayList<>();
        AtomicBoolean cast = new AtomicBoolean();
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request(6101L, 2, null))
            .hand(1, "Lightning Strike").battlefield(1, "Mountain", "Mountain");
        play(scenario, (seat, prompt, view) -> {
            if (prompt.team() == null) {
                problems.add("a prompt without its team: " + prompt.kind());
            }
            switch (prompt.kind()) {
                case "priority": {
                    if (prompt.team() != null && prompt.team().teammatePassed() == null) {
                        problems.add("a priority prompt that does not say whether the teammate passed");
                    }
                    if (view.turn() == 1 && !view.stack().isEmpty()) {
                        order.add(String.valueOf(seat));
                        teammatePassed.putIfAbsent(seat, prompt.team().teammatePassed());
                    }
                    var strike = option(prompt, "cast", "Lightning Strike");
                    if (seat == 1 && view.turn() == 1 && strike != null && cast.compareAndSet(false, true)) {
                        return strike.id();
                    }
                    return pass.choose(seat, prompt, view);
                }
                case "choose_target":
                    return seatTwo(prompt);
                case "pay_mana":
                    return ScriptedPlayer.byAction(prompt.options(), "tap_source").get(0).id();
                default:
                    if (prompt.team().teammatePassed() != null) {
                        problems.add("teammate_passed on a " + prompt.kind() + " prompt");
                    }
                    return pass.choose(seat, prompt, view);
            }
        });
        System.out.println("Priority with Lightning Strike on the stack: " + order);

        assertTrue(problems.isEmpty(), "problems: " + problems);
        assertTrue(cast.get(), "seat 1 cast Lightning Strike");
        assertEquals(List.of("1", "0", "2", "3"), order);
        assertEquals(Boolean.FALSE, teammatePassed.get(1), "seat 1 has just acted: its team holds priority");
        assertEquals(Boolean.TRUE, teammatePassed.get(0), "seat 0 passes for its team");
        assertEquals(Boolean.FALSE, teammatePassed.get(2));
        assertEquals(Boolean.TRUE, teammatePassed.get(3));
        assertEquals(27, scenario.life.get("2:2"), "Lightning Strike hit team B: " + scenario.life);
    }

    /**
     * The given seat casts Raging Goblin in turn 1 (once); records the order_triggers prompts by
     * seat and the controllers' seats their options name. The first ability listed is put on the
     * stack first; yes to every optional trigger.
     */
    private static Tables.Policy orderingTriggers(int caster, Map<Integer, Set<Integer>> controllers,
                                                  Map<Integer, AtomicInteger> prompts, List<String> problems) {
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        AtomicBoolean cast = new AtomicBoolean();
        return (seat, prompt, view) -> {
            if (prompt.kind().equals("priority") && seat == caster && view.turn() == 1) {
                var goblin = option(prompt, "cast", "Raging Goblin");
                if (goblin != null && cast.compareAndSet(false, true)) {
                    return goblin.id();
                }
            }
            if (prompt.kind().equals("pay_mana")) {
                return ScriptedPlayer.byAction(prompt.options(), "tap_source").get(0).id();
            }
            if (prompt.kind().equals("order_triggers")) {
                prompts.computeIfAbsent(seat, key -> new AtomicInteger()).incrementAndGet();
                for (PromptView.Option option : prompt.options()) {
                    if (option.seat() == null) {
                        problems.add("a team trigger without its controller's seat: " + option.label());
                    } else {
                        controllers.computeIfAbsent(seat, key -> ConcurrentHashMap.newKeySet()).add(option.seat());
                    }
                }
                return prompt.options().get(0).id();
            }
            if (prompt.kind().equals("yes_no")) {
                return ScriptedPlayer.byAction(prompt.options(), "yes").get(0).id();
            }
            return pass.choose(seat, prompt, view);
        };
    }

    @Test
    void theTeamPutsItsTriggersOnTheStackInOneOrder() throws Exception {
        // 805.7: Soul Warden (seat 0) and Soul's Attendant (seat 1) both trigger when seat 0's Raging
        // Goblin enters. The team orders them together: one prompt to seat 0, its primary player
        // (805.2), listing seat 1's ability with seat 0's; seat 1 is asked for no order. Each
        // controller gains its life, the team's.
        Map<Integer, Set<Integer>> controllers = new ConcurrentHashMap<>();
        Map<Integer, AtomicInteger> prompts = new ConcurrentHashMap<>();
        List<String> problems = new CopyOnWriteArrayList<>();
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request(6102L, 2, null))
            .battlefield(0, "Soul Warden", "Mountain").hand(0, "Raging Goblin").battlefield(1, "Soul's Attendant");
        play(scenario, orderingTriggers(0, controllers, prompts, problems));
        System.out.println("Trigger orders by seat: " + prompts + ", controllers listed: " + controllers
            + ", life " + scenario.life);

        assertTrue(problems.isEmpty(), "problems: " + problems);
        assertTrue(prompts.containsKey(0), "seat 0 ordered its team's triggers: " + prompts);
        assertNull(prompts.get(1), "seat 1 was not asked: " + prompts);
        assertEquals(Set.of(0, 1), controllers.get(0), "seat 1's ability listed with seat 0's");
        assertTrue(scenario.life.get("2:0") >= 32, "both triggers resolved: " + scenario.life);
    }

    @Test
    void aBotLeavesTheTeamsChoiceToItsHumanTeammate() throws Exception {
        // 805.2: with a bot as team A's primary player (seat 0) and a human at seat 1, the human
        // orders the team's triggers, its teammate's included.
        Map<Integer, Set<Integer>> controllers = new ConcurrentHashMap<>();
        Map<Integer, AtomicInteger> prompts = new ConcurrentHashMap<>();
        List<String> problems = new CopyOnWriteArrayList<>();
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request(6103L, 1, null, false, true, true, true))
            .battlefield(0, "Soul Warden").battlefield(1, "Soul's Attendant", "Mountain").hand(1, "Raging Goblin");
        play(scenario, orderingTriggers(1, controllers, prompts, problems));
        System.out.println("Trigger orders by seat: " + prompts + ", controllers listed: " + controllers);

        assertTrue(problems.isEmpty(), "problems: " + problems);
        assertTrue(prompts.containsKey(1), "seat 1 ordered its team's triggers: " + prompts);
        assertEquals(Set.of(0, 1), controllers.get(1), "the bot's abilities listed with seat 1's");
    }

    @Test
    void theTeamsChooserPrefersAHuman() throws Exception {
        // 805.2, TwoHeadedGiant.getTeamChooser: the primary player (each team's first seat), unless
        // it is a bot with a human teammate.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request(6104L, 1, null, false, true, false, false));
        Map<String, Integer> choosers = new ConcurrentHashMap<>();
        scenario.setup((game, ids, seat, view) -> {
            for (int index = 0; index < ids.size(); index++) {
                choosers.put("seat " + index, ids.indexOf(game.getTeamChooser(ids.get(index))));
            }
        });
        play(scenario, TwoHeadedGiantAuditTest.passing(false));
        assertEquals(Map.of("seat 0", 1, "seat 1", 1, "seat 2", 2, "seat 3", 2), choosers);
    }

    @Test
    void theStartingTeamDecidesItsMulligansFirst() throws Exception {
        // 805.3a: seat 1 starts; its team decides first (seat 1, then seat 0), then team B. XMage's
        // own order went round the table from seat 1: 1, 2, 3, 0.
        List<Integer> order = new CopyOnWriteArrayList<>();
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request(6105L, 1, 1));
        play(scenario, (seat, prompt, view) -> {
            if (prompt.kind().equals("mulligan")) {
                order.add(seat);
            }
            return pass.choose(seat, prompt, view);
        });
        assertEquals(List.of(1, 0, 2, 3), order);
    }

    /**
     * Team A's attack in turn 1: seat 0 attacks with Mogg Flunkies ("can't attack or block alone")
     * at seat 2 and, if {@code teammateAttacks}, seat 1 with Grizzly Bears; asked again with Mogg
     * Flunkies already attacking, seat 0 keeps it, or (when told it can't attack this way) takes it
     * back. Records each seat's attack prompts, the messages seat 0 saw and the most attackers a
     * priority prompt's view showed in combat.
     */
    private static Tables.Policy flunkies(boolean teammateAttacks, Map<Integer, AtomicInteger> asked,
                                          List<String> messages, Map<String, Integer> attacking) {
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        return (seat, prompt, view) -> {
            if (view.turn() != 1) {
                return pass.choose(seat, prompt, view);
            }
            if (seat == 0) {
                view.messages().forEach(message -> {
                    if (!messages.contains(message)) {
                        messages.add(message);
                    }
                });
            }
            int attackers = view.combat().stream().mapToInt(group -> group.attackers().size()).sum();
            if (prompt.kind().equals("priority") && attackers > 0) {
                attacking.merge("attackers", attackers, Math::max);
            }
            switch (prompt.kind()) {
                case "declare_attackers": {
                    asked.computeIfAbsent(seat, key -> new AtomicInteger()).incrementAndGet();
                    String name = seat == 0 ? "Mogg Flunkies" : seat == 1 && teammateAttacks ? "Grizzly Bears" : null;
                    PromptView.Option creature = name == null ? null : option(prompt, "toggle_attacker", name);
                    boolean told = messages.stream().anyMatch(message -> message.contains("can't attack this way"));
                    if (creature != null && !creature.selected() && !(seat == 0 && told)) {
                        return creature.id();
                    }
                    if (creature != null && creature.selected() && seat == 0 && told) {
                        return creature.id(); // takes it back
                    }
                    return done(prompt);
                }
                case "choose_defender":
                    return seatTwo(prompt);
                default:
                    return pass.choose(seat, prompt, view);
            }
        };
    }

    @Test
    void theTeamsAttackIsLegalAsAWhole() throws Exception {
        // 805.10b: Mogg Flunkies attacks beside seat 1's Grizzly Bears, so it does not attack alone.
        // Checked after each player's declaration, seat 0's attack alone was illegal. Seat 0 is asked
        // again once seat 1 has joined the attack, and agrees to it.
        Map<Integer, AtomicInteger> asked = new ConcurrentHashMap<>();
        List<String> messages = new CopyOnWriteArrayList<>();
        Map<String, Integer> attacking = new ConcurrentHashMap<>();
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request(6106L, 1, null))
            .battlefield(0, "Mogg Flunkies").battlefield(1, "Grizzly Bears");
        play(scenario, flunkies(true, asked, messages, attacking));
        System.out.println("Attack prompts by seat: " + asked + "; seat 0's messages: " + messages
            + "; attackers seen by team B: " + attacking);

        assertTrue(messages.stream().noneMatch(message -> message.contains("can't attack this way")),
            "nothing told seat 0 that its attack was illegal: " + messages);
        assertEquals(2, attacking.get("attackers"), "both creatures attacked: " + attacking);
        // Seat 0: toggles Mogg Flunkies, is done; asked again after seat 1 joined, done.
        assertEquals(3, asked.get(0).get(), "seat 0 saw the team's attack again: " + asked);
    }

    @Test
    void aTeamsAttackThatBreaksARestrictionIsDeclaredAgain() throws Exception {
        // 805.10b: seat 1 does not attack, so Mogg Flunkies would attack alone: seat 0 is told and
        // declares again, takes it back, and team A does not attack.
        Map<Integer, AtomicInteger> asked = new ConcurrentHashMap<>();
        List<String> messages = new CopyOnWriteArrayList<>();
        Map<String, Integer> attacking = new ConcurrentHashMap<>();
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request(6107L, 1, null))
            .battlefield(0, "Mogg Flunkies").battlefield(1, "Grizzly Bears");
        play(scenario, flunkies(false, asked, messages, attacking));
        System.out.println("Attack prompts by seat: " + asked + "; seat 0's messages: " + messages);

        assertTrue(messages.stream().anyMatch(message -> message.contains("can't attack this way")),
            "seat 0 was told: " + messages);
        assertTrue(attacking.isEmpty(), "team A did not attack: " + attacking);
    }

    @Test
    void theDefendingTeamsBlockIsLegalAsAWhole() throws Exception {
        // 805.10d: Boggart Brute (menace) attacks seat 2, and seat 2 and seat 3 block it with one
        // creature each. Checked after each player's declaration, seat 2's lone blocker was removed;
        // as one block it is legal, and Boggart Brute is blocked by both. Seat 2 is asked again once
        // seat 3 has joined the block (its Wall of Wood could still block: XMage asks no human
        // player with no creature left that can block).
        Map<String, Integer> blockers = new ConcurrentHashMap<>();
        Map<Integer, AtomicInteger> asked = new ConcurrentHashMap<>();
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request(6108L, 1, null))
            .battlefield(0, "Boggart Brute").battlefield(2, "Grizzly Bears", "Wall of Wood")
            .battlefield(3, "Runeclaw Bear");
        play(scenario, (seat, prompt, view) -> {
            if (view.turn() != 1) {
                return pass.choose(seat, prompt, view);
            }
            switch (prompt.kind()) {
                case "declare_attackers": {
                    PromptView.Option brute = option(prompt, "toggle_attacker", "Boggart Brute");
                    return brute != null && !brute.selected() ? brute.id() : done(prompt);
                }
                case "choose_defender":
                    return seatTwo(prompt);
                case "declare_blockers": {
                    asked.computeIfAbsent(seat, key -> new AtomicInteger()).incrementAndGet();
                    PromptView.Option blocker = option(prompt, "toggle_blocker",
                        seat == 2 ? "Grizzly Bears" : "Runeclaw Bear");
                    return blocker != null && !blocker.selected() ? blocker.id() : done(prompt);
                }
                case "priority":
                    if ("declare_blockers".equals(view.step())) {
                        view.combat().forEach(group -> blockers.merge("blockers", group.blockers().size(), Math::max));
                    }
                    return pass.choose(seat, prompt, view);
                default:
                    return pass.choose(seat, prompt, view);
            }
        });
        System.out.println("Block prompts by seat: " + asked + "; blockers: " + blockers);
        assertEquals(2, blockers.get("blockers"), "Boggart Brute blocked by both: " + blockers);
        // Seat 2: toggles Grizzly Bears, is done; asked again after seat 3 joined, done.
        assertEquals(3, asked.get(2).get(), "seat 2 saw the team's block again: " + asked);
    }

    @Test
    void otherFormatsHaveNoTeamInPrompts() throws Exception {
        // Without teammates nothing changes: no prompt carries a team, and a trigger order names no seat.
        List<String> problems = new CopyOnWriteArrayList<>();
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        var scenario = new TwoHeadedGiantAuditTest.Scenario(new HumanGameRequest(6109L, GameFormat.LEGACY,
                List.of(Tables.human(LegacyDuel.DECKS.get(0)), Tables.human(LegacyDuel.DECKS.get(1))), 1, 3, 900, 0, 0))
            .battlefield(0, "Soul Warden", "Soul's Attendant").battlefield(1, "Grizzly Bears");
        play(scenario, (seat, prompt, view) -> {
            if (prompt.team() != null) {
                problems.add("a team on a " + prompt.kind() + " prompt");
            }
            prompt.options().stream().filter(option -> option.action().equals("put_first") && option.seat() != null)
                .forEach(option -> problems.add("a seat on a trigger: " + option.label()));
            if (prompt.kind().equals("order_triggers")) {
                return prompt.options().get(0).id();
            }
            return pass.choose(seat, prompt, view);
        });
        assertTrue(problems.isEmpty(), "problems: " + problems);
    }
}
