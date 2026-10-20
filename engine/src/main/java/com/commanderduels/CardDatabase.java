package com.commanderduels;

import java.util.ArrayList;
import java.util.List;
import mage.cards.repository.CardRepository;
import mage.cards.repository.CardScanner;
import mage.cards.repository.TokenRepository;
import mage.util.Copier;

/**
 * Opens XMage's card database (./db/cards.h2). The image ships one built from the pinned commit,
 * so startup normally only opens it. A missing database, or one XMage judges stale for these
 * jars, is rebuilt by the classpath scan, which takes about 20 seconds.
 */
public final class CardDatabase {
    public record Stats(long printings, long distinctNames, long loadMillis, boolean builtAtStartup) {}

    private CardDatabase() {}

    public static Stats load() {
        long started = System.nanoTime();
        // Game copies deserialize with this loader; everything is on the application classpath.
        Copier.setLoader(CardDatabase.class.getClassLoader());
        boolean built = false;
        if (counts()[0] == 0) {
            List<String> errors = new ArrayList<>();
            CardScanner.scan(errors);
            if (!errors.isEmpty()) {
                throw new IllegalStateException("Card scan reported " + errors.size() + " errors, first: "
                    + errors.get(0));
            }
            built = true;
        } else {
            // The shipped database is complete: skip XMage's per-card existence check.
            CardScanner.scanned = true;
        }
        long[] counts = counts();
        if (counts[0] == 0) {
            throw new IllegalStateException("Card database is empty after loading");
        }
        // XMage fills its token list lazily, without a lock, when a game first needs it (every game
        // creates its helper emblems at the start). Games starting together on a fresh engine raced
        // there and failed with a ConcurrentModificationException; fill it once, before any game.
        TokenRepository.instance.init();
        return new Stats(counts[0], counts[1], (System.nanoTime() - started) / 1_000_000, built);
    }

    private static long[] counts() {
        List<List<String>> rows = CardRepository.instance.querySQL(
            "SELECT COUNT(*), COUNT(DISTINCT name) FROM card");
        if (rows == null || rows.isEmpty() || rows.get(0).size() < 2) {
            throw new IllegalStateException("Card database count query failed");
        }
        return new long[]{Long.parseLong(rows.get(0).get(0)), Long.parseLong(rows.get(0).get(1))};
    }
}
