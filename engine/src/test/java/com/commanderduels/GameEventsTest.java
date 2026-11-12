package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * A game's structured events (v0.9.10), from real games: in order, in the schema's words, with no
 * XMage id, each object with the seats that may see it, and a cause where XMage names one.
 */
class GameEventsTest {
    private static final Pattern XMAGE_ID = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");

    @BeforeAll
    static void loadCards() {
        CardDatabase.load();
        Tables.actAsClient();
    }

    /** A human seat and three bots, each with one of the format's own decks. */
    private static List<HumanGameRequest.Seat> seats(GameFormat format) {
        List<String> decks = format.decks();
        return List.of(Tables.human(decks.get(0)), Tables.bot(decks.get(1 % decks.size())),
            Tables.bot(decks.get(2 % decks.size())), Tables.bot(decks.get(3 % decks.size())));
    }

    private static List<JsonObject> play(HumanGameRequest request, long seed) throws Exception {
        HumanGame game = Tables.start(request, HumanGame.Hooks.NONE);
        var player = new ScriptedPlayer(seed);
        Tables.play(game, (seat, prompt, view) -> player.choose(prompt, view), 6, new Tables.Coverage());
        List<JsonObject> events = game.events().since(0, Integer.MAX_VALUE);
        assertFalse(events.isEmpty());
        return events;
    }

    /** What every event holds, whatever its kind. */
    private static void wellFormed(List<JsonObject> events, int seats) {
        long expected = 1;
        int lastTurn = 0;
        for (JsonObject event : events) {
            assertEquals(1, event.get("v").getAsInt(), event.toString());
            assertEquals(expected++, event.get("seq").getAsLong(), "numbered in order, without a gap");
            assertTrue(event.get("turn").getAsInt() >= lastTurn, "turns never go back: " + event);
            lastTurn = event.get("turn").getAsInt();
            assertTrue(event.has("type"), event.toString());
            assertFalse(XMAGE_ID.matcher(event.toString()).find(), "no XMage id: " + event);
            for (String key : List.of("object", "target", "cause")) {
                JsonElement value = event.get(key);
                if (value == null || !value.isJsonObject() || value.getAsJsonObject().has("seat")) {
                    continue;
                }
                JsonObject object = value.getAsJsonObject();
                assertTrue(object.get("ref").getAsString().matches("o[0-9a-f]{16}"), event.toString());
                JsonElement seen = object.get("seen_by");
                assertTrue(seen.isJsonArray() || seen.getAsString().equals("all"), event.toString());
                if (seen.isJsonArray()) {
                    for (JsonElement seat : seen.getAsJsonArray()) {
                        assertTrue(seat.getAsInt() >= 0 && seat.getAsInt() < seats, event.toString());
                    }
                }
            }
        }
    }

    private static boolean isDraw(JsonObject event) {
        return "zone_change".equals(event.get("type").getAsString())
            && "library".equals(event.get("from").getAsString()) && "hand".equals(event.get("to").getAsString());
    }

    @Test
    void aCommanderTableIsDescribedInOrderAndItsDrawsAreTheirOwnersAlone() throws Exception {
        var request = new HumanGameRequest(4401L, GameFormat.COMMANDER,
            seats(GameFormat.COMMANDER), 1, 12, 900, 0, 0);
        List<JsonObject> events = play(request, 4401L);
        wellFormed(events, 4);
        Map<String, Integer> kinds = new TreeMap<>();
        events.forEach(event -> kinds.merge(event.get("type").getAsString(), 1, Integer::sum));
        for (String kind : List.of("step", "zone_change", "cast")) {
            assertTrue(kinds.containsKey(kind), kind + " in " + kinds);
        }
        int draws = 0;
        for (JsonObject event : events) {
            if (isDraw(event)) {
                draws++;
                JsonObject card = event.getAsJsonObject("object");
                JsonArray seen = card.getAsJsonArray("seen_by");
                assertEquals(1, seen.size(), "a draw is its owner's to see: " + event);
                assertEquals(event.get("player").getAsInt(), seen.get(0).getAsInt(), event.toString());
            }
            if ("cast".equals(event.get("type").getAsString())) {
                assertEquals("all", event.getAsJsonObject("object").get("seen_by").getAsString(),
                    "a spell cast face up is everyone's: " + event);
            }
        }
        assertTrue(draws >= 4, "every seat drew: " + draws);
        System.out.println("EVENTS kinds " + kinds);
    }

    @Test
    void aTeammateSeesItsPartnersDraws() throws Exception {
        var request = new HumanGameRequest(4402L, GameFormat.TWO_HEADED_GIANT,
            seats(GameFormat.TWO_HEADED_GIANT), 1, 6, 900, 0, 0);
        List<JsonObject> events = play(request, 4402L);
        wellFormed(events, 4);
        boolean found = false;
        for (JsonObject event : events) {
            if (isDraw(event)) {
                found = true;
                int owner = event.get("player").getAsInt();
                JsonArray seen = event.getAsJsonObject("object").getAsJsonArray("seen_by");
                // Seats 0 and 1 are one team, 2 and 3 the other (810.5: teammates see each other's hands).
                int partner = owner < 2 ? 1 - owner : 5 - owner;
                assertEquals(List.of(Math.min(owner, partner), Math.max(owner, partner)),
                    List.of(seen.get(0).getAsInt(), seen.get(1).getAsInt()), event.toString());
            }
        }
        assertTrue(found);
    }

    /**
     * How much cause XMage's events carry (the plan's first measurement, docs/engine/events.md):
     * for each kind, how many events name what did it.
     */
    @Test
    void howMuchCauseTheEventsCarry() throws Exception {
        Map<String, int[]> tally = new TreeMap<>();
        for (long seed : new long[] {4411L, 4412L, 4413L}) {
            var request = new HumanGameRequest(seed, GameFormat.COMMANDER,
                seats(GameFormat.COMMANDER), 3, 14, 900, 0, 0);
            for (JsonObject event : play(request, seed)) {
                String kind = event.get("type").getAsString();
                if (kind.equals("zone_change")) {
                    kind += " " + event.get("from").getAsString() + ">" + event.get("to").getAsString();
                }
                int[] counts = tally.computeIfAbsent(kind, key -> new int[2]);
                counts[0]++;
                if (event.has("cause")) {
                    counts[1]++;
                }
            }
        }
        StringBuilder text = new StringBuilder("EVENTS cause");
        tally.forEach((kind, counts) -> text.append("; ").append(kind).append(' ').append(counts[1]).append('/')
            .append(counts[0]));
        System.out.println(text);
        // Damage always names its source: the one cause the timeline must never lack.
        int[] damage = tally.get("damage");
        assertNotNull(damage, tally.keySet().toString());
        assertEquals(damage[0], damage[1], "every damage event names its source");
    }
}
