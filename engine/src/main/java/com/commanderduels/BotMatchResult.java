package com.commanderduels;

import java.util.List;

/**
 * Outcome of one development-only bot match. {@code result} is exactly one of completed (a winner
 * or a draw), turn_limit, timeout or error. A game XMage ended with a "technical winner" after an
 * internal error is an error, not a completion. {@code engineErrors} counts XMage's recovered and
 * fatal game errors.
 */
public record BotMatchResult(
    String result,
    Integer winnerSeat,
    boolean draw,
    int turns,
    long durationMs,
    long seed,
    Settings settings,
    String xmageCommit,
    Integer startingSeat,
    List<Seat> seats,
    String error,
    int engineErrors,
    String cleanup,
    LogSummary logSummary,
    List<MatchLog.Entry> log,
    Diagnostics diagnostics) {

    public record Settings(int skill, int turnCap, int timeBudgetSeconds) {}

    /** {@code life} is null when the game thread was still running and the state could not be read. */
    public record Seat(int seat, String name, String deck, Integer life, Boolean won) {}

    public record LogSummary(int lines, String sha256, List<String> tail) {}

    /** JVM state measured after the game thread ended, following an explicit GC request. */
    public record Diagnostics(long heapUsedMb, long heapCommittedMb, long heapMaxMb, int liveThreads,
                              int gameThreads) {}
}
