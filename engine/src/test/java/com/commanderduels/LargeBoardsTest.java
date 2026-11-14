package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import mage.game.permanent.token.GoblinToken;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Large boards (v0.9.12, the specification's section 14) in real games: several attackers or
 * blockers declared with one command, a yield to a source's repeated triggers, and what a seat's
 * view of a board of hundreds of tokens costs to build and send. The decisions themselves are
 * tested on prompts made by hand in {@link AutomationTest}. Needs ./db (the card database).
 */
class LargeBoardsTest {
    private static final String BEARS = "Grizzly Bears";

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    private static HumanGameRequest duel(long seed) {
        return new HumanGameRequest(seed, GameFormat.LEGACY,
            List.of(Tables.human(LegacyDuel.DECKS.get(0)), Tables.human(LegacyDuel.DECKS.get(1))), 1, 4, 900, 0, 0);
    }

    private static String first(PromptView prompt, String action) {
        return ScriptedPlayer.byAction(prompt.options(), action).get(0).id();
    }

    private static List<PromptView.Option> offered(PromptView prompt, String action, String label) {
        return prompt.options().stream()
            .filter(option -> option.action().equals(action) && label.equals(option.label())).toList();
    }

    private static String quoted(List<String> ids) {
        return "[\"" + String.join("\",\"", ids) + "\"]";
    }

    private static int lifeOf(SeatView view, int seat) {
        if (view.you() != null && view.you().seat() == seat) {
            return view.you().life();
        }
        return view.opponents().stream().filter(player -> player.seat() == seat).findFirst().orElseThrow().life();
    }

    @Test
    void oneCommandDeclaresManyAttackers() throws Exception {
        // Seat 0 has twelve Grizzly Bears. In turn 3 it declares eight of them with one command,
        // after two batches that are refused whole, and then confirms: the eight attack, the four
        // stay home, and the game heard two answers from the seat for the whole declaration.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(duel(9121L))
            .battlefield(0, Collections.nCopies(12, BEARS).toArray(String[]::new));
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        AtomicInteger declarations = new AtomicInteger();
        List<Integer> declared = new CopyOnWriteArrayList<>();
        List<String> refusals = new CopyOnWriteArrayList<>();
        HumanGame game = Tables.start(scenario.gameRequest, scenario);
        Tables.Played played = Tables.play(game, (seat, prompt, view) -> {
            if (view.turn() != 3 || seat != 0 || !prompt.kind().equals("declare_attackers")) {
                return pass.choose(seat, prompt, view);
            }
            declarations.incrementAndGet();
            List<PromptView.Option> bears = offered(prompt, "toggle_attacker", BEARS);
            long attacking = bears.stream().filter(PromptView.Option::selected).count();
            declared.add((int) attacking);
            if (attacking > 0) {
                return first(prompt, "done");
            }
            List<String> eight = bears.stream().limit(8).map(PromptView.Option::objectId).toList();
            try {
                HumanGame.Snapshot now = game.snapshot(seat, -1, 0, 0);
                // One of them is not the prompt's to declare: nothing is declared.
                List<String> wrong = new ArrayList<>(eight);
                wrong.add("no-such-object");
                HumanGame.Reply refused = game.submit(seat,
                    Tables.batch(game, now.revision(), prompt.id(), "{\"objects\":" + quoted(wrong) + "}"));
                Tables.assertRejected(422, "invalid_batch", refused);
                refusals.add(String.valueOf(refused.body().get("message")));
                // Nor is a withdrawal of attackers that are not declared.
                Tables.assertRejected(422, "invalid_batch", game.submit(seat, Tables.batch(game, now.revision(),
                    prompt.id(), "{\"objects\":" + quoted(eight) + ",\"declare\":false}")));
                HumanGame.Snapshot after = game.snapshot(seat, -1, 0, 0);
                assertEquals(now.revision(), after.revision(), "a refused batch changed the game");
                assertEquals(prompt.id(), after.prompt().id());
            } catch (JsonRequest.Invalid | InterruptedException e) {
                throw new IllegalStateException(e);
            }
            return Tables.BATCH + "{\"objects\":" + quoted(eight) + "}";
        }, 4, new Tables.Coverage());
        scenario.settle();
        assertTrue(scenario.failures.isEmpty(), "leaks or wrong views: " + scenario.failures);

        assertEquals(List.of("The prompt does not offer no-such-object to declare"), refusals);
        assertEquals(List.of(0, 8), declared, "the prompt came back once, with the eight declared");
        assertEquals(2, declarations.get(), "the seat answered twice: the batch, and Done");
        assertEquals(20 - 16, lifeOf(played.last().view(), 1), "eight Bears dealt 16 damage");
    }

    @Test
    void oneCommandDeclaresBlockersOnTheAttackerItNames() throws Exception {
        // Seat 0 attacks with a Hill Giant and a Craw Wurm. Seat 1 blocks the Wurm with three of its
        // five Grizzly Bears in one command that names the Wurm, and confirms: the Wurm (6/4) dies
        // to the three, and the Giant's 3 damage goes through.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(duel(9122L))
            .battlefield(0, "Hill Giant", "Craw Wurm")
            .battlefield(1, Collections.nCopies(5, BEARS).toArray(String[]::new));
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        List<Integer> blocking = new CopyOnWriteArrayList<>();
        Set<String> asked = ConcurrentHashMap.newKeySet();
        HumanGame game = Tables.start(scenario.gameRequest, scenario);
        Tables.Played played = Tables.play(game, (seat, prompt, view) -> {
            if (view.turn() == 3 && seat == 0 && prompt.kind().equals("declare_attackers")) {
                boolean fresh = prompt.options().stream()
                    .anyMatch(option -> option.action().equals("toggle_attacker") && !option.selected());
                return fresh ? first(prompt, "all_attack") : first(prompt, "done");
            }
            if (view.turn() == 3 && seat == 1 && !prompt.kind().equals("priority")) {
                asked.add(prompt.kind());
            }
            if (view.turn() == 3 && seat == 1 && prompt.kind().equals("declare_blockers")) {
                List<PromptView.Option> bears = offered(prompt, "toggle_blocker", BEARS);
                long blockers = bears.stream().filter(PromptView.Option::selected).count();
                blocking.add((int) blockers);
                if (blockers > 0) {
                    return first(prompt, "done");
                }
                String wurm = view.battlefield().stream()
                    .filter(permanent -> "Craw Wurm".equals(permanent.card().name())).findFirst().orElseThrow().id();
                List<String> three = bears.stream().limit(3).map(PromptView.Option::objectId).toList();
                return Tables.BATCH + "{\"objects\":" + quoted(three) + ",\"then\":{\"object_id\":\"" + wurm + "\"}}";
            }
            return pass.choose(seat, prompt, view);
        }, 4, new Tables.Coverage());
        scenario.settle();
        assertTrue(scenario.failures.isEmpty(), "leaks or wrong views: " + scenario.failures);

        assertEquals(List.of(0, 3), blocking, "the prompt came back once, with the three blocking");
        assertEquals(Set.of("declare_blockers"), asked, "which attacker to block was answered by the batch");
        assertEquals(20 - 3, lifeOf(played.last().view(), 1), "only the Giant's damage went through");
        assertFalse(played.last().view().battlefield().stream()
            .anyMatch(permanent -> "Craw Wurm".equals(permanent.card().name())), "three Bears killed the Wurm");
    }

    @Test
    void aBatchWithNoAnswerAsksTheSeatOnceAndUsesItForTheRest() throws Exception {
        // The same attack. Seat 1 declares two blockers in one command that names no attacker: the
        // game asks which attacker the first blocks, the seat says the Giant, and the second blocks
        // the Giant too without the seat being asked again.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(duel(9123L))
            .battlefield(0, "Hill Giant", "Craw Wurm")
            .battlefield(1, Collections.nCopies(5, BEARS).toArray(String[]::new));
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        List<Integer> blocking = new CopyOnWriteArrayList<>();
        List<String> questions = new CopyOnWriteArrayList<>();
        HumanGame game = Tables.start(scenario.gameRequest, scenario);
        Tables.Played played = Tables.play(game, (seat, prompt, view) -> {
            if (view.turn() == 3 && seat == 0 && prompt.kind().equals("declare_attackers")) {
                boolean fresh = prompt.options().stream()
                    .anyMatch(option -> option.action().equals("toggle_attacker") && !option.selected());
                return fresh ? first(prompt, "all_attack") : first(prompt, "done");
            }
            if (view.turn() == 3 && seat == 1 && prompt.kind().equals("declare_blockers")) {
                List<PromptView.Option> bears = offered(prompt, "toggle_blocker", BEARS);
                long blockers = bears.stream().filter(PromptView.Option::selected).count();
                blocking.add((int) blockers);
                if (blockers > 0) {
                    return first(prompt, "done");
                }
                List<String> two = bears.stream().limit(2).map(PromptView.Option::objectId).toList();
                return Tables.BATCH + "{\"objects\":" + quoted(two) + "}";
            }
            if (view.turn() == 3 && seat == 1 && !prompt.kind().equals("priority")
                    && !prompt.kind().equals("assign_amounts")) {
                // Which attacker to block: the Giant.
                questions.add(prompt.kind());
                return prompt.options().stream().filter(option -> "Hill Giant".equals(option.label())).findFirst()
                    .orElseThrow().id();
            }
            return pass.choose(seat, prompt, view);
        }, 4, new Tables.Coverage());
        scenario.settle();
        assertTrue(scenario.failures.isEmpty(), "leaks or wrong views: " + scenario.failures);

        assertEquals(List.of("choose_target"), questions, "the seat was asked which attacker once");
        assertEquals(List.of(0, 2), blocking, "both blockers were declared");
        assertEquals(20 - 6, lifeOf(played.last().view(), 1), "only the Wurm's damage went through");
        assertFalse(played.last().view().battlefield().stream()
            .anyMatch(permanent -> "Hill Giant".equals(permanent.card().name())), "two Bears killed the Giant");
    }

    @Test
    void aYieldPassesForASourcesNextTrigger() throws Exception {
        // Seat 0 has Impact Tremors and casts Dragon Fodder in turn 3: two Goblins, two triggers. It
        // yields at the first; the engine passes for it at the second. Seat 1 does not yield and is
        // asked at both.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(duel(9124L))
            .battlefield(0, "Impact Tremors", "Mountain", "Mountain")
            .hand(0, "Dragon Fodder");
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        List<String> offers = new CopyOnWriteArrayList<>();
        AtomicInteger askedOwner = new AtomicInteger();
        AtomicInteger askedOther = new AtomicInteger();
        Set<List<String>> yielding = ConcurrentHashMap.newKeySet();
        HumanGame game = Tables.start(scenario.gameRequest, scenario);
        Tables.Played played = Tables.play(game, (seat, prompt, view) -> {
            if (seat == 0 && view.priority() != null) {
                yielding.add(view.priority().yields());
            }
            if (view.turn() != 3) {
                return pass.choose(seat, prompt, view);
            }
            if (prompt.kind().equals("pay_mana")) {
                return prompt.options().stream().filter(option -> option.action().equals("tap_source")
                    || option.action().equals("use_pool")).findFirst().orElse(prompt.options().get(0)).id();
            }
            if (!prompt.kind().equals("priority")) {
                return pass.choose(seat, prompt, view);
            }
            boolean trigger = !view.stack().isEmpty() && "Impact Tremors".equals(view.stack().get(0).name());
            if (seat == 1) {
                if (trigger) {
                    askedOther.incrementAndGet();
                }
                return first(prompt, "pass");
            }
            if (trigger) {
                askedOwner.incrementAndGet();
                PromptView.Option yield = ScriptedPlayer.byAction(prompt.options(), "yield").get(0);
                offers.add(yield.label());
                assertEquals(null, yield.objectId(), "a yield is the prompt's choice, not the stack object's");
                return yield.id();
            }
            List<PromptView.Option> fodder = offered(prompt, "cast", "Dragon Fodder");
            return view.stack().isEmpty() && !fodder.isEmpty() && "precombat_main".equals(view.step())
                ? fodder.get(0).id() : first(prompt, "pass");
        }, 4, new Tables.Coverage());
        scenario.settle();
        assertTrue(scenario.failures.isEmpty(), "leaks or wrong views: " + scenario.failures);

        assertEquals(List.of("Pass, and keep passing for Impact Tremors"), offers);
        assertEquals(1, askedOwner.get(), "the yielding seat was asked at the first trigger only");
        assertEquals(2, askedOther.get(), "the other seat was asked at both");
        assertEquals(20 - 2, lifeOf(played.last().view(), 1), "both triggers resolved");
        assertTrue(yielding.contains(List.of("Impact Tremors")), "the seat's view says what it yields to");
        assertEquals(List.of(), played.last().view().priority().yields(), "the yield ended with its turn");
    }

    @Test
    void aBoardOfHundredsOfTokensIsBuiltAndSentWithinBudget() throws Exception {
        // The performance fixture for a large token board: 300 Goblin tokens a seat in a duel.
        measure("duel, 2 seats", duel(9125L), 300);
    }

    @Test
    void sixSeatsOfTokensAreBuiltAndSentWithinBudget() throws Exception {
        // The performance fixture for six seats: King's Table, 100 Goblin tokens a seat, every seat
        // a player's (no bot's search is part of what is measured).
        List<String> decks = GameFormat.KINGS_TABLE_COMMANDER.decks();
        List<HumanGameRequest.Seat> seats = new ArrayList<>();
        for (int seat = 0; seat < 6; seat++) {
            seats.add(Tables.human(decks.get(seat % decks.size())));
        }
        var rules = new KingsTableRules(true, KingsTableRules.ALL_40, false);
        measure("King's Table, 6 seats", new HumanGameRequest(9126L, GameFormat.KINGS_TABLE_COMMANDER, seats, 1, 7,
            900, 0, null, null, rules), 100);
    }

    /**
     * What a seat's view of a board of {@code each} tokens a seat costs to build and to send: every
     * snapshot a seat takes once the board is full, as the service takes it for a client, timed and
     * measured. Printed for docs/engine/large-boards.md, and held under a ceiling several times
     * what this machine and the hosted checks measure, so that only a real regression fails it.
     */
    private static void measure(String name, HumanGameRequest request, int each) throws Exception {
        int seats = request.seats().size();
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request)
            .setup((current, seatIds, seat, view) -> {
                for (var player : seatIds) {
                    new GoblinToken().putOntoBattlefield(each, current, null, player);
                }
            });
        List<Long> nanos = new CopyOnWriteArrayList<>();
        List<Integer> bytes = new CopyOnWriteArrayList<>();
        List<Integer> permanents = new CopyOnWriteArrayList<>();
        List<Integer> choices = new CopyOnWriteArrayList<>();
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        HumanGame game = Tables.start(scenario.gameRequest, scenario);
        Tables.play(game, (seat, prompt, view) -> {
            if (view.battlefield().size() >= seats * each) {
                try {
                    long started = System.nanoTime();
                    HumanGame.Snapshot snapshot = game.snapshot(seat, -1, 0, 0);
                    String sent = EngineServer.JSON.toJson(snapshot);
                    nanos.add(System.nanoTime() - started);
                    bytes.add(sent.length());
                    permanents.add(view.battlefield().size());
                    if (prompt.kind().equals("declare_attackers")) {
                        choices.add(prompt.options().size());
                    }
                } catch (InterruptedException e) {
                    throw new IllegalStateException(e);
                }
            }
            return pass.choose(seat, prompt, view);
        }, 8, new Tables.Coverage());
        scenario.settle();
        assertTrue(scenario.failures.isEmpty(), "leaks or wrong views: " + scenario.failures);

        assertFalse(nanos.isEmpty(), "no view of the full board was taken");
        List<Long> sorted = new ArrayList<>(nanos);
        Collections.sort(sorted);
        long median = sorted.get(sorted.size() / 2) / 1_000;
        long worst = sorted.get(sorted.size() - 1) / 1_000;
        int largest = Collections.max(bytes);
        System.out.println("Large board (" + name + "): " + Collections.max(permanents) + " permanents, "
            + nanos.size() + " snapshots, median " + median + " us, worst " + worst + " us, largest " + largest
            + " bytes of JSON, declare_attackers offers " + (choices.isEmpty() ? 0 : Collections.max(choices))
            + " choices");
        assertTrue(Collections.max(permanents) >= seats * each);
        assertTrue(median < 250_000, "a snapshot of the board took " + median + " us at the median");
        assertTrue(largest < 2_000_000, "a snapshot of the board is " + largest + " bytes");
        assertFalse(choices.isEmpty(), "the tokens were never offered as attackers");
    }
}
