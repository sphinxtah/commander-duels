package com.commanderduels;

import java.lang.management.ManagementFactory;
import java.util.Optional;
import java.util.concurrent.Semaphore;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * Engine lifecycle (loading, ready, failed) and the single-slot gate for development bot matches.
 * Gameplay for players is not available in any state.
 */
public final class Engine {
    public enum Status { LOADING, READY, FAILED }

    private final XmagePin pin;
    private final boolean botMatchEnabled;
    private final Supplier<CardDatabase.Stats> loader;
    private final Function<BotMatchRequest, BotMatchRunner.Outcome> matchRunner;
    // Held from the start of a match until its game thread has exited, so a game that ignores the
    // stop request keeps further matches out instead of piling up.
    private final Semaphore matchSlot = new Semaphore(1);
    private volatile Status status = Status.LOADING;
    private volatile CardDatabase.Stats cards;

    public Engine(XmagePin pin, boolean botMatchEnabled, Supplier<CardDatabase.Stats> loader,
                  Function<BotMatchRequest, BotMatchRunner.Outcome> matchRunner) {
        this.pin = pin;
        this.botMatchEnabled = botMatchEnabled;
        this.loader = loader;
        this.matchRunner = matchRunner;
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
