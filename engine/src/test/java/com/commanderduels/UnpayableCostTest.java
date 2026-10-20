package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * XMage asks whether to pay an optional cost before it checks that the player can pay it: Chain
 * Lightning asks the player it hit "Pay {R}{R} to copy the spell?". A player with only Forests who
 * says yes reaches a payment that nothing can finish. The payment must then offer only cancel: no
 * Forest (XMage taps it, and the green mana cannot pay {R}{R}) and no green pool mana (XMage asks
 * again, forever). CI run #24's test player tapped the Forests, then answered with the pool's green
 * mana until the 600-prompt guard stopped the game. Bears are the control: a castable spell's
 * payment still offers its Forests. Needs ./db (the card database).
 */
class UnpayableCostTest {
    private static final String BEARS = "Grizzly Bears";
    private static final String COPY_QUESTION = "to copy the spell";
    /** CI run #24's guard was 600 prompts; a payment asked this often in a row is a loop. */
    private static final int LOOP = 20;

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    /** CI run #24's test player, recording every payment and stopping a payment loop. */
    static final class Run24Player implements Tables.Policy {
        final AtomicInteger copyQuestions = new AtomicInteger();
        /** The actions of each payment prompt for Chain Lightning's copy, and for Grizzly Bears. */
        final List<List<String>> copyPayments = new CopyOnWriteArrayList<>();
        final List<List<String>> bearsPayments = new CopyOnWriteArrayList<>();
        /** The detail line of each payment for Chain Lightning's copy. */
        final List<String> copyDetails = new CopyOnWriteArrayList<>();
        final AtomicInteger longestPaymentRun = new AtomicInteger();
        private int paymentRun;

        @Override
        public String choose(int seat, PromptView prompt, SeatView view) {
            List<PromptView.Option> options = prompt.options();
            paymentRun = prompt.kind().equals("pay_mana") ? paymentRun + 1 : 0;
            longestPaymentRun.accumulateAndGet(paymentRun, Math::max);
            switch (prompt.kind()) {
                case "mulligan":
                    return first(options, "keep");
                case "priority": {
                    String land = first(options, "play_land");
                    String cast = first(options, "cast");
                    return land != null ? land : cast != null ? cast : first(options, "pass");
                }
                case "yes_no":
                    if (prompt.message().contains(COPY_QUESTION)) {
                        copyQuestions.incrementAndGet();
                    }
                    return first(options, "yes");
                case "pay_mana": {
                    List<String> actions = options.stream().map(PromptView.Option::action).toList();
                    (prompt.message().contains(BEARS) ? bearsPayments : copyPayments).add(actions);
                    if (!prompt.message().contains(BEARS)) {
                        copyDetails.add(String.valueOf(prompt.detail()));
                    }
                    if (paymentRun >= LOOP) {
                        return first(options, "cancel"); // end the loop so the game can finish
                    }
                    String pay = first(options, "tap_source");
                    pay = pay != null ? pay : first(options, "use_pool");
                    return pay != null ? pay : options.get(0).id();
                }
                case "choose_target": {
                    if (prompt.message().contains("starting player")) {
                        return options.stream().filter(option -> Integer.valueOf(seat).equals(option.seat()))
                            .findFirst().orElse(options.get(0)).id();
                    }
                    var choices = options.stream().filter(o -> o.action().equals("choose") && !o.selected()).toList();
                    return choices.stream().filter(o -> o.seat() != null && o.seat() != seat).findFirst()
                        .or(() -> choices.stream().findFirst()).map(PromptView.Option::id)
                        .orElseGet(() -> first(options, "done"));
                }
                case "declare_attackers":
                case "declare_blockers":
                    return first(options, "done");
                default:
                    return options.stream().filter(option -> !option.action().equals("cancel")).findFirst()
                        .orElse(options.get(0)).id();
            }
        }

        private static String first(List<PromptView.Option> options, String action) {
            return options.stream().filter(option -> option.action().equals(action)).findFirst()
                .map(PromptView.Option::id).orElse(null);
        }
    }

    @Test
    void aCostNothingCanPayOffersOnlyCancel() throws Exception {
        var human = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Forest", 24),
            new DeckLists.Entry(BEARS, 16)), List.of());
        var bot = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Mountain", 16),
            new DeckLists.Entry("Chain Lightning", 24)), List.of());
        var request = new HumanGameRequest(2424L, GameFormat.LEGACY, List.of(
            new HumanGameRequest.Seat(HumanGameRequest.HUMAN, HumanGameRequest.CUSTOM_DECK, human),
            new HumanGameRequest.Seat(HumanGameRequest.BOT, HumanGameRequest.CUSTOM_DECK, bot)), 1, 8, 900);
        var check = new SeatChecks(request);
        var coverage = new Tables.Coverage();
        var player = new Run24Player();
        HumanGame game = Tables.start(request, check);
        Tables.play(game, player, 4, coverage);
        coverage.summary().forEach(System.out::println);
        System.out.println("Copy questions: " + player.copyQuestions + "; copy payments: " + player.copyPayments
            + "; Bears payments: " + player.bearsPayments + "; longest payment run: " + player.longestPaymentRun);

        check.settle();
        assertTrue(check.failures.isEmpty(), "leaks, wrong views or XMage errors: " + check.failures);
        assertTrue(player.copyQuestions.get() > 0, "Chain Lightning never asked to copy: " + coverage.kinds);
        assertFalse(player.copyPayments.isEmpty(), "no payment for a copy");
        assertTrue(player.copyPayments.stream().allMatch(actions -> actions.equals(List.of("cancel"))),
            "a payment of {R}{R} offered Forests or green mana: " + player.copyPayments);
        assertTrue(player.copyDetails.stream().allMatch("Nothing you control can pay {R}{R}."::equals),
            "a cancel-only payment did not say why: " + player.copyDetails);
        assertTrue(player.longestPaymentRun.get() < LOOP, "a payment repeated " + player.longestPaymentRun + " times");
        assertFalse(player.bearsPayments.isEmpty(), "Grizzly Bears was never cast");
        assertTrue(player.bearsPayments.stream().allMatch(actions -> actions.contains("tap_source")
            || actions.contains("use_pool")), "a castable spell's payment offered nothing to pay with: "
            + player.bearsPayments);
    }

    /** The unpaid cost read from XMage's payment message; null when the message reads otherwise. */
    @Test
    void theUnpaidCostIsReadFromThePaymentMessage() {
        assertEquals("{R}{R}", Prompts.unpaidCost("Pay {R}{R}<div style='font-size:11pt'>Chain Lightning</div>").getText());
        assertEquals("{2}{G}", Prompts.unpaidCost("Pay {2}{G}<div style='font-size:11pt'>Grizzly Bears</div>").getText());
        assertEquals("{1}", Prompts.unpaidCost("Pay {1}").getText());
        assertNull(Prompts.unpaidCost("Pay the life"));
        assertNull(Prompts.unpaidCost("Choose a mana source"));
        assertNull(Prompts.unpaidCost(null));
    }
}
