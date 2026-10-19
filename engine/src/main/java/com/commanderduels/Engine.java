package com.commanderduels;

import java.lang.management.ManagementFactory;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Optional;
import java.util.concurrent.Semaphore;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * Engine lifecycle (loading, ready, failed), the single-slot gate for development bot matches, the
 * games and who may reach them. Development games are on only with development endpoints. Service
 * games are on only with a service token: the API presents it with every request, and only the API
 * knows it. Both kinds share one registry and its game cap.
 */
public final class Engine {
    public enum Status { LOADING, READY, FAILED }

    /** A service token must be at least this long; a shorter one is refused at startup. */
    static final int MIN_SERVICE_TOKEN_LENGTH = 32;

    private final XmagePin pin;
    private final boolean botMatchEnabled;
    private final Supplier<CardDatabase.Stats> loader;
    private final Function<BotMatchRequest, BotMatchRunner.Outcome> matchRunner;
    private final HumanGames humanGames;
    private final boolean devGames;
    /** SHA-256 of the service token; null when service games are off. */
    private final byte[] serviceTokenHash;
    // Held from the start of a match until its game thread has exited, so a game that ignores the
    // stop request keeps further matches out instead of piling up.
    private final Semaphore matchSlot = new Semaphore(1);
    private volatile Status status = Status.LOADING;
    private volatile CardDatabase.Stats cards;

    public Engine(XmagePin pin, boolean botMatchEnabled, Supplier<CardDatabase.Stats> loader,
                  Function<BotMatchRequest, BotMatchRunner.Outcome> matchRunner) {
        this(pin, botMatchEnabled, loader, matchRunner, null);
    }

    /** Development games only: {@code humanGames} is null unless development endpoints are enabled. */
    Engine(XmagePin pin, boolean botMatchEnabled, Supplier<CardDatabase.Stats> loader,
           Function<BotMatchRequest, BotMatchRunner.Outcome> matchRunner, HumanGames humanGames) {
        this(pin, botMatchEnabled, loader, matchRunner, humanGames, humanGames != null, null);
    }

    /**
     * @param devGames     whether the development game endpoints serve {@code humanGames}
     * @param serviceToken the API's token for service games, or null or empty to turn them off
     */
    Engine(XmagePin pin, boolean botMatchEnabled, Supplier<CardDatabase.Stats> loader,
           Function<BotMatchRequest, BotMatchRunner.Outcome> matchRunner, HumanGames humanGames, boolean devGames,
           String serviceToken) {
        boolean service = serviceToken != null && !serviceToken.isEmpty();
        if (service && serviceToken.length() < MIN_SERVICE_TOKEN_LENGTH) {
            throw new IllegalArgumentException("CD_ENGINE_SERVICE_TOKEN must be at least "
                + MIN_SERVICE_TOKEN_LENGTH + " characters");
        }
        this.pin = pin;
        this.botMatchEnabled = botMatchEnabled;
        this.loader = loader;
        this.matchRunner = matchRunner;
        this.humanGames = humanGames;
        this.devGames = devGames && humanGames != null;
        this.serviceTokenHash = service && humanGames != null ? sha256(serviceToken) : null;
    }

    /** Loads the card database on a background thread; health stays available meanwhile. */
    public Thread startLoading() {
        return Thread.ofPlatform().name("card-database-loader").start(this::load);
    }

    private void load() {
        try {
            CardDatabase.Stats stats = loader.get();
            cards = stats;
            status = Status.READY;
            long uptime = ManagementFactory.getRuntimeMXBean().getUptime();
            System.out.printf("Engine ready: %d printings, %d distinct names; database %s in %d ms;"
                    + " JVM uptime %d ms%n", stats.printings(), stats.distinctNames(),
                stats.builtAtStartup() ? "built" : "opened", stats.loadMillis(), uptime);
        } catch (Throwable t) {
            status = Status.FAILED;
            System.err.println("Engine failed to load the card database");
            t.printStackTrace();
        }
    }

    public Status status() {
        return status;
    }

    public CardDatabase.Stats cards() {
        return cards;
    }

    public XmagePin pin() {
        return pin;
    }

    public boolean botMatchEnabled() {
        return botMatchEnabled;
    }

    HumanGames humanGames() {
        return humanGames;
    }

    boolean devGamesEnabled() {
        return devGames;
    }

    boolean serviceGamesEnabled() {
        return serviceTokenHash != null;
    }

    /** Whether {@code presented} is the service token, compared by hash in constant time. */
    boolean serviceAuthorized(String presented) {
        return serviceTokenHash != null && presented != null
            && MessageDigest.isEqual(serviceTokenHash, sha256(presented));
    }

    static byte[] sha256(String value) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Runs a bot match on the caller's thread, or returns empty when one is already running. */
    public Optional<BotMatchResult> tryBotMatch(BotMatchRequest request) {
        if (!matchSlot.tryAcquire()) {
            return Optional.empty();
        }
        Thread gameThread = null;
        try {
            BotMatchRunner.Outcome outcome = matchRunner.apply(request);
            gameThread = outcome.gameThread();
            return Optional.of(outcome.result());
        } finally {
            releaseWhenFinished(gameThread);
        }
    }

    private void releaseWhenFinished(Thread gameThread) {
        if (gameThread == null || !gameThread.isAlive()) {
            matchSlot.release();
            return;
        }
        Thread.ofVirtual().name("bot-match-slot-watcher").start(() -> {
            try {
                gameThread.join();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } finally {
                matchSlot.release();
            }
        });
    }
}
