package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;

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
}
