package com.commanderduels;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Comparator;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The development human games in this engine. Each game has a seat token, returned once when it is
 * created; requests carry it as a bearer token and it alone selects the seat. Unknown games and
 * wrong tokens look the same (not found). At most {@code maxActive} games run at once: each holds
 * a platform thread while it waits for the seat, and XMage's AI shares one search pool and one random
 * generator across games. Finished games stay readable for a while, then are dropped.
 */
final class HumanGames {
    static final int DEFAULT_MAX_ACTIVE = 2;
    static final int MAX_ACTIVE_LIMIT = 8;
    static final long RETAIN_FINISHED_MILLIS = TimeUnit.MINUTES.toMillis(10);
    static final int MAX_FINISHED = 16;
    private static final SecureRandom RANDOM = new SecureRandom();

    record Created(HumanGame game, String seatToken) {}

    private static final class Entry {
        final HumanGame game;
        final byte[] tokenHash;
        final AtomicBoolean closing = new AtomicBoolean();
        volatile long finishedAtNanos;

        Entry(HumanGame game, byte[] tokenHash) {
            this.game = game;
            this.tokenHash = tokenHash;
        }
    }

    private final Path deckDirectory;
    private final int maxActive;
    private final Map<String, Entry> games = new ConcurrentHashMap<>();
    private final ScheduledExecutorService watchdog;

    HumanGames(Path deckDirectory, int maxActive) {
        this.deckDirectory = deckDirectory;
        this.maxActive = Math.max(1, Math.min(MAX_ACTIVE_LIMIT, maxActive));
        this.watchdog = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "human-game-watchdog");
            thread.setDaemon(true);
            return thread;
        });
        watchdog.scheduleWithFixedDelay(this::sweep, 1, 1, TimeUnit.SECONDS);
    }

    int maxActive() {
        return maxActive;
    }

    /** Starts a game, or returns empty when {@code maxActive} games are already running. */
    synchronized Optional<Created> create(HumanGameRequest request) {
        evict();
        if (active() >= maxActive) {
            return Optional.empty();
        }
        String id = UUID.randomUUID().toString();
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        var game = new HumanGame(id, request, deckDirectory, this::finished);
        games.put(id, new Entry(game, hash(token)));
        game.start();
        return Optional.of(new Created(game, token));
    }

    /** The game, if the id exists and the token is its seat token. */
    Optional<HumanGame> find(String id, String token) {
        Entry entry = id == null ? null : games.get(id);
        byte[] presented = hash(token == null ? "" : token);
        if (entry == null || !MessageDigest.isEqual(entry.tokenHash, presented)) {
            return Optional.empty();
        }
        return Optional.of(entry.game);
    }

    synchronized int active() {
        return (int) games.values().stream().filter(entry -> !entry.game.finished()).count();
    }

    private void finished(HumanGame game) {
        Entry entry = games.get(game.id());
        if (entry != null) {
            entry.finishedAtNanos = System.nanoTime();
        }
    }

    /** Closes games idle past their timeout; drops old finished games. */
    private void sweep() {
        try {
            for (Entry entry : games.values()) {
                HumanGame game = entry.game;
                long timeout = TimeUnit.SECONDS.toMillis(game.settings().idleTimeoutSeconds());
                if (!game.finished() && game.idleMillis() > timeout && entry.closing.compareAndSet(false, true)) {
                    Thread.ofVirtual().name("human-game-idle-close").start(() -> game.close("idle_timeout"));
                }
            }
            synchronized (this) {
                evict();
            }
        } catch (RuntimeException e) {
            System.err.println("Human game watchdog: " + e);
        }
    }

    /** Caller holds the lock. */
    private void evict() {
        long now = System.nanoTime();
        games.values().removeIf(entry -> entry.game.finished() && entry.finishedAtNanos != 0
            && TimeUnit.NANOSECONDS.toMillis(now - entry.finishedAtNanos) > RETAIN_FINISHED_MILLIS);
        var finished = games.values().stream()
            .filter(entry -> entry.game.finished() && entry.finishedAtNanos != 0)
            .sorted(Comparator.comparingLong(entry -> entry.finishedAtNanos))
            .toList();
        for (int i = 0; i < finished.size() - MAX_FINISHED; i++) {
            games.remove(finished.get(i).game.id());
        }
    }

    private static byte[] hash(String token) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
