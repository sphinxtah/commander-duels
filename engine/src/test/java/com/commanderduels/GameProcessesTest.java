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
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Each game in a process of its own (v0.9.10), over HTTP as the API meets it, with real XMage games
 * in real Java processes started from this test's class path. The test's own process is the front
 * process: it holds the card database, which the game processes read through it.
 */
class GameProcessesTest {
    private static final XmagePin PIN = XmagePin.load();
    private static final CardDatabase.Stats CARDS = new CardDatabase.Stats(120, 100, 5, false);
    private static final String SERVICE_TOKEN = "service-token-for-tests-0123456789abcdef";
    private static final String GAMES = "/v1/service/games";

    private final HttpClient client = HttpClient.newHttpClient();
    private HttpServer server;
    private GameProcesses processes;
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
        if (processes != null) {
            processes.close();
        }
        if (server != null) {
            server.stop(0);
        }
        client.close();
        Recordings.deleteAll(recordings);
    }

    /** A front process whose games run in processes of their own, within {@code budget} megabytes. */
    private void start(long budget, int warm) throws Exception {
        start(budget, warm, 3);
    }

    private void start(long budget, int warm, int finishedGraceSeconds) throws Exception {
        Map<GameProcesses.Size, Integer> heaps = new EnumMap<>(GameProcesses.Size.class);
        heaps.put(GameProcesses.Size.DUEL, 512);
        heaps.put(GameProcesses.Size.TABLE, 768);
        heaps.put(GameProcesses.Size.COURT, 1024);
        Map<GameProcesses.Size, Integer> warmEach = new EnumMap<>(GameProcesses.Size.class);
        for (GameProcesses.Size size : GameProcesses.Size.values()) {
            warmEach.put(size, size == GameProcesses.Size.COURT ? 0 : warm);
        }
        var settings = new GameProcesses.Settings(GameProcesses.Settings.launcher(), Path.of("").toAbsolutePath(),
            heaps, 256, budget, warmEach, 8, false, List.of(),
            Map.of("CD_ENGINE_DECKS", SeatChecks.DECKS.toAbsolutePath().toString(),
                "CD_ENGINE_RECORDINGS", recordings.toString(),
                "CD_ENGINE_AI_THREADS", "2"),
            TimeUnit.SECONDS.toMillis(finishedGraceSeconds), TimeUnit.SECONDS.toMillis(60));
        var games = new HumanGames(SeatChecks.DECKS, 8, recordings, TimeUnit.HOURS.toMillis(24));
        var engine = new Engine(PIN, false, () -> CARDS, EngineServerTest::echo, games, false, SERVICE_TOKEN);
        processes = new GameProcesses(settings);
        engine.isolate(processes);
        server = EngineServer.create(0, engine);
        server.start();
        base = "http://localhost:" + server.getAddress().getPort();
        engine.startLoading().join();
        processes.open();
    }

    private HttpResponse<String> service(String method, String path, String seat, String body) throws Exception {
        var builder = HttpRequest.newBuilder(URI.create(base + path)).method(method,
                body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofString(body))
            .header(EngineServer.SERVICE_TOKEN_HEADER, SERVICE_TOKEN);
        if (seat != null) {
            builder.header("Authorization", "Bearer " + seat);
        }
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
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
        return "{\"seed\":" + seed + ",\"format\":\"legacy\",\"skill\":1,\"turn_cap\":30,\"game_id\":\"" + gameId
            + "\",\"seats\":[{\"player\":\"human\",\"deck\":\"" + LegacyDuel.DECKS.get(0) + "\"},"
            + "{\"player\":\"human\",\"deck\":\"" + LegacyDuel.DECKS.get(1) + "\"}]}";
    }

    private static String table(long seed, String gameId, int skill) {
        return "{\"seed\":" + seed + ",\"format\":\"commander\",\"skill\":" + skill + ",\"turn_cap\":40,"
            + "\"game_id\":\"" + gameId + "\",\"seats\":[{\"player\":\"human\"},{\"player\":\"bot\"},"
            + "{\"player\":\"bot\"},{\"player\":\"bot\"}]}";
    }

    private static JsonObject comparable(JsonObject view) {
        JsonObject copy = view.deepCopy();
        copy.remove("revision");
        if (copy.get("prompt").isJsonObject()) {
            copy.getAsJsonObject("prompt").remove("id");
        }
        return copy;
    }

    private JsonObject metrics() throws Exception {
        var response = service("GET", "/v1/service/processes", null, null);
        assertEquals(200, response.statusCode(), response.body());
        return json(response);
    }

    private JsonObject gameMetrics(String id) throws Exception {
        for (var entry : metrics().getAsJsonArray("games")) {
            if (entry.getAsJsonObject().get("game_id").getAsString().equals(id)) {
                return entry.getAsJsonObject();
            }
        }
        return null;
    }

    /** Waits until the front process has the game's report from its process. */
    private JsonObject reported(String id) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (true) {
            JsonObject game = gameMetrics(id);
            if (game != null && game.has("bots")) {
                return game;
            }
            assertTrue(System.nanoTime() < deadline, "no report of " + id);
            Thread.sleep(200);
        }
    }

    @Test
    void aGameWhoseProcessIsKilledLeavesTheOthersRunningAndIsTakenUpByANewProcess() throws Exception {
        start(16_384, 1);
        String doomed = UUID.randomUUID().toString();
        String other = UUID.randomUUID().toString();
        var createdDoomed = service("POST", GAMES, null, duel(61L, doomed));
        assertEquals(201, createdDoomed.statusCode(), createdDoomed.body());
        var createdOther = service("POST", GAMES, null, duel(62L, other));
        assertEquals(201, createdOther.statusCode(), createdOther.body());
        String first = token(json(createdDoomed), 0);
        String second = token(json(createdDoomed), 1);
        String otherFirst = token(json(createdOther), 0);
        String otherSecond = token(json(createdOther), 1);
        var player = new ScriptedPlayer(61);
        var otherPlayer = new ScriptedPlayer(62);
        JsonObject asked = play(doomed, player, 20, first, second);
        play(other, otherPlayer, 20, otherFirst, otherSecond);

        Process process = processes.processForTest(doomed).orElseThrow();
        long otherPid = processes.processForTest(other).orElseThrow().pid();
        assertNotEquals(process.pid(), otherPid, "each game has a process of its own");
        // Its answers are on disk before they are acknowledged; what is pending is a checkpoint,
        // which recovery does without (the journal is played on an older one).
        process.destroyForcibly().waitFor(30, TimeUnit.SECONDS);

        // The other game plays on, in its own process, untouched.
        JsonObject otherAsked = play(other, otherPlayer, 20, otherFirst, otherSecond);
        assertTrue(otherAsked.get("result").isJsonNull() || otherAsked.get("result").isJsonObject());
        assertEquals(otherPid, processes.processForTest(other).orElseThrow().pid());

        // The killed game is not here, so the API is answered 404 and asks for it again.
        assertEquals(404, service("GET", GAMES + "/" + doomed + "/view", first, null).statusCode());
        var attached = service("POST", GAMES + "/" + doomed + "/attach", null, "");
        assertEquals(200, attached.statusCode(), attached.body());
        JsonObject again = json(attached);
        assertEquals("recovered", again.get("status").getAsString());
        String newFirst = token(again, 0);
        String newSecond = token(again, 1);
        assertNotEquals(first, newFirst);
        JsonObject askedAgain = untilAsked(doomed, newFirst, newSecond);
        assertEquals(comparable(asked), comparable(askedAgain), "the game goes on where it stood");
        long newPid = processes.processForTest(doomed).orElseThrow().pid();
        assertNotEquals(process.pid(), newPid);
        assertNotEquals(otherPid, newPid);

        JsonObject totals = metrics().getAsJsonObject("totals");
        assertEquals(1, totals.getAsJsonObject("ended_unasked").get("killed").getAsInt(), totals.toString());
        assertEquals(doomed, metrics().getAsJsonArray("recent_failures").get(0).getAsJsonObject()
            .get("game_id").getAsString());

        // Played to its end: its process is ended once the game is over, and the recording answers.
        JsonObject last = play(doomed, player, 2000, newFirst, newSecond);
        assertFalse(last.get("result").isJsonNull());
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (processes.processForTest(doomed).isPresent()) {
            assertTrue(System.nanoTime() < deadline, "the finished game's process was not ended");
            Thread.sleep(200);
        }
        var finished = service("POST", GAMES + "/" + doomed + "/attach", null, "");
        assertEquals(200, finished.statusCode(), finished.body());
        assertEquals("finished", json(finished).get("status").getAsString());
        assertEquals(last.get("result"), json(finished).get("result"));
        assertEquals(409, service("POST", GAMES, null, duel(61L, doomed)).statusCode(), "never started anew");
    }

    @Test
    void aFullEngineRefusesInWordsAndAdmitsAgainOnceThereIsRoom() throws Exception {
        // Room for one duel's process (512 MB of heap and 256 beside it), and no warm process. A
        // finished game's process would stay a minute: the room is made by ending it at once.
        start(1_000, 0, 60);
        String admitted = UUID.randomUUID().toString();
        var created = service("POST", GAMES, null, duel(71L, admitted));
        assertEquals(201, created.statusCode(), created.body());

        String refused = UUID.randomUUID().toString();
        var full = service("POST", GAMES, null, duel(72L, refused));
        assertEquals(429, full.statusCode(), full.body());
        assertEquals("games_busy", json(full).get("code").getAsString());
        assertEquals("The tables are full; try again in a minute.", json(full).get("message").getAsString());
        assertEquals("60", full.headers().firstValue("Retry-After").orElseThrow());
        // A table needs more than a duel: refused too, and the running game is untouched by either.
        assertEquals(429, service("POST", GAMES, null, table(73L, UUID.randomUUID().toString(), 1)).statusCode());
        assertEquals(200, service("GET", GAMES + "/" + admitted + "/view", token(json(created), 0), null).statusCode());
        assertEquals(2, metrics().getAsJsonObject("totals").get("refused_full").getAsInt());

        // The game is closed: its process, kept for its end to be read, is ended for the room.
        assertEquals(200, service("POST", GAMES + "/" + admitted + "/close", null, "{}").statusCode());
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        HttpResponse<String> again;
        while ((again = service("POST", GAMES, null, duel(72L, refused))).statusCode() == 429) {
            assertTrue(System.nanoTime() < deadline, "no room after the game was over");
            Thread.sleep(500);
        }
        assertEquals(201, again.statusCode(), again.body());
    }

    @Test
    void aGameRunsInAProcessSizedForItsFormatAndReportsItsBots() throws Exception {
        start(16_384, 0);
        String id = UUID.randomUUID().toString();
        var created = service("POST", GAMES, null, table(81L, id, 1));
        assertEquals(201, created.statusCode(), created.body());
        String human = token(json(created), 0);
        play(id, new ScriptedPlayer(81), 60, human);
        JsonObject game = reported(id);
        assertEquals("table", game.get("size").getAsString());
        // The process's heap is the table's (the collector may round it down a little).
        long heap = game.getAsJsonObject("memory").get("heap_max_megabytes").getAsLong();
        assertTrue(heap > 700 && heap <= 768, "heap " + heap);
        JsonObject bots = game.getAsJsonObject("bots");
        assertTrue(bots.get("searches").getAsLong() > 0, bots.toString());
        // A weaker player's habits are its skill, counted apart from any shortage of time or memory.
        assertTrue(bots.get("weaker_habits").getAsLong() > 0, bots.toString());
        assertEquals(0, bots.get("cut_off_by_heap").getAsLong(), bots.toString());
        // The inspection and the bots' switch reach the game through its process.
        assertEquals(200, service("POST", GAMES + "/" + id + "/bots", null, "{\"passive\":true}").statusCode());
        assertEquals(404, service("GET", GAMES + "/" + UUID.randomUUID() + "/inspection", null, null).statusCode());
    }
}
