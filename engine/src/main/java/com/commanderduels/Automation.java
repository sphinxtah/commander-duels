package com.commanderduels;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import mage.game.Game;
import mage.game.stack.Spell;
import mage.game.stack.StackAbility;
import mage.game.stack.StackObject;

/**
 * What the engine answers for a seat on the seat's own standing instruction (v0.9.12, the
 * specification's section 14, large boards): the rest of a <b>batch declaration</b>, and
 * <b>yields</b>. Both answer a prompt as it opens, with an option the prompt itself offers, as the
 * seat would have: XMage declares each attacker or blocker and takes each pass as it does one
 * given by hand, so nothing here can make a move the rules do not allow, and the journal keeps
 * each as an ordinary answer, which a game taken up again plays as it plays any other.
 *
 * <h2>Batch declarations</h2>
 * At a declare_attackers or declare_blockers prompt a seat names several of the creatures the
 * prompt offers, in one command, instead of one command a creature. The whole batch is checked
 * against the open prompt before any of it is declared: every object must be one the prompt
 * offers to declare (or, withdrawing, one already declared), and none twice. A batch that fails
 * that is refused whole and declares nothing.
 *
 * <p>XMage may ask a question after a declaration: which player, planeswalker or battle an
 * attacker attacks, which attacker a blocker blocks. A batch may carry the answer ({@code then});
 * one that does not leaves the first such question to the seat, and gives the seat's answer to
 * the questions that follow for the rest of the batch. A batch ends, with what it has declared
 * left declared, when the game asks anything else, when an answer it carries is not offered, or
 * when the seat answers anything but that question. It never confirms the declaration: Done
 * is the seat's own, and XMage checks the whole declaration then as it always does.
 *
 * <h2>Yields</h2>
 * A priority prompt with an object on top of the stack offers "yield": pass now, and pass again
 * each time priority comes with an object of the same source, the same words and the same
 * controller on top. A yield ends:
 * <ul>
 *   <li>when what the seat can do has changed since it yielded: the prompt's choices other than
 *       its passes are not the ones it had then (a card drawn, a land untapped, a new ability).
 *       The prompt is then the seat's to answer, and says why;</li>
 *   <li>at the end of the turn it was made in;</li>
 *   <li>when the seat cancels its passes (set_priority's cancel_passes).</li>
 * </ul>
 * Anything else on top of the stack is the seat's to answer, and leaves the yield as it is. A
 * yield never answers for a player whose turn the seat controls, and never anything but a
 * priority prompt.
 *
 * <p>Neither is kept across a recovery: the journal holds the answers given, not the instruction,
 * so a game taken up again asks the seat from where the answers stop.
 */
final class Automation {
    /** The most objects one batch names: more than any board declares at once. */
    static final int MAX_BATCH = 250;
    static final Set<String> DECLARATIONS = Set.of("declare_attackers", "declare_blockers");
    private static final Set<String> FIELDS = Set.of("objects", "declare", "then");
    private static final Set<String> FOLLOW_FIELDS = Set.of("object_id", "seat");

    /**
     * A batch as a seat sent it.
     *
     * @param objects the creatures, by their ids in the seat's view, in the order to declare them
     * @param declare true to declare them, false to withdraw them
     * @param then    the answer to the question XMage asks after each, or null
     */
    record Batch(List<String> objects, boolean declare, Follow then) {
        String fingerprint() {
            return objects + ":" + declare + ":" + (then == null ? "" : then.objectId() + "/" + then.seat());
        }
    }

    /** An answer to the question after a declaration: an object, or a player by seat. */
    record Follow(String objectId, Integer seat) {
        boolean is(PromptView.Option option) {
            return objectId != null ? objectId.equals(option.objectId())
                : option.objectId() == null && Objects.equals(seat, option.seat());
        }
    }

    /** A batch refused before any of it was declared. */
    static final class Refused extends Exception {
        private static final long serialVersionUID = 1L;

        Refused(String message) {
            super(message);
        }
    }

    /**
     * What to do with a prompt that has just opened.
     *
     * @param optionId the option the engine answers with for the seat, or null to ask the seat
     * @param note     a line for the seat's messages (why a batch or a yield ended), or null
     * @param yielded  whether the answer is a yield's pass
     */
    record Step(String optionId, String note, boolean yielded) {
        static final Step ASK = new Step(null, null, false);
    }

    /** What a yield covers and when it was made. */
    private record Yield(UUID controller, UUID source, String rule, String label, int turn, String decisions) {
        boolean covers(Offer top) {
            return top.controller().equals(controller) && Objects.equals(top.source(), source)
                && top.rule().equals(rule);
        }
    }

    /**
     * The yield a priority prompt offers: the object on top of the stack, as a yield names it.
     *
     * @param label what the seat reads: the source's name
     */
    record Offer(UUID controller, UUID source, String rule, String label) {}

    private static final class Pending {
        final String kind;
        final int promptFor;
        final Deque<String> left;
        final boolean declare;
        final int total;
        Follow then;
        /** The question after a declaration is the seat's to answer: its answer becomes {@code then}. */
        boolean asked;
        int declared;

        Pending(String kind, int promptFor, Batch batch) {
            this.kind = kind;
            this.promptFor = promptFor;
            this.left = new ArrayDeque<>(batch.objects());
            this.declare = batch.declare();
            this.total = batch.objects().size();
            this.then = batch.then();
        }
    }

    private final Map<Integer, Pending> batches = new HashMap<>();
    private final Map<Integer, List<Yield>> yields = new HashMap<>();

    static Batch parse(JsonObject payload) throws JsonRequest.Invalid {
        JsonElement element = payload.get("batch");
        if (element == null || !element.isJsonObject()) {
            throw new JsonRequest.Invalid("payload.batch must be an object");
        }
        JsonObject batch = element.getAsJsonObject();
        JsonRequest.onlyFields(batch, FIELDS, "payload.batch.");
        String problem = "payload.batch.objects must be 1 to " + MAX_BATCH + " object ids, none twice";
        JsonElement listed = batch.get("objects");
        if (listed == null || !listed.isJsonArray() || listed.getAsJsonArray().isEmpty()
                || listed.getAsJsonArray().size() > MAX_BATCH) {
            throw new JsonRequest.Invalid(problem);
        }
        Set<String> objects = new LinkedHashSet<>();
        for (JsonElement item : listed.getAsJsonArray()) {
            if (!item.isJsonPrimitive() || !item.getAsJsonPrimitive().isString()) {
                throw new JsonRequest.Invalid(problem);
            }
            String id = item.getAsString();
            if (id.isEmpty() || id.length() > 64 || !objects.add(id)) {
                throw new JsonRequest.Invalid(problem);
            }
        }
        boolean declare = true;
        if (batch.has("declare")) {
            JsonElement value = batch.get("declare");
            if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isBoolean()) {
                throw new JsonRequest.Invalid("payload.batch.declare must be true or false");
            }
            declare = value.getAsBoolean();
        }
        Follow then = null;
        if (batch.has("then")) {
            JsonElement value = batch.get("then");
            if (!value.isJsonObject()) {
                throw new JsonRequest.Invalid("payload.batch.then must be an object");
            }
            JsonObject follow = value.getAsJsonObject();
            JsonRequest.onlyFields(follow, FOLLOW_FIELDS, "payload.batch.then.");
            if (follow.size() != 1) {
                throw new JsonRequest.Invalid("payload.batch.then needs exactly one of object_id and seat");
            }
            if (follow.has("object_id")) {
                then = new Follow(JsonRequest.string(follow, "object_id", 64), null);
            } else {
                int seat = JsonRequest.integer(follow, "seat").intValueExact();
                if (seat < 0 || seat > 5) {
                    throw new JsonRequest.Invalid("payload.batch.then.seat must be a seat");
                }
                then = new Follow(null, seat);
            }
            if (!declare) {
                throw new JsonRequest.Invalid("payload.batch.then goes with a declaration, not a withdrawal");
            }
        }
        return new Batch(List.copyOf(objects), declare, then);
    }

    /**
     * A seat's batch at its open prompt: checked whole, then begun. Returns the first object's
     * option, which the seat's command answers the prompt with; the rest follow as the prompt
     * opens again ({@link #opened}).
     */
    synchronized String begin(int seat, int promptFor, Prompts.Prompt prompt, Batch batch) throws Refused {
        PromptView view = prompt.view();
        if (!DECLARATIONS.contains(view.kind())) {
            throw new Refused("Only attackers and blockers are declared in a batch");
        }
        String action = view.kind().equals("declare_attackers") ? "toggle_attacker" : "toggle_blocker";
        for (String object : batch.objects()) {
            PromptView.Option option = toggle(view, action, object);
            if (option == null) {
                throw new Refused("The prompt does not offer " + object + " to declare");
            }
            if (option.selected() == batch.declare()) {
                throw new Refused((option.label() == null ? object : option.label())
                    + (batch.declare() ? " is already declared" : " is not declared"));
            }
        }
        Pending pending = new Pending(view.kind(), promptFor, batch);
        String first = toggle(view, action, pending.left.poll()).id();
        pending.declared = 1;
        batches.put(seat, pending);
        return first;
    }

    /**
     * Game thread: a prompt has opened for the seat. The engine's own answer to it, if the seat's
     * batch or one of its yields gives one; else the seat is asked.
     *
     * @param turn the game's turn
     * @param top  the object on top of the stack, as a yield names it ({@link #offer}); null with
     *             an empty stack
     */
    synchronized Step opened(int seat, int promptFor, Prompts.Prompt prompt, int turn, Offer top) {
        PromptView view = prompt.view();
        Pending pending = batches.get(seat);
        if (pending != null) {
            return batchStep(seat, promptFor, view, pending);
        }
        return yieldStep(seat, promptFor, prompt, turn, top);
    }

    private Step batchStep(int seat, int promptFor, PromptView view, Pending pending) {
        if (promptFor != pending.promptFor) {
            return ended(seat, pending, null);
        }
        boolean attackers = pending.kind.equals("declare_attackers");
        if (view.kind().equals(pending.kind)) {
            pending.asked = false;
            if (pending.left.isEmpty()) {
                batches.remove(seat);
                return Step.ASK;
            }
            String next = pending.left.peek();
            PromptView.Option option = toggle(view, attackers ? "toggle_attacker" : "toggle_blocker", next);
            if (option == null || option.selected() == pending.declare) {
                return ended(seat, pending, "one of them can no longer be " + (pending.declare ? "declared" : "withdrawn"));
            }
            pending.left.poll();
            pending.declared++;
            return new Step(option.id(), null, false);
        }
        // The question after a declaration: which defender an attacker attacks, which attacker a
        // blocker blocks.
        if (pending.declare && view.kind().equals(attackers ? "choose_defender" : "choose_target")) {
            if (pending.then == null) {
                // The seat's to answer, once: its answer goes to the rest.
                pending.asked = true;
                return Step.ASK;
            }
            for (PromptView.Option option : view.options()) {
                if (pending.then.is(option)) {
                    return new Step(option.id(), null, false);
                }
            }
            // The creature whose question it is stays undeclared: the seat answers for it.
            pending.declared--;
            return ended(seat, pending, "the " + (attackers ? "defender" : "attacker") + " named is not offered here");
        }
        pending.declared--;
        return ended(seat, pending, "the game asks something else first");
    }

    private Step ended(int seat, Pending pending, String why) {
        batches.remove(seat);
        if (why == null) {
            return Step.ASK;
        }
        String what = pending.kind.equals("declare_attackers") ? "attackers" : "blockers";
        return new Step(null, "The batch stopped after " + Math.max(0, pending.declared) + " of " + pending.total
            + " " + what + ": " + why + ".", false);
    }

    /**
     * Request thread: the seat has answered its open prompt itself. An answer to the question a
     * batch left to it goes to the rest of the batch; any other answer ends the batch.
     */
    synchronized void answered(int seat, PromptView view, String optionId) {
        Pending pending = batches.get(seat);
        if (pending == null) {
            return;
        }
        PromptView.Option chosen = optionId == null ? null : view.options().stream()
            .filter(option -> option.id().equals(optionId)).findFirst().orElse(null);
        if (pending.asked && chosen != null && (chosen.objectId() != null || chosen.seat() != null)) {
            pending.then = new Follow(chosen.objectId(), chosen.objectId() == null ? chosen.seat() : null);
            pending.asked = false;
            return;
        }
        batches.remove(seat);
    }

    /**
     * The yield a priority prompt may offer: for the object on top of the stack, if there is one.
     *
     * @param label what the yielding seat reads for it: its name as that seat sees it, never the
     *              name of an object hidden from the seat
     */
    static Offer offer(Game game, String label) {
        StackObject top = game.getStack().getFirstOrNull();
        return top == null ? null : new Offer(top.getControllerId(), sourceOf(top), ruleOf(top), label);
    }

    /** Request thread: the seat chose a priority prompt's yield. */
    synchronized void yield(int seat, Prompts.Prompt prompt, Offer offer, int turn) {
        List<Yield> held = yields.computeIfAbsent(seat, key -> new ArrayList<>());
        held.removeIf(yield -> yield.turn() != turn || (yield.controller().equals(offer.controller())
            && Objects.equals(yield.source(), offer.source()) && yield.rule().equals(offer.rule())));
        held.add(new Yield(offer.controller(), offer.source(), offer.rule(), offer.label(), turn, decisions(prompt)));
    }

    private Step yieldStep(int seat, int promptFor, Prompts.Prompt prompt, int turn, Offer top) {
        List<Yield> held = yields.get(seat);
        if (held == null) {
            return Step.ASK;
        }
        held.removeIf(yield -> yield.turn() != turn);
        if (held.isEmpty()) {
            yields.remove(seat);
            return Step.ASK;
        }
        PromptView view = prompt.view();
        if (!view.kind().equals("priority") || promptFor != seat || view.forSeat() != null || top == null) {
            return Step.ASK;
        }
        Yield yield = held.stream().filter(candidate -> candidate.covers(top)).findFirst().orElse(null);
        if (yield == null) {
            return Step.ASK;
        }
        if (!yield.decisions().equals(decisions(prompt))) {
            held.remove(yield);
            return new Step(null, "Your yield to " + yield.label() + " has ended: what you can do has changed.",
                false);
        }
        for (PromptView.Option option : view.options()) {
            if (option.action().equals("pass")) {
                return new Step(option.id(), null, true);
            }
        }
        return Step.ASK;
    }

    /** Request thread: the seat cancels its passes, and with them its yields and its batch. */
    synchronized void cancel(int seat) {
        yields.remove(seat);
        batches.remove(seat);
    }

    /** The seat is out of the game, or the game is over. */
    synchronized void forget(int seat) {
        cancel(seat);
    }

    /** What the seat yields to now, for its view: each source's name. */
    synchronized List<String> yielding(int seat, int turn) {
        List<Yield> held = yields.get(seat);
        if (held == null) {
            return List.of();
        }
        return held.stream().filter(yield -> yield.turn() == turn).map(Yield::label).toList();
    }

    /**
     * What the seat can do at a priority prompt, apart from passing: every choice but the passes
     * and the yield, as the journal would keep them. Two prompts with the same give the seat the
     * same things to do.
     */
    static String decisions(Prompts.Prompt prompt) {
        List<String> codes = new ArrayList<>();
        for (PromptView.Option option : prompt.view().options()) {
            if (!option.action().startsWith("pass") && !option.action().equals("yield")) {
                codes.add(option.action() + " " + prompt.code(option.id()));
            }
        }
        codes.sort(null);
        return String.join("\n", codes);
    }

    private static PromptView.Option toggle(PromptView view, String action, String object) {
        for (PromptView.Option option : view.options()) {
            if (option.action().equals(action) && object.equals(option.objectId())) {
                return option;
            }
        }
        return null;
    }

    /** An ability's source; null for a spell, which is its own. */
    private static UUID sourceOf(StackObject object) {
        return object instanceof StackAbility ? object.getSourceId() : null;
    }

    /** What the object says: an ability's rule, or a spell's name (its copies are the same spell). */
    private static String ruleOf(StackObject object) {
        if (object instanceof StackAbility ability) {
            String rule = ability.getStackAbility() == null ? null : ability.getStackAbility().getRule();
            return rule == null ? "" : rule;
        }
        return "spell:" + (object instanceof Spell spell ? spell.getName() : object.getName());
    }
}
