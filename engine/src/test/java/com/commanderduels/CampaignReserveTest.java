package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * A campaign finale's incarnation in reserve (v0.8.0, {@link CampaignReserve}), with a public
 * planeswalker standing in for the owner's card: a deck list names it, the engine knows it, and the
 * bot casts it for free the first time its life is at the threshold or less. Needs ./db.
 */
class CampaignReserveTest {
    private static final String WALKER = "Ajani Goldmane";
    private static final String COMMANDER = "Isamaru, Hound of Konda";

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    @Test
    void aCommanderListNamesItsReserve() throws Exception {
        String body = "{\"cards\":[{\"name\":\"Plains\",\"count\":99}],\"commanders\":[\"" + COMMANDER + "\"],"
            + "\"reserve\":[{\"name\":\"" + WALKER + "\",\"threshold\":15}]}";
        DeckLists.CustomDeck deck = DeckLists.parse(JsonParser.parseString(body), GameFormat.COMMANDER);
        assertEquals(List.of(new DeckLists.Reserve(WALKER, 15)), deck.reserve());
        assertTrue(DeckLists.unknown(deck).isEmpty());

        String unknown = body.replace(WALKER, "No Such Walker");
        assertEquals(List.of("No Such Walker"),
            DeckLists.unknown(DeckLists.parse(JsonParser.parseString(unknown), GameFormat.COMMANDER)));
        String legacy = "{\"cards\":[{\"name\":\"Plains\",\"count\":60}],"
            + "\"reserve\":[{\"name\":\"" + WALKER + "\"}]}";
        assertThrows(JsonRequest.Invalid.class,
            () -> DeckLists.parse(JsonParser.parseString(legacy), GameFormat.LEGACY));
        String two = body.replace("}]}", "},{\"name\":\"" + WALKER + "\"}]}");
        assertThrows(JsonRequest.Invalid.class,
            () -> DeckLists.parse(JsonParser.parseString(two), GameFormat.COMMANDER));
        String zero = body.replace("\"threshold\":15", "\"threshold\":0");
        assertThrows(JsonRequest.Invalid.class,
            () -> DeckLists.parse(JsonParser.parseString(zero), GameFormat.COMMANDER));
    }

    @Test
    void theIncarnationCrossesAtItsThresholdAndStaysSingle() throws Exception {
        var human = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Plains", 99)), List.of(COMMANDER));
        // A threshold above the starting life: the bot crosses as soon as triggers are checked.
        var bot = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Plains", 99)), List.of(COMMANDER),
            List.of(), java.util.Map.of(), List.of(new DeckLists.Reserve(WALKER, 99)));
        var request = new HumanGameRequest(8008L, GameFormat.COMMANDER, List.of(
            new HumanGameRequest.Seat(HumanGameRequest.HUMAN, HumanGameRequest.CUSTOM_DECK, human),
            new HumanGameRequest.Seat(HumanGameRequest.BOT, HumanGameRequest.CUSTOM_DECK, bot)), 1, 3, 900);
        Set<Integer> walkers = ConcurrentHashMap.newKeySet();
        Set<String> emblems = ConcurrentHashMap.newKeySet();
        HumanGame game = Tables.start(request, HumanGame.Hooks.NONE);
        Tables.play(game, (seat, prompt, view) -> {
            if (view != null) {
                walkers.add((int) view.battlefield().stream()
                    .filter(permanent -> WALKER.equals(permanent.card().name()) && permanent.controllerSeat() == 1)
                    .count());
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
        }, 4, new Tables.Coverage());
        assertTrue(emblems.contains(CampaignReserve.NAME), "the bot's command zone: " + emblems);
        assertTrue(walkers.contains(1), "the incarnation never reached the battlefield: " + walkers);
        assertTrue(walkers.stream().allMatch(count -> count <= 1), "more than one incarnation: " + walkers);
    }
}
