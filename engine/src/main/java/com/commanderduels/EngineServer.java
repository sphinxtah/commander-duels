package com.commanderduels;

import com.google.gson.FieldNamingPolicy;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Executors;

/**
 * Internal HTTP boundary of the XMage engine. It reports engine status and, when development
 * endpoints are enabled, runs bot-versus-bot matches. Every player operation still fails closed.
 */
public final class EngineServer {
    public static final int PROTOCOL_VERSION = 1;
    static final int MAX_BODY_BYTES = 4096;
    static final Gson JSON = new GsonBuilder()
        .setFieldNamingPolicy(FieldNamingPolicy.LOWER_CASE_WITH_UNDERSCORES)
        .serializeNulls()
        .disableHtmlEscaping()
        .create();
    private static final SecureRandom SEEDS = new SecureRandom();

    record Health(String status, int protocolVersion, boolean gameplayAvailable, Xmage xmage, Cards cards,
                  boolean botMatchEnabled) {}

    record Xmage(String version, String tag, String commit, String commitDate) {}

    record Cards(long printings, long distinctNames) {}

    private EngineServer() {}

    public static HttpServer create(int port, Engine engine) throws IOException {
        var server = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 16);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/", exchange -> {
            try (exchange) {
                route(exchange, engine);
            }
        });
        return server;
    }

    private static void route(HttpExchange exchange, Engine engine) throws IOException {
        String path = exchange.getRequestURI().getPath();
        String method = exchange.getRequestMethod();
        if (path.equals("/health")) {
            if (!method.equals("GET")) {
                methodNotAllowed(exchange, "GET");
            } else {
                respond(exchange, 200, health(engine));
            }
        } else if (path.equals("/ready")) {
            if (!method.equals("GET")) {
                methodNotAllowed(exchange, "GET");
            } else if (engine.status() == Engine.Status.READY) {
                respond(exchange, 200, Map.of("status", "ready"));
            } else {
                respond(exchange, 503, Map.of("code", notReadyCode(engine)));
            }
        } else if (path.equals("/v1/bot_match") && engine.botMatchEnabled()) {
            botMatch(exchange, engine);
        } else if (path.startsWith("/v1/")) {
            respond(exchange, 503, Map.of("code", "engine_not_integrated", "protocol_version", PROTOCOL_VERSION));
        } else {
            respond(exchange, 404, Map.of("code", "not_found"));
        }
    }

    static Health health(Engine engine) {
        XmagePin pin = engine.pin();
        CardDatabase.Stats stats = engine.cards();
        return new Health(
            engine.status().name().toLowerCase(Locale.ROOT),
            PROTOCOL_VERSION,
            false,
            new Xmage(pin.version(), pin.tag(), pin.commit(), pin.commitDate()),
            stats == null ? null : new Cards(stats.printings(), stats.distinctNames()),
            engine.botMatchEnabled());
    }

    /** Development only: plays one bot match synchronously. Outside the player command envelope. */
    private static void botMatch(HttpExchange exchange, Engine engine) throws IOException {
        if (!exchange.getRequestMethod().equals("POST")) {
            methodNotAllowed(exchange, "POST");
            return;
        }
        if (engine.status() != Engine.Status.READY) {
            respond(exchange, 503, Map.of("code", notReadyCode(engine)));
            return;
        }
        byte[] body;
        try (InputStream stream = exchange.getRequestBody()) {
            body = stream.readNBytes(MAX_BODY_BYTES + 1);
        }
        if (body.length > MAX_BODY_BYTES) {
            respond(exchange, 413, Map.of("code", "body_too_large", "max_bytes", MAX_BODY_BYTES));
            return;
        }
        BotMatchRequest request;
        try {
            request = BotMatchRequest.parse(new String(body, StandardCharsets.UTF_8), SEEDS::nextLong);
        } catch (BotMatchRequest.InvalidRequest e) {
            respond(exchange, 400, Map.of("code", "invalid_request", "message", e.getMessage()));
            return;
        }
        Optional<BotMatchResult> result = engine.tryBotMatch(request);
        if (result.isEmpty()) {
            exchange.getResponseHeaders().set("Retry-After", "30");
            respond(exchange, 429, Map.of("code", "bot_match_busy",
                "message", "One bot match runs at a time"));
            return;
        }
        respond(exchange, 200, result.get());
    }

    private static String notReadyCode(Engine engine) {
        return engine.status() == Engine.Status.FAILED ? "engine_failed" : "engine_loading";
    }

    private static void methodNotAllowed(HttpExchange exchange, String allowed) throws IOException {
        exchange.getResponseHeaders().set("Allow", allowed);
        respond(exchange, 405, Map.of("code", "method_not_allowed"));
    }

    private static void respond(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] bytes = JSON.toJson(body).getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(status, bytes.length);
        try (var stream = exchange.getResponseBody()) {
            stream.write(bytes);
        }
    }

    public static void main(String[] args) throws IOException {
        int port = Integer.parseInt(System.getenv().getOrDefault("CD_ENGINE_PORT", "8090"));
        boolean devEndpoints = "true".equalsIgnoreCase(System.getenv("CD_ENGINE_DEV_ENDPOINTS"));
        Path decks = Path.of(System.getenv().getOrDefault("CD_ENGINE_DECKS", "decks"));
        XmagePin pin = XmagePin.load();
        var runner = new BotMatchRunner(decks, pin);
        var engine = new Engine(pin, devEndpoints, CardDatabase::load, runner::run);
        var server = create(port, engine);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> server.stop(2)));
        server.start();
        System.out.printf("Commander Duels engine on port %d: XMage %s (%s); gameplay unavailable;"
            + " development bot matches %s%n", port, pin.version(), pin.commit(),
            devEndpoints ? "enabled" : "disabled");
        engine.startLoading();
    }
}
