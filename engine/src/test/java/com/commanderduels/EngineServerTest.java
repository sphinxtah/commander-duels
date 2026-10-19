package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpServer;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.function.Function;
import java.util.function.Supplier;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/** HTTP boundary behaviour with stand-in loading and match functions (no XMage game is played). */
class EngineServerTest {
    private static final XmagePin PIN = XmagePin.load();
    private static final CardDatabase.Stats CARDS = new CardDatabase.Stats(120, 100, 5, false);

    private final HttpClient client = HttpClient.newHttpClient();
    private final CountDownLatch loaded = new CountDownLatch(1);
    private HttpServer server;
    private String base;

    @AfterEach
    void stop() {
        if (server != null) {
            server.stop(0);
        }
        client.close();
    }

    private Engine start(boolean botMatch, Supplier<CardDatabase.Stats> loader,
                         Function<BotMatchRequest, BotMatchRunner.Outcome> runner) throws Exception {
        var engine = new Engine(PIN, botMatch, loader, runner);
        server = EngineServer.create(0, engine);
        server.start();
        base = "http://localhost:" + server.getAddress().getPort();
        engine.startLoading();
        return engine;
    }

    private Engine startReady(Function<BotMatchRequest, BotMatchRunner.Outcome> runner) throws Exception {
        loaded.countDown();
        Engine engine = start(true, () -> CARDS, runner);
        awaitStatus(200, "/ready");
        return engine;
    }

    private CardDatabase.Stats blockedLoader() {
        try {
            assertTrue(loaded.await(10, TimeUnit.SECONDS));
        } catch (InterruptedException e) {
            throw new IllegalStateException(e);
        }
        return CARDS;
    }

    private HttpResponse<String> get(String path) throws Exception {
        return client.send(HttpRequest.newBuilder(URI.create(base + path)).build(),
            HttpResponse.BodyHandlers.ofString());
    }

    private HttpRequest post(String path, String body) {
        return HttpRequest.newBuilder(URI.create(base + path))
            .POST(HttpRequest.BodyPublishers.ofString(body)).build();
    }

    private HttpResponse<String> send(HttpRequest request) throws Exception {
        return client.send(request, HttpResponse.BodyHandlers.ofString());
    }

    private static JsonObject json(HttpResponse<String> response) {
        return JsonParser.parseString(response.body()).getAsJsonObject();
    }

    private void awaitStatus(int status, String path) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (get(path).statusCode() != status) {
            assertTrue(System.nanoTime() < deadline, path + " never returned " + status);
            Thread.sleep(20);
        }
    }

    static BotMatchRunner.Outcome echo(BotMatchRequest request) {
        var result = new BotMatchResult("completed", 0, false, 3, 1, request.seed(),
            new BotMatchResult.Settings(request.skill(), request.turnCap(), request.timeBudgetSeconds()),
            PIN.commit(), 0, List.of(), null, 0, "complete", new BotMatchResult.LogSummary(0, "", List.of()),
            null, null);
        return new BotMatchRunner.Outcome(result, null);
    }

    @Test
    void healthAndReadinessFollowCardLoading() throws Exception {
        start(false, this::blockedLoader, EngineServerTest::echo);

        JsonObject loading = json(get("/health"));
        assertEquals("loading", loading.get("status").getAsString());
        assertEquals(1, loading.get("protocol_version").getAsInt());
        assertFalse(loading.get("gameplay_available").getAsBoolean());
        assertTrue(loading.get("cards").isJsonNull());
        assertFalse(loading.get("bot_match_enabled").getAsBoolean());
        JsonObject xmage = loading.getAsJsonObject("xmage");
        assertEquals(PIN.commit(), xmage.get("commit").getAsString());
        assertEquals(PIN.version(), xmage.get("version").getAsString());
        assertEquals(PIN.tag(), xmage.get("tag").getAsString());
        assertEquals(PIN.commitDate(), xmage.get("commit_date").getAsString());
        assertFalse(loading.get("service_games_enabled").getAsBoolean());
        assertEquals(7, loading.size(), "health fields: " + loading.keySet());

        var notReady = get("/ready");
        assertEquals(503, notReady.statusCode());
        assertEquals("engine_loading", json(notReady).get("code").getAsString());

        loaded.countDown();
        awaitStatus(200, "/ready");
        JsonObject ready = json(get("/health"));
        assertEquals("ready", ready.get("status").getAsString());
        assertEquals(120, ready.getAsJsonObject("cards").get("printings").getAsLong());
        assertEquals(100, ready.getAsJsonObject("cards").get("distinct_names").getAsLong());
        assertFalse(ready.get("gameplay_available").getAsBoolean());
    }

    @Test
    void failedLoadingStaysUnready() throws Exception {
        start(true, () -> {
            throw new IllegalStateException("no database");
        }, EngineServerTest::echo);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (!json(get("/health")).get("status").getAsString().equals("failed")) {
            assertTrue(System.nanoTime() < deadline);
            Thread.sleep(20);
        }
        assertEquals("engine_failed", json(get("/ready")).get("code").getAsString());
        var match = send(post("/v1/bot_match", "{}"));
        assertEquals(503, match.statusCode());
        assertEquals("engine_failed", json(match).get("code").getAsString());
    }

    @Test
    void playerOperationsFailClosed() throws Exception {
        startReady(EngineServerTest::echo);
        for (String op : new String[]{"create_game", "submit_choice", "get_authorized_view", "advance_bot"}) {
            for (var response : new HttpResponse<?>[]{get("/v1/" + op), send(post("/v1/" + op, "{}"))}) {
                assertEquals(503, response.statusCode(), op);
                assertTrue(response.body().toString().contains("engine_not_integrated"), op);
            }
        }
        assertEquals(404, get("/nope").statusCode());
        var postHealth = send(post("/health", ""));
        assertEquals(405, postHealth.statusCode());
        assertEquals("GET", postHealth.headers().firstValue("Allow").orElse(""));
    }

    @Test
    void botMatchIsAbsentUnlessEnabled() throws Exception {
        loaded.countDown();
        start(false, () -> CARDS, EngineServerTest::echo);
        awaitStatus(200, "/ready");
        var response = send(post("/v1/bot_match", "{}"));
        assertEquals(503, response.statusCode());
        assertEquals("engine_not_integrated", json(response).get("code").getAsString());
    }

    @Test
    void botMatchWaitsForTheCardDatabase() throws Exception {
        start(true, this::blockedLoader, EngineServerTest::echo);
        var response = send(post("/v1/bot_match", "{}"));
        assertEquals(503, response.statusCode());
        assertEquals("engine_loading", json(response).get("code").getAsString());
        loaded.countDown();
    }

    @Test
    void botMatchInputsAreClampedToSafeLimits() throws Exception {
        startReady(EngineServerTest::echo);
        var response = send(post("/v1/bot_match",
            "{\"seed\":7,\"turn_cap\":100000,\"time_budget_seconds\":-5,\"skill\":99}"));
        assertEquals(200, response.statusCode());
        JsonObject body = json(response);
        assertEquals(7, body.get("seed").getAsLong());
        JsonObject settings = body.getAsJsonObject("settings");
        assertEquals(BotMatchRequest.MAX_TURN_CAP, settings.get("turn_cap").getAsInt());
        assertEquals(1, settings.get("time_budget_seconds").getAsInt());
        assertEquals(BotMatchRequest.MAX_SKILL, settings.get("skill").getAsInt());
        assertEquals(PIN.commit(), body.get("xmage_commit").getAsString());

        JsonObject defaults = json(send(post("/v1/bot_match", "")));
        assertEquals(BotMatchRequest.DEFAULT_SKILL, defaults.getAsJsonObject("settings").get("skill").getAsInt());
        assertTrue(defaults.has("seed"));
    }

    @Test
    void botMatchRejectsMalformedRequests() throws Exception {
        startReady(EngineServerTest::echo);
        for (String body : new String[]{"not json", "[]", "{\"turn_cap\":\"ten\"}", "{\"extra\":true}"}) {
            var response = send(post("/v1/bot_match", body));
            assertEquals(400, response.statusCode(), body);
            assertEquals("invalid_request", json(response).get("code").getAsString());
        }
        var large = send(post("/v1/bot_match", "{\"seed\":1" + " ".repeat(EngineServer.MAX_BODY_BYTES) + "}"));
        assertEquals(413, large.statusCode());
        var get = get("/v1/bot_match");
        assertEquals(405, get.statusCode());
        assertEquals("POST", get.headers().firstValue("Allow").orElse(""));
    }

    @Test
    void onlyOneBotMatchRunsAtATime() throws Exception {
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        startReady(request -> {
            entered.countDown();
            try {
                assertTrue(release.await(10, TimeUnit.SECONDS));
            } catch (InterruptedException e) {
                throw new IllegalStateException(e);
            }
            return echo(request);
        });
        CompletableFuture<HttpResponse<String>> first =
            client.sendAsync(post("/v1/bot_match", "{\"seed\":1}"), HttpResponse.BodyHandlers.ofString());
        assertTrue(entered.await(10, TimeUnit.SECONDS));

        var busy = send(post("/v1/bot_match", "{\"seed\":2}"));
        assertEquals(429, busy.statusCode());
        assertEquals("bot_match_busy", json(busy).get("code").getAsString());
        assertEquals("30", busy.headers().firstValue("Retry-After").orElse(""));
        assertEquals(200, get("/health").statusCode(), "health stays responsive during a match");

        release.countDown();
        assertEquals(200, first.get(10, TimeUnit.SECONDS).statusCode());
        assertEquals(200, send(post("/v1/bot_match", "{\"seed\":3}")).statusCode());
    }

    @Test
    void aGameThreadThatOutlivesItsMatchKeepsTheSlot() throws Exception {
        var release = new CountDownLatch(1);
        Thread lingering = new Thread(() -> {
            try {
                release.await();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        lingering.start();
        startReady(request -> new BotMatchRunner.Outcome(echo(request).result(), lingering));

        assertEquals(200, send(post("/v1/bot_match", "{}")).statusCode());
        assertEquals(429, send(post("/v1/bot_match", "{}")).statusCode());
        release.countDown();
        lingering.join(Duration.ofSeconds(5));
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        int status;
        while ((status = send(post("/v1/bot_match", "{}")).statusCode()) == 429) {
            assertTrue(System.nanoTime() < deadline, "slot was never released");
            Thread.sleep(20);
        }
        assertEquals(200, status);
    }
}
