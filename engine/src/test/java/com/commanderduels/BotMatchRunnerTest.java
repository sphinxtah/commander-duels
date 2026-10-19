package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import mage.game.GameException;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Real XMage games with the fixture decks. Needs ./db (the card database) and ./decks. */
class BotMatchRunnerTest {
    private static final XmagePin PIN = XmagePin.load();
    private static final Path DECKS = Path.of("decks");
    private static BotMatchRunner runner;

    @BeforeAll
    static void loadCards() {
        CardDatabase.Stats stats = CardDatabase.load();
        assertTrue(stats.printings() > 50_000, "card database looks incomplete: " + stats);
        runner = new BotMatchRunner(DECKS, PIN);
    }

    @Test
    void fixtureDecksAreLegacyLegal() throws Exception {
        for (String deck : BotMatchRunner.DECKS) {
            assertEquals(60, runner.loadLegacyDeck(deck).getMaindeckCards().size(), deck);
        }
    }

    @Test
    void legacyValidatorRejectsAnIllegalDeck(@TempDir Path dir) throws Exception {
        // Five copies of one card and a banned card: the validator must be XMage's real Legacy rules.
        Files.writeString(dir.resolve("illegal.txt"), "51 Mountain\n5 Lightning Bolt\n4 Mental Misstep\n");
        var exception = assertThrows(GameException.class,
            () -> new BotMatchRunner(dir, PIN).loadLegacyDeck("illegal"));
        assertTrue(exception.getMessage().contains("not Legacy-legal"), exception.getMessage());
    }

    @Test
    void seededGameFinishesWithinItsBudget() {
        var request = new BotMatchRequest(20261018L, 60, 300, 1, true);
        BotMatchResult result = runner.run(request).result();
        assertEquals("completed", result.result(), () -> "unexpected " + result.result() + ": " + result.error()
            + " " + result.logSummary().tail());
        assertTrue(result.draw() || result.winnerSeat() != null);
        assertTrue(result.turns() >= 1 && result.turns() <= 60);
        assertTrue(result.durationMs() < 300_000);
        assertEquals(0, result.engineErrors(), () -> "XMage reported game errors: " + result.logSummary().tail());
        assertEquals("complete", result.cleanup());
        assertEquals(PIN.commit(), result.xmageCommit());
        assertTrue(result.logSummary().lines() > 0);
        assertEquals(result.logSummary().lines(), result.log().size());
        assertEquals(0, BotMatchRunner.gameThreadCount());
    }

    @Test
    void turnCapStopsTheGame() {
        BotMatchResult result = runner.run(new BotMatchRequest(7L, 2, 120, 1, false)).result();
        assertEquals("turn_limit", result.result(), () -> result.error() + " " + result.logSummary().tail());
        assertEquals(2, result.turns());
        assertNull(result.winnerSeat());
        assertFalse(result.draw());
        assertNull(result.log());
        assertEquals("complete", result.cleanup());
        assertEquals(0, BotMatchRunner.gameThreadCount());
    }

    @Test
    void timeoutStopsTheGameAndFreesItsThread() {
        // Real games finish in about a second, so slow this one down: every log line costs 20 ms
        // (interruptible, flag restored as XMage expects). Any full game then far exceeds 1 second.
        var slow = new BotMatchRunner(DECKS, PIN, game -> game.addTableEventListener(event -> {
            try {
                Thread.sleep(20);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }));
        BotMatchRunner.Outcome outcome = slow.run(new BotMatchRequest(11L, 200, 1, 6, false));
        BotMatchResult result = outcome.result();
        assertEquals("timeout", result.result());
        assertNull(result.winnerSeat());
        assertTrue(result.durationMs() < 1_000 + 500, "budget enforced, took " + result.durationMs());
        assertEquals("complete", result.cleanup(), "game thread must exit after the stop request");
        assertFalse(outcome.gameThread().isAlive());
        assertEquals(0, BotMatchRunner.gameThreadCount());
        assertNotNull(result.diagnostics());
    }
}
