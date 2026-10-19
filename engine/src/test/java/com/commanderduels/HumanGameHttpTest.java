package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpServer;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** The development game endpoints over HTTP, with real XMage games. Needs ./db and ./decks. */
class HumanGameHttpTest {
    private static final XmagePin PIN = XmagePin.load();
    private static final CardDatabase.Stats CARDS = new CardDatabase.Stats(120, 100, 5, false);

    private final HttpClient client = HttpClient.newHttpClient();
    private HttpServer server;
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

    private void start(HumanGames games) throws Exception {
        var engine = new Engine(PIN, games != null, () -> CARDS, EngineServerTest::echo, games);
        server = EngineServer.create(0, engine);
        server.start();
        base = "http://localhost:" + server.getAddress().getPort();
        engine.startLoading().join();
    }

    private HttpResponse<String> send(String method, String path, String token, String body) throws Exception {
        var builder = HttpRequest.newBuilder(URI.create(base + path))
            .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body));
        if (token != null) {
            builder.header("Authorization", "Bearer " + token);
        }
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }

    private static JsonObject json(HttpResponse<String> response) {
        return JsonParser.parseString(response.body()).getAsJsonObject();
    }

    private static String command(String gameId, long revision, String promptId, String type, String payload) {
        return "{\"v\":1,\"game_id\":\"" + gameId + "\",\"action_id\":\"" + UUID.randomUUID()
            + "\",\"expected_revision\":" + revision + (promptId == null ? "" : ",\"prompt_id\":\"" + promptId + "\"")
            + ",\"type\":\"" + type + "\",\"payload\":" + payload + "}";
    }

    /** Long-polls the view until a prompt is open or the game has finished. */
    private JsonObject untilPrompt(String gameId, String token) throws Exception {
        long since = -1;
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (true) {
            var response = send("GET", "/v1/games/" + gameId + "/view?wait_ms=5000&since=" + since, token, null);
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
    void gamesAreAbsentUnlessDevelopmentEndpointsAreOn() throws Exception {
        start(null);
        var response = send("POST", "/v1/games", null, "{}");
        assertEquals(503, response.statusCode());
        assertEquals("engine_not_integrated", json(response).get("code").getAsString());
    }

    @Test
    void theSeatTokenAloneSelectsTheSeat() throws Exception {
        start(new HumanGames(SeatChecks.DECKS, 1));
        assertEquals(405, send("GET", "/v1/games", null, null).statusCode());
        for (String invalid : new String[]{
            "{\"seats\":[{\"player\":\"human\",\"deck\":\"vintage-power\"},{\"player\":\"bot\"}]}",
            "{\"format\":\"two_headed_giant\"}",
            "{\"seats\":[{\"player\":\"bot\"},{\"player\":\"bot\"}]}",
            "{\"seats\":[{\"player\":\"human\"},{\"player\":\"bot\"},{\"player\":\"bot\"}]}",
            "{\"format\":\"commander\",\"seats\":[{\"player\":\"human\"}]}",
            "{\"format\":\"commander\",\"seats\":[{\"player\":\"human\",\"deck\":\"legacy-mono-red-burn\"},"
                + "{\"player\":\"bot\"}]}",
            "{\"seats\":[{\"player\":\"human\",\"seat\":1},{\"player\":\"bot\"}]}",
        }) {
            var bad = send("POST", "/v1/games", null, invalid);
            assertEquals(400, bad.statusCode(), invalid + " -> " + bad.body());
        }

        var created = send("POST", "/v1/games", null, "{\"seed\":31,\"skill\":1,\"turn_cap\":10}");
        assertEquals(201, created.statusCode(), created.body());
        JsonObject game = json(created);
        String id = game.get("game_id").getAsString();
        JsonArray seats = game.getAsJsonArray("seats");
        assertEquals(2, seats.size());
        String token = token(game, 0);
        assertEquals("human", seats.get(0).getAsJsonObject().get("player").getAsString());
        assertTrue(seats.get(1).getAsJsonObject().get("seat_token").isJsonNull(), "a bot seat has no token");
        assertFalse(created.body().contains("\"seed\""), "the seed determines every shuffle and is never returned");
        JsonObject settings = game.getAsJsonObject("settings");
        assertEquals("legacy", settings.get("format").getAsString());
        assertEquals("legacy-mono-red-burn",
            settings.getAsJsonArray("seats").get(0).getAsJsonObject().get("deck").getAsString());

        String view = "/v1/games/" + id + "/view";
        assertEquals(404, send("GET", view, null, null).statusCode());
        assertEquals(404, send("GET", view, token + "x", null).statusCode());
        assertEquals(404, send("GET", "/v1/games/" + UUID.randomUUID() + "/view", token, null).statusCode());
        assertEquals(404, send("GET", "/v1/games/" + id + "/hand", token, null).statusCode());
        assertEquals(400, send("GET", view + "?wait_ms=99999", token, null).statusCode());
        assertEquals(400, send("GET", view + "?since=soon", token, null).statusCode());
        assertEquals(405, send("POST", view, token, "{}").statusCode());

        JsonObject open = untilPrompt(id, token);
        assertFalse(open.toString().contains("\"seed\""));
        assertEquals(0, open.get("seat").getAsInt());
        JsonObject opponent = open.getAsJsonObject("view").getAsJsonArray("opponents").get(0).getAsJsonObject();
        assertFalse(opponent.has("hand"), "the opponent's hand is a count only");
        assertTrue(opponent.get("hand_count").getAsInt() >= 0);
        assertTrue(open.getAsJsonObject("settings").getAsJsonArray("seats").get(1).getAsJsonObject().get("deck")
            .isJsonNull(), "the opponent's deck is private");
        long revision = open.get("revision").getAsLong();
        JsonObject prompt = open.getAsJsonObject("prompt");
        String promptId = prompt.get("id").getAsString();
        String option = prompt.getAsJsonArray("options").get(0).getAsJsonObject().get("id").getAsString();

        String commands = "/v1/games/" + id + "/commands";
        assertEquals(404, send("POST", commands, null, command(id, revision, promptId, "submit_choice",
            "{\"option_id\":\"" + option + "\"}")).statusCode());
        for (String invalid : new String[]{
            "not json",
            command(UUID.randomUUID().toString(), revision, promptId, "submit_choice", "{\"option_id\":\"1\"}"),
            command(id, revision, promptId, "submit_choice", "{\"option_id\":\"1\",\"seat\":1}"),
            command(id, revision, promptId, "submit_choice", "{}"),
            command(id, revision, null, "submit_choice", "{\"option_id\":\"1\"}"),
            command(id, revision, promptId, "advance_bot", "{}"),
            command(id, revision, promptId, "submit_choice", "{\"option_id\":\"1\"}").replace("\"v\":1", "\"v\":2"),
            command(id, revision, promptId, "submit_choice", "{\"option_id\":\"1\"}")
                .replace("{\"v\":1,", "{\"v\":1,\"seat\":1,"),
        }) {
            var response = send("POST", commands, token, invalid);
            assertEquals(400, response.statusCode(), invalid + " -> " + response.body());
            assertEquals("invalid_command", json(response).get("code").getAsString());
        }
        var stale = send("POST", commands, token, command(id, revision + 5, promptId, "submit_choice",
            "{\"option_id\":\"" + option + "\"}"));
        assertEquals(409, stale.statusCode());
        assertEquals("stale_revision", json(stale).get("code").getAsString());
        var accepted = send("POST", commands, token, command(id, revision, promptId, "submit_choice",
            "{\"option_id\":\"" + option + "\"}"));
        assertEquals(200, accepted.statusCode(), accepted.body());
        assertEquals("accepted", json(accepted).get("status").getAsString());

        JsonObject next = untilPrompt(id, token);
        var conceded = send("POST", commands, token, command(id, next.get("revision").getAsLong(), null, "concede",
            "{}"));
        assertEquals(200, conceded.statusCode(), conceded.body());
        JsonObject last = untilPrompt(id, token);
        JsonObject result = last.getAsJsonObject("result");
        assertEquals("finished", last.get("status").getAsString());
        assertEquals("completed", result.get("kind").getAsString(), result.toString());
        assertEquals(1, result.get("winner_seat").getAsInt());
        assertEquals(0, result.getAsJsonArray("conceded_seats").get(0).getAsInt());
        assertTrue(last.get("log_count").getAsInt() > 0);
    }

    @Test
    void gamesAreCappedAndCanBeClosed() throws Exception {
        start(new HumanGames(SeatChecks.DECKS, 1));
        JsonObject first = json(send("POST", "/v1/games", null, "{\"seed\":32,\"skill\":1}"));
        String id = first.get("game_id").getAsString();
        String token = token(first, 0);
        var busy = send("POST", "/v1/games", null, "{}");
        assertEquals(429, busy.statusCode());
        assertEquals("games_busy", json(busy).get("code").getAsString());
        assertEquals("30", busy.headers().firstValue("Retry-After").orElse(""));

        untilPrompt(id, token);
        assertEquals(404, send("POST", "/v1/games/" + id + "/close", null, "").statusCode());
        var closed = send("POST", "/v1/games/" + id + "/close", token, "");
        assertEquals(200, closed.statusCode(), closed.body());
        assertEquals("finished", json(closed).get("status").getAsString());
        JsonObject last = untilPrompt(id, token);
        assertEquals("closed", last.getAsJsonObject("result").get("kind").getAsString());

        var second = send("POST", "/v1/games", null, "{\"seed\":33,\"skill\":1}");
        assertEquals(201, second.statusCode(), second.body());
        JsonObject game = json(second);
        assertEquals(200, send("POST", "/v1/games/" + game.get("game_id").getAsString() + "/close",
            token(game, 0), "").statusCode());
    }

    /** The spectator token reads the public view and nothing else. */
    @Test
    void theSpectatorTokenOnlyReadsThePublicView() throws Exception {
        start(new HumanGames(SeatChecks.DECKS, 1));
        var created = send("POST", "/v1/games", null, "{\"seed\":35,\"skill\":1,\"format\":\"commander\","
            + "\"seats\":[{\"player\":\"human\"},{\"player\":\"bot\"},{\"player\":\"bot\"}]}");
        assertEquals(201, created.statusCode(), created.body());
        JsonObject game = json(created);
        String id = game.get("game_id").getAsString();
        String spectator = game.get("spectator_token").getAsString();
        assertFalse(spectator.equals(token(game, 0)));
        assertEquals(0, game.getAsJsonObject("settings").get("spectator_delay_seconds").getAsInt());

        untilPrompt(id, token(game, 0));
        JsonObject watched = json(send("GET", "/v1/games/" + id + "/view?wait_ms=5000", spectator, null));
        assertTrue(watched.get("seat").isJsonNull());
        assertTrue(watched.get("prompt").isJsonNull(), "a spectator never sees a prompt");
        assertEquals("spectating", watched.get("status").getAsString());
        JsonObject view = watched.getAsJsonObject("view");
        assertTrue(view.get("you").isJsonNull());
        assertEquals(0, view.getAsJsonArray("hand").size());
        assertEquals(3, view.getAsJsonArray("opponents").size(), "a spectator sees every player");
        for (var seat : watched.getAsJsonObject("settings").getAsJsonArray("seats")) {
            assertTrue(seat.getAsJsonObject().get("deck").isJsonNull(), "a spectator sees no deck");
        }

        String commands = "/v1/games/" + id + "/commands";
        var refused = send("POST", commands, spectator, command(id, 0, null, "concede", "{}"));
        assertEquals(403, refused.statusCode(), refused.body());
        assertEquals("read_only", json(refused).get("code").getAsString());
        assertEquals(403, send("POST", "/v1/games/" + id + "/close", spectator, "").statusCode());
        assertEquals(200, send("POST", "/v1/games/" + id + "/close", token(game, 0), "").statusCode());
    }

    private static String token(JsonObject created, int seat) {
        return created.getAsJsonArray("seats").get(seat).getAsJsonObject().get("seat_token").getAsString();
    }

    /** Each human seat's token reads and answers for that seat only; no request can pick another seat. */
    @Test
    void eachSeatTokenSelectsOnlyItsOwnSeat() throws Exception {
        start(new HumanGames(SeatChecks.DECKS, 1));
        var created = send("POST", "/v1/games", null, "{\"seed\":34,\"skill\":1,\"turn_cap\":12,"
            + "\"format\":\"commander\",\"seats\":[{\"player\":\"human\"},{\"player\":\"bot\"},"
            + "{\"player\":\"human\"},{\"player\":\"bot\"}]}");
        assertEquals(201, created.statusCode(), created.body());
        JsonObject game = json(created);
        String id = game.get("game_id").getAsString();
        String first = token(game, 0);
        String third = token(game, 2);
        assertFalse(first.equals(third));
        assertTrue(game.getAsJsonArray("seats").get(1).getAsJsonObject().get("seat_token").isJsonNull());
        assertEquals("commander_free_for_all", game.getAsJsonObject("settings").get("rules_profile").getAsString());

        for (int seat : new int[]{0, 2}) {
            JsonObject view = json(send("GET", "/v1/games/" + id + "/view", seat == 0 ? first : third, null));
            assertEquals(seat, view.get("seat").getAsInt());
            JsonArray seats = view.getAsJsonObject("settings").getAsJsonArray("seats");
            for (int other = 0; other < 4; other++) {
                assertEquals(other == seat, !seats.get(other).getAsJsonObject().get("deck").isJsonNull(),
                    "seat " + seat + " sees only its own deck");
            }
        }

        // Whichever seat XMage asks first, the other seat's token cannot answer that prompt.
        JsonObject asked = null;
        String askedToken = null;
        String otherToken = null;
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (asked == null) {
            assertTrue(System.nanoTime() < deadline, "no prompt for either seat");
            for (String token : new String[]{first, third}) {
                JsonObject view = json(send("GET", "/v1/games/" + id + "/view?wait_ms=500", token, null));
                if (!view.get("prompt").isJsonNull()) {
                    asked = view;
                    askedToken = token;
                    otherToken = token.equals(first) ? third : first;
                    break;
                }
            }
        }
        assertEquals(3, asked.getAsJsonObject("view").getAsJsonArray("opponents").size());
        String promptId = asked.getAsJsonObject("prompt").get("id").getAsString();
        String option = asked.getAsJsonObject("prompt").getAsJsonArray("options").get(0).getAsJsonObject()
            .get("id").getAsString();
        long revision = asked.get("revision").getAsLong();
        String commands = "/v1/games/" + id + "/commands";
        JsonObject otherView = json(send("GET", "/v1/games/" + id + "/view", otherToken, null));
        assertTrue(otherView.get("prompt").isJsonNull(), "only one prompt is open per game");
        var forged = send("POST", commands, otherToken, command(id, otherView.get("revision").getAsLong(), promptId,
            "submit_choice", "{\"option_id\":\"" + option + "\"}"));
        assertEquals(409, forged.statusCode(), forged.body());
        assertEquals("stale_prompt", json(forged).get("code").getAsString());
        var accepted = send("POST", commands, askedToken, command(id, revision, promptId, "submit_choice",
            "{\"option_id\":\"" + option + "\"}"));
        assertEquals(200, accepted.statusCode(), accepted.body());

        var closed = send("POST", "/v1/games/" + id + "/close", otherToken, "");
        assertEquals(200, closed.statusCode(), closed.body());
        JsonObject last = untilPrompt(id, first);
        assertEquals("closed", last.getAsJsonObject("result").get("kind").getAsString());
        assertEquals("finished", json(send("GET", "/v1/games/" + id + "/view", third, null)).get("status")
            .getAsString());
    }
}
