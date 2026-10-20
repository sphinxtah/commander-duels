package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import mage.cards.Card;
import mage.game.Game;
import mage.players.Player;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * A spell XMage lists as castable only because it counts mana from beyond the battlefield's mana
 * abilities: Simian Spirit Guide's from the hand, and convoke's from an untapped creature. The
 * payment prompt must offer both, or the cast ends at a payment whose only option is cancel. The
 * seat's deck list and library are arranged; the bot's deck holds only Islands, so it never
 * interferes. Needs ./db (the card database).
 */
class SpecialPaymentTest {
    private static final String STOKE = "Stoke the Flames";
    private static final String GOBLIN = "Raging Goblin";
    private static final String GUIDE = "Simian Spirit Guide";
    /** The seat's opening hand. The library under it holds only Stoke the Flames: no third land. */
    private static final List<String> HAND = List.of("Mountain", "Mountain", GOBLIN, GUIDE, STOKE, STOKE, STOKE);

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    /** Puts the opening hand on top of seat 0's library and turns off the opening shuffle. */
    static final class Arranged extends SeatChecks {
        Arranged(HumanGameRequest request) throws Exception {
            super(request);
        }

        @Override
        public void beforeStart(Game game, List<UUID> ids) {
            super.beforeStart(game, ids);
            game.getOptions().skipInitShuffling = true;
            Player player = game.getPlayer(ids.get(0));
            List<Card> rest = new ArrayList<>(player.getLibrary().getCards(game));
            LinkedHashSet<Card> ordered = new LinkedHashSet<>();
            for (String name : HAND) {
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

    /**
     * Plays a Mountain each turn and Raging Goblin on the first, then casts Stoke the Flames at the
     * bot as soon as it is offered. It pays with the Mountains first, then the hand, then a special
     * payment, as XMage requires (after convoke, mana abilities no longer pay for the spell).
     */
    static final class Plan implements Tables.Policy {
        volatile boolean casting;
        /** The actions of each payment prompt for Stoke the Flames. */
        final List<List<String>> payments = new CopyOnWriteArrayList<>();
        /** How Stoke the Flames was paid: battlefield, hand or special_payment. */
        final Set<String> paidWith = ConcurrentHashMap.newKeySet();
        final List<String> specialLabels = new CopyOnWriteArrayList<>();

        @Override
        public String choose(int seat, PromptView prompt, SeatView view) {
            List<PromptView.Option> options = prompt.options();
            switch (prompt.kind()) {
                case "priority": {
                    boolean myMain = view.activeSeat() != null && view.activeSeat() == seat
                        && "precombat_main".equals(view.step());
                    if (myMain) {
                        var land = ScriptedPlayer.byAction(options, "play_land");
                        if (!land.isEmpty()) {
                            return land.get(0).id();
                        }
                        boolean goblinOut = view.battlefield().stream()
                            .anyMatch(permanent -> GOBLIN.equals(permanent.card().name()));
                        for (PromptView.Option option : ScriptedPlayer.byAction(options, "cast")) {
                            if (STOKE.equals(option.label()) && payments.isEmpty() && !casting) {
                                casting = true;
                                return option.id();
                            }
                            if (GOBLIN.equals(option.label()) && !goblinOut) {
                                return option.id();
                            }
                        }
                    }
                    casting = false;
                    return ScriptedPlayer.byAction(options, "pass").get(0).id();
                }
                case "pay_mana": {
                    Set<String> battlefield = new HashSet<>();
                    view.battlefield().forEach(permanent -> battlefield.add(permanent.id()));
                    Set<String> hand = new HashSet<>();
                    view.hand().forEach(card -> hand.add(card.id()));
                    if (casting) {
                        payments.add(options.stream().map(PromptView.Option::action).toList());
                    }
                    for (String from : List.of("battlefield", "hand")) {
                        for (PromptView.Option option : ScriptedPlayer.byAction(options, "tap_source")) {
                            if ((from.equals("battlefield") ? battlefield : hand).contains(option.objectId())) {
                                if (casting) {
                                    paidWith.add(from);
                                }
                                return option.id();
                            }
                        }
                    }
                    var special = ScriptedPlayer.byAction(options, "special_payment");
                    if (!special.isEmpty()) {
                        if (casting) {
                            paidWith.add("special_payment");
                        }
                        return special.get(0).id();
                    }
                    return ScriptedPlayer.byAction(options, "cancel").get(0).id();
                }
                case "choose_ability": {
                    var abilities = ScriptedPlayer.byAction(options, "use_ability");
                    abilities.forEach(option -> specialLabels.add(option.label()));
                    return abilities.isEmpty() ? options.get(0).id() : abilities.get(0).id();
                }
                case "choose_target": {
                    if (prompt.message().contains("starting player")) {
                        return seatOption(options, seat);
                    }
                    var done = ScriptedPlayer.byAction(options, "done");
                    if (options.stream().anyMatch(PromptView.Option::selected) && !done.isEmpty()) {
                        return done.get(0).id();
                    }
                    // Stoke the Flames goes at the bot; convoke taps the Goblin.
                    String bot = seatOption(options, 1);
                    if (bot != null) {
                        return bot;
                    }
                    return options.stream().filter(option -> option.objectId() != null && !option.selected())
                        .findFirst().orElse(options.get(0)).id();
                }
                case "mulligan":
                    return ScriptedPlayer.byAction(options, "keep").get(0).id();
                case "declare_attackers":
                case "declare_blockers":
                    return ScriptedPlayer.byAction(options, "done").get(0).id();
                default:
                    return options.stream().filter(option -> !option.action().equals("cancel")).findFirst()
                        .orElse(options.get(0)).id();
            }
        }

        private static String seatOption(List<PromptView.Option> options, int seat) {
            return options.stream().filter(option -> Integer.valueOf(seat).equals(option.seat())).findFirst()
                .map(PromptView.Option::id).orElse(null);
        }
    }

    @Test
    void aSpellPaidFromTheHandAndByConvokeCanBeCast() throws Exception {
        var human = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Mountain", 2),
            new DeckLists.Entry(GOBLIN, 1), new DeckLists.Entry(GUIDE, 1), new DeckLists.Entry(STOKE, 36)), List.of());
        var bot = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Island", 40)), List.of());
        var request = new HumanGameRequest(7007L, GameFormat.LEGACY, List.of(
            new HumanGameRequest.Seat(HumanGameRequest.HUMAN, HumanGameRequest.CUSTOM_DECK, human),
            new HumanGameRequest.Seat(HumanGameRequest.BOT, HumanGameRequest.CUSTOM_DECK, bot)), 1, 6, 900);
        var check = new Arranged(request);
        var coverage = new Tables.Coverage();
        var plan = new Plan();
        HumanGame game = Tables.start(request, check);
        Tables.Played played = Tables.play(game, plan, 4, coverage);
        coverage.summary().forEach(System.out::println);
        System.out.println("Payments for Stoke the Flames: " + plan.payments + "; special payments offered: "
            + plan.specialLabels);

        check.settle();
        assertTrue(check.failures.isEmpty(), "leaks, wrong views or XMage errors: " + check.failures);
        assertTrue(coverage.unsupported.isEmpty(), "unsupported: " + coverage.unsupported);
        assertFalse(plan.payments.isEmpty(), "Stoke the Flames was never offered: " + coverage.kinds);
        assertTrue(plan.payments.stream().noneMatch(actions -> actions.equals(List.of("cancel"))),
            "a payment for a castable spell offered only cancel: " + plan.payments);
        assertEquals(Set.of("battlefield", "hand", "special_payment"), plan.paidWith);
        SeatView last = played.last().view();
        assertEquals(16, last.opponents().get(0).life(), "Stoke the Flames dealt 4 damage to the bot");
        assertTrue(last.you().graveyard().stream().anyMatch(card -> STOKE.equals(card.name())));
        assertTrue(last.you().exile().stream().anyMatch(card -> GUIDE.equals(card.name())),
            "Simian Spirit Guide paid from the hand by exiling itself");
    }
}
