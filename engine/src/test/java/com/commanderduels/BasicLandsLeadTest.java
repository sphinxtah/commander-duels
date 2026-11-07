package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Basic lands lead the payment prompt (v0.8.9, the owner's word): with a Sol Ring, a Tropical
 * Island and four basics on the battlefield, paying for Grizzly Bears offers the basics first in
 * W, U, B, R, G order (a snow basic among its type, by name), then the other sources by name.
 * Needs ./db (the card database).
 */
class BasicLandsLeadTest {
    private static final String BEARS = "Grizzly Bears";

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    @Test
    void basicLandsComeFirstInColourOrder() throws Exception {
        var human = new DeckLists.CustomDeck(List.of(new DeckLists.Entry(BEARS, 40)), List.of());
        var bot = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Plains", 40)), List.of());
        var request = new HumanGameRequest(8909L, GameFormat.LEGACY, List.of(
            new HumanGameRequest.Seat(HumanGameRequest.HUMAN, HumanGameRequest.CUSTOM_DECK, human),
            new HumanGameRequest.Seat(HumanGameRequest.BOT, HumanGameRequest.CUSTOM_DECK, bot)), 1, 3, 900);
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request).battlefield(0, "Tropical Island",
            "Sol Ring", "Snow-Covered Forest", "Forest", "Island", "Plains");
        List<List<String>> payments = new CopyOnWriteArrayList<>();
        Tables.Policy policy = (seat, prompt, view) -> {
            List<PromptView.Option> options = prompt.options();
            switch (prompt.kind()) {
                case "priority": {
                    String cast = first(options, "cast");
                    return payments.isEmpty() && cast != null ? cast : first(options, "pass");
                }
                case "pay_mana": {
                    if (prompt.message().contains(BEARS) && payments.isEmpty()) {
                        payments.add(options.stream().filter(option -> option.action().equals("tap_source"))
                            .map(PromptView.Option::label).toList());
                    }
                    String pay = first(options, "tap_source");
                    return pay != null ? pay : options.get(0).id();
                }
                case "mulligan":
                    return first(options, "keep");
                default:
                    return options.stream().filter(option -> !option.action().equals("cancel")).findFirst()
                        .orElse(options.get(0)).id();
            }
        };
        HumanGame game = Tables.start(scenario.gameRequest, scenario);
        Tables.play(game, policy, 3, new Tables.Coverage());
        scenario.settle();
        System.out.println("Payment sources for Grizzly Bears: " + payments);
        assertTrue(scenario.failures.isEmpty(), "leaks, wrong views or XMage errors: " + scenario.failures);
        assertFalse(payments.isEmpty(), "Grizzly Bears was never paid for");
        assertEquals(List.of("Plains", "Island", "Forest", "Snow-Covered Forest", "Sol Ring", "Tropical Island"),
            payments.get(0));
    }

    private static String first(List<PromptView.Option> options, String action) {
        return options.stream().filter(option -> option.action().equals(action)).findFirst()
            .map(PromptView.Option::id).orElse(null);
    }
}
