package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/**
 * Batch declarations and yields (v0.9.12, {@link Automation}) on prompts made by hand: what the
 * engine answers for a seat, and everything that makes it stop and ask the seat instead. The
 * real games are in {@link LargeBoardsTest}.
 */
class AutomationTest {
    private static final UUID ME = UUID.randomUUID();
    private static final UUID TREMORS = UUID.randomUUID();
    private static final Automation.Offer TRIGGER =
        new Automation.Offer(ME, TREMORS, "Whenever a creature enters, this deals 1 damage.", "Impact Tremors");

    /** A prompt of options: each "action", "action:object" or "action:object:selected". */
    private static Prompts.Prompt prompt(String kind, Integer forSeat, String... options) {
        List<PromptView.Option> shown = new ArrayList<>();
        Map<String, Prompts.Answer> answers = new LinkedHashMap<>();
        for (String option : options) {
            String[] parts = option.split(":");
            String id = String.valueOf(shown.size() + 1);
            String object = parts.length > 1 && !parts[1].isEmpty() ? parts[1] : null;
            shown.add(new PromptView.Option(id, parts[0], object, object, null,
                parts.length > 2 && parts[2].equals("selected")));
            // The same object is the same answer in every prompt, as a game's own ids are.
            answers.put(id, object == null ? new Prompts.BooleanAnswer(true)
                : new Prompts.UuidAnswer(UUID.nameUUIDFromBytes(object.getBytes())));
        }
        return new Prompts.Prompt(new PromptView(UUID.randomUUID().toString(), kind, "", null, shown, null, null,
            null, forSeat, null), answers, null);
    }

    private static Prompts.Prompt priority(String... playable) {
        List<String> options = new ArrayList<>(List.of("pass", "pass_until_stack_resolved", "yield:top"));
        options.addAll(List.of(playable));
        return prompt("priority", null, options.toArray(String[]::new));
    }

    private static String actionOf(Prompts.Prompt prompt, Automation.Step step) {
        return prompt.view().options().stream().filter(option -> option.id().equals(step.optionId()))
            .map(PromptView.Option::action).findFirst().orElse(null);
    }

    @Test
    void aYieldPassesWhileTheSameSourceIsOnTopAndTheSeatCanDoWhatItCould() {
        var automation = new Automation();
        Prompts.Prompt asked = priority("cast:bolt", "activate_mana:mountain");
        automation.yield(0, asked, TRIGGER, 3);
        assertEquals(List.of("Impact Tremors"), automation.yielding(0, 3));

        // The same ability of the same source on top again, and nothing new to do: the engine passes.
        Prompts.Prompt again = priority("activate_mana:mountain", "cast:bolt");
        Automation.Step step = automation.opened(0, 0, again, 3, TRIGGER);
        assertEquals("pass", actionOf(again, step));
        assertTrue(step.yielded());
        assertNull(step.note());

        // Something else on top is the seat's to answer, and leaves the yield as it is.
        var other = new Automation.Offer(UUID.randomUUID(), null, "spell:Lightning Bolt", "Lightning Bolt");
        assertEquals(Automation.Step.ASK, automation.opened(0, 0, again, 3, other));
        var sameWordsOtherSource = new Automation.Offer(ME, UUID.randomUUID(), TRIGGER.rule(), "Impact Tremors");
        assertEquals(Automation.Step.ASK, automation.opened(0, 0, again, 3, sameWordsOtherSource));
        var otherController = new Automation.Offer(UUID.randomUUID(), TREMORS, TRIGGER.rule(), "Impact Tremors");
        assertEquals(Automation.Step.ASK, automation.opened(0, 0, again, 3, otherController));
        assertEquals("pass", actionOf(again, automation.opened(0, 0, again, 3, TRIGGER)));

        // Never with an empty stack, for another kind of question, or for a player whose turn the
        // seat controls.
        assertEquals(Automation.Step.ASK, automation.opened(0, 0, again, 3, null));
        assertEquals(Automation.Step.ASK,
            automation.opened(0, 0, prompt("yes_no", null, "yes", "no"), 3, TRIGGER));
        assertEquals(Automation.Step.ASK, automation.opened(0, 1, again, 3, TRIGGER));
        assertEquals(Automation.Step.ASK,
            automation.opened(0, 0, prompt("priority", 1, "pass", "cast:bolt", "activate_mana:mountain"), 3, TRIGGER));
        // Another seat has no yield.
        assertEquals(Automation.Step.ASK, automation.opened(1, 1, again, 3, TRIGGER));
        assertEquals(List.of(), automation.yielding(1, 3));
    }

    @Test
    void aYieldEndsWhenWhatTheSeatCanDoChanges() {
        var automation = new Automation();
        automation.yield(0, priority("cast:bolt"), TRIGGER, 3);

        // A card drawn: a second spell to cast. The seat is asked, and told why.
        Prompts.Prompt more = priority("cast:bolt", "cast:shock");
        Automation.Step stopped = automation.opened(0, 0, more, 3, TRIGGER);
        assertNull(stopped.optionId());
        assertEquals("Your yield to Impact Tremors has ended: what you can do has changed.", stopped.note());
        // It is gone: the prompt it was made at would no longer be passed.
        assertEquals(Automation.Step.ASK, automation.opened(0, 0, priority("cast:bolt"), 3, TRIGGER));
        assertEquals(List.of(), automation.yielding(0, 3));

        // Less to do is a change too: the spell is no longer castable.
        automation.yield(0, priority("cast:bolt"), TRIGGER, 3);
        assertNotNull(automation.opened(0, 0, priority(), 3, TRIGGER).note());
        // The passes a prompt offers are not what the seat can do: the stack's own pass comes and goes.
        automation.yield(0, priority("cast:bolt"), TRIGGER, 3);
        Prompts.Prompt fewerPasses = prompt("priority", null, "pass", "cast:bolt");
        assertEquals("pass", actionOf(fewerPasses, automation.opened(0, 0, fewerPasses, 3, TRIGGER)));
    }

    @Test
    void aYieldEndsWithItsTurnAndWhenPassesAreCancelled() {
        var automation = new Automation();
        Prompts.Prompt asked = priority("cast:bolt");
        automation.yield(0, asked, TRIGGER, 3);
        assertEquals(List.of(), automation.yielding(0, 4));
        assertEquals(Automation.Step.ASK, automation.opened(0, 0, asked, 4, TRIGGER));
        // Not brought back by the turn's number coming round in the same call order.
        assertEquals(Automation.Step.ASK, automation.opened(0, 0, asked, 3, TRIGGER));

        automation.yield(0, asked, TRIGGER, 5);
        automation.cancel(0);
        assertEquals(Automation.Step.ASK, automation.opened(0, 0, asked, 5, TRIGGER));

        // Yielding to the same thing twice keeps one yield, with what the seat can do now.
        automation.yield(0, asked, TRIGGER, 6);
        automation.yield(0, priority("cast:bolt", "cast:shock"), TRIGGER, 6);
        assertEquals(List.of("Impact Tremors"), automation.yielding(0, 6));
        Prompts.Prompt now = priority("cast:bolt", "cast:shock");
        assertEquals("pass", actionOf(now, automation.opened(0, 0, now, 6, TRIGGER)));
    }

    private static Prompts.Prompt attackers(String... options) {
        List<String> all = new ArrayList<>(List.of(options));
        all.add("all_attack");
        all.add("done");
        return prompt("declare_attackers", null, all.toArray(String[]::new));
    }

    @Test
    void aBatchIsCheckedWholeBeforeAnyOfItIsDeclared() {
        var automation = new Automation();
        Prompts.Prompt open = attackers("toggle_attacker:a", "toggle_attacker:b", "toggle_attacker:c:selected");
        var refused = assertThrows(Automation.Refused.class, () -> automation.begin(0, 0, open,
            new Automation.Batch(List.of("a", "x"), true, null)));
        assertEquals("The prompt does not offer x to declare", refused.getMessage());
        assertEquals("c is already declared", assertThrows(Automation.Refused.class, () -> automation.begin(0, 0, open,
            new Automation.Batch(List.of("a", "c"), true, null))).getMessage());
        assertEquals("a is not declared", assertThrows(Automation.Refused.class, () -> automation.begin(0, 0, open,
            new Automation.Batch(List.of("c", "a"), false, null))).getMessage());
        // Done and All attack are not creatures to declare, and a batch is for declarations only.
        assertThrows(Automation.Refused.class, () -> automation.begin(0, 0, open,
            new Automation.Batch(List.of("done"), true, null)));
        assertEquals("Only attackers and blockers are declared in a batch", assertThrows(Automation.Refused.class,
            () -> automation.begin(0, 0, priority("cast:a"), new Automation.Batch(List.of("a"), true, null)))
            .getMessage());
        // Nothing was begun: the next prompt is the seat's.
        assertEquals(Automation.Step.ASK, automation.opened(0, 0, open, 3, null));
    }

    @Test
    void aBatchDeclaresEachInTurnAndLeavesDoneToTheSeat() throws Exception {
        var automation = new Automation();
        Prompts.Prompt first = attackers("toggle_attacker:a", "toggle_attacker:b", "toggle_attacker:c");
        String begun = automation.begin(0, 0, first, new Automation.Batch(List.of("b", "c", "a"), true, null));
        assertEquals("b", first.view().options().get(Integer.parseInt(begun) - 1).objectId());

        Prompts.Prompt second = attackers("toggle_attacker:a", "toggle_attacker:b:selected", "toggle_attacker:c");
        Automation.Step step = automation.opened(0, 0, second, 3, null);
        assertEquals("c", second.view().options().get(Integer.parseInt(step.optionId()) - 1).objectId());
        assertFalse(step.yielded());

        Prompts.Prompt third =
            attackers("toggle_attacker:a", "toggle_attacker:b:selected", "toggle_attacker:c:selected");
        step = automation.opened(0, 0, third, 3, null);
        assertEquals("a", third.view().options().get(Integer.parseInt(step.optionId()) - 1).objectId());

        // All three are declared: the prompt, with Done, is the seat's.
        Prompts.Prompt last = attackers("toggle_attacker:a:selected", "toggle_attacker:b:selected",
            "toggle_attacker:c:selected");
        assertEquals(Automation.Step.ASK, automation.opened(0, 0, last, 3, null));
        // And the batch is over: the prompt opening again is answered by nobody.
        assertEquals(Automation.Step.ASK, automation.opened(0, 0, first, 3, null));

        // A withdrawal takes declared attackers back the same way.
        String withdrawn = automation.begin(0, 0, last, new Automation.Batch(List.of("a", "b"), false, null));
        assertEquals("a", last.view().options().get(Integer.parseInt(withdrawn) - 1).objectId());
        Prompts.Prompt after = attackers("toggle_attacker:a", "toggle_attacker:b:selected", "toggle_attacker:c:selected");
        step = automation.opened(0, 0, after, 3, null);
        assertEquals("b", after.view().options().get(Integer.parseInt(step.optionId()) - 1).objectId());
    }

    @Test
    void aBatchAnswersTheQuestionAfterADeclarationOrAsksTheSeatOnce() throws Exception {
        Prompts.Prompt open = attackers("toggle_attacker:a", "toggle_attacker:b", "toggle_attacker:c");
        Prompts.Prompt whom = new Prompts.Prompt(new PromptView(UUID.randomUUID().toString(), "choose_defender", "",
            null, List.of(new PromptView.Option("1", "choose", "Human 2", null, 1, false),
                new PromptView.Option("2", "choose", "Human 3", null, 2, false),
                new PromptView.Option("3", "choose", "Jace", "jace", null, false)), null, null, null, null, null),
            Map.of("1", new Prompts.UuidAnswer(UUID.randomUUID()), "2", new Prompts.UuidAnswer(UUID.randomUUID()),
                "3", new Prompts.UuidAnswer(UUID.randomUUID())), null);
        Prompts.Prompt one = attackers("toggle_attacker:a:selected", "toggle_attacker:b", "toggle_attacker:c");

        // With the answer in the batch: a player by seat, or an object.
        var automation = new Automation();
        automation.begin(0, 0, open, new Automation.Batch(List.of("a", "b"), true, new Automation.Follow(null, 2)));
        assertEquals("2", automation.opened(0, 0, whom, 3, null).optionId());
        assertEquals("b", one.view().options().get(
            Integer.parseInt(automation.opened(0, 0, one, 3, null).optionId()) - 1).objectId());
        assertEquals("2", automation.opened(0, 0, whom, 3, null).optionId());
        automation.cancel(0);
        automation.begin(0, 0, open, new Automation.Batch(List.of("a"), true, new Automation.Follow("jace", null)));
        assertEquals("3", automation.opened(0, 0, whom, 3, null).optionId());
        automation.cancel(0);

        // An answer the question does not offer ends the batch there, and says so.
        automation.begin(0, 0, open, new Automation.Batch(List.of("a", "b"), true, new Automation.Follow(null, 5)));
        Automation.Step stopped = automation.opened(0, 0, whom, 3, null);
        assertNull(stopped.optionId());
        assertEquals("The batch stopped after 0 of 2 attackers: the defender named is not offered here.",
            stopped.note());
        assertEquals(Automation.Step.ASK, automation.opened(0, 0, one, 3, null));

        // With no answer: the seat is asked once, and its answer goes to the rest.
        automation.begin(0, 0, open, new Automation.Batch(List.of("a", "b", "c"), true, null));
        assertEquals(Automation.Step.ASK, automation.opened(0, 0, whom, 3, null));
        automation.answered(0, whom.view(), "1");
        assertEquals("b", one.view().options().get(
            Integer.parseInt(automation.opened(0, 0, one, 3, null).optionId()) - 1).objectId());
        assertEquals("1", automation.opened(0, 0, whom, 3, null).optionId());
    }

    @Test
    void aBatchEndsWhenTheGameAsksSomethingElseOrTheSeatAnswersItself() throws Exception {
        Prompts.Prompt open = attackers("toggle_attacker:a", "toggle_attacker:b", "toggle_attacker:c");
        var automation = new Automation();

        // A cost to pay, say: the question is the seat's, and the batch is over.
        automation.begin(0, 0, open, new Automation.Batch(List.of("a", "b", "c"), true, null));
        Automation.Step stopped = automation.opened(0, 0, prompt("yes_no", null, "yes", "no"), 3, null);
        assertNull(stopped.optionId());
        assertEquals("The batch stopped after 0 of 3 attackers: the game asks something else first.", stopped.note());
        assertEquals(Automation.Step.ASK, automation.opened(0, 0, open, 3, null));

        // One of them is no longer offered (it left the battlefield, or cannot attack after all).
        automation.begin(0, 0, open, new Automation.Batch(List.of("a", "b", "c"), true, null));
        Prompts.Prompt without = attackers("toggle_attacker:a:selected", "toggle_attacker:c");
        stopped = automation.opened(0, 0, without, 3, null);
        assertEquals("The batch stopped after 1 of 3 attackers: one of them can no longer be declared.",
            stopped.note());

        // The seat's own answer to the declaration (a toggle by hand, Done) ends it.
        automation.begin(0, 0, open, new Automation.Batch(List.of("a", "b", "c"), true, null));
        Prompts.Prompt one = attackers("toggle_attacker:a:selected", "toggle_attacker:b", "toggle_attacker:c");
        automation.answered(0, one.view(), "5");
        assertEquals(Automation.Step.ASK, automation.opened(0, 0, one, 3, null));

        // A prompt for another player (a turn the seat controls) is not the batch's.
        automation.begin(0, 0, open, new Automation.Batch(List.of("a", "b"), true, null));
        assertEquals(Automation.Step.ASK, automation.opened(0, 1, one, 3, null));
        assertEquals(Automation.Step.ASK, automation.opened(0, 0, one, 3, null));
    }

    @Test
    void aBatchsPayloadIsParsedStrictly() throws Exception {
        String head = "{\"v\":1,\"game_id\":\"" + ME + "\",\"action_id\":\"" + UUID.randomUUID()
            + "\",\"expected_revision\":4,\"prompt_id\":\"" + UUID.randomUUID()
            + "\",\"type\":\"submit_choice\",\"payload\":";
        SeatCommand parsed = SeatCommand.parse(head + "{\"batch\":{\"objects\":[\"a\",\"b\"],\"then\":{\"seat\":2}}}}",
            ME.toString());
        assertEquals(new Automation.Batch(List.of("a", "b"), true, new Automation.Follow(null, 2)), parsed.batch());
        assertNull(parsed.optionId());
        SeatCommand withdrawal = SeatCommand.parse(head + "{\"batch\":{\"objects\":[\"a\"],\"declare\":false}}}",
            ME.toString());
        assertFalse(withdrawal.batch().declare());
        // The batch is part of what a retried command must repeat.
        assertFalse(parsed.fingerprint().equals(withdrawal.fingerprint()));

        for (String bad : List.of(
                "{\"batch\":{\"objects\":[]}}",
                "{\"batch\":{\"objects\":[\"a\",\"a\"]}}",
                "{\"batch\":{\"objects\":[1]}}",
                "{\"batch\":{\"objects\":\"a\"}}",
                "{\"batch\":{}}",
                "{\"batch\":[\"a\"]}",
                "{\"batch\":{\"objects\":[\"a\"],\"confirm\":true}}",
                "{\"batch\":{\"objects\":[\"a\"],\"declare\":\"yes\"}}",
                "{\"batch\":{\"objects\":[\"a\"],\"then\":{}}}",
                "{\"batch\":{\"objects\":[\"a\"],\"then\":{\"seat\":9}}}",
                "{\"batch\":{\"objects\":[\"a\"],\"then\":{\"seat\":1,\"object_id\":\"b\"}}}",
                "{\"batch\":{\"objects\":[\"a\"],\"declare\":false,\"then\":{\"seat\":1}}}",
                "{\"batch\":{\"objects\":[\"a\"]},\"option_id\":\"1\"}")) {
            assertThrows(JsonRequest.Invalid.class, () -> SeatCommand.parse(head + bad + "}", ME.toString()), bad);
        }
        StringBuilder many = new StringBuilder("{\"batch\":{\"objects\":[");
        for (int index = 0; index <= Automation.MAX_BATCH; index++) {
            many.append(index == 0 ? "" : ",").append("\"o").append(index).append('"');
        }
        assertThrows(JsonRequest.Invalid.class,
            () -> SeatCommand.parse(head + many + "]}}}", ME.toString()));
    }
}
