package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

/**
 * What a recording costs (v0.9.9): each format's game played with its recording, and the numbers the
 * recorder kept, printed for {@code docs/engine/recovery.md}. Run on demand:
 * {@code mvn test -Dtest=RecordingCostTest -Dcd.test.costs=true}.
 */
class RecordingCostTest {
    @BeforeAll
    static void loadCards() {
        CardDatabase.load();
        Tables.actAsClient();
    }

    private static void measure(String what, String body, long seed, int answers) throws Exception {
        Path root = Files.createTempDirectory("recordings");
        try {
            var player = new ScriptedPlayer(seed);
            Tables.Policy policy = (seat, prompt, view) -> player.choose(prompt, view);
            long started = System.nanoTime();
            HumanGame game = Recordings.start(root, body, HumanGame.Hooks.NONE);
            int answered = 0;
            while (answered < answers && Recordings.answer(game, policy)) {
                answered++;
            }
            int seat = Recordings.awaitPrompt(game);
            long played = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
            Recorder.Metrics metrics = game.recorder().metrics();
            assertNull(game.recorder().failure());
            long bytesOnDisk = 0;
            if (seat != -2) {
                assertTrue(game.recorder().awaitDurable());
                bytesOnDisk = Recording.of(root, game.id()).bytes();
                game.interrupt();
                long restoring = System.nanoTime();
                Recovery.Restored restored = Recordings.restore(root, game.id(), HumanGame.Hooks.NONE);
                Recordings.awaitPrompt(restored.game());
                long restoreMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - restoring);
                System.out.println("RECORDING COST " + what + ": taken up again and asking its seat in "
                    + restoreMillis + " ms");
                restored.game().close("closed");
                Tables.finalSnapshot(restored.game(), restored.game().humanSeats().get(0));
            }
            long captures = Math.max(1, metrics.captures.get());
            long checkpoints = Math.max(1, metrics.checkpoints.get());
            long records = Math.max(1, metrics.records.get());
            System.out.println("RECORDING COST " + what + ": " + answered + " answers in " + played + " ms; states taken "
                + metrics.captures.get() + ", " + metrics.captureMicros.get() / captures + " us each (longest "
                + metrics.longestCaptureMicros.get() + " us), " + metrics.captureMicros.get() / 1000 + " ms of the game's"
                + " thread in all (" + String.format("%.1f", metrics.captureMicros.get() / 10.0 / Math.max(1, played))
                + "% of the time played); checkpoints written " + metrics.checkpoints.get() + ", "
                + metrics.checkpointBytes.get() / checkpoints / 1024 + " KiB and "
                + metrics.checkpointMillis.get() / checkpoints + " ms each (longest "
                + metrics.longestCheckpointMillis.get() + " ms), skipped " + metrics.skipped.get() + "; journal records "
                + metrics.records.get() + ", " + String.format("%.2f", metrics.journalMillis.get() / (double) records)
                + " ms each (longest " + metrics.longestJournalMillis.get() + " ms); answers that waited for a"
                + " checkpoint " + metrics.waits.get() + " (" + metrics.waitMillis.get() + " ms in all); on disk "
                + bytesOnDisk / 1024 + " KiB");
        } finally {
            Recordings.deleteAll(root);
        }
    }

    @Test
    @EnabledIfSystemProperty(named = "cd.test.costs", matches = "true")
    void eachFormatsRecordingIsMeasured() throws Exception {
        measure("Legacy duel, two people", Recordings.body(71L, "legacy", 1, 30, "human:" + LegacyDuel.DECKS.get(0),
            "human:" + LegacyDuel.DECKS.get(1)), 71, 150);
        measure("Commander, one person and three bots (skill 4)", Recordings.body(72L, "commander", 4, 24,
            "human:commander-mono-red-raiders", "bot:commander-mono-white-soldiers", "bot:commander-mono-blue-flyers",
            "bot:commander-mono-green-stompers"), 72, 150);
        measure("Two-Headed Giant, two people and two bots (skill 4)", Recordings.body(73L, "two_headed_giant", 4, 30,
            "human:legacy-mono-red-burn", "human:legacy-mono-green-creatures", "bot:legacy-mono-white-weenie",
            "bot:legacy-mono-blue-skies"), 73, 150);
        measure("King's Table, one person and five bots (skill 4)", Recordings.body(74L, "kings_table", 4, 30,
            "human:commander-mono-white-soldiers", "bot:commander-mono-blue-flyers", "bot:commander-mono-red-raiders",
            "bot:commander-mono-green-stompers", "bot:commander-mono-white-soldiers", "bot:commander-mono-blue-flyers"),
            74, 150);
    }
}
