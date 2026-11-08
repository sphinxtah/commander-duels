package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Learn Commander's training hand (v0.9.1): a human seat's deck list names an {@code opening}, and
 * the engine puts those cards on top after the game's first shuffle, so the opening hand is exactly
 * them whatever the seed. Needs ./db.
 */
class OpeningHandTest {
    private static final String COMMANDER = "Adeline, Resplendent Cathar";
    private static final List<String> TRAINING = List.of("Plains", "Plains", "Plains", "Sol Ring", "Arcane Signet",
        "Raise the Alarm", "Pacifism");

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    private static String deck(String opening) {
        return "{\"cards\":[{\"name\":\"Plains\",\"count\":60},{\"name\":\"Sol Ring\",\"count\":1},"
            + "{\"name\":\"Arcane Signet\",\"count\":1},{\"name\":\"Raise the Alarm\",\"count\":1},"
            + "{\"name\":\"Pacifism\",\"count\":1},{\"name\":\"Savannah Lions\",\"count\":35}],"
            + "\"commanders\":[\"" + COMMANDER + "\"]" + (opening == null ? "" : ",\"opening\":" + opening) + "}";
    }

    @Test
    void aDeckListNamesItsOpeningFromItsOwnCards() throws Exception {
        String names = "[\"Plains\",\"Plains\",\"Plains\",\"Sol Ring\",\"Arcane Signet\",\"Raise the Alarm\","
            + "\"Pacifism\"]";
        DeckLists.CustomDeck deck = DeckLists.parse(JsonParser.parseString(deck(names)), GameFormat.COMMANDER);
        assertEquals(TRAINING, deck.opening());
        assertTrue(DeckLists.parse(JsonParser.parseString(deck(null)), GameFormat.COMMANDER).opening().isEmpty());
        // Two Sol Rings from a deck holding one, a card the deck lacks, more than a hand's worth.
        for (String bad : List.of("[\"Sol Ring\",\"Sol Ring\"]", "[\"Island\"]",
                "[\"Plains\",\"Plains\",\"Plains\",\"Plains\",\"Plains\",\"Plains\",\"Plains\",\"Plains\"]", "\"Plains\"")) {
            assertThrows(JsonRequest.Invalid.class,
                () -> DeckLists.parse(JsonParser.parseString(deck(bad)), GameFormat.COMMANDER), bad);
        }
        // Only a human seat's list stacks its library.
        String request = "{\"format\":\"commander\",\"seats\":[{\"player\":\"human\",\"deck_list\":" + deck(null)
            + "},{\"player\":\"bot\",\"deck_list\":" + deck(names) + "}]}";
        assertThrows(JsonRequest.Invalid.class, () -> HumanGameRequest.parse(request, () -> 1L, true));
    }

    @Test
    void theOpeningHandIsTheTrainingSevenWhateverTheSeed() throws Exception {
        for (long seed : new long[] {20261031L, 7L}) {
            List<String> hand = openingHand(seed);
            List<String> sorted = new ArrayList<>(hand);
            Collections.sort(sorted);
            List<String> expected = new ArrayList<>(TRAINING);
            Collections.sort(expected);
            assertEquals(expected, sorted, "seed " + seed);
        }
    }

    /** The human seat's hand at its first mulligan decision. */
    private static List<String> openingHand(long seed) throws Exception {
        String names = "[\"Plains\",\"Plains\",\"Plains\",\"Sol Ring\",\"Arcane Signet\",\"Raise the Alarm\","
            + "\"Pacifism\"]";
        var learner = DeckLists.parse(JsonParser.parseString(deck(names)), GameFormat.COMMANDER);
        var bot = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Plains", 99)), List.of(COMMANDER));
        var request = new HumanGameRequest(seed, GameFormat.COMMANDER, List.of(
            new HumanGameRequest.Seat(HumanGameRequest.HUMAN, HumanGameRequest.CUSTOM_DECK, learner),
            new HumanGameRequest.Seat(HumanGameRequest.BOT, HumanGameRequest.CUSTOM_DECK, bot)), 1, 2, 900);
        AtomicReference<List<String>> hand = new AtomicReference<>();
        HumanGame game = Tables.start(request, HumanGame.Hooks.NONE);
        Tables.play(game, (seat, prompt, view) -> {
            if (prompt.kind().equals("mulligan")) {
                if (hand.get() == null && view != null) {
                    hand.compareAndSet(null, view.hand().stream().map(card -> card.name()).toList());
                }
                return ScriptedPlayer.byAction(prompt.options(), "keep").get(0).id();
            }
            var pass = ScriptedPlayer.byAction(prompt.options(), "pass");
            if (!pass.isEmpty()) {
                return pass.get(0).id();
            }
            var done = ScriptedPlayer.byAction(prompt.options(), "done");
            return done.isEmpty() ? prompt.options().get(0).id() : done.get(0).id();
        }, 4, new Tables.Coverage());
        assertNotNull(hand.get(), "no mulligan decision was asked");
        return hand.get();
    }
}
