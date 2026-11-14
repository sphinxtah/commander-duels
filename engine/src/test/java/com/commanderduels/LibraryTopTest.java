package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * A card that lets its player look at the top of their library and play it from there (v0.9.14,
 * the owner's report of 2026-11-14): with Bolas's Citadel on the battlefield ("You may look at the
 * top card of your library any time. You may play lands and cast spells from the top of your
 * library. If you cast a spell this way, pay life equal to its mana value rather than pay its mana
 * cost."), the seat's view names the card it is looking at as one in its own library, and the
 * priority prompt offers to cast it.
 */
class LibraryTopTest {
    private static final String BEARS = "Grizzly Bears";

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    @Test
    void theTopOfTheLibraryIsShownAsTheLibrarysAndCanBeCast() throws Exception {
        var human = new DeckLists.CustomDeck(List.of(new DeckLists.Entry(BEARS, 40)), List.of());
        var bot = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Plains", 40)), List.of());
        var request = new HumanGameRequest(9141L, GameFormat.LEGACY, List.of(
            new HumanGameRequest.Seat(HumanGameRequest.HUMAN, HumanGameRequest.CUSTOM_DECK, human),
            new HumanGameRequest.Seat(HumanGameRequest.BOT, HumanGameRequest.CUSTOM_DECK, bot)), 1, 2, 900);
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request).battlefield(0, "Bolas's Citadel");
        List<String> seen = new CopyOnWriteArrayList<>();
        List<String> offered = new CopyOnWriteArrayList<>();
        List<Integer> lives = new CopyOnWriteArrayList<>();
        Tables.Policy policy = (seat, prompt, view) -> {
            List<PromptView.Option> options = prompt.options();
            switch (prompt.kind()) {
                case "priority": {
                    lives.add(view.you().life());
                    for (SeatView.CardGroup group : view.lookedAt()) {
                        seen.add(group.name() + ": " + group.cards().stream().map(SeatView.CardInfo::name).toList()
                            + " library_seat " + group.librarySeat());
                        for (SeatView.CardInfo card : group.cards()) {
                            for (PromptView.Option option : options) {
                                if (card.id().equals(option.objectId())) {
                                    offered.add(option.action());
                                    return option.id();
                                }
                            }
                        }
                    }
                    return first(options, "pass");
                }
                case "mulligan":
                    return first(options, "keep");
                default:
                    return options.stream().filter(option -> !option.action().equals("cancel")).findFirst()
                        .orElse(options.get(0)).id();
            }
        };
        HumanGame game = Tables.start(scenario.gameRequest, scenario);
        Tables.play(game, policy, 2, new Tables.Coverage());
        scenario.settle();
        System.out.println("Looked at: " + seen.stream().distinct().toList());
        System.out.println("Offered for the top card: " + offered + "; life at each priority: " + lives);
        assertTrue(scenario.failures.isEmpty(), "leaks, wrong views or XMage errors: " + scenario.failures);
        assertFalse(seen.isEmpty(), "the seat was never shown the top of its library");
        assertTrue(seen.stream().allMatch(line -> line.endsWith("library_seat 0")),
            "a group of the library's top card did not say whose library: " + seen);
        assertFalse(offered.isEmpty(), "the top card of the library was never offered to cast");
        assertEquals("cast", offered.get(0));
        assertNotNull(lives.stream().filter(life -> life < 20).findFirst().orElse(null),
            "casting from the top of the library cost no life: " + lives);
    }

    private static String first(List<PromptView.Option> options, String action) {
        return options.stream().filter(option -> option.action().equals(action)).findFirst()
            .map(PromptView.Option::id).orElse(null);
    }
}
