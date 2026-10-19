package com.commanderduels;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.regex.Pattern;
import mage.constants.PhaseStep;
import mage.game.Game;
import mage.game.events.TableEvent;

/**
 * Structured copy of XMage's game log: the INFO table events a client would display, plus ERROR
 * events, which XMage raises when it recovers from (or gives up on) an internal game error. Entries
 * are recorded on the game thread. The digest covers every message, minus XMage's short object ids
 * ("Kalonian Tusker [b64]"), which come from random UUIDs, so repeated runs can be compared.
 */
public final class MatchLog {
    public record Entry(int turn, Integer activeSeat, String step, String text) {}

    static final int MAX_ENTRIES = 5_000;
    static final int TAIL = 12;
    private static final Pattern TAGS = Pattern.compile("<[^>]*>");
    private static final Pattern OBJECT_IDS = Pattern.compile(" \\[[0-9a-f]{3}]");

    private final List<Entry> entries = new ArrayList<>();
    private final MessageDigest digest;
    private int lines;
    private int engineErrors;
    private String criticalError;
    private volatile int lastTurn;

    MatchLog() {
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Subscribes to the game's table events; call before the game starts. */
    void attach(Game game, List<UUID> seatIds) {
        game.addTableEventListener(event -> {
            if (event.getEventType() == TableEvent.EventType.INFO) {
                record(game, seatIds, event.getMessage());
            } else if (event.getEventType() == TableEvent.EventType.ERROR) {
                recordError(game, seatIds, event);
            }
        });
    }

    private synchronized void recordError(Game game, List<UUID> seatIds, TableEvent event) {
        engineErrors++;
        String detail = event.getException() == null ? "" : " " + event.getException();
        String text = "ENGINE ERROR: " + plain(event.getMessage()) + detail;
        // GameImpl's outer handler: the game is about to end with a "technical winner".
        if (event.getMessage() != null && event.getMessage().startsWith("Game end on critical error")
                && criticalError == null) {
            criticalError = text;
        }
        record(game, seatIds, text);
    }

    private synchronized void record(Game game, List<UUID> seatIds, String message) {
        String text = plain(message);
        if (text.isEmpty()) {
            return;
        }
        int turn = game.getTurnNum();
        int seat = seatIds.indexOf(game.getActivePlayerId());
        PhaseStep step = game.getTurnStepType();
        lastTurn = turn;
        lines++;
        String comparable = OBJECT_IDS.matcher(text).replaceAll("");
        digest.update((turn + "|" + comparable + "\n").getBytes(StandardCharsets.UTF_8));
        if (entries.size() < MAX_ENTRIES) {
            entries.add(new Entry(turn, seat < 0 ? null : seat, step == null ? null : step.name(), text));
        }
    }

    int lastTurn() {
        return lastTurn;
    }

    synchronized int engineErrors() {
        return engineErrors;
    }

    /** Set when XMage ended the game after an unrecoverable error; its winner is not a game result. */
    synchronized String criticalError() {
        return criticalError;
    }

    synchronized BotMatchResult.LogSummary summary() {
        List<String> tail = entries.subList(Math.max(0, entries.size() - TAIL), entries.size()).stream()
            .map(entry -> "T" + entry.turn() + " " + entry.text())
            .toList();
        String sha256 = HexFormat.of().formatHex(cloneDigest().digest());
        return new BotMatchResult.LogSummary(lines, sha256, tail);
    }

    synchronized List<Entry> entries() {
        return List.copyOf(entries);
    }

    private MessageDigest cloneDigest() {
        try {
            return (MessageDigest) digest.clone();
        } catch (CloneNotSupportedException e) {
            throw new IllegalStateException(e);
        }
    }

    static String plain(String message) {
        if (message == null) {
            return "";
        }
        return TAGS.matcher(message).replaceAll("")
            .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
            .replace("&nbsp;", " ").replace("&amp;", "&")
            .replaceAll("\\s+", " ")
            .trim();
    }
}
