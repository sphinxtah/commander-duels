package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The court's incarnation (v0.9.6, {@link CampaignReserve#applyCourt}): ward 15's rule, with a public
 * card standing in for the owner's. Ball Lightning is sacrificed at the beginning of every end step, so
 * it shows each part of the rule in a few turns: it is on the battlefield from the start, it goes back
 * to the reserve instead of the graveyard, and it comes back at its controller's upkeep, again and
 * again, never more than one. Needs ./db.
 */
class CampaignCourtTest {
    private static final String CARD = "Ball Lightning";
    private static final String COMMANDER = "Isamaru, Hound of Konda";

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    @Test
    void theCourtsReserveIsParsedForKingsTableCommanderDecks() throws Exception {
        String body = "{\"cards\":[{\"name\":\"Plains\",\"count\":99}],\"commanders\":[\"" + COMMANDER + "\"],"
            + "\"reserve\":[{\"name\":\"" + CARD + "\",\"mode\":\"court\"}]}";
        DeckLists.CustomDeck deck = DeckLists.parse(JsonParser.parseString(body), GameFormat.KINGS_TABLE_COMMANDER);
        assertEquals(List.of(new DeckLists.Reserve(CARD, 15, true)), deck.reserve());
        String threshold = body.replace("\"mode\":\"court\"", "\"mode\":\"court\",\"threshold\":15");
        assertThrows(JsonRequest.Invalid.class,
            () -> DeckLists.parse(JsonParser.parseString(threshold), GameFormat.KINGS_TABLE_COMMANDER));
        String odd = body.replace("court", "throne");
        assertThrows(JsonRequest.Invalid.class,
            () -> DeckLists.parse(JsonParser.parseString(odd), GameFormat.COMMANDER));
        String legacy = "{\"cards\":[{\"name\":\"Plains\",\"count\":60}],"
            + "\"reserve\":[{\"name\":\"" + CARD + "\",\"mode\":\"court\"}]}";
        assertThrows(JsonRequest.Invalid.class,
            () -> DeckLists.parse(JsonParser.parseString(legacy), GameFormat.KINGS_TABLE_LEGACY));
    }

    @Test
    void theIncarnationStartsOnTheBattlefieldAndReturnsEachUpkeep() throws Exception {
        var human = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Plains", 99)), List.of(COMMANDER));
        var bot = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Mountain", 99)), List.of(COMMANDER),
            List.of(), Map.of(), List.of(new DeckLists.Reserve(CARD, 15, true)));
        var request = new HumanGameRequest(9156L, GameFormat.COMMANDER, List.of(
            new HumanGameRequest.Seat(HumanGameRequest.HUMAN, HumanGameRequest.CUSTOM_DECK, human),
            new HumanGameRequest.Seat(HumanGameRequest.BOT, HumanGameRequest.CUSTOM_DECK, bot)), 1, 6, 900);
        Set<String> emblems = ConcurrentHashMap.newKeySet();
        AtomicInteger arrivals = new AtomicInteger();
        AtomicInteger most = new AtomicInteger();
        AtomicBoolean present = new AtomicBoolean(false);
        AtomicBoolean firstTurnSeen = new AtomicBoolean(false);
        HumanGame game = Tables.start(request, HumanGame.Hooks.NONE);
        Tables.play(game, (seat, prompt, view) -> {
            if (view != null) {
                int count = (int) view.battlefield().stream()
                    .filter(permanent -> CARD.equals(permanent.card().name()) && permanent.controllerSeat() == 1)
                    .count();
                most.accumulateAndGet(count, Math::max);
                if (count > 0 && !present.get()) {
                    arrivals.incrementAndGet();
                }
                present.set(count > 0);
                if (count > 0) {
                    firstTurnSeen.set(true);
                }
                view.opponents().forEach(player -> player.commandZone().forEach(card -> emblems.add(card.name())));
            }
            if (prompt.kind().equals("mulligan")) {
                return ScriptedPlayer.byAction(prompt.options(), "keep").get(0).id();
            }
            var pass = ScriptedPlayer.byAction(prompt.options(), "pass");
            if (!pass.isEmpty()) {
                return pass.get(0).id();
            }
            var done = ScriptedPlayer.byAction(prompt.options(), "done");
            return done.isEmpty() ? prompt.options().get(0).id() : done.get(0).id();
        }, 6, new Tables.Coverage());
        assertTrue(emblems.contains(CampaignReserve.COURT_NAME), "the bot's command zone: " + emblems);
        assertTrue(firstTurnSeen.get(), "the incarnation never took the court");
        assertTrue(arrivals.get() >= 2, "the incarnation came back " + (arrivals.get() - 1) + " times");
        assertEquals(1, most.get(), "more than one incarnation at once");
    }
}
