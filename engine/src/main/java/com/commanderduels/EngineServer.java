package com.commanderduels;

import com.google.gson.FieldNamingPolicy;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
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
 * Internal HTTP boundary of the XMage engine. It reports engine status. When development endpoints
 * are enabled, it runs bot-versus-bot matches and development games with human and bot seats (each
 * human seat's token selects that seat). When a service token is configured, the API's service
 * games run under {@code /v1/service}: every request there must carry the token, seats still need
 * their own seat tokens, and the API may also close a game, inspect it for SysOp, look up card
 * names and fetch the list of implemented cards. Every other operation fails closed.
 */
public final class EngineServer {
    public static final int PROTOCOL_VERSION = 1;
    static final int MAX_BODY_BYTES = 4096;
    /** Service game requests may carry deck lists. */
    static final int MAX_SERVICE_BODY_BYTES = 65_536;
    static final long MAX_WAIT_MILLIS = 30_000;
    static final String SERVICE_TOKEN_HEADER = "X-Service-Token";
    static final int DEFAULT_CARD_RESULTS = 20;
    private static final String GAMES = "/v1/games";
    private static final String SERVICE = "/v1/service/";
    private static final String GAME_ID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
    private static final Pattern GAME_PATH = Pattern.compile(GAME_ID + "/(view|commands|close)");
    private static final Pattern SERVICE_GAME_PATH = Pattern.compile(GAME_ID + "/(close|inspection)");
    static final Gson JSON = new GsonBuilder()
        .setFieldNamingPolicy(FieldNamingPolicy.LOWER_CASE_WITH_UNDERSCORES)
        .serializeNulls()
        .disableHtmlEscaping()
        .create();
    private static final SecureRandom SEEDS = new SecureRandom();

    record Health(String status, int protocolVersion, boolean gameplayAvailable, Xmage xmage, Cards cards,
                  boolean botMatchEnabled, boolean serviceGamesEnabled,
                  Implementations.Summary implementations) {}

    record Xmage(String version, String tag, String commit, String commitDate) {}

    record Cards(long printings, long distinctNames) {}

    private EngineServer() {}

    public static HttpServer create(int port, Engine engine) throws IOException {
        return create(port, engine, Implementations.none());
    }

    static HttpServer create(int port, Engine engine, Implementations implementations) throws IOException {
        var server = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 16);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/", exchange -> {
            try (exchange) {
                try {
                    route(exchange, engine, implementations);
                } catch (RuntimeException e) {
                    // A bug, not a refusal: the caller gets a JSON 500 rather than a dropped
                    // connection, and the details stay in the engine's log.
                    System.err.println("Engine request " + exchange.getRequestMethod() + " "
                        + exchange.getRequestURI().getPath() + " failed");
                    e.printStackTrace();
                    if (exchange.getResponseCode() == -1) {
                        respond(exchange, 500, Map.of("code", "internal_error"));
                    }
                }
            }
        });
        return server;
    }

    private static void route(HttpExchange exchange, Engine engine, Implementations implementations)
            throws IOException {
        String path = exchange.getRequestURI().getPath();
        String method = exchange.getRequestMethod();
        if (path.equals("/health")) {
            if (!method.equals("GET")) {
                methodNotAllowed(exchange, "GET");
            } else {
                respond(exchange, 200, health(engine, implementations));
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
        } else if (path.startsWith(SERVICE) && engine.serviceGamesEnabled()) {
            service(exchange, engine, implementations, path.substring(SERVICE.length()));
        } else if (path.equals(GAMES) && engine.devGamesEnabled()) {
            createGame(exchange, engine, false);
        } else if (path.startsWith(GAMES + "/") && engine.devGamesEnabled()) {
            gameRoute(exchange, engine.humanGames(), path.substring(GAMES.length() + 1), false);
        } else if (path.startsWith("/v1/")) {
            respond(exchange, 503, Map.of("code", "engine_not_integrated", "protocol_version", PROTOCOL_VERSION));
        } else {
            respond(exchange, 404, Map.of("code", "not_found"));
        }
    }

    static Health health(Engine engine) {
        return health(engine, Implementations.none());
    }

    static Health health(Engine engine, Implementations implementations) {
        XmagePin pin = engine.pin();
        CardDatabase.Stats stats = engine.cards();
        return new Health(
            engine.status().name().toLowerCase(Locale.ROOT),
            PROTOCOL_VERSION,
            // Players' games run on the service routes, which the API serves to the game screen.
            // They start only once the card database is open (createGame answers 503 before that).
            engine.serviceGamesEnabled() && engine.status() == Engine.Status.READY,
            new Xmage(pin.version(), pin.tag(), pin.commit(), pin.commitDate()),
            stats == null ? null : new Cards(stats.printings(), stats.distinctNames()),
            engine.botMatchEnabled(),
            engine.serviceGamesEnabled(),
            implementations.summary());
    }

    /**
     * The API's routes. The service token comes first: without it nothing under the prefix exists
     * for the caller. Seat routes still need the seat's own token.
     */
    private static void service(HttpExchange exchange, Engine engine, Implementations implementations,
                                String rest) throws IOException {
        if (!engine.serviceAuthorized(exchange.getRequestHeaders().getFirst(SERVICE_TOKEN_HEADER))) {
            respond(exchange, 401, Map.of("code", "service_unauthorized"));
            return;
        }
        HumanGames games = engine.humanGames();
        if (rest.equals("games")) {
            createGame(exchange, engine, true);
        } else if (rest.equals("cards")) {
            cards(exchange, engine);
        } else if (rest.equals("implementations")) {
            implementations(exchange, implementations);
        } else if (rest.startsWith("games/")) {
            String gamePath = rest.substring("games/".length());
            Matcher matcher = SERVICE_GAME_PATH.matcher(gamePath);
            if (!matcher.matches()) {
                gameRoute(exchange, games, gamePath, true);
                return;
            }
            Optional<HumanGame> game = games.service(matcher.group(1));
            if (game.isEmpty()) {
                respond(exchange, 404, Map.of("code", "not_found"));
            } else if (matcher.group(2).equals("close")) {
                close(exchange, game.get());
            } else {
                inspection(exchange, game.get());
            }
        } else {
            respond(exchange, 404, Map.of("code", "not_found"));
        }
    }

    /** The implementation list, gzipped as the image made it. */
    private static void implementations(HttpExchange exchange, Implementations implementations)
            throws IOException {
        if (!exchange.getRequestMethod().equals("GET")) {
            methodNotAllowed(exchange, "GET");
            return;
        }
        Optional<Path> list = implementations.list();
        if (list.isEmpty()) {
            respond(exchange, 404, Map.of("code", "no_implementation_list"));
            return;
        }
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Content-Encoding", "gzip");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(200, Files.size(list.get()));
        try (var stream = exchange.getResponseBody()) {
            Files.copy(list.get(), stream);
        }
    }

    /** SysOp's inspection view, once XMage waits for a human seat (see {@link HumanGame#inspect}). */
    private static void inspection(HttpExchange exchange, HumanGame game) throws IOException {
        if (!exchange.getRequestMethod().equals("GET")) {
            methodNotAllowed(exchange, "GET");
            return;
        }
        long waitMillis;
        try {
            waitMillis = longParameter(query(exchange.getRequestURI().getRawQuery()), "wait_ms", 0, 0,
                MAX_WAIT_MILLIS);
        } catch (JsonRequest.Invalid e) {
            respond(exchange, 400, Map.of("code", "invalid_request", "message", e.getMessage()));
            return;
        }
        try {
            HumanGame.Inspection inspection = game.inspect(waitMillis);
            if (inspection == null) {
                respond(exchange, 409, Map.of("code", "unsettled",
                    "message", "The game is not waiting for a player; ask again shortly"));
            } else {
                respond(exchange, 200, inspection);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            respond(exchange, 503, Map.of("code", "interrupted"));
        }
    }

    /** Card names in the engine's database containing {@code q}, for SysOp's deck lists. */
    private static void cards(HttpExchange exchange, Engine engine) throws IOException {
        if (!exchange.getRequestMethod().equals("GET")) {
            methodNotAllowed(exchange, "GET");
            return;
        }
        if (engine.status() != Engine.Status.READY) {
            respond(exchange, 503, Map.of("code", notReadyCode(engine)));
            return;
        }
        String text;
        int limit;
        try {
            Map<String, String> query = query(exchange.getRequestURI().getRawQuery());
            text = URLDecoder.decode(query.getOrDefault("q", ""), StandardCharsets.UTF_8);
            limit = (int) longParameter(query, "limit", DEFAULT_CARD_RESULTS, 1, DeckLists.MAX_SEARCH);
            if (text.isBlank() || text.length() > DeckLists.MAX_NAME) {
                throw new JsonRequest.Invalid("q must be 1 to " + DeckLists.MAX_NAME + " characters");
            }
        } catch (JsonRequest.Invalid | IllegalArgumentException e) {
            respond(exchange, 400, Map.of("code", "invalid_request", "message", e.getMessage()));
            return;
        }
        respond(exchange, 200, Map.of("names", DeckLists.search(text, limit)));
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

    /**
     * Starts a development or service game and returns each human seat's token, once. Service games
     * may seat deck lists; every name in them must be in the card database.
     */
    private static void createGame(HttpExchange exchange, Engine engine, boolean service) throws IOException {
        if (!exchange.getRequestMethod().equals("POST")) {
            methodNotAllowed(exchange, "POST");
            return;
        }
        if (engine.status() != Engine.Status.READY) {
            respond(exchange, 503, Map.of("code", notReadyCode(engine)));
            return;
        }
        Optional<String> body = readBody(exchange, service ? MAX_SERVICE_BODY_BYTES : MAX_BODY_BYTES);
        if (body.isEmpty()) {
            return;
        }
        HumanGameRequest request;
        try {
            request = HumanGameRequest.parse(body.get(), SEEDS::nextLong, service);
        } catch (JsonRequest.Invalid e) {
            respond(exchange, 400, Map.of("code", "invalid_request", "message", e.getMessage()));
            return;
        }
        List<String> unknown = request.unknownCards();
        if (!unknown.isEmpty()) {
            Map<String, Object> refusal = new LinkedHashMap<>();
            refusal.put("code", "unknown_cards");
            refusal.put("message", "The card database has no card named " + String.join(", ", unknown));
            refusal.put("names", unknown);
            respond(exchange, 400, refusal);
            return;
        }
        HumanGames games = engine.humanGames();
        Optional<HumanGames.Created> created = games.create(request, service);
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
        response.put("spectator_token", created.get().spectatorToken());
        response.put("settings", game.settings());
        respond(exchange, 201, response);
    }

    private static void gameRoute(HttpExchange exchange, HumanGames games, String rest, boolean service)
            throws IOException {
        Matcher matcher = GAME_PATH.matcher(rest);
        Optional<HumanGames.SeatHandle> found = matcher.matches()
            ? games.find(matcher.group(1), bearerToken(exchange), service) : Optional.empty();
        if (found.isEmpty()) {
            respond(exchange, 404, Map.of("code", "not_found"));
            return;
        }
        HumanGame game = found.get().game();
        Integer seat = found.get().seat();
        if (seat == null && !matcher.group(2).equals("view")) {
            respond(exchange, 403, Map.of("code", "read_only", "message", "A spectator token can only read the view"));
            return;
        }
        switch (matcher.group(2)) {
            case "view" -> view(exchange, game, seat);
            case "commands" -> command(exchange, game, seat);
            default -> close(exchange, game);
        }
    }

    /** A seat's snapshot, or the spectator's when {@code seat} is null. */
    private static void view(HttpExchange exchange, HumanGame game, Integer seat) throws IOException {
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
            respond(exchange, 200, seat == null ? game.spectatorSnapshot(since, waitMillis, logFrom)
                : game.snapshot(seat, since, waitMillis, logFrom));
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
        HumanGame.Reply reply = switch (command.type()) {
            case SeatCommand.CONCEDE -> game.concede(seat, command);
            case SeatCommand.SET_PRIORITY -> game.setPriority(seat, command);
            default -> game.submit(seat, command);
        };
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
        return readBody(exchange, MAX_BODY_BYTES);
    }

    private static Optional<String> readBody(HttpExchange exchange, int maxBytes) throws IOException {
        byte[] body;
        try (InputStream stream = exchange.getRequestBody()) {
            body = stream.readNBytes(maxBytes + 1);
        }
        if (body.length > maxBytes) {
            respond(exchange, 413, Map.of("code", "body_too_large", "max_bytes", maxBytes));
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
        String serviceToken = System.getenv().getOrDefault("CD_ENGINE_SERVICE_TOKEN", "").strip();
        var games = devEndpoints || !serviceToken.isEmpty() ? new HumanGames(decks, maxGames) : null;
        var engine = new Engine(pin, devEndpoints, CardDatabase::load, runner::run, games, devEndpoints, serviceToken);
        var implementations = Implementations.load(
            Path.of(System.getenv().getOrDefault("CD_ENGINE_IMPLEMENTATIONS", "catalog")));
        var server = create(port, engine, implementations);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> server.stop(2)));
        server.start();
        System.out.printf("Commander Duels engine on port %d: XMage %s (%s); development bot matches and"
            + " games %s; service games %s%s%n", port, pin.version(), pin.commit(),
            devEndpoints ? "enabled" : "disabled", engine.serviceGamesEnabled() ? "enabled" : "disabled",
            games != null ? " (at most " + games.maxActive() + " games at once, " + FairBot.SEARCH_THREADS
                + " bot search threads)" : "");
        System.out.println(implementations.summary() == null ? "No implementation list"
            : "Implementation list " + implementations.summary().build() + ": "
                + implementations.summary().cards() + " cards");
        engine.startLoading();
    }
}
