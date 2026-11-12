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
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Internal HTTP boundary of the XMage engine. It reports engine status. When development endpoints
 * are enabled, it runs bot-versus-bot matches and development games with human and bot seats (each
 * human seat's token selects that seat). When a service token is configured, the API's service
 * games run under {@code /v1/service}: every request there must carry the token, seats still need
 * their own seat tokens, and the API may also close a game, inspect it for SysOp, make its bots
 * passive for SysOp (v0.8.6), look up card names and fetch the list of implemented cards. Every
 * other operation fails closed.
 */
public final class EngineServer {
    public static final int PROTOCOL_VERSION = 1;
    static final int MAX_BODY_BYTES = 4096;
    /**
     * Service game requests may carry deck lists; since v0.6.2 with their stand-ins described card
     * by card, so four decks of a hundred stand-ins still fit.
     */
    static final int MAX_SERVICE_BODY_BYTES = 262_144;
    static final long MAX_WAIT_MILLIS = 30_000;
    static final String SERVICE_TOKEN_HEADER = "X-Service-Token";
    static final int DEFAULT_CARD_RESULTS = 20;
    private static final String GAMES = "/v1/games";
    private static final String SERVICE = "/v1/service/";
    private static final String GAME_ID = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
    private static final Pattern GAME_PATH = Pattern.compile(GAME_ID + "/(view|commands|close)");
    private static final Pattern SERVICE_GAME_PATH = Pattern.compile(GAME_ID + "/(close|inspection|bots|attach)");
    /** The body of a request to the passive bot switch (v0.8.6). */
    private static final Set<String> BOTS_FIELDS = Set.of("passive");
    /** Content a plugin carries for the API (v0.8.0): {@code /v1/service/content/<name>}. */
    private static final Pattern CONTENT_NAME = Pattern.compile("[a-z0-9][a-z0-9-]{0,63}");
    static final String CONTENT_RESOURCES = "commander-duels/content/";
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
        return create(new InetSocketAddress("0.0.0.0", port), engine, implementations);
    }

    static HttpServer create(InetSocketAddress address, Engine engine, Implementations implementations)
            throws IOException {
        var server = HttpServer.create(address, 16);
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
            if (engine.processes() != null) {
                isolatedCreate(exchange, engine, false);
            } else {
                createGame(exchange, engine, false);
            }
        } else if (path.startsWith(GAMES + "/") && engine.devGamesEnabled()) {
            if (engine.processes() != null) {
                isolatedGameRoute(exchange, engine, path.substring(GAMES.length() + 1), false);
            } else {
                gameRoute(exchange, engine.humanGames(), path.substring(GAMES.length() + 1), false);
            }
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
        GameProcesses processes = engine.processes();
        if (rest.equals("games")) {
            if (processes != null) {
                isolatedCreate(exchange, engine, true);
            } else {
                createGame(exchange, engine, true);
            }
        } else if (rest.equals("processes")) {
            // Each game's process, its memory and its bots, and the engine's numbers in all (v0.9.10).
            if (!exchange.getRequestMethod().equals("GET")) {
                methodNotAllowed(exchange, "GET");
            } else {
                respond(exchange, 200, processes != null ? processes.metrics() : inlineMetrics(games));
            }
        } else if (rest.equals("process") && engine.gameProcess()) {
            // A game's own process, to its front process (v0.9.10): its game, memory and bots.
            Map<String, Object> status = new LinkedHashMap<>();
            status.put("pid", ProcessHandle.current().pid());
            status.put("games", games.processStatus());
            status.put("memory", GameProcesses.ownMemory());
            respond(exchange, 200, status);
        } else if (rest.equals("cards")) {
            cards(exchange, engine);
        } else if (rest.equals("implementations")) {
            implementations(exchange, implementations);
        } else if (rest.equals("recordings")) {
            // What recording and recovery are doing (v0.9.9): numbers and game ids, for the operator.
            if (!exchange.getRequestMethod().equals("GET")) {
                methodNotAllowed(exchange, "GET");
            } else {
                respond(exchange, 200, games.recordingStatus());
            }
        } else if (rest.startsWith("content/")) {
            content(exchange, rest.substring("content/".length()));
        } else if (rest.startsWith("games/") && processes != null) {
            isolatedGameRoute(exchange, engine, rest.substring("games/".length()), true);
        } else if (rest.startsWith("games/")) {
            String gamePath = rest.substring("games/".length());
            Matcher matcher = SERVICE_GAME_PATH.matcher(gamePath);
            if (!matcher.matches()) {
                gameRoute(exchange, games, gamePath, true);
                return;
            }
            if (matcher.group(2).equals("attach")) {
                attach(exchange, engine, matcher.group(1));
                return;
            }
            // A close for an id no game has records it as cancelled (v0.8.3): the API gave up on a
            // create whose game it never heard of, and a late create with that id is refused.
            boolean close = matcher.group(2).equals("close") && exchange.getRequestMethod().equals("POST");
            Optional<HumanGame> game = close ? games.serviceOrCancel(matcher.group(1))
                : games.service(matcher.group(1));
            if (game.isEmpty()) {
                respond(exchange, 404, Map.of("code", "not_found"));
            } else if (matcher.group(2).equals("close")) {
                close(exchange, game.get());
            } else if (matcher.group(2).equals("bots")) {
                bots(exchange, game.get());
            } else {
                inspection(exchange, game.get());
            }
        } else {
            respond(exchange, 404, Map.of("code", "not_found"));
        }
    }

    /**
     * The API asks for a game again (v0.9.9, {@link HumanGames#attach}): after the engine's restart,
     * when the game is taken up from its recording, or after its own, when it has lost the game's
     * tokens. The answer has the shape of a create's, with a {@code status}: {@code attached} (the
     * game was running here) or {@code recovered} (it was taken up), each with new seat tokens, the
     * old ones no longer working; or {@code finished}, with the game's {@code result} and no tokens.
     * A game that is not here and has no recording is 404; a recording that cannot give its game
     * back is 409 with a {@code code} ({@code recording_unreadable}, {@code recording_incompatible},
     * {@code recording_unrecoverable}) and a {@code message} that says why in words.
     */
    private static void attach(HttpExchange exchange, Engine engine, String id) throws IOException {
        if (!exchange.getRequestMethod().equals("POST")) {
            methodNotAllowed(exchange, "POST");
            return;
        }
        if (engine.status() != Engine.Status.READY) {
            // The cards are still being loaded: a game cannot be taken up without them.
            exchange.getResponseHeaders().set("Retry-After", "5");
            respond(exchange, 503, Map.of("code", notReadyCode(engine)));
            return;
        }
        if (readBody(exchange).isEmpty()) {
            return;
        }
        HumanGames.Attachment attachment = engine.humanGames().attach(id);
        switch (attachment.status()) {
            case UNKNOWN -> respond(exchange, 404, Map.of("code", "not_found"));
            case BUSY -> {
                exchange.getResponseHeaders().set("Retry-After", "30");
                respond(exchange, 429, Map.of("code", "games_busy",
                    "message", "At most " + engine.humanGames().maxActive() + " games run at once"));
            }
            case UNUSABLE -> {
                Map<String, Object> refusal = new LinkedHashMap<>();
                refusal.put("code", "recording_" + attachment.code());
                refusal.put("message", attachment.message());
                respond(exchange, 409, refusal);
            }
            case FINISHED -> {
                Map<String, Object> response = new LinkedHashMap<>();
                response.put("game_id", id);
                response.put("status", "finished");
                response.put("result", attachment.result());
                respond(exchange, 200, response);
            }
            default -> {
                Map<String, Object> response = created(attachment.created());
                response.put("status", attachment.status() == HumanGames.Attached.RECOVERED ? "recovered" : "attached");
                if (attachment.report() != null) {
                    Map<String, Object> recovery = new LinkedHashMap<>();
                    recovery.put("checkpoint", attachment.report().checkpoint());
                    recovery.put("journal_records", attachment.report().records());
                    recovery.put("passed_over", attachment.report().problems());
                    response.put("recovery", recovery);
                }
                respond(exchange, 200, response);
            }
        }
    }

    /** Every route a game's process answers for it, on the front process (v0.9.10). */
    private static final Pattern ISOLATED_GAME_PATH = Pattern.compile(GAME_ID + "/(view|commands|close|inspection|bots|attach)");

    /**
     * The engine's numbers when every game runs in this one process (v0.9.10): memory and the bots
     * of each running game, in the shape of {@link GameProcesses#metrics}'s.
     */
    private static Map<String, Object> inlineMetrics(HumanGames games) {
        Map<String, Object> metrics = new LinkedHashMap<>();
        metrics.put("isolation", "none");
        metrics.put("memory", GameProcesses.ownMemory());
        metrics.put("games", games == null ? List.of() : games.processStatus());
        return metrics;
    }

    /**
     * A game's request, on the front process (v0.9.10): forwarded to the game's process, or 404 when
     * no process runs the game, which is what the API is answered for a game whose process ended
     * (it then attaches, and a new process takes the game up from its recording). A service close
     * for an id no process has is recorded as cancelled, as {@link HumanGames#serviceOrCancel} does.
     */
    private static void isolatedGameRoute(HttpExchange exchange, Engine engine, String rest, boolean service)
            throws IOException {
        Matcher matcher = ISOLATED_GAME_PATH.matcher(rest);
        String action = matcher.matches() ? matcher.group(2) : "";
        boolean serviceOnly = action.equals("inspection") || action.equals("bots") || action.equals("attach");
        if (action.isEmpty() || serviceOnly && !service) {
            respond(exchange, 404, Map.of("code", "not_found"));
            return;
        }
        String id = matcher.group(1);
        if (action.equals("attach")) {
            isolatedAttach(exchange, engine, id);
            return;
        }
        GameProcesses processes = engine.processes();
        Optional<GameProcesses.GameProcess> process = processes.of(id);
        if (process.isEmpty()) {
            if (service && action.equals("close") && exchange.getRequestMethod().equals("POST")) {
                engine.humanGames().serviceOrCancel(id);
            }
            respond(exchange, 404, Map.of("code", "not_found"));
            return;
        }
        Optional<String> body = exchange.getRequestMethod().equals("POST")
            ? readBody(exchange, service ? MAX_SERVICE_BODY_BYTES : MAX_BODY_BYTES) : Optional.of("");
        if (body.isEmpty()) {
            return;
        }
        forwardTo(exchange, processes, process.get(), body.get());
    }

    /** Forwards the exchange to a game's process and answers with what it answered. */
    private static void forwardTo(HttpExchange exchange, GameProcesses processes, GameProcesses.GameProcess process,
                                  String body) throws IOException {
        Optional<GameProcesses.Forwarded> answer;
        try {
            answer = processes.forward(process, exchange.getRequestMethod(), exchange.getRequestURI().getRawPath(),
                exchange.getRequestURI().getRawQuery(), exchange.getRequestHeaders().getFirst("Authorization"),
                exchange.getRequestMethod().equals("POST") ? body.getBytes(StandardCharsets.UTF_8) : null,
                MAX_WAIT_MILLIS + 30_000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            respond(exchange, 503, Map.of("code", "interrupted"));
            return;
        }
        if (answer.isEmpty()) {
            if (!process.alive()) {
                respond(exchange, 404, Map.of("code", "not_found"));
            } else {
                exchange.getResponseHeaders().set("Retry-After", "5");
                respond(exchange, 503, Map.of("code", "game_process_unavailable",
                    "message", "The game's process did not answer; ask again shortly"));
            }
            return;
        }
        respondRaw(exchange, answer.get());
    }

    private static void respondRaw(HttpExchange exchange, GameProcesses.Forwarded answer) throws IOException {
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        if (answer.retryAfter() != null) {
            exchange.getResponseHeaders().set("Retry-After", answer.retryAfter());
        }
        byte[] bytes = answer.body();
        exchange.sendResponseHeaders(answer.status(), bytes.length == 0 ? -1 : bytes.length);
        if (bytes.length > 0) {
            try (var stream = exchange.getResponseBody()) {
                stream.write(bytes);
            }
        }
    }

    /** A refusal to admit a game, in words a player understands (v0.9.10). */
    private static void refuse(HttpExchange exchange, GameProcesses processes, GameProcesses.Refusal refusal)
            throws IOException {
        switch (refusal) {
            case BUSY -> {
                exchange.getResponseHeaders().set("Retry-After", "30");
                respond(exchange, 429, Map.of("code", "games_busy",
                    "message", "At most " + processes.settings().maxGames() + " games run at once; try again in a minute."));
            }
            case FULL -> {
                exchange.getResponseHeaders().set("Retry-After", "60");
                respond(exchange, 429, Map.of("code", "games_busy",
                    "message", "The tables are full; try again in a minute."));
            }
            default -> {
                exchange.getResponseHeaders().set("Retry-After", "10");
                respond(exchange, 503, Map.of("code", "game_process_failed",
                    "message", "The game could not be started; try again shortly."));
            }
        }
    }

    /**
     * A create on the front process (v0.9.10): checked as {@link #createGame} checks it, then given
     * a process of its own, sized for its format, which creates the game.
     */
    private static void isolatedCreate(HttpExchange exchange, Engine engine, boolean service) throws IOException {
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
        GameProcesses processes = engine.processes();
        String id = service ? request.gameId() : null;
        var lock = id == null ? new java.util.concurrent.locks.ReentrantLock() : processes.lock(id);
        lock.lock();
        try {
            if (id != null) {
                Path recordings = engine.humanGames().recordings();
                if (processes.of(id).isPresent() || recordings != null && Recording.of(recordings, id).exists()) {
                    respond(exchange, 409, Map.of("code", "game_exists",
                        "message", "A game with this game_id already exists"));
                    return;
                }
                if (engine.humanGames().cancelled(id)) {
                    respond(exchange, 409, Map.of("code", "game_cancelled",
                        "message", "This game_id was closed before its game was created"));
                    return;
                }
            }
            GameProcesses.Claim claim;
            try {
                claim = processes.claim(GameProcesses.Size.of(request.format().id(), request.seats().size()));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                respond(exchange, 503, Map.of("code", "interrupted"));
                return;
            }
            if (claim.refusal() != null) {
                refuse(exchange, processes, claim.refusal());
                return;
            }
            GameProcesses.GameProcess process = claim.process();
            Optional<GameProcesses.Forwarded> answer;
            try {
                answer = processes.forward(process, "POST", exchange.getRequestURI().getRawPath(), null, null,
                    body.get().getBytes(StandardCharsets.UTF_8), 120_000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                processes.retire(process);
                respond(exchange, 503, Map.of("code", "interrupted"));
                return;
            }
            String created = answer.filter(forwarded -> forwarded.status() == 201)
                .map(forwarded -> gameIdOf(forwarded.body())).orElse(null);
            if (created == null) {
                processes.retire(process);
            } else {
                processes.assign(process, created);
            }
            if (answer.isEmpty()) {
                refuse(exchange, processes, GameProcesses.Refusal.FAILED);
            } else {
                respondRaw(exchange, answer.get());
            }
        } finally {
            lock.unlock();
        }
    }

    /**
     * An attach on the front process (v0.9.10): forwarded to the game's process when one runs it;
     * otherwise answered from the recording when the game is over or cannot be given back, and
     * else a new process, sized for the game, takes the game up from its recording.
     */
    private static void isolatedAttach(HttpExchange exchange, Engine engine, String id) throws IOException {
        if (!exchange.getRequestMethod().equals("POST")) {
            methodNotAllowed(exchange, "POST");
            return;
        }
        if (engine.status() != Engine.Status.READY) {
            exchange.getResponseHeaders().set("Retry-After", "5");
            respond(exchange, 503, Map.of("code", notReadyCode(engine)));
            return;
        }
        Optional<String> body = readBody(exchange);
        if (body.isEmpty()) {
            return;
        }
        GameProcesses processes = engine.processes();
        var lock = processes.lock(id);
        lock.lock();
        try {
            Optional<GameProcesses.GameProcess> running = processes.of(id);
            if (running.isPresent()) {
                forwardTo(exchange, processes, running.get(), body.get());
                return;
            }
            Path recordings = engine.humanGames().recordings();
            Recording recording = recordings == null ? null : Recording.of(recordings, id);
            if (recording == null || !recording.exists()) {
                respond(exchange, 404, Map.of("code", "not_found"));
                return;
            }
            Optional<com.google.gson.JsonObject> result = recording.result();
            if (result.isPresent()) {
                Map<String, Object> response = new LinkedHashMap<>();
                response.put("game_id", id);
                response.put("status", "finished");
                response.put("result", result.get());
                respond(exchange, 200, response);
                return;
            }
            GameProcesses.Size size;
            try {
                Recording.Manifest manifest = recording.manifest();
                if (!manifest.service()) {
                    respond(exchange, 404, Map.of("code", "not_found"));
                    return;
                }
                size = GameProcesses.Size.of(formatOf(manifest.request()), manifest.seats().size());
            } catch (Recording.Unusable e) {
                Map<String, Object> refusal = new LinkedHashMap<>();
                refusal.put("code", "recording_" + e.code);
                refusal.put("message", e.getMessage());
                respond(exchange, 409, refusal);
                return;
            }
            GameProcesses.Claim claim;
            try {
                claim = processes.claim(size);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                respond(exchange, 503, Map.of("code", "interrupted"));
                return;
            }
            if (claim.refusal() != null) {
                refuse(exchange, processes, claim.refusal());
                return;
            }
            GameProcesses.GameProcess process = claim.process();
            Optional<GameProcesses.Forwarded> answer;
            try {
                answer = processes.forward(process, "POST", exchange.getRequestURI().getRawPath(), null, null,
                    body.get().getBytes(StandardCharsets.UTF_8), 120_000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                processes.retire(process);
                respond(exchange, 503, Map.of("code", "interrupted"));
                return;
            }
            boolean taken = answer.filter(forwarded -> forwarded.status() == 200)
                .map(forwarded -> statusOf(forwarded.body()))
                .filter(status -> status.equals("recovered") || status.equals("attached")).isPresent();
            if (taken) {
                processes.assign(process, id);
            } else {
                processes.retire(process);
            }
            if (answer.isEmpty()) {
                refuse(exchange, processes, GameProcesses.Refusal.FAILED);
            } else {
                respondRaw(exchange, answer.get());
            }
        } finally {
            lock.unlock();
        }
    }

    private static String gameIdOf(byte[] body) {
        try {
            var json = com.google.gson.JsonParser.parseString(new String(body, StandardCharsets.UTF_8)).getAsJsonObject();
            return json.has("game_id") ? json.get("game_id").getAsString() : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static String statusOf(byte[] body) {
        try {
            var json = com.google.gson.JsonParser.parseString(new String(body, StandardCharsets.UTF_8)).getAsJsonObject();
            return json.has("status") ? json.get("status").getAsString() : "";
        } catch (RuntimeException e) {
            return "";
        }
    }

    /** A recorded request's format, as its create named it; Legacy when it named none. */
    private static String formatOf(String request) {
        try {
            var json = com.google.gson.JsonParser.parseString(request).getAsJsonObject();
            return json.has("format") ? json.get("format").getAsString() : "legacy";
        } catch (RuntimeException e) {
            return "legacy";
        }
    }

    /** A game with its tokens, as a create and an attach answer. */
    private static Map<String, Object> created(HumanGames.Created created) {
        HumanGame game = created.game();
        List<Map<String, Object>> seats = new ArrayList<>();
        for (HumanGame.SeatSettings seat : game.settings().seats()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("seat", seat.seat());
            entry.put("player", seat.player());
            entry.put("seat_token", created.seatTokens().get(seat.seat()));
            seats.add(entry);
        }
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("game_id", game.id());
        response.put("seats", seats);
        response.put("spectator_token", created.spectatorToken());
        response.put("settings", game.settings());
        return response;
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

    /**
     * Content a plugin on the classpath carries for the API (v0.8.0): the JSON resource
     * {@code commander-duels/content/<name>.json}, as it is. The owner's private image carries the
     * campaign finale's this way, so this repository names none of its cards; the public image has
     * none, and every name answers 404.
     */
    private static void content(HttpExchange exchange, String name) throws IOException {
        if (!exchange.getRequestMethod().equals("GET")) {
            methodNotAllowed(exchange, "GET");
            return;
        }
        Optional<String> found = CONTENT_NAME.matcher(name).matches() ? contentResource(name) : Optional.empty();
        if (found.isEmpty()) {
            respond(exchange, 404, Map.of("code", "not_found"));
            return;
        }
        byte[] bytes = found.get().getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control", "no-store");
        exchange.sendResponseHeaders(200, bytes.length);
        try (var stream = exchange.getResponseBody()) {
            stream.write(bytes);
        }
    }

    /** A content resource's JSON, when the classpath has it and it is an object. */
    static Optional<String> contentResource(String name) {
        ClassLoader loader = EngineServer.class.getClassLoader();
        try (InputStream stream = loader.getResourceAsStream(CONTENT_RESOURCES + name + ".json")) {
            if (stream == null) {
                return Optional.empty();
            }
            String text = new String(stream.readAllBytes(), StandardCharsets.UTF_8);
            return com.google.gson.JsonParser.parseString(text).isJsonObject() ? Optional.of(text) : Optional.empty();
        } catch (IOException | com.google.gson.JsonParseException e) {
            return Optional.empty();
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

    /**
     * SysOp's switch for passive bots (v0.8.6, see {@link HumanGame#setPassiveBots}): a POST of
     * {@code {"passive": true}} or {@code {"passive": false}} answers 200 with the switch as it now
     * is. Any other body is a 400 {@code invalid_request}, and a finished game a 409
     * {@code game_over}. Setting the value the switch already has is accepted and changes nothing.
     */
    private static void bots(HttpExchange exchange, HumanGame game) throws IOException {
        if (!exchange.getRequestMethod().equals("POST")) {
            methodNotAllowed(exchange, "POST");
            return;
        }
        Optional<String> body = readBody(exchange);
        if (body.isEmpty()) {
            return;
        }
        boolean passive;
        try {
            passive = JsonRequest.bool(JsonRequest.object(body.get(), BOTS_FIELDS), "passive");
        } catch (JsonRequest.Invalid e) {
            respond(exchange, 400, Map.of("code", "invalid_request", "message", e.getMessage()));
            return;
        }
        Boolean now = game.setPassiveBots(passive);
        if (now == null) {
            respond(exchange, 409, Map.of("code", "game_over", "message", "The game has finished"));
        } else {
            respond(exchange, 200, Map.of("passive", now));
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
     * may seat deck lists; every name in them must be in the card database. Since v0.8.3 a service
     * request may name the game's id ({@code game_id}): an id already in use answers 409
     * {@code game_exists}, and an id the API closed before any game had it 409 {@code game_cancelled}.
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
        HumanGames.Creation creation = games.start(request, service, body.get());
        if (creation.refusal() == HumanGames.Refusal.GAME_EXISTS) {
            respond(exchange, 409, Map.of("code", "game_exists",
                "message", "A game with this game_id already exists"));
            return;
        }
        if (creation.refusal() == HumanGames.Refusal.GAME_CANCELLED) {
            respond(exchange, 409, Map.of("code", "game_cancelled",
                "message", "This game_id was closed before its game was created"));
            return;
        }
        Optional<HumanGames.Created> created = Optional.ofNullable(creation.created());
        if (created.isEmpty()) {
            exchange.getResponseHeaders().set("Retry-After", "30");
            respond(exchange, 429, Map.of("code", "games_busy",
                "message", "At most " + games.maxActive() + " development games run at once"));
            return;
        }
        respond(exchange, 201, created(created.get()));
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
        if (matcher.group(2).equals("close") && !service && seat != hostSeat(game)) {
            // Bug E5 (v0.8.6): any seat's token closed the whole game for everyone.
            respond(exchange, 403, Map.of("code", "forbidden",
                "message", "Only the first human seat can close the game; concede to leave it"));
            return;
        }
        switch (matcher.group(2)) {
            case "view" -> view(exchange, game, seat);
            case "commands" -> command(exchange, game, seat);
            default -> close(exchange, game);
        }
    }

    /**
     * The seat that may close a development game for everyone (v0.8.6): the first human seat, the
     * one whoever created the game sits in (seat 0 at the default tables). Every other seat leaves
     * by conceding, and the game goes on without it while players remain. The service route's close
     * is the API's alone (it holds the service token) and is not a seat's.
     */
    static int hostSeat(HumanGame game) {
        return game.humanSeats().get(0);
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
        Map<String, String> env = System.getenv();
        // v0.9.10: "game" is one game's own process, started by a front process (GameProcesses).
        boolean gameProcess = "game".equals(env.getOrDefault("CD_ENGINE_ROLE", "").strip());
        int port = Integer.parseInt(env.getOrDefault("CD_ENGINE_PORT", "8090"));
        boolean devEndpoints = "true".equalsIgnoreCase(env.get("CD_ENGINE_DEV_ENDPOINTS"));
        Path decks = Path.of(env.getOrDefault("CD_ENGINE_DECKS", "decks"));
        XmagePin pin = XmagePin.load();
        var runner = new BotMatchRunner(decks, pin);
        int maxGames = Integer.parseInt(env.getOrDefault("CD_ENGINE_MAX_GAMES",
            String.valueOf(HumanGames.DEFAULT_MAX_ACTIVE)));
        String serviceToken = env.getOrDefault("CD_ENGINE_SERVICE_TOKEN", "").strip();
        // Recordings (v0.9.9): where service games keep them, and for how long after their last
        // change. Without a folder no game is recorded and none can be taken up again.
        String recordingsFolder = env.getOrDefault("CD_ENGINE_RECORDINGS", "").strip();
        Path recordings = recordingsFolder.isEmpty() ? null : Path.of(recordingsFolder);
        long retentionHours = Long.parseLong(env.getOrDefault("CD_ENGINE_RECORDING_RETENTION_HOURS", "24"));
        if (recordings != null) {
            java.nio.file.Files.createDirectories(recordings);
        }
        var games = devEndpoints || !serviceToken.isEmpty()
            ? new HumanGames(decks, gameProcess ? 1 : maxGames, recordings,
                java.util.concurrent.TimeUnit.HOURS.toMillis(retentionHours))
            : null;
        // A game's process plays no development bot matches: they are the front process's.
        var engine = new Engine(pin, devEndpoints && !gameProcess, CardDatabase::load, runner::run, games,
            devEndpoints, serviceToken);
        if (gameProcess) {
            gameProcessMain(engine, games);
            return;
        }
        String isolation = env.getOrDefault("CD_ENGINE_ISOLATION", "process").strip();
        GameProcesses processes = null;
        if (games != null && isolation.equals("process")) {
            processes = new GameProcesses(GameProcesses.Settings.fromEnvironment(env, games.maxActive(), devEndpoints));
            engine.isolate(processes);
        }
        var implementations = Implementations.load(
            Path.of(env.getOrDefault("CD_ENGINE_IMPLEMENTATIONS", "catalog")));
        var server = create(port, engine, implementations);
        GameProcesses isolated = processes;
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            server.stop(2);
            if (isolated != null) {
                isolated.close();
            }
        }));
        server.start();
        System.out.printf("Commander Duels engine on port %d: XMage %s (%s); development bot matches and"
            + " games %s; service games %s%s%n", port, pin.version(), pin.commit(),
            devEndpoints ? "enabled" : "disabled", engine.serviceGamesEnabled() ? "enabled" : "disabled",
            games != null ? " (at most " + games.maxActive() + " games at once)" : "");
        if (processes != null) {
            GameProcesses.Settings settings = processes.settings();
            System.out.println("Each game runs in a process of its own: heaps " + settings.heapMegabytes()
                + " MB and " + settings.overheadMegabytes() + " MB beside each, within "
                + settings.budgetMegabytes() + " MB; warm " + settings.warm());
        } else if (games != null) {
            System.out.println("Every game runs in this process (CD_ENGINE_ISOLATION=" + isolation + "), "
                + FairBot.SEARCH_THREADS + " bot search threads");
        }
        System.out.println(recordings == null || games == null ? "Service games keep no recording (CD_ENGINE_RECORDINGS"
                + " is not set): a game the engine loses is lost"
            : "Service games are recorded in " + recordings.toAbsolutePath() + " (kept " + retentionHours
                + " hours after their last change); this engine's build is " + EngineBuild.key());
        System.out.println(implementations.summary() == null ? "No implementation list"
            : "Implementation list " + implementations.summary().build() + ": "
                + implementations.summary().cards() + " cards");
        Thread loader = engine.startLoading();
        if (processes != null) {
            // Game processes read the cards through this process's database: they start once it is open.
            Thread.ofVirtual().name("game-processes-open").start(() -> {
                try {
                    loader.join();
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
                if (engine.status() == Engine.Status.READY) {
                    isolated.open();
                }
            });
        }
    }

    /**
     * One game's own process (v0.9.10): on loopback, on a port of the system's choosing, which it
     * prints for its front process with its readiness; it ends when its front process does (its
     * standard input closes). Its front process sweeps the recordings and ends it when its game is over.
     */
    private static void gameProcessMain(Engine engine, HumanGames games) throws IOException {
        engine.markGameProcess();
        games.stopSweepingRecordings();
        var server = create(new InetSocketAddress(java.net.InetAddress.getLoopbackAddress(), 0), engine,
            Implementations.none());
        server.start();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> server.stop(0)));
        System.out.println(GameProcesses.PORT_LINE + server.getAddress().getPort());
        try {
            engine.startLoading().join();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        if (engine.status() != Engine.Status.READY) {
            System.out.println(GameProcesses.FAILED_LINE);
            System.exit(1);
        }
        System.out.println(GameProcesses.READY_LINE);
        // The main thread stays, so the process lives (the server's threads are daemons), until its
        // front process ends: nothing is sent on standard input, which ends with the front process.
        try {
            while (System.in.read() != -1) {
                // nothing is sent
            }
        } catch (IOException e) {
            // the same
        }
        System.exit(0);
    }
}
