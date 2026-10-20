package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import mage.cards.Card;
import mage.game.Game;
import mage.players.Player;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Priority controls (UI07) and T10 in real games against a bot whose deck holds only Islands, so it
 * never acts. The seat's library is arranged. Needs ./db (the card database).
 */
class PriorityControlsTest {
    private static final String BOLT = "Lightning Bolt";
    private static final String GOBLIN = "Raging Goblin";

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    /** Puts the given cards on top of seat 0's library, in order, and turns off the shuffle. */
    static final class Arranged extends SeatChecks {
        private final List<String> top;

        Arranged(HumanGameRequest request, List<String> top) throws Exception {
            super(request);
            this.top = top;
        }

        @Override
        public void beforeStart(Game game, List<UUID> ids) {
            super.beforeStart(game, ids);
            game.getOptions().skipInitShuffling = true;
            Player player = game.getPlayer(ids.get(0));
            List<Card> rest = new ArrayList<>(player.getLibrary().getCards(game));
            LinkedHashSet<Card> ordered = new LinkedHashSet<>();
            for (String name : top) {
                Card card = rest.stream().filter(candidate -> candidate.getName().equals(name)).findFirst()
                    .orElseThrow(() -> new IllegalStateException(name + " is not in the deck"));
                rest.remove(card);
                ordered.add(card);
            }
            ordered.addAll(rest);
            player.getLibrary().clear();
            player.getLibrary().addAll(ordered, game);
        }
    }

    private static HumanGameRequest request(long seed, List<DeckLists.Entry> deck) {
        var human = new DeckLists.CustomDeck(deck, List.of());
        var bot = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Island", 40)), List.of());
        return new HumanGameRequest(seed, GameFormat.LEGACY, List.of(
            new HumanGameRequest.Seat(HumanGameRequest.HUMAN, HumanGameRequest.CUSTOM_DECK, human),
            new HumanGameRequest.Seat(HumanGameRequest.BOT, HumanGameRequest.CUSTOM_DECK, bot)), 1, 8, 900);
    }

    static SeatCommand priority(HumanGame game, String payload) throws JsonRequest.Invalid {
        return SeatCommand.parse("{\"v\":1,\"game_id\":\"" + game.id() + "\",\"action_id\":\"" + UUID.randomUUID()
            + "\",\"expected_revision\":0,\"type\":\"set_priority\",\"payload\":" + payload + "}", game.id());
    }

    private static String seatOption(List<PromptView.Option> options, int seat) {
        return options.stream().filter(option -> Integer.valueOf(seat).equals(option.seat())).findFirst()
            .map(PromptView.Option::id).orElse(null);
    }

    /** A prompt answered, and where it came: turn, step and stack size. */
    record Seen(int turn, String step, String kind, int stack, List<String> actions) {}

    /**
     * Holds priority after Lightning Bolt to cast a second one in response (a nested stack), both at
     * the seat's own Raging Goblin: the second kills it, the first loses its only target. Then a
     * payment cancelled midway: the spell goes back to the hand and no land stays tapped (T10).
     */
    static final class Responses implements Tables.Policy {
        final List<Seen> seen = new CopyOnWriteArrayList<>();
        volatile int bolts;
        volatile boolean cancelled;
        volatile boolean cancelling;
        volatile boolean resolving;
        volatile String goblin;
        volatile int handBoltsBeforeCancel = -1;
        volatile int handBoltsAfterCancel = -1;
        volatile long untappedAfterCancel = -1;

        @Override
        public String choose(int seat, PromptView prompt, SeatView view) {
            List<PromptView.Option> options = prompt.options();
            seen.add(new Seen(view.turn(), view.step(), prompt.kind(), view.stack().size(),
                options.stream().map(PromptView.Option::action).toList()));
            boolean mine = view.activeSeat() != null && view.activeSeat() == seat;
            switch (prompt.kind()) {
                case "priority": {
                    if (cancelling) {
                        cancelling = false;
                        handBoltsAfterCancel = (int) view.hand().stream().filter(c -> BOLT.equals(c.name())).count();
                        untappedAfterCancel = view.battlefield().stream()
                            .filter(p -> p.controllerSeat() == seat && "Mountain".equals(p.card().name())
                                && !p.tapped()).count();
                    }
                    if (mine && view.step() != null && view.step().endsWith("main")) {
                        var land = ScriptedPlayer.byAction(options, "play_land");
                        if (!land.isEmpty()) {
                            return land.get(0).id();
                        }
                        var goblins = view.battlefield().stream()
                            .filter(p -> GOBLIN.equals(p.card().name()) && p.controllerSeat() == seat).toList();
                        for (PromptView.Option option : ScriptedPlayer.byAction(options, "cast")) {
                            if (GOBLIN.equals(option.label()) && goblins.isEmpty() && bolts == 0) {
                                return option.id();
                            }
                            if (BOLT.equals(option.label()) && !goblins.isEmpty() && bolts < 2) {
                                goblin = goblins.get(0).id();
                                bolts++;
                                return option.id();
                            }
                            if (BOLT.equals(option.label()) && bolts == 2 && !resolving && view.stack().isEmpty()
                                && !cancelled) {
                                cancelled = true;
                                cancelling = true;
                                handBoltsBeforeCancel = (int) view.hand().stream()
                                    .filter(c -> BOLT.equals(c.name())).count();
                                return option.id();
                            }
                        }
                        if (view.stack().size() == 2) {
                            resolving = true;
                            return ScriptedPlayer.byAction(options, "pass_until_stack_resolved").get(0).id();
                        }
                    }
                    if (view.stack().isEmpty()) {
                        resolving = false;
                    }
                    return ScriptedPlayer.byAction(options, "pass").get(0).id();
                }
                case "pay_mana": {
                    if (cancelling) {
                        return ScriptedPlayer.byAction(options, "cancel").get(0).id();
                    }
                    var tap = ScriptedPlayer.byAction(options, "tap_source");
                    return tap.isEmpty() ? ScriptedPlayer.byAction(options, "cancel").get(0).id() : tap.get(0).id();
                }
                case "choose_target": {
                    if (prompt.message().contains("starting player")) {
                        return seatOption(options, seat);
                    }
                    if (cancelling) {
                        String bot = seatOption(options, 1);
                        if (bot != null) {
                            return bot;
                        }
                    }
                    var target = options.stream().filter(o -> goblin != null && goblin.equals(o.objectId()))
                        .findFirst();
                    if (target.isPresent()) {
                        return target.get().id();
                    }
                    var done = ScriptedPlayer.byAction(options, "done");
                    return done.isEmpty() ? options.get(0).id() : done.get(0).id();
                }
                case "mulligan":
                    return ScriptedPlayer.byAction(options, "keep").get(0).id();
                default:
                    var done = ScriptedPlayer.byAction(options, "done");
                    return done.isEmpty() ? options.get(0).id() : done.get(0).id();
            }
        }
    }

    @Test
    void heldPriorityNestsResponsesAndAnIllegalTargetDoesNothing() throws Exception {
        var request = request(101L, List.of(new DeckLists.Entry("Mountain", 20), new DeckLists.Entry(GOBLIN, 2),
            new DeckLists.Entry(BOLT, 18)));
        var check = new Arranged(request, List.of("Mountain", GOBLIN, BOLT, BOLT, "Mountain", "Mountain", BOLT,
            "Mountain", "Mountain"));
        var policy = new Responses();
        HumanGame game = Tables.start(request, check);
        Tables.Played played = Tables.play(game, policy, 4, new Tables.Coverage());
        check.settle();
        assertTrue(check.failures.isEmpty(), "leaks, wrong views or XMage errors: " + check.failures);
        assertEquals(2, policy.bolts, "both Bolts were cast: " + policy.seen);
        assertTrue(policy.seen.stream().anyMatch(seen -> seen.kind().equals("priority") && seen.stack() == 2),
            "the seat held priority with its first Bolt on the stack and cast a second: " + policy.seen);
        assertTrue(policy.seen.stream().filter(seen -> seen.kind().equals("priority") && seen.stack() > 0)
            .allMatch(seen -> seen.actions().contains("pass_until_stack_resolved")));
        assertTrue(policy.seen.stream().filter(seen -> seen.kind().equals("priority") && seen.stack() == 0)
            .noneMatch(seen -> seen.actions().contains("pass_until_stack_resolved")));
        SeatView last = played.last().view();
        assertEquals(20, last.opponents().get(0).life(), "no Bolt reached the bot");
        long boltsInGraveyard = last.you().graveyard().stream().filter(card -> BOLT.equals(card.name())).count();
        assertTrue(boltsInGraveyard >= 2, "both Bolts went to the graveyard: " + last.you().graveyard());
        assertTrue(last.you().graveyard().stream().anyMatch(card -> GOBLIN.equals(card.name())),
            "the second Bolt killed the Goblin, so the first had no legal target");
        assertTrue(policy.cancelled, "a payment was started and cancelled");
        assertEquals(policy.handBoltsBeforeCancel, policy.handBoltsAfterCancel,
            "the cancelled Bolt went back to the hand");
        assertTrue(policy.untappedAfterCancel >= 1, "the cancelled payment left its land untapped");
    }

    /** Records where the seat was asked, and switches modes as it goes. */
    static final class Modes implements Tables.Policy {
        final List<Seen> seen = new CopyOnWriteArrayList<>();
        volatile HumanGame game;
        volatile int passedUntilNextTurnOn = -1;
        volatile int fullControlFrom = -1;
        volatile Map<String, Object> fullReply;
        volatile Map<String, Object> backReply;

        @Override
        public String choose(int seat, PromptView prompt, SeatView view) {
            seen.add(new Seen(view.turn(), view.step(), prompt.kind(), view.stack().size(),
                prompt.options().stream().map(PromptView.Option::action).toList()));
            List<PromptView.Option> options = prompt.options();
            switch (prompt.kind()) {
                case "priority": {
                    assertTrue(view.priority() != null, "a seat's view carries its priority controls");
                    if (view.turn() == 2 && passedUntilNextTurnOn < 0) {
                        passedUntilNextTurnOn = 2;
                        return ScriptedPlayer.byAction(options, "pass_until_next_turn").get(0).id();
                    }
                    if (view.turn() == 7 && backReply == null) {
                        try {
                            backReply = game.setPriority(seat,
                                priority(game, "{\"full_control\":false,\"cancel_passes\":true}")).body();
                        } catch (JsonRequest.Invalid e) {
                            throw new IllegalStateException(e);
                        }
                    }
                    if (view.turn() == 4 && fullControlFrom < 0) {
                        fullControlFrom = 4;
                        try {
                            HumanGame.Reply reply = game.setPriority(seat, priority(game, "{\"full_control\":true}"));
                            assertEquals(200, reply.status(), reply.body().toString());
                            fullReply = reply.body();
                        } catch (JsonRequest.Invalid e) {
                            throw new IllegalStateException(e);
                        }
                    }
                    return ScriptedPlayer.byAction(options, "pass").get(0).id();
                }
                case "choose_target":
                    if (prompt.message().contains("starting player")) {
                        return seatOption(options, seat);
                    }
                    return options.get(0).id();
                case "mulligan":
                    return ScriptedPlayer.byAction(options, "keep").get(0).id();
                default:
                    var done = ScriptedPlayer.byAction(options, "done");
                    return done.isEmpty() ? options.get(0).id() : done.get(0).id();
            }
        }
    }

    @Test
    void passModesStopsAndFullControl() throws Exception {
        var request = request(202L, List.of(new DeckLists.Entry("Mountain", 40)));
        var check = new Arranged(request, List.of());
        var policy = new Modes();
        HumanGame game = Tables.start(request, check);
        policy.game = game;
        int seat = game.humanSeats().get(0);
        // Before any pass: the defaults, XMage's, stop only in the main phases.
        HumanGame.Reply plain = game.setPriority(seat, priority(game, "{\"stop_on_attackers\":true}"));
        var controls = (SeatView.PriorityControls) plain.body().get("priority");
        assertEquals(List.of("main1", "main2"), controls.yourTurn());
        assertFalse(controls.fullControl());
        assertNull(controls.passing());
        Tables.play(game, policy, 4, new Tables.Coverage());
        check.settle();
        assertTrue(check.failures.isEmpty(), "leaks, wrong views or XMage errors: " + check.failures);
        // Passing until the next turn on turn 2: no further prompt in turn 2.
        assertEquals(1, policy.seen.stream().filter(seen -> seen.turn() == 2 && seen.kind().equals("priority"))
            .count(), "one prompt in turn 2, then the pass ran to its end: " + policy.seen);
        // Before full control the seat is never asked in an upkeep; after it, it is.
        assertTrue(policy.seen.stream().filter(seen -> seen.turn() < 4)
            .noneMatch(seen -> "upkeep".equals(seen.step())), policy.seen.toString());
        assertTrue(policy.seen.stream().filter(seen -> seen.turn() > 4 && seen.turn() < 7)
            .anyMatch(seen -> "upkeep".equals(seen.step())), policy.seen.toString());
        var full = (SeatView.PriorityControls) policy.fullReply.get("priority");
        assertTrue(full.fullControl());
        assertEquals(7, full.yourTurn().size());
        // Turning full control off returns to the defaults; cancel ends any pass.
        var back = (SeatView.PriorityControls) policy.backReply.get("priority");
        assertEquals(List.of("main1", "main2"), back.yourTurn());
        assertFalse(back.fullControl());
        assertNull(back.passing());
        // Once the game is over, nothing changes.
        Tables.assertRejected(409, "game_over", game.setPriority(seat, priority(game, "{\"cancel_passes\":true}")));
    }

    @Test
    void priorityCommandsAreValidated() {
        String id = UUID.randomUUID().toString();
        String start = "{\"v\":1,\"game_id\":\"" + id + "\",\"action_id\":\"" + UUID.randomUUID()
            + "\",\"expected_revision\":0,\"type\":\"set_priority\",";
        assertThrows(JsonRequest.Invalid.class, () -> SeatCommand.parse(start + "\"payload\":{}}", id));
        assertThrows(JsonRequest.Invalid.class,
            () -> SeatCommand.parse(start + "\"payload\":{\"your_turn\":[\"cleanup\"]}}", id));
        assertThrows(JsonRequest.Invalid.class,
            () -> SeatCommand.parse(start + "\"payload\":{\"full_control\":\"yes\"}}", id));
        assertThrows(JsonRequest.Invalid.class,
            () -> SeatCommand.parse(start + "\"payload\":{\"surprise\":true}}", id));
        assertThrows(JsonRequest.Invalid.class, () -> SeatCommand.parse(start + "\"prompt_id\":\""
            + UUID.randomUUID() + "\",\"payload\":{\"cancel_passes\":true}}", id));
    }
}
