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
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Internal HTTP boundary of the XMage engine. It reports engine status and, when development
 * endpoints are enabled, runs bot-versus-bot matches and development games with human and bot seats
 * (each human seat's token selects that seat). Every other operation fails closed.
 */
public final class EngineServer {
    public static final int PROTOCOL_VERSION = 1;
    static final int MAX_BODY_BYTES = 4096;
    static final long MAX_WAIT_MILLIS = 30_000;
    private static final String GAMES = "/v1/games";
    private static final Pattern GAME_PATH =
        Pattern.compile("([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/(view|commands|close)");
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
        } else if (path.equals(GAMES) && engine.humanGames() != null) {
            createGame(exchange, engine);
        } else if (path.startsWith(GAMES + "/") && engine.humanGames() != null) {
            gameRoute(exchange, engine.humanGames(), path.substring(GAMES.length() + 1));
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
        Optional<String> body = readBody(exchange);
        if (body.isEmpty()) {
            return;
        }
        BotMatchRequest request;
        try {
            request = BotMatchRequest.parse(body.get(), SEEDS::nextLong);
        } catch (JsonRequest.Invalid e) {
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

    /** Development only: starts a game and returns each human seat's token, once. */
    private static void createGame(HttpExchange exchange, Engine engine) throws IOException {
        if (!exchange.getRequestMethod().equals("POST")) {
            methodNotAllowed(exchange, "POST");
            return;
        }
        if (engine.status() != Engine.Status.READY) {
            respond(exchange, 503, Map.of("code", notReadyCode(engine)));
            return;
        }
        Optional<String> body = readBody(exchange);
        if (body.isEmpty()) {
            return;
        }
        HumanGameRequest request;
        try {
            request = HumanGameRequest.parse(body.get(), SEEDS::nextLong);
        } catch (JsonRequest.Invalid e) {
            respond(exchange, 400, Map.of("code", "invalid_request", "message", e.getMessage()));
            return;
        }
        HumanGames games = engine.humanGames();
        Optional<HumanGames.Created> created = games.create(request);
        if (created.isEmpty()) {
            exchange.getResponseHeaders().set("Retry-After", "30");
            respond(exchange, 429, Map.of("code", "games_busy",
                "message", "At most " + games.maxActive() + " development games run at once"));
            return;
        }
        HumanGame game = created.get().game();
        List<Map<String, Object>> seats = new ArrayList<>();
        for (HumanGame.SeatSettings seat : game.settings().seats()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("seat", seat.seat());
            entry.put("player", seat.player());
            entry.put("seat_token", created.get().seatTokens().get(seat.seat()));
            seats.add(entry);
        }
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("game_id", game.id());
        response.put("seats", seats);
        response.put("settings", game.settings());
        respond(exchange, 201, response);
    }

    private static void gameRoute(HttpExchange exchange, HumanGames games, String rest) throws IOException {
        Matcher matcher = GAME_PATH.matcher(rest);
        Optional<HumanGames.SeatHandle> found = matcher.matches()
            ? games.find(matcher.group(1), bearerToken(exchange)) : Optional.empty();
        if (found.isEmpty()) {
            respond(exchange, 404, Map.of("code", "not_found"));
            return;
        }
        HumanGame game = found.get().game();
        int seat = found.get().seat();
        switch (matcher.group(2)) {
            case "view" -> view(exchange, game, seat);
            case "commands" -> command(exchange, game, seat);
            default -> close(exchange, game);
        }
    }

    private static void view(HttpExchange exchange, HumanGame game, int seat) throws IOException {
        if (!exchange.getRequestMethod().equals("GET")) {
            methodNotAllowed(exchange, "GET");
            return;
        }
        long since;
        long waitMillis;
        int logFrom;
        try {
            Map<String, String> query = query(exchange.getRequestURI().getRawQuery());
            since = longParameter(query, "since", -1, -1, Long.MAX_VALUE);
            waitMillis = longParameter(query, "wait_ms", 0, 0, MAX_WAIT_MILLIS);
            logFrom = (int) longParameter(query, "log_from", -1, -1, Integer.MAX_VALUE);
        } catch (JsonRequest.Invalid e) {
            respond(exchange, 400, Map.of("code", "invalid_request", "message", e.getMessage()));
            return;
        }
        try {
            respond(exchange, 200, game.snapshot(seat, since, waitMillis, logFrom));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            respond(exchange, 503, Map.of("code", "interrupted"));
        }
    }

    private static void command(HttpExchange exchange, HumanGame game, int seat) throws IOException {
        if (!exchange.getRequestMethod().equals("POST")) {
            methodNotAllowed(exchange, "POST");
            return;
        }
        Optional<String> body = readBody(exchange);
        if (body.isEmpty()) {
            return;
        }
        SeatCommand command;
        try {
            command = SeatCommand.parse(body.get(), game.id());
        } catch (JsonRequest.Invalid e) {
            respond(exchange, 400, Map.of("code", "invalid_command", "message", e.getMessage()));
            return;
        }
        HumanGame.Reply reply = command.type().equals(SeatCommand.CONCEDE)
            ? game.concede(seat, command) : game.submit(seat, command);
        respond(exchange, reply.status(), reply.body());
    }

    private static void close(HttpExchange exchange, HumanGame game) throws IOException {
        if (!exchange.getRequestMethod().equals("POST")) {
            methodNotAllowed(exchange, "POST");
            return;
        }
        if (readBody(exchange).isEmpty()) {
            return;
        }
        respond(exchange, 200, game.close("closed"));
    }

    /** The body as text, or empty after a 413 response. */
    private static Optional<String> readBody(HttpExchange exchange) throws IOException {
        byte[] body;
        try (InputStream stream = exchange.getRequestBody()) {
            body = stream.readNBytes(MAX_BODY_BYTES + 1);
        }
        if (body.length > MAX_BODY_BYTES) {
            respond(exchange, 413, Map.of("code", "body_too_large", "max_bytes", MAX_BODY_BYTES));
            return Optional.empty();
        }
        return Optional.of(new String(body, StandardCharsets.UTF_8));
    }

    private static String bearerToken(HttpExchange exchange) {
        String header = exchange.getRequestHeaders().getFirst("Authorization");
        if (header == null || !header.regionMatches(true, 0, "Bearer ", 0, 7)) {
            return null;
        }
        return header.substring(7).trim();
    }

    private static Map<String, String> query(String rawQuery) throws JsonRequest.Invalid {
        Map<String, String> values = new HashMap<>();
        if (rawQuery == null || rawQuery.isEmpty()) {
            return values;
        }
        for (String pair : rawQuery.split("&")) {
            int equals = pair.indexOf('=');
            if (equals <= 0 || values.put(pair.substring(0, equals), pair.substring(equals + 1)) != null) {
                throw new JsonRequest.Invalid("Malformed query string");
            }
        }
        return values;
    }

    private static long longParameter(Map<String, String> query, String name, long fallback, long min, long max)
            throws JsonRequest.Invalid {
        String value = query.get(name);
        if (value == null) {
            return fallback;
        }
        try {
            long parsed = Long.parseLong(value);
            if (parsed >= min && parsed <= max) {
                return parsed;
            }
        } catch (NumberFormatException e) {
            // reported below
        }
        throw new JsonRequest.Invalid(name + " must be an integer from " + min + " to " + max);
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
        int maxGames = Integer.parseInt(System.getenv().getOrDefault("CD_ENGINE_MAX_GAMES",
            String.valueOf(HumanGames.DEFAULT_MAX_ACTIVE)));
        var games = devEndpoints ? new HumanGames(decks, maxGames) : null;
        var engine = new Engine(pin, devEndpoints, CardDatabase::load, runner::run, games);
        var server = create(port, engine);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> server.stop(2)));
        server.start();
        System.out.printf("Commander Duels engine on port %d: XMage %s (%s); gameplay unavailable;"
            + " development bot matches and human games %s%n", port, pin.version(), pin.commit(),
            games != null ? "enabled (at most " + games.maxActive() + " human games)" : "disabled");
        engine.startLoading();
    }
}
