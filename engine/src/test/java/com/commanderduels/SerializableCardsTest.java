package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.NotSerializableException;
import java.io.ObjectOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import mage.cards.Card;
import mage.cards.repository.CardInfo;
import mage.cards.repository.CardRepository;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

/**
 * Which cards a checkpoint can hold (v0.9.9). A checkpoint is XMage's game written down by Java's
 * serialization, and XMage itself never serializes a game: it copies its objects. So a card's
 * class may hold an object Java cannot write (a lambda that is not serializable, most often), and
 * a game with that card in it cannot be checkpointed: its recording skips the state
 * ({@code Recorder.skipped}) and the game cannot be taken up from then on.
 *
 * <p>This writes every card of the card database once, as a fresh card object, and names those
 * that cannot be written. At XMage 1.4.63 it found 37 of 33,612, for six reasons; patch 0019 made
 * them writable, and the test now fails if a card cannot be. It is the evidence for what
 * {@code docs/engine/recovery.md} says about such cards, and is run on demand, and whenever the
 * XMage pin moves: {@code mvn test -Dtest=SerializableCardsTest -Dcd.test.allCards=true} (two
 * minutes). What a card makes while it is played (an effect, a token, a watcher) is not covered
 * by it: the recovery tests' games and every recorded game are, and a state that cannot be written
 * is skipped and reported, with the class's name, by the recorder.
 */
class SerializableCardsTest {
    @BeforeAll
    static void loadCards() {
        CardDatabase.load();
    }

    private static final class Nowhere extends OutputStream {
        long bytes;

        @Override
        public void write(int b) {
            bytes++;
        }

        @Override
        public void write(byte[] buffer, int offset, int length) {
            bytes += length;
        }
    }

    /** Why a card cannot be written, or null when it can. */
    private static String unwritable(Card card) {
        try (var out = new ObjectOutputStream(new Nowhere())) {
            out.writeObject(card);
            return null;
        } catch (NotSerializableException e) {
            return e.getMessage();
        } catch (IOException | RuntimeException | StackOverflowError e) {
            return e.toString();
        }
    }

    @Test
    @EnabledIfSystemProperty(named = "cd.test.allCards", matches = "true")
    void everyCardOfTheDatabaseIsWrittenOnce() {
        Map<String, List<String>> unwritable = new TreeMap<>();
        int cards = 0;
        int failedToMake = 0;
        for (String name : new TreeSet<>(CardRepository.instance.getNames())) {
            CardInfo info = CardRepository.instance.findPreferredCoreExpansionCard(name);
            if (info == null) {
                continue;
            }
            Card card;
            try {
                card = info.createCard();
            } catch (RuntimeException e) {
                failedToMake++;
                continue;
            }
            if (card == null) {
                failedToMake++;
                continue;
            }
            cards++;
            String why = unwritable(card);
            if (why != null) {
                unwritable.computeIfAbsent(why, key -> new ArrayList<>()).add(name);
            }
        }
        int count = unwritable.values().stream().mapToInt(List::size).sum();
        System.out.println("SERIALIZABLE CARDS: " + cards + " cards written, " + count + " cannot be ("
            + failedToMake + " could not be made at all)");
        unwritable.forEach((why, names) -> System.out.println("SERIALIZABLE CARDS: " + names.size() + " hold "
            + why + ": " + (names.size() > 12 ? names.subList(0, 12) + " and " + (names.size() - 12) + " more" : names)));
        assertTrue(cards > 20_000, "the card database's cards: " + cards);
        assertTrue(unwritable.isEmpty(), "cards a checkpoint cannot hold (patch 0019 made every card writable at the"
            + " pin it was written for): " + unwritable);
    }

    /** The fixture decks' cards, every time: the games the engine's own tests record are of these. */
    @Test
    void theFixtureDecksCardsCanBeWritten() throws Exception {
        List<String> bad = new ArrayList<>();
        int cards = 0;
        for (GameFormat format : GameFormat.values()) {
            for (String deck : format.decks()) {
                for (String name : SeatChecks.deckNames(deck)) {
                    CardInfo info = CardRepository.instance.findPreferredCoreExpansionCard(name);
                    Card card = info == null ? null : info.createCard();
                    if (card == null) {
                        continue;
                    }
                    cards++;
                    String why = unwritable(card);
                    if (why != null) {
                        bad.add(name + " (" + why + ")");
                    }
                }
            }
        }
        assertTrue(cards > 100, "cards looked at: " + cards);
        assertTrue(bad.isEmpty(), "fixture cards a checkpoint cannot hold: " + bad);
    }
}
