package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The tool that looks at recordings (v0.9.9): it says whether each is whole and whether this engine
 * could take its game up, and shows nothing of the game unless it is asked to.
 */
class RecordingToolTest {
    private Path root;

    @BeforeAll
    static void loadCards() {
        CardDatabase.load();
        Tables.actAsClient();
    }

    @BeforeEach
    void folder() throws Exception {
        root = Files.createTempDirectory("recordings");
    }

    @AfterEach
    void clean() throws Exception {
        Recordings.deleteAll(root);
    }

    private record Ran(int exit, String output) {}

    private static Ran run(String... args) {
        var bytes = new ByteArrayOutputStream();
        int exit = RecordingTool.run(args, new PrintStream(bytes, true, StandardCharsets.UTF_8));
        return new Ran(exit, bytes.toString(StandardCharsets.UTF_8));
    }

    private HumanGame play(long seed, int answers) throws Exception {
        String body = Recordings.body(seed, "commander", 1, 20, "human:commander-mono-red-raiders",
            "bot:commander-mono-white-soldiers", "human:commander-mono-blue-flyers", "bot:commander-mono-green-stompers");
        var player = new ScriptedPlayer(seed);
        HumanGame game = Recordings.start(root, body, HumanGame.Hooks.NONE);
        for (int answered = 0; answered < answers; answered++) {
            assertTrue(Recordings.answer(game, (seat, prompt, view) -> player.choose(prompt, view)));
        }
        Recordings.awaitPrompt(game);
        assertTrue(game.recorder().awaitDurable());
        return game;
    }

    @Test
    void itReportsOnARecordingWithoutShowingTheGame() throws Exception {
        HumanGame game = play(61L, 30);
        game.interrupt();
        Set<String> cards = new HashSet<>();
        for (String deck : List.of("commander-mono-red-raiders", "commander-mono-white-soldiers",
            "commander-mono-blue-flyers", "commander-mono-green-stompers")) {
            cards.addAll(SeatChecks.deckNames(deck));
        }
        assertTrue(cards.size() > 100, "the decks' cards: " + cards.size());

        Ran whole = run(root.toString(), game.id(), "--verify");
        assertEquals(0, whole.exit(), whole.output());
        assertTrue(whole.output().contains("The recording is whole (resumable)"), whole.output());
        assertTrue(whole.output().contains("this engine's build"), whole.output());
        assertTrue(whole.output().contains("state read back and is the game that was saved"), whole.output());
        assertTrue(whole.output().contains("seat 0: human, deck commander-mono-red-raiders"), whole.output());
        assertTrue(whole.output().contains("answers by seat: {0="), whole.output());
        // Nothing of the game: no card of any deck is named, and no answer is shown.
        for (String card : cards) {
            assertFalse(whole.output().contains(card), "the report names the card " + card + ":\n" + whole.output());
        }
        assertFalse(whole.output().contains("\"code\""), whole.output());

        // The journal in full only when asked for, and said to be private.
        Ran shown = run(root.toString(), game.id(), "--show-private");
        assertEquals(0, shown.exit(), shown.output());
        assertTrue(shown.output().contains("\"type\":\"answer\""), shown.output());
        assertTrue(shown.output().contains("private to the players"), shown.output());

        // A recording's own folder is taken as well as the folder of all.
        assertEquals(0, run(root.resolve(game.id()).toString()).exit());

        // Damage is found and said, and the tool exits with 1.
        Recording recording = Recording.of(root, game.id());
        List<Integer> seqs = recording.checkpointSeqs();
        Path newest = recording.folder().resolve(String.format("checkpoint-%010d.bin", seqs.get(seqs.size() - 1)));
        byte[] bytes = Files.readAllBytes(newest);
        bytes[bytes.length - 100] ^= 0x5a;
        Files.write(newest, bytes);
        Ran damaged = run(root.toString(), game.id());
        assertEquals(1, damaged.exit(), damaged.output());
        assertTrue(damaged.output().contains("fails its checksum"), damaged.output());
        assertTrue(damaged.output().contains("PROBLEMS (resumable)"), "the checkpoint before it still gives the game back:\n"
            + damaged.output());
    }

    @Test
    void itListsAFolderOfRecordings() throws Exception {
        HumanGame left = play(62L, 12);
        left.interrupt();
        HumanGame over = play(63L, 12);
        over.close("closed");
        Tables.finalSnapshot(over, 0);

        Ran listed = run(root.toString());
        assertEquals(0, listed.exit(), listed.output());
        assertTrue(listed.output().contains("2 recordings in "), listed.output());
        assertTrue(listed.output().lines().anyMatch(line -> line.startsWith(left.id()) && line.contains("resumable")
            && line.contains("commander")), listed.output());
        assertTrue(listed.output().lines().anyMatch(line -> line.startsWith(over.id()) && line.contains("finished")
            && line.contains("0 checkpoints")), listed.output());
        assertTrue(listed.output().contains("every recording is whole"), listed.output());

        // Called wrongly.
        assertEquals(2, run().exit());
        assertEquals(2, run(root.toString(), "not-a-game-id").exit());
        assertEquals(2, run(root.toString(), "--no-such-option").exit());
        assertEquals(2, run(root.resolve("nowhere").toString()).exit());
    }
}
