package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import mage.cards.Card;
import mage.cards.CardsImpl;
import mage.cards.decks.Deck;
import mage.constants.RangeOfInfluence;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.match.Match;
import mage.player.ai.ComputerPlayerControllableProxy;
import mage.players.Player;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The copy a fair bot searches holds a sample of the concealed zones, never the real ones (AI02).
 * Tables are seated but not started, with hands dealt by hand, so every sample is reproducible: the
 * random source is seeded and pools are dealt in card-name order. Needs ./db and ./decks.
 */
class DeterminizerTest {
    /** The only nonland card in the opponent's pool, dealt to its hand. */
    private static final String SINGLETON = "Llanowar Elves";
    private static final int HAND = 7;
    private static final int SAMPLES = 40;

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
    }

    /** A Legacy table: the fair bot with the red fixture deck, and an opponent holding the Elves. */
    private record Table(Game game, FairBot bot, Player opponent) {}

    private static Table table(long seed) throws Exception {
        Game game = LegacyDuel.newGame(10);
        Match match = LegacyDuel.newMatch("determinizer test");
        var bot = new FairBot("Bot", RangeOfInfluence.ONE, 1, seed);
        var opponent = new ComputerPlayerControllableProxy("Opponent", RangeOfInfluence.ONE, 1);
        LegacyDuel.seat(game, match, bot, LegacyDuel.loadDeck(SeatChecks.DECKS, "legacy-mono-red-burn"));
        Deck pool = DeckLists.load(new DeckLists.CustomDeck(
            List.of(new DeckLists.Entry(SINGLETON, 1), new DeckLists.Entry("Forest", 59)), List.of()));
        LegacyDuel.seat(game, match, opponent, pool);
        deal(game, bot, List.of());
        deal(game, opponent, List.of(SINGLETON));
        return new Table(game, bot, opponent);
    }

    /** Moves the named cards, then the top of the library, into the hand until it holds seven. */
    private static void deal(Game game, Player player, List<String> first) {
        for (String name : first) {
            Card card = player.getLibrary().getCards(game).stream().filter(c -> c.getName().equals(name))
                .findFirst().orElseThrow();
            player.getLibrary().remove(card.getId(), game);
            player.getHand().add(card);
            card.setZone(Zone.HAND, game);
        }
        while (player.getHand().size() < HAND) {
            Card card = player.getLibrary().drawFromTop(game);
            player.getHand().add(card);
            card.setZone(Zone.HAND, game);
        }
    }

    /** A player's concealed zones: the hand, the library from the top, and each card's zone. */
    private record Concealed(List<UUID> hand, List<UUID> library, Map<UUID, Zone> zones) {}

    private static Concealed concealed(Game game, UUID playerId) {
        Player player = game.getPlayer(playerId);
        List<UUID> hand = new ArrayList<>(player.getHand());
        List<UUID> library = player.getLibrary().getCardList();
        Map<UUID, Zone> zones = new LinkedHashMap<>();
        hand.forEach(id -> zones.put(id, game.getState().getZone(id)));
        library.forEach(id -> zones.put(id, game.getState().getZone(id)));
        return new Concealed(hand, library, zones);
    }

    /** How many cards of each name. */
    private static Map<String, Integer> names(Game game, List<UUID> ids) {
        Map<String, Integer> counts = new TreeMap<>();
        ids.forEach(id -> counts.merge(game.getCard(id).getName(), 1, Integer::sum));
        return counts;
    }

    private static List<String> inOrder(Game game, List<UUID> ids) {
        return ids.stream().map(id -> game.getCard(id).getName()).toList();
    }

    private static List<UUID> pool(Concealed zones) {
        List<UUID> all = new ArrayList<>(zones.hand());
        all.addAll(zones.library());
        return all;
    }

    /** Every card the copy lists in a hand or library is recorded in that zone. */
    private static void assertZonesMatch(Concealed zones) {
        zones.hand().forEach(id -> assertEquals(Zone.HAND, zones.zones().get(id)));
        zones.library().forEach(id -> assertEquals(Zone.LIBRARY, zones.zones().get(id)));
    }

    private static boolean holds(Game game, Concealed zones, String name) {
        return zones.hand().stream().anyMatch(id -> game.getCard(id).getName().equals(name));
    }

    @Test
    void theSearchedCopyHoldsASampleNotTheOpponentsHand() throws Exception {
        Table table = table(5L);
        Game game = table.game();
        UUID botId = table.bot().getId();
        UUID opponentId = table.opponent().getId();
        Concealed realBot = concealed(game, botId);
        Concealed realOpponent = concealed(game, opponentId);
        assertTrue(holds(game, realOpponent, SINGLETON));

        int elvesInHand = 0;
        int reordered = 0;
        for (int i = 0; i < SAMPLES; i++) {
            Game sim = table.bot().createSimulation(game);
            Concealed bot = concealed(sim, botId);
            Concealed opponent = concealed(sim, opponentId);
            // Sizes and pools as in the real game; each card recorded in the zone it was dealt to.
            assertEquals(HAND, opponent.hand().size());
            assertEquals(realOpponent.library().size(), opponent.library().size());
            assertEquals(names(game, pool(realOpponent)), names(sim, pool(opponent)));
            assertZonesMatch(opponent);
            // The bot's own hand as it is; its library's contents, not its order.
            assertEquals(realBot.hand(), bot.hand());
            assertEquals(names(game, realBot.library()), names(sim, bot.library()));
            assertZonesMatch(bot);
            if (!bot.library().equals(realBot.library())) {
                reordered++;
            }
            if (holds(sim, opponent, SINGLETON)) {
                elvesInHand++;
            }
        }
        // The Elves is one card in 60: dealt to the hand about 7 times in 60, not every time.
        assertTrue(elvesInHand < SAMPLES / 3, "the real hand leaked into the copies: " + elvesInHand);
        assertTrue(elvesInHand > 0, "the Elves is a plausible card in hand, yet no sample dealt it there");
        assertEquals(SAMPLES, reordered, "the bot's library must be shuffled in every copy");
        assertEquals(SAMPLES, table.bot().stats().samples());

        // The real game is untouched.
        assertEquals(realBot, concealed(game, botId));
        assertEquals(realOpponent, concealed(game, opponentId));
    }

    @Test
    void cardsTheSeatHasSeenStayWhereTheyAre() throws Exception {
        Table table = table(6L);
        Game game = table.game();
        UUID opponentId = table.opponent().getId();
        Card elves = game.getPlayer(opponentId).getHand().getCards(game).stream()
            .filter(card -> card.getName().equals(SINGLETON)).findFirst().orElseThrow();

        // Looked at by its owner only: still concealed from the bot.
        game.getState().getLookedAt(opponentId).add("own hand", new CardsImpl(elves));
        int kept = 0;
        for (int i = 0; i < SAMPLES; i++) {
            if (table.bot().createSimulation(game).getPlayer(opponentId).getHand().contains(elves.getId())) {
                kept++;
            }
        }
        assertTrue(kept < SAMPLES / 3, "a card only its owner looked at was kept: " + kept);

        // Looked at by the bot, or revealed to everyone: it stays in that hand.
        for (int variant = 0; variant < 2; variant++) {
            game.getState().clearLookedAt();
            game.getState().clearRevealed();
            if (variant == 0) {
                game.getState().getLookedAt(table.bot().getId()).add("Peek", new CardsImpl(elves));
            } else {
                game.getState().getRevealed().add("Thoughtseize", new CardsImpl(elves));
            }
            Concealed real = concealed(game, opponentId);
            for (int i = 0; i < SAMPLES / 4; i++) {
                Game sim = table.bot().createSimulation(game);
                Concealed sample = concealed(sim, opponentId);
                assertTrue(sample.hand().contains(elves.getId()), "variant " + variant);
                assertEquals(HAND, sample.hand().size());
                assertEquals(names(game, pool(real)), names(sim, pool(sample)));
            }
        }
    }

    @Test
    void aTopCardRevealedByAnEffectStaysOnTop() throws Exception {
        Table table = table(7L);
        Game game = table.game();
        table.bot().setTopCardRevealed(true);
        table.opponent().setTopCardRevealed(true);
        UUID botTop = table.bot().getLibrary().getCardList().get(0);
        UUID opponentTop = table.opponent().getLibrary().getCardList().get(0);
        for (int i = 0; i < SAMPLES / 4; i++) {
            Game sim = table.bot().createSimulation(game);
            assertEquals(botTop, sim.getPlayer(table.bot().getId()).getLibrary().getCardList().get(0));
            assertEquals(opponentTop, sim.getPlayer(table.opponent().getId()).getLibrary().getCardList().get(0));
        }
    }

    /** Five samples as card names: the opponent's hand, then the bot's library from the top. */
    private static List<List<String>> samples(Table table) {
        List<List<String>> samples = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            Game sim = table.bot().createSimulation(table.game());
            List<String> names = new ArrayList<>(inOrder(sim,
                new ArrayList<>(sim.getPlayer(table.opponent().getId()).getHand())));
            names.addAll(inOrder(sim, sim.getPlayer(table.bot().getId()).getLibrary().getCardList()));
            samples.add(names);
        }
        return samples;
    }

    @Test
    void samplesFollowTheSeed() throws Exception {
        List<List<String>> first = samples(table(8L));
        assertEquals(first, samples(table(8L)), "the same seed deals the same samples");
        assertNotEquals(first, samples(table(9L)), "another seed deals other samples");
    }

    @Test
    void botsAtACommanderTableDoNotSeeEachOthersHands() throws Exception {
        List<String> decks = GameFormat.COMMANDER.decks();
        Game game = GameFormat.COMMANDER.newGame(decks.size(), 10);
        Match match = GameFormat.COMMANDER.newMatch("determinizer test", decks.size());
        List<FairBot> bots = new ArrayList<>();
        for (int seat = 0; seat < decks.size(); seat++) {
            var bot = new FairBot("Bot " + seat, RangeOfInfluence.ALL, 1, FairBot.seedFor(11L, seat));
            LegacyDuel.seat(game, match, bot, GameFormat.COMMANDER.loadDeck(SeatChecks.DECKS, decks.get(seat)));
            deal(game, bot, List.of());
            bots.add(bot);
        }
        Map<UUID, Concealed> real = new LinkedHashMap<>();
        bots.forEach(bot -> real.put(bot.getId(), concealed(game, bot.getId())));

        FairBot viewer = bots.get(0);
        Map<UUID, Integer> differentHands = new LinkedHashMap<>();
        for (int i = 0; i < 10; i++) {
            Game sim = viewer.createSimulation(game);
            for (FairBot bot : bots) {
                Concealed sample = concealed(sim, bot.getId());
                Concealed actual = real.get(bot.getId());
                assertEquals(names(game, pool(actual)), names(sim, pool(sample)));
                assertEquals(actual.hand().size(), sample.hand().size());
                if (bot == viewer) {
                    assertEquals(actual.hand(), sample.hand(), "the viewer keeps its own hand");
                } else if (!names(sim, sample.hand()).equals(names(game, actual.hand()))) {
                    differentHands.merge(bot.getId(), 1, Integer::sum);
                }
            }
        }
        for (FairBot bot : bots.subList(1, bots.size())) {
            assertTrue(differentHands.getOrDefault(bot.getId(), 0) >= 8,
                bot.getName() + "'s real hand showed up in the viewer's copies: " + differentHands);
        }
        bots.forEach(bot -> assertEquals(real.get(bot.getId()), concealed(game, bot.getId())));
    }
}
