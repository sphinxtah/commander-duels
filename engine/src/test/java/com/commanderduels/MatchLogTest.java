package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.Test;

class MatchLogTest {
    @Test
    void clientMarkupIsReducedToPlainText() {
        assertEquals("Bot A casts Lightning Bolt [3fa] targeting Bot B",
            MatchLog.plain("<font color='#20B2AA'>Bot A</font> casts <b>Lightning Bolt</b> [3fa]"
                + "\n targeting&nbsp;Bot B"));
        assertEquals("1 < 2 & \"x\"", MatchLog.plain("1 &lt; 2 &amp; &quot;x&quot;"));
        assertEquals("", MatchLog.plain(null));
    }

    /** XMage's error handlers put the exception in the ordinary log; seats read a plain notice. */
    @Test
    void xmageErrorLinesBecomeSeatSafe() {
        assertEquals(MatchLog.ROLLED_BACK, MatchLog.seatSafe("Auto-restored to T5.M1 due game error:"
            + " java.lang.IllegalStateException: Can't add unknown player to turn controllers:"
            + " 3f2c9a4e-1b7d-4c55-9e0a-5d1f2b3c4d5e Leatherback Baloth"));
        assertEquals(MatchLog.STOPPED, MatchLog.seatSafe("Game stopped due critical error, technical winner:"
            + " Bot 2 (decided by life). Reason: mage.MageException: Too many errors, game will be end."
            + " Last error: java.lang.NullPointerException"));
        assertEquals("Bot 2 casts Leatherback Baloth", MatchLog.seatSafe("Bot 2 casts Leatherback Baloth"));
        assertEquals("Auto-restored to T5.M1", MatchLog.seatSafe("Auto-restored to T5.M1"));
        assertNull(MatchLog.seatSafe(null));
    }
}
