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
 * Recovery as the API meets it (v0.9.9), over HTTP with real XMage games: an engine whose games are
 * gone, as after a crash or a restart, is replaced by a second engine on the same recordings
 * folder, and the API asks for each game again ({@code POST /v1/service/games/{id}/attach}).
 */
class ServiceRecoveryHttpTest {
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

    @Test
    void aGameOfADeadEngineIsGivenBackByTheNextOne() throws Exception {
        start(4, TimeUnit.HOURS.toMillis(24));
        String id = UUID.randomUUID().toString();
        var createdResponse = service("POST", GAMES, null, duel(51L, id));
        assertEquals(201, createdResponse.statusCode(), createdResponse.body());
        JsonObject created = json(createdResponse);
        String first = token(created, 0);
        String second = token(created, 1);
        var player = new ScriptedPlayer(51);
        JsonObject asked = play(id, player, 25, first, second);
        int askedSeat = asked.get("seat").getAsInt();
        JsonObject other = view(id, askedSeat == 0 ? second : first);
        JsonObject inspection = json(service("GET", GAMES + "/" + id + "/inspection", null, null));

        die(id);
        start(4, TimeUnit.HOURS.toMillis(24));

        // The second engine knows nothing of the game until it is asked for: the old tokens find nothing.
        assertEquals(404, service("GET", GAMES + "/" + id + "/view", first, null).statusCode());
        // Only the API may ask.
        assertEquals(401, send("POST", GAMES + "/" + id + "/attach", null, null, "").statusCode());
        assertEquals(405, service("GET", GAMES + "/" + id + "/attach", null, null).statusCode());

        var attached = service("POST", GAMES + "/" + id + "/attach", null, "");
        assertEquals(200, attached.statusCode(), attached.body());
        JsonObject again = json(attached);
        assertEquals("recovered", again.get("status").getAsString());
        assertEquals(id, again.get("game_id").getAsString());
        assertEquals(created.get("settings"), again.get("settings"));
        assertTrue(again.getAsJsonObject("recovery").get("checkpoint").getAsInt() > 0, attached.body());
        assertEquals(0, again.getAsJsonObject("recovery").getAsJsonArray("passed_over").size());
        String newFirst = token(again, 0);
        String newSecond = token(again, 1);
        assertNotEquals(first, newFirst);
        assertNotEquals(second, newSecond);
        // The tokens the first engine gave are worth nothing here.
        assertEquals(404, service("GET", GAMES + "/" + id + "/view", first, null).statusCode());

        JsonObject askedAgain = untilAsked(id, newFirst, newSecond);
        assertEquals(askedSeat, askedAgain.get("seat").getAsInt());
        assertEquals(comparable(asked), comparable(askedAgain));
        assertTrue(askedAgain.get("revision").getAsLong() > asked.get("revision").getAsLong());
        assertEquals(comparable(other), comparable(view(id, askedSeat == 0 ? newSecond : newFirst)));
        JsonObject inspectionAgain = json(service("GET", GAMES + "/" + id + "/inspection", null, null));
        assertEquals(inspection.get("players"), inspectionAgain.get("players"), "every hand and library");

        // Asked for once more while it runs (the API's own restart): new tokens again, the same game.
        var reattached = service("POST", GAMES + "/" + id + "/attach", null, "");
        assertEquals(200, reattached.statusCode(), reattached.body());
        assertEquals("attached", json(reattached).get("status").getAsString());
        assertFalse(json(reattached).has("recovery"));
        assertEquals(404, service("GET", GAMES + "/" + id + "/view", newFirst, null).statusCode());
        String third = token(json(reattached), 0);
        String fourth = token(json(reattached), 1);
        assertEquals(comparable(askedAgain), comparable(untilAsked(id, third, fourth)));

        // The game is played to its end, and is over for good.
        JsonObject last = play(id, player, 2000, third, fourth);
        assertFalse(last.get("result").isJsonNull());
        var finished = service("POST", GAMES + "/" + id + "/attach", null, "");
        assertEquals(200, finished.statusCode(), finished.body());
        assertEquals("finished", json(finished).get("status").getAsString());
        assertEquals(last.get("result"), json(finished).get("result"));
        assertFalse(json(finished).has("seats"), "a game that is over has no tokens to give");

        // A third engine, which never ran the game, answers the same from the recording.
        die();
        start(4, TimeUnit.HOURS.toMillis(24));
        var later = service("POST", GAMES + "/" + id + "/attach", null, "");
        assertEquals(200, later.statusCode(), later.body());
        assertEquals("finished", json(later).get("status").getAsString());
        assertEquals(last.get("result"), json(later).get("result"));
        // And no game of that id is started anew.
        assertEquals(409, service("POST", GAMES, null, duel(51L, id)).statusCode());
        // The recording of a game that is over keeps no state of the game.
        assertEquals(java.util.List.of(), Recording.of(recordings, id).checkpointSeqs());

        JsonObject status = json(service("GET", "/v1/service/recordings", null, null));
        assertTrue(status.get("enabled").getAsBoolean());
        assertEquals(1, status.getAsJsonObject("asked_for_again").get("finished").getAsInt(), status.toString());
        assertEquals(1, status.getAsJsonObject("on_disk").get("recordings").getAsInt(), status.toString());
    }


    /** A game's events (v0.9.10) as the API reads them. */
    private JsonObject events(String id, long since) throws Exception {
        var response = service("GET", GAMES + "/" + id + "/events?since=" + since, null, null);
        assertEquals(200, response.statusCode(), response.body());
        return json(response);
    }

    private static JsonObject withoutEpoch(com.google.gson.JsonElement event) {
        JsonObject copy = event.getAsJsonObject().deepCopy();
        copy.remove("epoch");
        return copy;
    }

    @Test
    void aGamesEventsGoOnAcrossARecoveryUnderTheNextEpoch() throws Exception {
        start(4, TimeUnit.HOURS.toMillis(24));
        String id = UUID.randomUUID().toString();
        var createdResponse = service("POST", GAMES, null, duel(53L, id));
        assertEquals(201, createdResponse.statusCode(), createdResponse.body());
        JsonObject created = json(createdResponse);
        var player = new ScriptedPlayer(53);
        play(id, player, 30, token(created, 0), token(created, 1));
        JsonObject before = events(id, 0);
        assertEquals(0, before.get("epoch").getAsInt());
        JsonArray played = before.getAsJsonArray("events");
        assertTrue(played.size() > 10, before.toString());
        assertEquals(played.size(), before.get("next").getAsLong(), "numbered from one, without a gap");
        // Asked after a number, only what came later.
        assertEquals(played.size() - 5, events(id, 5).getAsJsonArray("events").size());

        die(id);
        start(4, TimeUnit.HOURS.toMillis(24));
        // No engine runs the game: its events are read from its recording, as they were written.
        // (The test's engine "dies" by interrupting its games, and XMage ends a game it is
        // interrupted in: what it wrote then follows. A process that is killed writes nothing more.)
        JsonArray recorded = events(id, 0).getAsJsonArray("events");
        for (int index = 0; index < played.size(); index++) {
            assertEquals(played.get(index), recorded.get(index));
        }

        var attached = service("POST", GAMES + "/" + id + "/attach", null, "");
        assertEquals(200, attached.statusCode(), attached.body());
        JsonObject again = json(attached);
        untilAsked(id, token(again, 0), token(again, 1));
        JsonObject after = events(id, 0);
        assertEquals(1, after.get("epoch").getAsInt());
        JsonArray now = after.getAsJsonArray("events");
        // The events up to the checkpoint stand as they were; the rest were made again as the journal
        // was played, under the next epoch, and, two people having played, they are the same events.
        assertEquals(played.size(), now.size(), now.toString());
        boolean remade = false;
        for (int index = 0; index < now.size(); index++) {
            JsonObject event = now.get(index).getAsJsonObject();
            assertEquals(index + 1, event.get("seq").getAsLong());
            remade |= event.get("epoch").getAsInt() == 1;
            assertEquals(withoutEpoch(played.get(index)), withoutEpoch(event));
        }
        assertTrue(remade || now.size() == played.size(), "the journal's records were played again");
    }

    @Test
    void whatCannotBeGivenBackIsRefusedInWords() throws Exception {
        start(1, TimeUnit.HOURS.toMillis(24));
        // No such game, here or among the recordings.
        assertEquals(404, service("POST", GAMES + "/" + UUID.randomUUID() + "/attach", null, "").statusCode());

        String id = UUID.randomUUID().toString();
        JsonObject created = json(service("POST", GAMES, null, duel(52L, id)));
        play(id, new ScriptedPlayer(52), 12, token(created, 0), token(created, 1));
        die(id);

        // The next engine is full: the game waits for a slot.
        start(1, TimeUnit.HOURS.toMillis(24));
        String busy = UUID.randomUUID().toString();
        assertEquals(201, service("POST", GAMES, null, duel(53L, busy)).statusCode());
        var full = service("POST", GAMES + "/" + id + "/attach", null, "");
        assertEquals(429, full.statusCode(), full.body());
        assertEquals("games_busy", json(full).get("code").getAsString());
        assertEquals(200, service("POST", GAMES + "/" + busy + "/close", null, "").statusCode());

        // A recording another engine build made is not this build's to play on.
        Path manifest = recordings.resolve(id).resolve(Recording.MANIFEST);
        String whole = Files.readString(manifest);
        JsonObject changed = JsonParser.parseString(whole).getAsJsonObject();
        changed.getAsJsonObject("binding").addProperty("engine_build", "0123456789abcdef0123456789abcdef");
        Files.writeString(manifest, changed.toString());
        var incompatible = service("POST", GAMES + "/" + id + "/attach", null, "");
        assertEquals(409, incompatible.statusCode(), incompatible.body());
        assertEquals("recording_incompatible", json(incompatible).get("code").getAsString());
        assertTrue(json(incompatible).get("message").getAsString().contains("engine build"), incompatible.body());

        // A damaged one says so.
        Files.writeString(manifest, whole.substring(0, whole.length() / 2));
        var unreadable = service("POST", GAMES + "/" + id + "/attach", null, "");
        assertEquals(409, unreadable.statusCode(), unreadable.body());
        assertEquals("recording_unreadable", json(unreadable).get("code").getAsString());

        // Whole again, it gives the game back; nothing above took anything from it.
        Files.writeString(manifest, whole);
        var attached = service("POST", GAMES + "/" + id + "/attach", null, "");
        assertEquals(200, attached.statusCode(), attached.body());
        assertEquals("recovered", json(attached).get("status").getAsString());

        JsonObject status = json(service("GET", "/v1/service/recordings", null, null));
        JsonObject refused = status.getAsJsonObject("asked_for_again").getAsJsonObject("refused");
        assertEquals(1, refused.get("incompatible").getAsInt(), status.toString());
        assertEquals(1, refused.get("unreadable").getAsInt(), status.toString());
        assertEquals(1, status.getAsJsonObject("asked_for_again").get("recovered").getAsInt(), status.toString());
        assertEquals(1, status.getAsJsonArray("running").size(), status.toString());
    }

    /**
     * A game that is taken up again and again with nobody answering in between is given up: what
     * interrupts it would come back each time, and take the engine's other games with it.
     */
    @Test
    void aGameThatKeepsBeingInterruptedIsGivenUp() throws Exception {
        start(2, TimeUnit.HOURS.toMillis(24));
        String id = UUID.randomUUID().toString();
        JsonObject created = json(service("POST", GAMES, null, duel(54L, id)));
        play(id, new ScriptedPlayer(54), 12, token(created, 0), token(created, 1));
        for (int round = 0; round < Recovery.MAX_FRUITLESS; round++) {
            die(id);
            start(2, TimeUnit.HOURS.toMillis(24));
            var attached = service("POST", GAMES + "/" + id + "/attach", null, "");
            assertEquals(200, attached.statusCode(), "round " + round + ": " + attached.body());
            // Asked something, and left without an answer.
            untilAsked(id, token(json(attached), 0), token(json(attached), 1));
        }
        die(id);
        start(2, TimeUnit.HOURS.toMillis(24));
        var refused = service("POST", GAMES + "/" + id + "/attach", null, "");
        assertEquals(409, refused.statusCode(), refused.body());
        assertEquals("recording_unrecoverable", json(refused).get("code").getAsString());
    }

    /**
     * A game whose recording stopped (the disk refused a write) plays on, and the operator's route
     * says so; once the engine has lost it, it is not given back from where its recording ends.
     */
    @Test
    void aGameWhoseRecordingStoppedIsNotGivenBack() throws Exception {
        start(2, TimeUnit.HOURS.toMillis(24));
        String id = UUID.randomUUID().toString();
        JsonObject created = json(service("POST", GAMES, null, duel(55L, id)));
        var player = new ScriptedPlayer(55);
        play(id, player, 12, token(created, 0), token(created, 1));
        games.service(id).orElseThrow().recorder()
            .failForTest("its journal could not be written: java.io.IOException: No space left on device");
        play(id, player, 8, token(created, 0), token(created, 1));

        JsonObject status = json(service("GET", "/v1/service/recordings", null, null));
        JsonObject running = status.getAsJsonArray("running").get(0).getAsJsonObject();
        assertEquals(id, running.get("game_id").getAsString());
        assertTrue(running.get("stopped").getAsString().contains("No space left on device"), status.toString());
        assertEquals(1, status.getAsJsonObject("written").get("recordings_stopped").getAsInt(), status.toString());
        // Asked for while it runs, it is simply here.
        var here = service("POST", GAMES + "/" + id + "/attach", null, "");
        assertEquals(200, here.statusCode(), here.body());
        assertEquals("attached", json(here).get("status").getAsString());

        games.service(id).orElseThrow().interrupt();
        die();
        start(2, TimeUnit.HOURS.toMillis(24));
        var refused = service("POST", GAMES + "/" + id + "/attach", null, "");
        assertEquals(409, refused.statusCode(), refused.body());
        assertEquals("recording_unrecoverable", json(refused).get("code").getAsString());
        assertTrue(json(refused).get("message").getAsString().contains("stopped"), refused.body());
        // And a new game is not started over it.
        var again = service("POST", GAMES, null, duel(55L, id));
        assertEquals(409, again.statusCode(), again.body());
        assertEquals("game_exists", json(again).get("code").getAsString());
    }

    /** Recordings are removed once nothing has changed in them for the retention time, running games' never. */
    @Test
    void oldRecordingsAreRemovedAndRunningGamesKeepTheirs() throws Exception {
        start(4, TimeUnit.MINUTES.toMillis(1));
        String over = UUID.randomUUID().toString();
        String left = UUID.randomUUID().toString();
        String running = UUID.randomUUID().toString();
        for (String id : new String[]{over, left, running}) {
            assertEquals(201, service("POST", GAMES, null, duel(55L, id)).statusCode());
        }
        assertEquals(200, service("POST", GAMES + "/" + over + "/close", null, "").statusCode());
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        while (Recording.of(recordings, over).result().isEmpty()) {
            assertTrue(System.nanoTime() < deadline, "the closed game has a result");
            Thread.sleep(20);
        }
        // One engine dies with a game nobody comes back for; the next runs the third.
        die(left, running);
        start(4, TimeUnit.MINUTES.toMillis(1));
        assertEquals(200, service("POST", GAMES + "/" + running + "/attach", null, "").statusCode());

        assertEquals(0, games.sweepRecordings(), "nothing is old yet");
        // Two hours on, as the files' own times tell it.
        var old = java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis() - TimeUnit.HOURS.toMillis(2));
        for (String id : new String[]{over, left, running}) {
            try (var files = Files.list(recordings.resolve(id))) {
                for (Path file : files.toList()) {
                    Files.setLastModifiedTime(file, old);
                }
            }
        }
        assertEquals(2, games.sweepRecordings());
        assertFalse(Files.exists(recordings.resolve(over)), "the finished game's recording is gone");
        assertFalse(Files.exists(recordings.resolve(left)), "and the one nobody came back for");
        assertTrue(Files.exists(recordings.resolve(running)), "the running game keeps its recording");
        assertEquals(0, games.sweepRecordings(), "a second sweep finds nothing");
        assertEquals(404, service("POST", GAMES + "/" + left + "/attach", null, "").statusCode());
    }
}
