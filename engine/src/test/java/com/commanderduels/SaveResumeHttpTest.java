package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpServer;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Save and resume as the API meets it (v1.0.0), over HTTP with real XMage games: a game its player
 * saves stops where it is ({@code POST /v1/service/games/{id}/save}), waits in its recording for as
 * long as its save lasts, and comes back when it is asked for ({@code attach} with {@code resume}),
 * in the same engine or the one that follows it, every seat as it was.
 */
class SaveResumeHttpTest {
    private static final XmagePin PIN = XmagePin.load();
    private static final CardDatabase.Stats CARDS = new CardDatabase.Stats(120, 100, 5, false);
    private static final String SERVICE_TOKEN = "service-token-for-tests-0123456789abcdef";
    private static final String GAMES = "/v1/service/games";

    private final HttpClient client = HttpClient.newHttpClient();
    private HttpServer server;
    private HumanGames games;
    private String base;
    private Path recordings;

    @BeforeAll
    static void loadCards() {
        CardDatabase.load();
        Tables.actAsClient();
    }

    @BeforeEach
    void folder() throws Exception {
        recordings = Files.createTempDirectory("recordings");
    }

    @AfterEach
    void stop() throws Exception {
        die();
        client.close();
        Recordings.deleteAll(recordings);
    }

    /** An engine on the recordings folder: the first, or the one that follows a dead one. */
    private void start(int maxGames, long retentionMillis) throws Exception {
        games = new HumanGames(SeatChecks.DECKS, maxGames, recordings, retentionMillis);
        var engine = new Engine(PIN, false, () -> CARDS, EngineServerTest::echo, games, false, SERVICE_TOKEN);
        server = EngineServer.create(0, engine);
        server.start();
        base = "http://localhost:" + server.getAddress().getPort();
        engine.startLoading().join();
    }

    /** The engine is gone as a dead process is: its games with it, their recordings as they stand. */
    private void die(String... ids) {
        if (server == null) {
            return;
        }
        for (String id : ids) {
            games.service(id).ifPresent(game -> {
                assertTrue(game.recorder().awaitDurable());
                game.interrupt();
            });
        }
        // The rest go with the process, as they stand.
        for (HumanGame game : games.runningForTest()) {
            game.interrupt();
        }
        server.stop(0);
        server = null;
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
        for (var entry : created.getAsJsonArray("seats")) {
            JsonObject object = entry.getAsJsonObject();
            if (object.get("seat").getAsInt() == seat) {
                return object.get("seat_token").getAsString();
            }
        }
        throw new AssertionError("no seat " + seat);
    }

    private JsonObject view(String id, String seat) throws Exception {
        var response = service("GET", GAMES + "/" + id + "/view", seat, null);
        assertEquals(200, response.statusCode(), response.body());
        return json(response);
    }

    /** Waits until one of the two seats is asked something (or the game is over) and returns that seat's view. */
    private JsonObject untilAsked(String id, String... tokens) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120);
        while (true) {
            for (String seat : tokens) {
                JsonObject view = view(id, seat);
                if (!view.get("prompt").isJsonNull() || !view.get("result").isJsonNull()) {
                    return view;
                }
            }
            assertTrue(System.nanoTime() < deadline, "no seat was asked");
            Thread.sleep(20);
        }
    }

    /** Answers whichever seat is asked, {@code answers} times, as a scripted player; returns the last view asked. */
    private JsonObject play(String id, ScriptedPlayer player, int answers, String... tokens) throws Exception {
        JsonObject asked = untilAsked(id, tokens);
        for (int answered = 0; answered < answers && asked.get("result").isJsonNull(); ) {
            int seat = asked.get("seat").getAsInt();
            PromptView prompt = EngineServer.JSON.fromJson(asked.get("prompt"), PromptView.class);
            SeatView seatView = EngineServer.JSON.fromJson(asked.get("view"), SeatView.class);
            String option = player.choose(prompt, seatView);
            JsonObject command = new JsonObject();
            command.addProperty("v", 1);
            command.addProperty("game_id", id);
            command.addProperty("action_id", UUID.randomUUID().toString());
            command.addProperty("expected_revision", asked.get("revision").getAsLong());
            command.addProperty("prompt_id", prompt.id());
            command.addProperty("type", "submit_choice");
            JsonObject payload = new JsonObject();
            if (option.startsWith(Tables.AMOUNTS)) {
                JsonArray amounts = new JsonArray();
                amounts.add(Integer.parseInt(option.substring(Tables.AMOUNTS.length())));
                payload.add("amounts", amounts);
            } else if (option.startsWith(Tables.TEXT)) {
                payload.addProperty("text", option.substring(Tables.TEXT.length()));
            } else {
                payload.addProperty("option_id", option);
            }
            command.add("payload", payload);
            var reply = service("POST", GAMES + "/" + id + "/commands", tokens[seat], command.toString());
            if (reply.statusCode() == 200) {
                answered++;
            } else {
                assertEquals(409, reply.statusCode(), reply.body());
            }
            asked = untilAsked(id, tokens);
        }
        return asked;
    }

    private static String duel(long seed, String gameId) {
        return "{\"seed\":" + seed + ",\"format\":\"legacy\",\"skill\":1,\"turn_cap\":30,"
            + (gameId == null ? "" : "\"game_id\":\"" + gameId + "\",")
            + "\"seats\":[{\"player\":\"human\",\"deck\":\"" + LegacyDuel.DECKS.get(0) + "\"},"
            + "{\"player\":\"human\",\"deck\":\"" + LegacyDuel.DECKS.get(1) + "\"}]}";
    }

    /** A view without what goes on across a recovery by design: the revision, and the prompt's own id. */
    private static JsonObject comparable(JsonObject view) {
        JsonObject copy = view.deepCopy();
        copy.remove("revision");
        if (copy.get("prompt").isJsonObject()) {
            copy.getAsJsonObject("prompt").remove("id");
        }
        return copy;
    }

    /** One person against one bot: the game a player saves. */
    private static String solo(long seed, String gameId) {
        return "{\"seed\":" + seed + ",\"format\":\"legacy\",\"skill\":1,\"turn_cap\":30,"
            + "\"game_id\":\"" + gameId + "\","
            + "\"seats\":[{\"player\":\"human\",\"deck\":\"" + LegacyDuel.DECKS.get(0) + "\"},"
            + "{\"player\":\"bot\"}]}";
    }

    private static String until(long millisFromNow) {
        return "{\"until_millis\":" + (System.currentTimeMillis() + millisFromNow) + "}";
    }

    private HttpResponse<String> save(String id, long millisFromNow) throws Exception {
        return service("POST", GAMES + "/" + id + "/save", null, until(millisFromNow));
    }

    private HttpResponse<String> resume(String id) throws Exception {
        return service("POST", GAMES + "/" + id + "/attach", null, "{\"resume\":true}");
    }

    private JsonObject saves() throws Exception {
        return json(service("GET", "/v1/service/recordings", null, null)).getAsJsonObject("saves");
    }

    @Test
    void aSavedGameWaitsInItsRecordingAndComesBackWhereItStood() throws Exception {
        // Room for one game: a saved game takes none.
        start(1, 1);
        String id = UUID.randomUUID().toString();
        var createdResponse = service("POST", GAMES, null, solo(71L, id));
        assertEquals(201, createdResponse.statusCode(), createdResponse.body());
        String human = token(json(createdResponse), 0);
        var player = new ScriptedPlayer(71);
        JsonObject asked = play(id, player, 20, human);
        assertTrue(asked.get("result").isJsonNull(), "the game is still being played");
        JsonObject inspection = json(service("GET", GAMES + "/" + id + "/inspection", null, null));

        // Only the API may ask, with a time to come.
        assertEquals(401, send("POST", GAMES + "/" + id + "/save", null, null, until(60_000)).statusCode());
        assertEquals(405, service("GET", GAMES + "/" + id + "/save", null, null).statusCode());
        assertEquals(400, service("POST", GAMES + "/" + id + "/save", null, "{}").statusCode());
        assertEquals(400, save(id, -1_000).statusCode());
        assertEquals(404, save(UUID.randomUUID().toString(), 60_000).statusCode());
        assertEquals(asked.get("prompt"), view(id, human).get("prompt"), "a refused save leaves the game as it was");

        var saved = save(id, 3_600_000);
        assertEquals(200, saved.statusCode(), saved.body());
        assertEquals("saved", json(saved).get("status").getAsString());
        assertEquals(EngineBuild.key(), json(saved).get("engine_build").getAsString());

        // The game is not here any more: its token finds nothing, it cannot be saved twice, and its
        // slot is free for another game.
        assertEquals(404, service("GET", GAMES + "/" + id + "/view", human, null).statusCode());
        assertEquals(404, save(id, 3_600_000).statusCode());
        assertEquals(404, service("GET", GAMES + "/" + id + "/inspection", null, null).statusCode());
        String other = UUID.randomUUID().toString();
        var next = service("POST", GAMES, null, solo(72L, other));
        assertEquals(201, next.statusCode(), next.body());
        assertEquals(200, service("POST", GAMES + "/" + other + "/close", null, "{}").statusCode());

        // It has no result, and its recording outlasts the sweep however old it is (retention: 1 ms).
        Recording recording = Recording.of(recordings, id);
        assertTrue(recording.result().isEmpty());
        assertTrue(recording.savedUntil().isPresent());
        Thread.sleep(20);
        games.sweepRecordings();
        assertTrue(recording.exists(), "a saved game is kept until its save runs out");
        assertEquals(1, saves().get("waiting").getAsInt());

        // Something that follows games and finds this one missing does not bring it back.
        var missed = service("POST", GAMES + "/" + id + "/attach", null, "{}");
        assertEquals(409, missed.statusCode(), missed.body());
        assertEquals("recording_saved", json(missed).get("code").getAsString());
        assertTrue(recording.savedUntil().isPresent());

        // The engine that follows this one gives the game back when its player asks.
        die();
        start(4, TimeUnit.HOURS.toMillis(24));
        var resumed = resume(id);
        assertEquals(200, resumed.statusCode(), resumed.body());
        assertEquals("recovered", json(resumed).get("status").getAsString());
        String again = token(json(resumed), 0);
        assertNotEquals(human, again);
        assertTrue(recording.savedUntil().isEmpty(), "running again, it is a recording like any other");
        JsonObject askedAgain = untilAsked(id, again);
        assertEquals(comparable(asked), comparable(askedAgain));
        assertTrue(askedAgain.get("revision").getAsLong() > asked.get("revision").getAsLong());
        JsonObject inspectionAgain = json(service("GET", GAMES + "/" + id + "/inspection", null, null));
        assertEquals(inspection.get("players"), inspectionAgain.get("players"), "every hand and library");

        // Saved and resumed more often than a game may be interrupted in a row, with nothing
        // answered in between: a save is its player's doing, and the game is given back each time.
        String seat = again;
        for (int round = 0; round <= Recovery.MAX_FRUITLESS; round++) {
            assertEquals(200, save(id, 3_600_000).statusCode());
            var back = resume(id);
            assertEquals(200, back.statusCode(), "round " + round + ": " + back.body());
            seat = token(json(back), 0);
            assertEquals(comparable(asked), comparable(untilAsked(id, seat)), "round " + round);
        }

        // Played to its end, it is over as any game is.
        JsonObject last = play(id, player, 3000, seat);
        assertFalse(last.get("result").isJsonNull());
        assertNotEquals("suspended", last.getAsJsonObject("result").get("kind").getAsString());
        assertEquals(409, save(id, 3_600_000).statusCode(), "a game that is over is not saved");
        var finished = resume(id);
        assertEquals("finished", json(finished).get("status").getAsString());
        assertEquals(last.get("result"), json(finished).get("result"));
        JsonObject counted = saves();
        assertEquals(0, counted.get("waiting").getAsInt(), counted.toString());
        assertEquals(Recovery.MAX_FRUITLESS + 1, counted.get("saved").getAsInt(), counted.toString());
        assertEquals(Recovery.MAX_FRUITLESS + 2, counted.get("resumed").getAsInt(), counted.toString());
    }

    @Test
    void aSavedGameIsKeptUntilItsSaveRunsOutAndNoLonger() throws Exception {
        start(4, TimeUnit.HOURS.toMillis(24));
        String id = UUID.randomUUID().toString();
        var created = service("POST", GAMES, null, solo(73L, id));
        assertEquals(201, created.statusCode(), created.body());
        play(id, new ScriptedPlayer(73), 8, token(json(created), 0));
        assertEquals(200, save(id, 400).statusCode());
        Recording recording = Recording.of(recordings, id);
        assertEquals(0, games.sweepRecordings());
        assertTrue(recording.exists());

        Thread.sleep(450);
        assertEquals(1, games.sweepRecordings(), "past its time it goes, though the retention is a day");
        assertFalse(recording.exists());
        assertEquals(404, resume(id).statusCode());
        JsonObject counted = saves();
        assertEquals(1, counted.get("expired").getAsInt(), counted.toString());
        assertEquals(0, counted.get("waiting").getAsInt(), counted.toString());
    }

    @Test
    void onlyASavedGameIsGivenUp() throws Exception {
        start(4, TimeUnit.HOURS.toMillis(24));
        String id = UUID.randomUUID().toString();
        var created = service("POST", GAMES, null, solo(74L, id));
        assertEquals(201, created.statusCode(), created.body());
        String human = token(json(created), 0);
        play(id, new ScriptedPlayer(74), 8, human);
        Recording recording = Recording.of(recordings, id);

        // A game that runs is not removed by a discard.
        assertEquals(401, send("POST", GAMES + "/" + id + "/discard", null, null, "{}").statusCode());
        var running = service("POST", GAMES + "/" + id + "/discard", null, "{}");
        assertEquals(409, running.statusCode(), running.body());
        assertEquals("game_running", json(running).get("code").getAsString());
        assertTrue(recording.exists());

        assertEquals(200, save(id, 3_600_000).statusCode());
        var discarded = service("POST", GAMES + "/" + id + "/discard", null, "{}");
        assertEquals(200, discarded.statusCode(), discarded.body());
        assertTrue(json(discarded).get("removed").getAsBoolean());
        assertFalse(recording.exists());
        // Safe to ask twice, and the game is gone for good.
        var twice = service("POST", GAMES + "/" + id + "/discard", null, "{}");
        assertEquals(200, twice.statusCode(), twice.body());
        assertFalse(json(twice).get("removed").getAsBoolean());
        assertEquals(404, resume(id).statusCode());

        // A game that is over keeps its recording: its result is the API's to ask for.
        String over = UUID.randomUUID().toString();
        assertEquals(201, service("POST", GAMES, null, solo(75L, over)).statusCode());
        assertEquals(200, service("POST", GAMES + "/" + over + "/close", null, "{}").statusCode());
        var kept = service("POST", GAMES + "/" + over + "/discard", null, "{}");
        assertEquals(200, kept.statusCode(), kept.body());
        assertFalse(json(kept).get("removed").getAsBoolean());
        assertTrue(Recording.of(recordings, over).result().isPresent());
        assertEquals(1, saves().get("discarded").getAsInt());
    }

    @Test
    void aGameThatCannotBeSavedPlaysOn() throws Exception {
        start(4, TimeUnit.HOURS.toMillis(24));
        String id = UUID.randomUUID().toString();
        var created = service("POST", GAMES, null, solo(76L, id));
        assertEquals(201, created.statusCode(), created.body());
        String human = token(json(created), 0);
        var player = new ScriptedPlayer(76);
        JsonObject asked = play(id, player, 8, human);

        // Its recording stopped (a full disk): there is nothing to save it in, and it says so.
        games.service(id).orElseThrow().recorder().failForTest("the disk is full");
        var refused = save(id, 3_600_000);
        assertEquals(409, refused.statusCode(), refused.body());
        assertEquals("not_recorded", json(refused).get("code").getAsString());
        assertTrue(Recording.of(recordings, id).savedUntil().isEmpty());

        // The game is where it was, and is played on with the same token.
        assertEquals(asked.get("prompt"), view(id, human).get("prompt"));
        JsonObject later = play(id, player, 3, human);
        assertTrue(later.get("revision").getAsLong() > asked.get("revision").getAsLong());
    }
}
