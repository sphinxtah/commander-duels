package com.commanderduels;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The games in this engine: development games, which scripts reach directly, and service games,
 * which only the API reaches (with the service token). A game belongs to one route and is not found
 * on the other. Each human seat has its own seat token, returned once when the game is created;
 * requests carry it as a bearer token and it alone selects the seat. Unknown games and wrong tokens
 * look the same (not found). At most {@code maxActive} games of both kinds run at once: each
 * holds a platform thread while it waits for a seat, and XMage's AI shares one search pool and one
 * random generator across games. Finished games stay readable for a while, then are dropped.
 */
final class HumanGames {
    static final int DEFAULT_MAX_ACTIVE = 2;
    static final int MAX_ACTIVE_LIMIT = 64;
    static final long RETAIN_FINISHED_MILLIS = TimeUnit.MINUTES.toMillis(10);
    static final int MAX_FINISHED = 16;
    private static final SecureRandom RANDOM = new SecureRandom();

    /**
     * @param seatTokens     each human seat's token, by seat, in seat order
     * @param spectatorToken a read-only token for the public, possibly delayed, view
     */
    record Created(HumanGame game, Map<Integer, String> seatTokens, String spectatorToken) {}

    /** A game and the seat a token selects; a null seat is the spectator. */
    record SeatHandle(HumanGame game, Integer seat) {
        boolean spectator() {
            return seat == null;
        }
    }

    private static final class Entry {
        final HumanGame game;
        /** SHA-256 of each human seat's token, by seat. */
        final Map<Integer, byte[]> tokenHashes;
        final byte[] spectatorHash;
        final boolean service;
        final AtomicBoolean closing = new AtomicBoolean();
        volatile long finishedAtNanos;

        Entry(HumanGame game, Map<Integer, byte[]> tokenHashes, byte[] spectatorHash, boolean service) {
            this.game = game;
            this.tokenHashes = tokenHashes;
            this.spectatorHash = spectatorHash;
            this.service = service;
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

    /** Starts a development game, or returns empty when {@code maxActive} games are already running. */
    Optional<Created> create(HumanGameRequest request) {
        return create(request, false);
    }

    /**
     * Starts a game, or returns empty when {@code maxActive} games are already running. A service
     * game can be inspected.
     */
    synchronized Optional<Created> create(HumanGameRequest request, boolean service) {
        evict();
        if (active() >= maxActive) {
            return Optional.empty();
        }
        String id = UUID.randomUUID().toString();
        var game = new HumanGame(id, request, deckDirectory, this::finished);
        Map<Integer, String> tokens = new LinkedHashMap<>();
        Map<Integer, byte[]> hashes = new LinkedHashMap<>();
        for (int seat : game.humanSeats()) {
            String token = newToken();
            tokens.put(seat, token);
            hashes.put(seat, hash(token));
        }
        String spectatorToken = newToken();
        if (service) {
            game.allowInspection();
        }
        games.put(id, new Entry(game, Map.copyOf(hashes), hash(spectatorToken), service));
        game.start();
        return Optional.of(new Created(game, tokens, spectatorToken));
    }

    private static String newToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    /** A development game's seat (null for the spectator), if the id exists and the token is one of its tokens. */
    Optional<SeatHandle> find(String id, String token) {
        return find(id, token, false);
    }

    /** The game and seat (null for the spectator) on the route given by {@code service}. */
    Optional<SeatHandle> find(String id, String token, boolean service) {
        Entry entry = id == null ? null : games.get(id);
        if (entry == null || entry.service != service) {
            return Optional.empty();
        }
        byte[] presented = hash(token == null ? "" : token);
        List<Integer> matches = new ArrayList<>();
        // Every hash is compared, in constant time, so timing does not say which seat matched.
        entry.tokenHashes.forEach((seat, hash) -> {
            if (MessageDigest.isEqual(hash, presented)) {
                matches.add(seat);
            }
        });
        boolean spectator = MessageDigest.isEqual(entry.spectatorHash, presented);
        if (matches.size() == 1 && !spectator) {
            return Optional.of(new SeatHandle(entry.game, matches.get(0)));
        }
        return spectator && matches.isEmpty() ? Optional.of(new SeatHandle(entry.game, null)) : Optional.empty();
    }

    /** A service game by id alone: the service token already authorized the caller. */
    Optional<HumanGame> service(String id) {
        Entry entry = id == null ? null : games.get(id);
        return entry == null || !entry.service ? Optional.empty() : Optional.of(entry.game);
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
        // At least as many as may run, so games that end together all stay readable for the API.
        for (int i = 0; i < finished.size() - Math.max(MAX_FINISHED, maxActive); i++) {
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
