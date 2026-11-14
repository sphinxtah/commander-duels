package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import mage.abilities.mana.ActivatedManaAbilityImpl;
import mage.cards.Card;
import mage.cards.c.CrypticSpires;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Cryptic Spires as printed (v0.9.12, XMage patch 0021): "As you create your deck, circle two of
 * the colors below. This land enters tapped. {T}: Add one mana of either of the circled colors."
 * The colours are a deck list entry's {@code choice}: each copy is circled with its entry's as the
 * deck is loaded, a copy keeps them, the land enters tapped and taps for either colour and no
 * other. Needs ./db (the card database).
 */
class CrypticSpiresTest {
    private static final String SPIRES = "Cryptic Spires";
    private static final String BEARS = "Grizzly Bears";

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    private static DeckLists.CustomDeck parse(String cards) throws JsonRequest.Invalid {
        return DeckLists.parse(JsonParser.parseString("{\"cards\": [" + cards + "]}"), GameFormat.LEGACY);
    }

    @Test
    void anEntrysChoiceIsTwoDifferentColoursAndOnlyCrypticSpiresTakesOne() throws Exception {
        var deck = parse("{\"name\": \"Cryptic Spires\", \"count\": 2, \"choice\": \"bw\"},"
            + "{\"name\": \"Cryptic Spires\", \"count\": 1, \"choice\": \"RG\"}, {\"name\": \"Forest\", \"count\": 57}");
        // Written one way, in WUBRG order, whatever the request's.
        assertEquals(List.of("WB", "RG"), deck.cards().stream().limit(2).map(DeckLists.Entry::choice).toList());
        assertTrue(DeckLists.takesChoice(SPIRES));
        assertFalse(DeckLists.takesChoice("Forest"));
        for (String wrong : List.of("W", "WW", "WUB", "WX", "")) {
            var refused = assertThrows(JsonRequest.Invalid.class,
                () -> parse("{\"name\": \"Cryptic Spires\", \"count\": 1, \"choice\": \"" + wrong + "\"}"));
            assertTrue(refused.getMessage().contains("choice"), refused.getMessage());
        }
        var missing = assertThrows(JsonRequest.Invalid.class, () -> parse("{\"name\": \"Cryptic Spires\", \"count\": 1}"));
        assertTrue(missing.getMessage().contains("needs its two circled colours"), missing.getMessage());
        var other = assertThrows(JsonRequest.Invalid.class,
            () -> parse("{\"name\": \"Forest\", \"count\": 1, \"choice\": \"WU\"}"));
        assertTrue(other.getMessage().contains("takes no choice"), other.getMessage());
        // A list that still describes it as a stand-in (a catalog that has not read this engine's
        // cards yet) gets the card itself: the engine plays it as written.
        var described = DeckLists.parse(JsonParser.parseString("{\"cards\": [{\"name\": \"Cryptic Spires\","
            + " \"count\": 60, \"choice\": \"UR\"}], \"stand_ins\": [{\"name\": \"Cryptic Spires\","
            + " \"types\": [\"Land\"]}]}"), GameFormat.LEGACY);
        assertTrue(described.standIns().isEmpty());
        assertTrue(DeckLists.load(described).getCards().stream()
            .allMatch(card -> card instanceof CrypticSpires spires && spires.getCircled().equals("UR")));
    }

    @Test
    void eachCopyIsCircledWithItsEntrysColoursAndACopyKeepsThem() throws Exception {
        var loaded = DeckLists.load(parse("{\"name\": \"Cryptic Spires\", \"count\": 2, \"choice\": \"WB\"},"
            + "{\"name\": \"Cryptic Spires\", \"count\": 1, \"choice\": \"RG\"}, {\"name\": \"Forest\", \"count\": 57}"));
        List<String> circled = new ArrayList<>();
        for (Card card : loaded.getCards()) {
            if (card instanceof CrypticSpires spires) {
                circled.add(spires.getCircled());
                // Enters tapped, and one mana ability a circled colour.
                assertEquals(2, mana(spires).size(), spires.getRules().toString());
                CrypticSpires copy = spires.copy();
                assertEquals(spires.getCircled(), copy.getCircled());
                assertEquals(mana(spires), mana(copy));
                assertThrows(IllegalStateException.class, () -> spires.circle("WU"));
            }
        }
        circled.sort(null);
        assertEquals(List.of("RG", "WB", "WB"), circled);
        // A copy made in code and never circled is a land with no mana ability, as printed blank.
        var blank = DeckLists.load(new DeckLists.CustomDeck(List.of(new DeckLists.Entry(SPIRES, 1),
            new DeckLists.Entry("Forest", 59)), List.of()));
        for (Card card : blank.getCards()) {
            if (card instanceof CrypticSpires spires) {
                assertTrue(mana(spires).isEmpty());
                assertThrows(IllegalArgumentException.class, () -> spires.circle("WW"));
            }
        }
    }

    private static List<String> mana(CrypticSpires spires) {
        return spires.getAbilities().stream().filter(ActivatedManaAbilityImpl.class::isInstance)
            .map(ability -> ability.getRule()).sorted().toList();
    }

    /** A game of Cryptic Spires and Grizzly Bears: what the Bears were paid with, and how the lands entered. */
    private record Game(List<String> payments, List<Boolean> enteredTapped, List<String> failures) {}

    private static Game play(String choice, long seed) throws Exception {
        var human = new DeckLists.CustomDeck(List.of(new DeckLists.Entry(SPIRES, 24, choice),
            new DeckLists.Entry(BEARS, 16)), List.of());
        var bot = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Plains", 40)), List.of());
        var request = new HumanGameRequest(seed, GameFormat.LEGACY, List.of(
            new HumanGameRequest.Seat(HumanGameRequest.HUMAN, HumanGameRequest.CUSTOM_DECK, human),
            new HumanGameRequest.Seat(HumanGameRequest.BOT, HumanGameRequest.CUSTOM_DECK, bot)), 1, 5, 900);
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request);
        List<String> payments = new CopyOnWriteArrayList<>();
        List<Boolean> entered = new CopyOnWriteArrayList<>();
        boolean[] justPlayed = {false};
        Tables.Policy policy = (seat, prompt, view) -> {
            if (justPlayed[0]) {
                // The view after a land drop: the newest Cryptic Spires, tapped or not.
                view.battlefield().stream().filter(permanent -> SPIRES.equals(permanent.card().name()))
                    .reduce((first, second) -> second).ifPresent(permanent -> entered.add(permanent.tapped()));
                justPlayed[0] = false;
            }
            List<PromptView.Option> options = prompt.options();
            switch (prompt.kind()) {
                case "priority": {
                    String land = first(options, "play_land");
                    String cast = first(options, "cast");
                    justPlayed[0] = land != null;
                    return land != null ? land : cast != null ? cast : first(options, "pass");
                }
                case "pay_mana": {
                    if (prompt.message().contains(BEARS)) {
                        options.stream().filter(option -> option.action().equals("tap_source"))
                            .map(PromptView.Option::label).forEach(payments::add);
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
        return new Game(payments, entered, scenario.failures);
    }

    @Test
    void itEntersTappedAndTapsForItsCircledColoursAndNoOther() throws Exception {
        // Red and green circled: the land pays for the green Grizzly Bears.
        Game green = play("RG", 91201L);
        assertTrue(green.failures().isEmpty(), "leaks, wrong views or XMage errors: " + green.failures());
        assertFalse(green.enteredTapped().isEmpty(), "no Cryptic Spires was played");
        assertTrue(green.enteredTapped().stream().allMatch(Boolean::booleanValue), "a Cryptic Spires entered untapped");
        assertFalse(green.payments().isEmpty(), "Grizzly Bears was never paid for with red and green circled");
        assertTrue(green.payments().stream().allMatch(SPIRES::equals), green.payments().toString());
        // White and blue circled: the same deck never has green mana, and the Bears are never cast.
        Game blue = play("WU", 91202L);
        assertTrue(blue.failures().isEmpty(), "leaks, wrong views or XMage errors: " + blue.failures());
        assertFalse(blue.enteredTapped().isEmpty(), "no Cryptic Spires was played");
        assertTrue(blue.payments().isEmpty(), "Grizzly Bears was paid for with white and blue circled: "
            + blue.payments());
    }

    private static String first(List<PromptView.Option> options, String action) {
        return options.stream().filter(option -> option.action().equals(action)).findFirst()
            .map(PromptView.Option::id).orElse(null);
    }
}
