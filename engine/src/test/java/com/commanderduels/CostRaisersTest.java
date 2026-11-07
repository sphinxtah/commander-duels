package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The payment prompt names what raised the cost (v0.8.8): with the bot's Sphere of Resistance on
 * the battlefield ("Spells cost {1} more to cast"), every payment for the player's Grizzly Bears
 * says "The cost is raised by Sphere of Resistance." Needs ./db (the card database).
 */
class CostRaisersTest {
    private static final String BEARS = "Grizzly Bears";

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    @Test
    void aPaymentNamesTheEffectThatRaisedItsCost() throws Exception {
        var human = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Forest", 24),
            new DeckLists.Entry(BEARS, 16)), List.of());
        var bot = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Plains", 40)), List.of());
        var request = new HumanGameRequest(8808L, GameFormat.LEGACY, List.of(
            new HumanGameRequest.Seat(HumanGameRequest.HUMAN, HumanGameRequest.CUSTOM_DECK, human),
            new HumanGameRequest.Seat(HumanGameRequest.BOT, HumanGameRequest.CUSTOM_DECK, bot)), 1, 3, 900);
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request).battlefield(1, "Sphere of Resistance")
            .battlefield(0, "Forest", "Forest", "Forest");
        List<String> details = new CopyOnWriteArrayList<>();
        Tables.Policy policy = (seat, prompt, view) -> {
            List<PromptView.Option> options = prompt.options();
            switch (prompt.kind()) {
                case "priority": {
                    String land = first(options, "play_land");
                    String cast = first(options, "cast");
                    return land != null ? land : cast != null ? cast : first(options, "pass");
                }
                case "pay_mana": {
                    if (prompt.message().contains(BEARS)) {
                        details.add(String.valueOf(prompt.detail()));
                    }
                    String pay = first(options, "tap_source");
                    pay = pay != null ? pay : first(options, "use_pool");
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
        Tables.play(game, policy, 4, new Tables.Coverage());
        scenario.settle();
        System.out.println("Payment details for Grizzly Bears: " + details);
        assertTrue(scenario.failures.isEmpty(), "leaks, wrong views or XMage errors: " + scenario.failures);
        assertFalse(details.isEmpty(), "Grizzly Bears was never paid for");
        assertTrue(details.stream().allMatch(detail -> detail.contains("The cost is raised by Sphere of Resistance.")),
            "a payment did not name the Sphere: " + details);
    }

    private static String first(List<PromptView.Option> options, String action) {
        return options.stream().filter(option -> option.action().equals(action)).findFirst()
            .map(PromptView.Option::id).orElse(null);
    }
}
