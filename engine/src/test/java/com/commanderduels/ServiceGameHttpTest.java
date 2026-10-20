package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpServer;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import mage.cards.Card;
import mage.game.Game;
import mage.players.Player;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The API's service routes over HTTP, with real XMage games: the service token, deck lists from any
 * card, SysOp's inspection view against XMage's own state, closing and card lookup. Needs ./db and
 * ./decks.
 */
class ServiceGameHttpTest {
    private static final XmagePin PIN = XmagePin.load();
    private static final CardDatabase.Stats CARDS = new CardDatabase.Stats(120, 100, 5, false);
    private static final String SERVICE_TOKEN = "service-token-for-tests-0123456789abcdef";
    private static final String GAMES = "/v1/service/games";

    private final HttpClient client = HttpClient.newHttpClient();
    private HttpServer server;
    private HumanGames games;
    private String base;

    @BeforeAll
    static void loadCards() {
        CardDatabase.load();
        Tables.actAsClient();
    }

    @AfterEach
    void stop() {
        if (server != null) {
            server.stop(0);
        }
        client.close();
    }

    /** Service games on, development games off, as with the API in production. */
    private void start(boolean devGames) throws Exception {
        games = new HumanGames(SeatChecks.DECKS, 2);
        var engine = new Engine(PIN, false, () -> CARDS, EngineServerTest::echo, games, devGames, SERVICE_TOKEN);
        server = EngineServer.create(0, engine);
        server.start();
        base = "http://localhost:" + server.getAddress().getPort();
        engine.startLoading().join();
    }

    private HttpResponse<String> send(String method, String path, String service, String seat, String body)
            throws Exception {
        var builder = HttpRequest.newBuilder(URI.create(base + path)).method(method,
            body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        if (service != null) {
            builder.header(EngineServer.SERVICE_TOKEN_HEADER, service);
        }
        if (seat != null) {
            builder.header("Authorization", "Bearer " + seat);
        }
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> service(String method, String path, String seat, String body) throws Exception {
        return send(method, path, SERVICE_TOKEN, seat, body);
    }

    private static JsonObject json(HttpResponse<String> response) {
        return JsonParser.parseString(response.body()).getAsJsonObject();
    }

    private static String token(JsonObject created, int seat) {
        return created.getAsJsonArray("seats").get(seat).getAsJsonObject().get("seat_token").getAsString();
    }

    private JsonObject untilPrompt(String id, String seat) throws Exception {
        long since = -1;
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (true) {
            var response = service("GET", GAMES + "/" + id + "/view?wait_ms=5000&since=" + since, seat, null);
            assertEquals(200, response.statusCode(), response.body());
            JsonObject view = json(response);
            if (!view.get("prompt").isJsonNull() || !view.get("result").isJsonNull()) {
                return view;
            }
            assertTrue(System.nanoTime() < deadline);
            since = view.get("revision").getAsLong();
        }
    }

    @Test
    void theServiceTokenGuardsEveryServiceRoute() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> new Engine(PIN, false, () -> CARDS,
            EngineServerTest::echo, new HumanGames(SeatChecks.DECKS, 1), false, "too-short"));
        start(false);
        for (String path : new String[]{GAMES, GAMES + "/" + UUID.randomUUID() + "/view", "/v1/service/cards?q=bolt"}) {
            assertEquals(401, send("GET", path, null, null, null).statusCode(), path);
            var wrong = send("GET", path, SERVICE_TOKEN + "x", null, null);
            assertEquals(401, wrong.statusCode(), path);
            assertEquals("service_unauthorized", json(wrong).get("code").getAsString());
        }
        var development = send("POST", "/v1/games", SERVICE_TOKEN, null, "{}");
        assertEquals(503, development.statusCode(), "development games are off");
        JsonObject health = json(send("GET", "/health", null, null, null));
        assertTrue(health.get("service_games_enabled").getAsBoolean());
        assertTrue(health.get("gameplay_available").getAsBoolean(), "the API's players' games run here");
    }

    /** The two routes keep their games apart: a token from one finds nothing on the other. */
    @Test
    void developmentAndServiceGamesAreSeparate() throws Exception {
        start(true);
        JsonObject dev = json(send("POST", "/v1/games", null, null, "{\"seed\":41,\"skill\":1}"));
        String devId = dev.get("game_id").getAsString();
        assertEquals(404, service("GET", GAMES + "/" + devId + "/view", token(dev, 0), null).statusCode());
        assertEquals(404, service("GET", GAMES + "/" + devId + "/inspection", null, null).statusCode());
        assertEquals(404, service("POST", GAMES + "/" + devId + "/close", null, "").statusCode());
        var listed = send("POST", "/v1/games", null, null, "{\"seats\":[{\"player\":\"human\",\"deck_list\":"
            + "{\"cards\":[{\"name\":\"Mountain\",\"count\":60}]}},{\"player\":\"bot\"}]}");
        assertEquals(400, listed.statusCode(), "development games take fixture decks only");

        JsonObject created = json(service("POST", GAMES, null, "{\"skill\":1}"));
        String id = created.get("game_id").getAsString();
        assertEquals(404, send("GET", "/v1/games/" + id + "/view", null, token(created, 0), null).statusCode());
        assertEquals(401, send("GET", GAMES + "/" + id + "/view", null, token(created, 0), null).statusCode(),
            "a seat token alone does not reach a service game");
        assertEquals(200, service("POST", GAMES + "/" + id + "/close", null, "").statusCode());
        assertEquals(200, send("POST", "/v1/games/" + devId + "/close", null, token(dev, 0), "").statusCode());
    }

    @Test
    void deckListsTakeAnyCardAndNameUnknownOnes() throws Exception {
        start(false);
        var unknown = service("POST", GAMES, null, "{\"seats\":[{\"player\":\"human\",\"deck_list\":{\"cards\":["
            + "{\"name\":\"Lightning Bolt\",\"count\":4},{\"name\":\"Not A Real Card\"},{\"name\":\"Glorp\"}]}},"
            + "{\"player\":\"bot\"}]}");
        assertEquals(400, unknown.statusCode(), unknown.body());
        assertEquals("unknown_cards", json(unknown).get("code").getAsString());
        assertEquals(List.of("Not A Real Card", "Glorp"), strings(json(unknown).getAsJsonArray("names")));
        for (String invalid : new String[]{
            "{\"seats\":[{\"player\":\"human\",\"deck\":\"legacy-mono-red-burn\",\"deck_list\":{\"cards\":"
                + "[{\"name\":\"Mountain\"}]}},{\"player\":\"bot\"}]}",
            "{\"seats\":[{\"player\":\"human\",\"deck_list\":{\"cards\":[]}},{\"player\":\"bot\"}]}",
            "{\"seats\":[{\"player\":\"human\",\"deck_list\":{\"cards\":[{\"name\":\"Mountain\",\"count\":0}]}},"
                + "{\"player\":\"bot\"}]}",
            "{\"seats\":[{\"player\":\"human\",\"deck_list\":{\"cards\":[{\"name\":\"Mountain\"}],"
                + "\"commanders\":[\"Isamaru, Hound of Konda\"]}},{\"player\":\"bot\"}]}",
            "{\"format\":\"commander\",\"seats\":[{\"player\":\"human\",\"deck_list\":{\"cards\":"
                + "[{\"name\":\"Plains\",\"count\":99}]}},{\"player\":\"bot\"}]}",
        }) {
            var response = service("POST", GAMES, null, invalid);
            assertEquals(400, response.statusCode(), invalid + " -> " + response.body());
        }

        // Any card, in any number and any case: 25 copies of a four-of and a card from another deck.
        var created = service("POST", GAMES, null, "{\"seed\":42,\"skill\":1,\"format\":\"commander\",\"seats\":["
            + "{\"player\":\"human\",\"deck_list\":{\"cards\":[{\"name\":\"lightning bolt\",\"count\":25},"
            + "{\"name\":\"Mountain\",\"count\":40},{\"name\":\"Counterspell\",\"count\":5}],"
            + "\"commanders\":[\"krenko, mob boss\"]}},{\"player\":\"bot\"}]}");
        assertEquals(201, created.statusCode(), created.body());
        JsonObject game = json(created);
        String id = game.get("game_id").getAsString();
        assertEquals("custom", game.getAsJsonObject("settings").getAsJsonArray("seats").get(0).getAsJsonObject()
            .get("deck").getAsString());
        JsonObject open = untilPrompt(id, token(game, 0));
        JsonObject you = open.getAsJsonObject("view").getAsJsonObject("you");
        assertEquals(70, you.get("library_count").getAsInt() + you.get("hand_count").getAsInt());
        assertEquals("Krenko, Mob Boss", you.getAsJsonArray("commanders").get(0).getAsJsonObject()
            .get("name").getAsString());
        assertEquals(200, service("POST", GAMES + "/" + id + "/close", null, "").statusCode());
    }

    /** The inspection view shows every hand and library in XMage's order, and nothing on other routes. */
    @Test
    void inspectionShowsEveryHandAndLibraryAsXmageHasThem() throws Exception {
        start(false);
        JsonObject created = json(service("POST", GAMES, null, "{\"seed\":43,\"skill\":1,\"turn_cap\":8}"));
        String id = created.get("game_id").getAsString();
        String seat = token(created, 0);
        HumanGame game = games.service(id).orElseThrow();
        String inspection = GAMES + "/" + id + "/inspection";
        assertEquals(400, service("GET", inspection + "?wait_ms=99999", null, null).statusCode());
        assertEquals(405, service("POST", inspection, null, "").statusCode());

        int checked = 0;
        long since = -1;
        while (checked < 6) {
            JsonObject open = untilPrompt(id, seat);
            if (!open.get("result").isJsonNull()) {
                break;
            }
            // A prompt is open, so XMage waits and its state holds still while it is compared.
            var response = service("GET", inspection + "?wait_ms=5000", null, null);
            assertEquals(200, response.statusCode(), response.body());
            JsonObject inspected = json(response);
            assertEquals("live", inspected.get("status").getAsString());
            assertTrue(inspected.get("version").getAsLong() > since);
            since = inspected.get("version").getAsLong();
            assertMatchesXmage(game, inspected);
            checked++;
            JsonObject prompt = open.getAsJsonObject("prompt");
            String option = firstSafeOption(prompt);
            var answered = service("POST", GAMES + "/" + id + "/commands", seat, "{\"v\":1,\"game_id\":\"" + id
                + "\",\"action_id\":\"" + UUID.randomUUID() + "\",\"expected_revision\":" + open.get("revision")
                + ",\"prompt_id\":\"" + prompt.get("id").getAsString() + "\",\"type\":\"submit_choice\","
                + "\"payload\":{\"option_id\":\"" + option + "\"}}");
            assertEquals(200, answered.statusCode(), answered.body());
        }
        assertTrue(checked >= 3, "inspected at " + checked + " prompts");

        assertEquals(200, service("POST", GAMES + "/" + id + "/close", null, "").statusCode());
        untilPrompt(id, seat);
        JsonObject last = json(service("GET", inspection, null, null));
        assertEquals("finished", last.get("status").getAsString());
        assertEquals("closed", last.getAsJsonObject("result").get("kind").getAsString());
        assertEquals(2, last.getAsJsonArray("players").size());
        assertFalse(last.toString().contains("\"seed\""));
    }

    /** Answers a prompt in a way that keeps the game going: keep, pass, or the first option. */
    private static String firstSafeOption(JsonObject prompt) {
        for (JsonElement element : prompt.getAsJsonArray("options")) {
            String action = element.getAsJsonObject().get("action").getAsString();
            if (action.equals("keep") || action.equals("pass") || action.equals("done")) {
                return element.getAsJsonObject().get("id").getAsString();
            }
        }
        return prompt.getAsJsonArray("options").get(0).getAsJsonObject().get("id").getAsString();
    }

    private static void assertMatchesXmage(HumanGame game, JsonObject inspected) {
        Game state = game.game();
        JsonArray players = inspected.getAsJsonArray("players");
        assertEquals(game.seatIds().size(), players.size());
        for (int seat = 0; seat < players.size(); seat++) {
            JsonObject entry = players.get(seat).getAsJsonObject();
            Player player = state.getPlayer(game.seatIds().get(seat));
            assertEquals(seat, entry.get("seat").getAsInt());
            assertEquals(names(player.getHand().getCards(state)), cardNames(entry.getAsJsonArray("hand")),
                "seat " + seat + " hand");
            assertEquals(names(player.getLibrary().getCards(state)), cardNames(entry.getAsJsonArray("library")),
                "seat " + seat + " library, top first");
            List<Card> library = player.getLibrary().getCards(state);
            JsonArray shown = entry.getAsJsonArray("library");
            for (int i = 0; i < library.size(); i++) {
                String ref = shown.get(i).getAsJsonObject().get("id").getAsString();
                assertEquals(library.get(i).getId(), game.refs().resolve(ref).orElseThrow(),
                    "seat " + seat + " library position " + i);
            }
        }
        assertEquals(2, inspected.getAsJsonObject("settings").getAsJsonArray("seats").size());
        for (JsonElement entry : inspected.getAsJsonObject("settings").getAsJsonArray("seats")) {
            assertFalse(entry.getAsJsonObject().get("deck").isJsonNull(), "SysOp sees every seat's deck");
        }
        assertTrue(inspected.getAsJsonObject("view").get("you").isJsonNull());
    }

    private static List<String> names(Iterable<Card> cards) {
        List<String> names = new ArrayList<>();
        cards.forEach(card -> names.add(card.getName()));
        return names;
    }

    private static List<String> cardNames(JsonArray cards) {
        List<String> names = new ArrayList<>();
        cards.forEach(card -> names.add(card.getAsJsonObject().get("name").getAsString()));
        return names;
    }

    private static List<String> strings(JsonArray array) {
        List<String> values = new ArrayList<>();
        array.forEach(value -> values.add(value.getAsString()));
        return values;
    }

    @Test
    void cardNamesCanBeLookedUp() throws Exception {
        start(false);
        JsonObject found = json(service("GET", "/v1/service/cards?q=lightning%20bo&limit=5", null, null));
        assertEquals("Lightning Bolt", found.getAsJsonArray("names").get(0).getAsString());
        assertTrue(found.getAsJsonArray("names").size() <= 5);
        assertEquals(400, service("GET", "/v1/service/cards", null, null).statusCode());
        assertEquals(400, service("GET", "/v1/service/cards?q=bolt&limit=0", null, null).statusCode());
        assertEquals(405, service("POST", "/v1/service/cards?q=bolt", null, "").statusCode());
        assertEquals("Lightning Bolt", DeckLists.find("LIGHTNING BOLT").getName());
    }
}
