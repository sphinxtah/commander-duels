package com.commanderduels;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.lang.management.ManagementFactory;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Deque;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Each game in a process of its own (v0.9.10, the owner's choice; docs/engine/isolation.md).
 *
 * <p>The engine's front process keeps the routes, the card database and the recordings; every game
 * runs in a Java process of its own beside it, started from the same classes, with a heap sized for
 * its format. A game that runs out of memory, or is killed, ends its own process and nothing else:
 * the front process forgets where it was, so the API's next request for it is answered 404, and the
 * API asks for the game again (attach), which a new process takes up from the game's recording, as
 * after the engine's restart since v0.9.9. A game that keeps killing its processes is given up after
 * {@link Recovery#MAX_FRUITLESS} recoveries with no answer between them, as before.
 *
 * <p><b>Admission.</b> Each process reserves its heap and an allowance for what a Java process holds
 * beside it ({@link Settings#overheadMegabytes}). A game is admitted only when its reservation fits
 * the budget ({@link Settings#budgetMegabytes}) and fewer than {@link Settings#maxGames} games run;
 * otherwise it is refused in words, and nothing already running is touched. Processes kept warm for
 * the next game count against the budget too; one of another size is stopped to make room.
 *
 * <p><b>The card database.</b> XMage opens its H2 file with {@code AUTO_SERVER}: the first process to
 * open it serves it to the others on loopback. The front process opens it before any game process
 * starts, so game processes read the cards through the front process and hold no copy of their own
 * (a game process idles at about 90 MB). Processes are started only once the front process is ready.
 *
 * <p>A game's process speaks the engine's own HTTP routes on loopback, with a service token of its
 * own; the front process forwards a game's requests to it unchanged, seat tokens included, so seat
 * tokens, views, commands and recordings work exactly as in one process.
 */
final class GameProcesses implements AutoCloseable {
    /** What a game's process prints on its standard output for the front process. */
    static final String PORT_LINE = "CD-GAME-PROCESS port ";
    static final String READY_LINE = "CD-GAME-PROCESS ready";
    static final String FAILED_LINE = "CD-GAME-PROCESS failed";
    /** {@code -XX:+ExitOnOutOfMemoryError}'s exit code. */
    static final int OUT_OF_MEMORY_EXIT = 3;
    static final long POLL_MILLIS = 2_000;
    private static final SecureRandom RANDOM = new SecureRandom();

    /** A game's size, which decides its process's heap. */
    enum Size {
        /** Two seats: Legacy, a Commander duel. */
        DUEL,
        /** Three or four seats: a Commander table, Two-Headed Giant. */
        TABLE,
        /** Six seats: King's Table, the campaign's court. */
        COURT;

        static Size of(String format, int seats) {
            if ("kings_table".equals(format) || seats > 4) {
                return COURT;
            }
            return seats > 2 ? TABLE : DUEL;
        }

        String label() {
            return name().toLowerCase(java.util.Locale.ROOT);
        }
    }

    /** Why a game was not admitted. */
    enum Refusal {
        /** {@link Settings#maxGames} games run already. */
        BUSY,
        /** The memory budget is spent. */
        FULL,
        /** Its process did not start. */
        FAILED
    }

    /**
     * @param command           the Java launcher and class path a game process is started with, before
     *                          its memory options
     * @param heapMegabytes     each size's heap
     * @param overheadMegabytes what a process holds beside its heap: classes, threads, code, the collector
     * @param budgetMegabytes   what every game process together may reserve
     * @param warm              processes kept started for each size, ready for the next game
     * @param maxGames          games at once, whatever the budget
     * @param javaOptions       more options for every game process
     * @param environment       variables for every game process, over the front process's own
     */
    record Settings(List<String> command, Path workingDirectory, Map<Size, Integer> heapMegabytes,
                    int overheadMegabytes, long budgetMegabytes, Map<Size, Integer> warm, int maxGames,
                    boolean devGames, List<String> javaOptions, Map<String, String> environment,
                    long finishedGraceMillis, long startTimeoutMillis) {

        int reserve(Size size) {
            return heapMegabytes.get(size) + overheadMegabytes;
        }

        /**
         * The front process's settings from its environment: {@code CD_ENGINE_GAME_HEAP_DUEL_MB},
         * {@code _TABLE_MB} and {@code _COURT_MB}; {@code CD_ENGINE_GAME_OVERHEAD_MB};
         * {@code CD_ENGINE_GAME_MEMORY_MB} (by default the machine's or container's memory less the
         * front process's heap and a gigabyte); {@code CD_ENGINE_GAME_WARM} (each size's warm
         * processes); {@code CD_ENGINE_GAME_JAVA_OPTIONS}; {@code CD_ENGINE_GAME_AI_THREADS}.
         */
        static Settings fromEnvironment(Map<String, String> env, int maxGames, boolean devGames) {
            Map<Size, Integer> heaps = new EnumMap<>(Size.class);
            heaps.put(Size.DUEL, integer(env, "CD_ENGINE_GAME_HEAP_DUEL_MB", DEFAULT_HEAPS.get(Size.DUEL)));
            heaps.put(Size.TABLE, integer(env, "CD_ENGINE_GAME_HEAP_TABLE_MB", DEFAULT_HEAPS.get(Size.TABLE)));
            heaps.put(Size.COURT, integer(env, "CD_ENGINE_GAME_HEAP_COURT_MB", DEFAULT_HEAPS.get(Size.COURT)));
            int warmEach = integer(env, "CD_ENGINE_GAME_WARM", 1);
            Map<Size, Integer> warm = new EnumMap<>(Size.class);
            warm.put(Size.DUEL, warmEach);
            warm.put(Size.TABLE, warmEach);
            // A court is rare and large: none is kept warm unless asked for.
            warm.put(Size.COURT, integer(env, "CD_ENGINE_GAME_WARM_COURT", 0));
            long memory = ((com.sun.management.OperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean())
                .getTotalMemorySize() / (1024 * 1024);
            long front = Runtime.getRuntime().maxMemory() / (1024 * 1024);
            long budget = integer(env, "CD_ENGINE_GAME_MEMORY_MB", (int) Math.max(1024, memory - front - 1024));
            List<String> options = new ArrayList<>();
            String extra = env.getOrDefault("CD_ENGINE_GAME_JAVA_OPTIONS", "").strip();
            if (!extra.isEmpty()) {
                options.addAll(List.of(extra.split("\\s+")));
            }
            Map<String, String> environment = new LinkedHashMap<>();
            // Each game has its own search pool now; by default a few threads each, not every core.
            environment.put("CD_ENGINE_AI_THREADS", env.getOrDefault("CD_ENGINE_GAME_AI_THREADS",
                String.valueOf(Math.max(2, Math.min(4, Runtime.getRuntime().availableProcessors())))));
            return new Settings(launcher(), Path.of("").toAbsolutePath(), heaps,
                integer(env, "CD_ENGINE_GAME_OVERHEAD_MB", DEFAULT_OVERHEAD_MB), budget, warm, maxGames, devGames,
                options, environment, TimeUnit.SECONDS.toMillis(integer(env, "CD_ENGINE_GAME_FINISHED_SECONDS", 120)),
                TimeUnit.SECONDS.toMillis(60));
        }

        /** This JVM's launcher and class path: game processes run the same classes as the front process. */
        static List<String> launcher() {
            String java = ProcessHandle.current().info().command()
                .orElse(Path.of(System.getProperty("java.home"), "bin", "java").toString());
            return List.of(java, "-cp", System.getProperty("java.class.path"));
        }

        private static int integer(Map<String, String> env, String name, int fallback) {
            String value = env.getOrDefault(name, "").strip();
            if (value.isEmpty()) {
                return fallback;
            }
            try {
                return Math.max(0, Integer.parseInt(value));
            } catch (NumberFormatException e) {
                System.err.println(name + " is not a number: " + value + "; using " + fallback);
                return fallback;
            }
        }
    }

    /**
     * Each size's heap, about twice what its games were measured to hold live at their peak
     * (docs/engine/isolation.md): a four-seat Commander table about 0.4 GB, the campaign's court
     * 1.85 GB after a collection in a 3 GB heap.
     */
    static final Map<Size, Integer> DEFAULT_HEAPS = Map.of(Size.DUEL, 1536, Size.TABLE, 2560, Size.COURT, 4096);
    /** Measured: classes, code, threads and the collector come to about 350 MB once a game has run. */
    static final int DEFAULT_OVERHEAD_MB = 512;

    /** A forwarded answer: the process's status, its Retry-After, and its body as it sent it. */
    record Forwarded(int status, String retryAfter, byte[] body) {}

    /** A game process, from its start to its end. */
    final class GameProcess {
        final int number;
        final Size size;
        final Process process;
        final String token;
        final long startedNanos = System.nanoTime();
        final CountDownLatch started = new CountDownLatch(1);
        volatile int port = -1;
        volatile boolean ready;
        volatile long readyMillis = -1;
        /** The game it runs, once its create or attach was answered. */
        volatile String gameId;
        volatile long claimedNanos;
        /** Set when the front process ends it on purpose: its end is not a failure. */
        volatile boolean retiring;
        /** The process's last report: its games, its memory and its bots. */
        volatile JsonObject status;
        volatile long peakHeapUsed;

        GameProcess(int number, Size size, Process process, String token) {
            this.number = number;
            this.size = size;
            this.process = process;
            this.token = token;
        }

        boolean alive() {
            return process.isAlive();
        }

        String label() {
            return "game process " + number + (gameId == null ? "" : " (" + gameId + ")");
        }
    }

    private final Settings settings;
    private final HttpClient client = HttpClient.newBuilder()
        .version(HttpClient.Version.HTTP_1_1)
        .connectTimeout(Duration.ofSeconds(2))
        .build();
    /** Every process that is alive, warm or claimed. Guarded by this. */
    private final Set<GameProcess> live = new java.util.LinkedHashSet<>();
    /** Started processes waiting for a game, by size. Guarded by this. */
    private final Map<Size, Deque<GameProcess>> warm = new EnumMap<>(Size.class);
    private final Map<String, GameProcess> byGame = new ConcurrentHashMap<>();
    private final Map<String, java.util.concurrent.locks.ReentrantLock> gameLocks = new ConcurrentHashMap<>();
    private final ScheduledExecutorService poller;
    private final AtomicInteger numbers = new AtomicInteger();
    private volatile boolean closed;
    private volatile boolean opened;
    // The operator's numbers (v0.9.10).
    private final AtomicLong startedCount = new AtomicLong();
    private final AtomicLong longestStartMillis = new AtomicLong();
    private final AtomicLong startMillis = new AtomicLong();
    private final AtomicLong retired = new AtomicLong();
    private final AtomicLong refusedFull = new AtomicLong();
    private final AtomicLong refusedBusy = new AtomicLong();
    private final AtomicLong failedToStart = new AtomicLong();
    private final Map<String, AtomicLong> ended = new ConcurrentHashMap<>();
    /** What the games that are over did: their bots' numbers added up. Guarded by this. */
    private final Map<String, Long> endedBots = new LinkedHashMap<>();
    /** The games' processes that ended unasked, most recent last: game id and why. Guarded by this. */
    private final Deque<Map<String, Object>> failures = new ArrayDeque<>();

    GameProcesses(Settings settings) {
        this.settings = settings;
        for (Size size : Size.values()) {
            warm.put(size, new ArrayDeque<>());
        }
        poller = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "game-process-poller");
            thread.setDaemon(true);
            return thread;
        });
        poller.scheduleWithFixedDelay(this::poll, POLL_MILLIS, POLL_MILLIS, TimeUnit.MILLISECONDS);
    }

    Settings settings() {
        return settings;
    }

    /** Called once the front process has opened the card database: warm processes may start. */
    void open() {
        opened = true;
        refill();
    }

    /** The process running a game, if one is. */
    Optional<GameProcess> of(String gameId) {
        GameProcess process = gameId == null ? null : byGame.get(gameId);
        if (process != null && !process.alive()) {
            byGame.remove(gameId, process);
            return Optional.empty();
        }
        return Optional.ofNullable(process);
    }

    /** Whether a game runs in one of these processes: its recording is not swept. */
    boolean running(String gameId) {
        return byGame.containsKey(gameId);
    }

    /**
     * One game's create or attach at a time: two cannot both start a process for it. A lock, not a
     * monitor: requests run on virtual threads, and one waiting inside a monitor would hold its
     * carrier thread for as long as a process takes to start.
     */
    java.util.concurrent.locks.ReentrantLock lock(String gameId) {
        return gameLocks.computeIfAbsent(gameId, id -> new java.util.concurrent.locks.ReentrantLock());
    }

    /** Games running now, in their processes. */
    int games() {
        return byGame.size();
    }

    /** What the processes alive now reserve, in megabytes. */
    synchronized long reserved() {
        return live.stream().mapToLong(process -> settings.reserve(process.size)).sum();
    }

    /** A process for a game of this size, started and ready; or why there is none. */
    record Claim(GameProcess process, Refusal refusal) {}

    Claim claim(Size size) throws InterruptedException {
        GameProcess process;
        synchronized (this) {
            if (byGame.size() + claimedWithoutGame() >= settings.maxGames) {
                refusedBusy.incrementAndGet();
                return new Claim(null, Refusal.BUSY);
            }
            process = takeWarm(size);
            if (process == null) {
                if (!makeRoom(settings.reserve(size))) {
                    refusedFull.incrementAndGet();
                    return new Claim(null, Refusal.FULL);
                }
                process = start(size);
                if (process == null) {
                    return new Claim(null, Refusal.FAILED);
                }
            }
            process.claimedNanos = System.nanoTime();
        }
        refill();
        if (!awaitReady(process)) {
            retire(process);
            return new Claim(null, Refusal.FAILED);
        }
        return new Claim(process, null);
    }

    /** Caller holds the lock. Claimed processes still waiting for their create or attach to be answered. */
    private long claimedWithoutGame() {
        return live.stream().filter(process -> process.claimedNanos != 0 && process.gameId == null).count();
    }

    /** Caller holds the lock. */
    private GameProcess takeWarm(Size size) {
        Deque<GameProcess> queue = warm.get(size);
        GameProcess process;
        while ((process = queue.poll()) != null) {
            if (process.alive()) {
                return process;
            }
        }
        return null;
    }

    /** Caller holds the lock. Stops warm processes of other sizes until {@code megabytes} fit, if they can. */
    private boolean makeRoom(int megabytes) {
        long free = settings.budgetMegabytes - reserved();
        if (free >= megabytes) {
            return true;
        }
        long warmReserve = 0;
        for (Deque<GameProcess> queue : warm.values()) {
            for (GameProcess process : queue) {
                warmReserve += settings.reserve(process.size);
            }
        }
        if (free + warmReserve < megabytes) {
            return false;
        }
        for (Deque<GameProcess> queue : warm.values()) {
            while (free < megabytes && !queue.isEmpty()) {
                GameProcess process = queue.poll();
                free += settings.reserve(process.size);
                retire(process);
            }
        }
        return free >= megabytes;
    }

    /** Caller holds the lock. Starts a process; its readiness is waited for outside the lock. */
    private GameProcess start(Size size) {
        if (closed) {
            return null;
        }
        String token = newToken();
        List<String> command = new ArrayList<>(settings.command);
        int heap = settings.heapMegabytes.get(size);
        command.add("-Xms" + Math.min(64, heap) + "m");
        command.add("-Xmx" + heap + "m");
        command.add("-XX:+UseG1GC");
        command.add("-XX:+ExitOnOutOfMemoryError");
        // A game's heap is given back to the machine while it waits for its players.
        command.add("-XX:G1PeriodicGCInterval=30000");
        command.add("-Dh2.bindAddress=127.0.0.1");
        // The cards database is the front process's, read as it is (XMage patch 0020).
        command.add("-Dxmage.cardsDatabase.shared=true");
        command.addAll(settings.javaOptions);
        command.add(EngineServer.class.getName());
        ProcessBuilder builder = new ProcessBuilder(command)
            .directory(settings.workingDirectory.toFile())
            .redirectErrorStream(true);
        Map<String, String> env = builder.environment();
        // The front process's own options (its larger heap) are not a game's.
        env.remove("JDK_JAVA_OPTIONS");
        env.putAll(settings.environment);
        env.put("CD_ENGINE_ROLE", "game");
        env.put("CD_ENGINE_BUILD_KEY", EngineBuild.key());
        env.put("CD_ENGINE_PORT", "0");
        env.put("CD_ENGINE_MAX_GAMES", "1");
        env.put("CD_ENGINE_SERVICE_TOKEN", token);
        env.put("CD_ENGINE_DEV_ENDPOINTS", String.valueOf(settings.devGames));
        Process process;
        try {
            process = builder.start();
        } catch (IOException e) {
            failedToStart.incrementAndGet();
            System.err.println("A game process could not be started: " + e);
            return null;
        }
        GameProcess game = new GameProcess(numbers.incrementAndGet(), size, process, token);
        live.add(game);
        startedCount.incrementAndGet();
        // A platform thread: a virtual one blocked reading a pipe holds its carrier.
        Thread.ofPlatform().daemon().name("game-process-" + game.number + "-output").start(() -> read(game));
        process.onExit().thenRun(() -> exited(game));
        return game;
    }

    /** The process's output: its port and readiness for the front process, the rest to the engine's log. */
    private void read(GameProcess game) {
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(game.process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.startsWith(PORT_LINE)) {
                    game.port = Integer.parseInt(line.substring(PORT_LINE.length()).strip());
                } else if (line.equals(READY_LINE)) {
                    game.readyMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - game.startedNanos);
                    game.ready = true;
                    startMillis.addAndGet(game.readyMillis);
                    longestStartMillis.accumulateAndGet(game.readyMillis, Math::max);
                    game.started.countDown();
                } else if (line.equals(FAILED_LINE)) {
                    game.started.countDown();
                } else if (!line.startsWith("Picked up JAVA_TOOL_OPTIONS")) {
                    System.out.println("[" + game.label() + "] " + line);
                }
            }
        } catch (IOException | RuntimeException e) {
            // The process ended; exited() says so.
        } finally {
            game.started.countDown();
        }
    }

    private boolean awaitReady(GameProcess game) throws InterruptedException {
        game.started.await(settings.startTimeoutMillis, TimeUnit.MILLISECONDS);
        if (!game.ready || game.port <= 0 || !game.alive()) {
            failedToStart.incrementAndGet();
            System.err.println("A " + game.size.label() + " process did not start within "
                + settings.startTimeoutMillis + " ms");
            return false;
        }
        return true;
    }

    /** Keeps each size's warm processes, within the budget. */
    void refill() {
        if (!opened || closed) {
            return;
        }
        List<GameProcess> starting = new ArrayList<>();
        synchronized (this) {
            for (Size size : Size.values()) {
                Deque<GameProcess> queue = warm.get(size);
                queue.removeIf(process -> !process.alive());
                while (queue.size() < settings.warm.get(size)
                        && settings.budgetMegabytes - reserved() >= settings.reserve(size)) {
                    GameProcess process = start(size);
                    if (process == null) {
                        break;
                    }
                    queue.add(process);
                    starting.add(process);
                }
            }
        }
        for (GameProcess process : starting) {
            Thread.ofPlatform().daemon().name("game-process-warm").start(() -> {
                try {
                    if (!awaitReady(process)) {
                        retire(process);
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });
        }
    }

    /** The game a process now runs: its requests go there. */
    void assign(GameProcess process, String gameId) {
        process.gameId = gameId;
        byGame.put(gameId, process);
    }

    /** Ends a process on purpose: its game is over, or it never got one. */
    void retire(GameProcess process) {
        process.retiring = true;
        if (process.gameId != null) {
            byGame.remove(process.gameId, process);
        }
        synchronized (this) {
            warm.get(process.size).remove(process);
        }
        process.process.destroy();
        process.process.onExit().orTimeout(10, TimeUnit.SECONDS)
            .exceptionally(timeout -> {
                process.process.destroyForcibly();
                return process.process;
            });
    }

    private void exited(GameProcess process) {
        String gameId = process.gameId;
        if (gameId != null) {
            byGame.remove(gameId, process);
        }
        JsonObject last = process.status;
        synchronized (this) {
            live.remove(process);
            warm.get(process.size).remove(process);
            if (last != null && last.has("games")) {
                for (var game : last.getAsJsonArray("games")) {
                    JsonObject bots = game.getAsJsonObject().getAsJsonObject("bots");
                    if (bots != null) {
                        bots.entrySet().forEach(entry -> endedBots.merge(entry.getKey(),
                            entry.getValue().getAsLong(), entry.getKey().startsWith("longest") ? Math::max : Long::sum));
                    }
                }
            }
        }
        if (process.retiring) {
            retired.incrementAndGet();
        } else if (!closed) {
            int code = process.process.exitValue();
            String why = code == OUT_OF_MEMORY_EXIT ? "out_of_memory"
                : code == 137 ? "killed" : code == 143 ? "terminated" : "exit_" + code;
            ended.computeIfAbsent(why, key -> new AtomicLong()).incrementAndGet();
            Map<String, Object> failure = new LinkedHashMap<>();
            failure.put("game_id", gameId);
            failure.put("size", process.size.label());
            failure.put("why", why);
            failure.put("at", java.time.Instant.now().toString());
            synchronized (this) {
                failures.addLast(failure);
                while (failures.size() > 32) {
                    failures.removeFirst();
                }
            }
            System.err.println("The " + process.label() + " ended unasked (" + why + ")"
                + (gameId == null ? "" : "; the game is taken up again from its recording when the API asks for it"));
        }
        refill();
    }

    /**
     * Forwards a request to a game's process, unchanged but for the service token. Empty when the
     * process cannot be reached: it is gone (its game is forgotten here) or not answering.
     */
    Optional<Forwarded> forward(GameProcess process, String method, String path, String query,
                                String authorization, byte[] body, long timeoutMillis) throws InterruptedException {
        if (process.port <= 0 || !process.alive()) {
            return Optional.empty();
        }
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + process.port + path
                + (query == null || query.isEmpty() ? "" : "?" + query)))
            .timeout(Duration.ofMillis(timeoutMillis))
            .header(EngineServer.SERVICE_TOKEN_HEADER, process.token)
            .header("Content-Type", "application/json")
            .method(method, body == null ? HttpRequest.BodyPublishers.noBody() : HttpRequest.BodyPublishers.ofByteArray(body));
        if (authorization != null) {
            request.header("Authorization", authorization);
        }
        try {
            HttpResponse<byte[]> response = client.send(request.build(), HttpResponse.BodyHandlers.ofByteArray());
            return Optional.of(new Forwarded(response.statusCode(),
                response.headers().firstValue("Retry-After").orElse(null), response.body()));
        } catch (IOException e) {
            if (process.alive()) {
                System.err.println("The " + process.label() + " did not answer " + method + " " + path + ": " + e);
            }
            return Optional.empty();
        }
    }

    /** Asks each claimed process how its game stands; ends the processes whose game is over. */
    private void poll() {
        try {
            List<GameProcess> claimed;
            synchronized (this) {
                claimed = live.stream().filter(process -> process.claimedNanos != 0).toList();
            }
            for (GameProcess process : claimed) {
                Optional<Forwarded> answer = forward(process, "GET", "/v1/service/process", null, null, null, 5_000);
                if (answer.isEmpty() || answer.get().status() != 200) {
                    continue;
                }
                JsonObject status = JsonParser.parseString(new String(answer.get().body(), StandardCharsets.UTF_8))
                    .getAsJsonObject();
                process.status = status;
                JsonObject memory = status.getAsJsonObject("memory");
                if (memory != null && memory.has("heap_used_megabytes")) {
                    process.peakHeapUsed = Math.max(process.peakHeapUsed, memory.get("heap_used_megabytes").getAsLong());
                }
                var games = status.getAsJsonArray("games");
                long claimedMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - process.claimedNanos);
                if (games == null || games.isEmpty()) {
                    // Its create or attach was refused, or its finished game was dropped.
                    if (claimedMillis > TimeUnit.SECONDS.toMillis(30)) {
                        retire(process);
                    }
                    continue;
                }
                JsonObject game = games.get(0).getAsJsonObject();
                if (game.get("finished").getAsBoolean()
                        && game.get("finished_millis").getAsLong() >= settings.finishedGraceMillis) {
                    retire(process);
                }
            }
        } catch (RuntimeException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            System.err.println("Game processes: " + e);
        }
    }

    /**
     * The operator's numbers (v0.9.10, {@code GET /v1/service/processes}): the budget and what is
     * reserved, each game's process with its memory and its bots' numbers, and in all: processes
     * started, how long they took, how many ended unasked and why, and games refused. Ids and
     * numbers only.
     */
    synchronized Map<String, Object> metrics() {
        Map<String, Object> metrics = new LinkedHashMap<>();
        metrics.put("isolation", "process");
        metrics.put("budget_megabytes", settings.budgetMegabytes);
        metrics.put("reserved_megabytes", reserved());
        Map<String, Object> sizes = new LinkedHashMap<>();
        for (Size size : Size.values()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("heap_megabytes", settings.heapMegabytes.get(size));
            entry.put("reserve_megabytes", settings.reserve(size));
            entry.put("warm", warm.get(size).size());
            entry.put("warm_wanted", settings.warm.get(size));
            sizes.put(size.label(), entry);
        }
        metrics.put("sizes", sizes);
        metrics.put("max_games", settings.maxGames);
        List<Map<String, Object>> games = new ArrayList<>();
        for (GameProcess process : live) {
            if (process.gameId == null) {
                continue;
            }
            Map<String, Object> game = new LinkedHashMap<>();
            game.put("game_id", process.gameId);
            game.put("size", process.size.label());
            game.put("pid", process.process.pid());
            game.put("uptime_seconds", TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - process.startedNanos));
            game.put("start_millis", process.readyMillis);
            game.put("peak_heap_used_megabytes", process.peakHeapUsed);
            JsonObject status = process.status;
            if (status != null) {
                game.put("memory", status.get("memory"));
                var reported = status.getAsJsonArray("games");
                if (reported != null && !reported.isEmpty()) {
                    JsonObject first = reported.get(0).getAsJsonObject();
                    game.put("finished", first.get("finished").getAsBoolean());
                    game.put("bots", first.get("bots"));
                }
            }
            games.add(game);
        }
        metrics.put("games", games);
        Map<String, Object> totals = new LinkedHashMap<>();
        long started = startedCount.get();
        totals.put("processes_started", started);
        totals.put("processes_alive", live.size());
        totals.put("start_millis_average", started == 0 ? 0 : startMillis.get() / Math.max(1, started - failedToStart.get()));
        totals.put("start_millis_longest", longestStartMillis.get());
        totals.put("failed_to_start", failedToStart.get());
        totals.put("retired", retired.get());
        Map<String, Long> endedUnasked = new LinkedHashMap<>();
        ended.forEach((why, count) -> endedUnasked.put(why, count.get()));
        totals.put("ended_unasked", endedUnasked);
        totals.put("refused_busy", refusedBusy.get());
        totals.put("refused_full", refusedFull.get());
        totals.put("bots_of_games_over", new LinkedHashMap<>(endedBots));
        metrics.put("totals", totals);
        metrics.put("recent_failures", new ArrayList<>(failures));
        return metrics;
    }

    /** What a game's process reports about its own memory, for {@link #metrics}. */
    static Map<String, Object> ownMemory() {
        Runtime runtime = Runtime.getRuntime();
        Map<String, Object> memory = new LinkedHashMap<>();
        long megabyte = 1024 * 1024;
        memory.put("heap_max_megabytes", runtime.maxMemory() / megabyte);
        memory.put("heap_committed_megabytes", runtime.totalMemory() / megabyte);
        memory.put("heap_used_megabytes", (runtime.totalMemory() - runtime.freeMemory()) / megabyte);
        long oldAfterCollection = 0;
        for (var pool : ManagementFactory.getMemoryPoolMXBeans()) {
            if (pool.getName().contains("Old Gen") && pool.getCollectionUsage() != null) {
                oldAfterCollection = pool.getCollectionUsage().getUsed() / megabyte;
            }
        }
        memory.put("old_after_collection_megabytes", oldAfterCollection);
        memory.put("pressure_percent", Math.round(100.0 * oldAfterCollection / Math.max(1, runtime.maxMemory() / megabyte)));
        return memory;
    }

    private static String newToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    /** Ends every game process: the front process is stopping, and its games with it. */
    @Override
    public void close() {
        closed = true;
        poller.shutdownNow();
        List<GameProcess> all;
        synchronized (this) {
            all = new ArrayList<>(live);
        }
        for (GameProcess process : all) {
            process.retiring = true;
            process.process.destroy();
        }
        for (GameProcess process : all) {
            try {
                if (!process.process.waitFor(10, TimeUnit.SECONDS)) {
                    process.process.destroyForcibly();
                }
            } catch (InterruptedException e) {
                process.process.destroyForcibly();
                Thread.currentThread().interrupt();
            }
        }
    }

    /** For tests: the process running a game, to end it as a crash would. */
    Optional<Process> processForTest(String gameId) {
        return of(gameId).map(process -> process.process);
    }
}
