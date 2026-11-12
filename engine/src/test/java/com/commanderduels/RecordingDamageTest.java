package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * What recovery does with a recording that is not what it should be (v0.9.9), and with what a seat
 * sends a second time. Nothing a recording holds is trusted: a damaged file is told from a whole
 * one, said so in words, and passed over for what is whole; a recording that cannot give back the
 * game that was played gives back none. And nothing is done twice: a command that comes again is
 * answered as it was, a concession stays one concession, a result stays the result.
 */
class RecordingDamageTest {
    private Path root;
    private final List<HumanGame> started = new ArrayList<>();

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
        for (HumanGame game : started) {
            if (!game.finished()) {
                game.interrupt();
            }
        }
        Recordings.deleteAll(root);
    }

    private static String duel(long seed) {
        return Recordings.body(seed, "legacy", 1, 30, "human:" + LegacyDuel.DECKS.get(0),
            "human:" + LegacyDuel.DECKS.get(1));
    }

    private static String commanderWithBots(long seed) {
        return Recordings.body(seed, "commander", 1, 20, "human:commander-mono-red-raiders",
            "bot:commander-mono-white-soldiers", "bot:commander-mono-blue-flyers", "bot:commander-mono-green-stompers");
    }

    /** A game played for a number of answers and left as a dead process leaves it, with what it showed last. */
    private record Left(String id, Recordings.Shown shown, int seat) {}

    private Left playAndLeave(String body, int answers, long policySeed) throws Exception {
        var player = new ScriptedPlayer(policySeed);
        Tables.Policy policy = (seat, prompt, view) -> player.choose(prompt, view);
        HumanGame game = Recordings.start(root, body, HumanGame.Hooks.NONE);
        started.add(game);
        for (int answered = 0; answered < answers; answered++) {
            assertTrue(Recordings.answer(game, policy), "the game ended after " + answered + " answers");
        }
        int seat = Recordings.awaitPrompt(game);
        Recordings.Shown shown = Recordings.shown(game);
        assertTrue(game.recorder().awaitDurable());
        game.interrupt();
        return new Left(game.id(), shown, seat);
    }

    /** A copy of a game's recording under another root, to damage and take up without touching the first. */
    private Path copyOf(String id) throws IOException {
        Path copy = Files.createTempDirectory(root, "copy");
        Path target = Files.createDirectory(copy.resolve(id));
        try (Stream<Path> files = Files.list(root.resolve(id))) {
            for (Path file : files.toList()) {
                Files.copy(file, target.resolve(file.getFileName()));
            }
        }
        return copy;
    }

    private Recovery.Restored takeUp(Path from, String id) throws Recording.Unusable {
        Recovery.Restored restored = Recordings.restore(from, id, HumanGame.Hooks.NONE);
        started.add(restored.game());
        return restored;
    }

    private static Path newest(Path from, String id) throws IOException {
        Recording recording = Recording.of(from, id);
        List<Integer> seqs = recording.checkpointSeqs();
        return recording.folder().resolve(String.format("checkpoint-%010d.bin", seqs.get(seqs.size() - 1)));
    }

    private static void flip(Path file, long at) throws IOException {
        byte[] bytes = Files.readAllBytes(file);
        bytes[(int) at] ^= 0x5a;
        Files.write(file, bytes);
    }

    // ------------------------------------------------------------------ damaged checkpoints

    @Test
    void aCheckpointThatFailsItsChecksumIsPassedOverForTheOneBefore() throws Exception {
        Left left = playAndLeave(duel(31L), 30, 31);
        Path copy = copyOf(left.id());
        Path file = newest(copy, left.id());
        flip(file, Files.size(file) - 200);

        Recovery.Restored restored = takeUp(copy, left.id());
        assertEquals(1, restored.report().problems().size(), restored.report().problems().toString());
        assertTrue(restored.report().problems().get(0).contains("fails its checksum"),
            restored.report().problems().toString());
        List<Integer> seqs = Recording.of(copy, left.id()).checkpointSeqs();
        assertEquals(seqs.get(seqs.size() - 2), restored.report().checkpoint(), "the checkpoint before the newest");
        // Between people the journal brings the game back to where it was.
        assertEquals(left.seat(), Recordings.awaitPrompt(restored.game()));
        assertEquals(0, restored.game().replayDropped());
        Recordings.assertSameButForNewObjects(left.shown(), Recordings.shown(restored.game()), "after the damage");
    }

    @Test
    void aCheckpointCutShortIsPassedOver() throws Exception {
        Left left = playAndLeave(duel(32L), 24, 32);
        Path copy = copyOf(left.id());
        Path file = newest(copy, left.id());
        byte[] bytes = Files.readAllBytes(file);
        Files.write(file, java.util.Arrays.copyOf(bytes, bytes.length / 2));

        Recovery.Restored restored = takeUp(copy, left.id());
        assertTrue(restored.report().problems().get(0).contains("cut short"), restored.report().problems().toString());
        assertEquals(left.seat(), Recordings.awaitPrompt(restored.game()));
        Recordings.assertSameButForNewObjects(left.shown(), Recordings.shown(restored.game()), "after the damage");
    }

    @Test
    void aFileThatIsNotACheckpointIsPassedOver() throws Exception {
        Left left = playAndLeave(duel(33L), 24, 33);
        Path copy = copyOf(left.id());
        Files.writeString(newest(copy, left.id()), "not a checkpoint at all");

        Recovery.Restored restored = takeUp(copy, left.id());
        assertTrue(restored.report().problems().get(0).contains("is not a checkpoint"),
            restored.report().problems().toString());
        assertEquals(left.seat(), Recordings.awaitPrompt(restored.game()));
    }

    /**
     * A checkpoint whose bytes are whole and whose state is not the one that was saved: its
     * checksum holds, and the game it gives back does not have the digest taken with it.
     */
    @Test
    void aCheckpointOfAnotherStateIsPassedOver() throws Exception {
        Left left = playAndLeave(duel(34L), 30, 34);
        Path copy = copyOf(left.id());
        Recording recording = Recording.of(copy, left.id());
        List<Integer> seqs = recording.checkpointSeqs();
        // The newest checkpoint's file under the name and header of... itself, with the digest of
        // the one before it: as a write that mixed two states up would leave it.
        Recording.Loaded newest = recording.checkpoint(seqs.get(seqs.size() - 1));
        Recording.Loaded before = recording.checkpoint(seqs.get(seqs.size() - 2));
        assertFalse(newest.header().stateDigest().equals(before.header().stateDigest()),
            "the two checkpoints are of different states");
        Recording.Packed packed = Recording.pack(newest.checkpoint());
        Recording.CheckpointHeader header = newest.header();
        recording.writeCheckpoint(new Recording.CheckpointHeader(header.seq(), header.journalSeq(), header.turn(),
            header.step(), header.takenAt(), packed.body().length, packed.rawBytes(), packed.crc32(),
            before.header().stateDigest(), header.engineBuild()), packed);

        Recovery.Restored restored = takeUp(copy, left.id());
        assertTrue(restored.report().problems().get(0).contains("does not hold the game that was saved"),
            restored.report().problems().toString());
        assertEquals(before.header().seq(), restored.report().checkpoint());
    }

    @Test
    void aCheckpointOfAnotherEngineBuildIsPassedOver() throws Exception {
        Left left = playAndLeave(duel(35L), 24, 35);
        Path copy = copyOf(left.id());
        Recording recording = Recording.of(copy, left.id());
        List<Integer> seqs = recording.checkpointSeqs();
        Recording.Loaded newest = recording.checkpoint(seqs.get(seqs.size() - 1));
        Recording.Packed packed = Recording.pack(newest.checkpoint());
        Recording.CheckpointHeader header = newest.header();
        recording.writeCheckpoint(new Recording.CheckpointHeader(header.seq(), header.journalSeq(), header.turn(),
            header.step(), header.takenAt(), packed.body().length, packed.rawBytes(), packed.crc32(),
            header.stateDigest(), "0123456789abcdef0123456789abcdef"), packed);

        Recovery.Restored restored = takeUp(copy, left.id());
        assertTrue(restored.report().problems().get(0).contains("another engine build"),
            restored.report().problems().toString());
        assertEquals(seqs.get(seqs.size() - 2), restored.report().checkpoint());
    }

    /**
     * A game that had checkpoints and has none left that can be used is refused, whoever sits at the
     * table: dealt again from its seed it would be another game (new cards the journal's answers do
     * not name, bots that decide by the clock), at its first turn.
     */
    @Test
    void aGameWithNoCheckpointLeftIsRefused() throws Exception {
        Left people = playAndLeave(duel(36L), 40, 36);
        Path damaged = copyOf(people.id());
        Recording recording = Recording.of(damaged, people.id());
        for (int seq : recording.checkpointSeqs()) {
            Files.writeString(recording.folder().resolve(String.format("checkpoint-%010d.bin", seq)), "gone");
        }
        Recording.Unusable refused = assertThrows(Recording.Unusable.class,
            () -> Recovery.restore(recording, SeatChecks.DECKS, finished -> {}, HumanGame.Hooks.NONE));
        assertEquals("unreadable", refused.code);
        assertTrue(refused.getMessage().contains("is not a checkpoint"), refused.getMessage());
        assertTrue(refused.getMessage().contains("not played again from its beginning"), refused.getMessage());

        // The checkpoints' files gone altogether: the journal says that the game had some.
        Path gone = copyOf(people.id());
        Recording without = Recording.of(gone, people.id());
        for (int seq : without.checkpointSeqs()) {
            Files.delete(without.folder().resolve(String.format("checkpoint-%010d.bin", seq)));
        }
        refused = assertThrows(Recording.Unusable.class,
            () -> Recovery.restore(without, SeatChecks.DECKS, finished -> {}, HumanGame.Hooks.NONE));
        assertEquals("unreadable", refused.code);

        // And with bots at the table.
        Left bots = playAndLeave(commanderWithBots(38L), 20, 38);
        Path botsGone = copyOf(bots.id());
        Recording botsWithout = Recording.of(botsGone, bots.id());
        for (int seq : botsWithout.checkpointSeqs()) {
            Files.delete(botsWithout.folder().resolve(String.format("checkpoint-%010d.bin", seq)));
        }
        refused = assertThrows(Recording.Unusable.class,
            () -> Recovery.restore(botsWithout, SeatChecks.DECKS, finished -> {}, HumanGame.Hooks.NONE));
        assertEquals("unreadable", refused.code);
    }

    // ------------------------------------------------------------------ a damaged journal

    /** A write cut off by the interruption itself: half a record at the journal's end. */
    @Test
    void aJournalWithAHalfWrittenLastRecordEndsBeforeIt() throws Exception {
        Left left = playAndLeave(duel(39L), 24, 39);
        Path copy = copyOf(left.id());
        Recording recording = Recording.of(copy, left.id());
        long whole = recording.readJournal().records().size();
        Files.write(recording.folder().resolve(Recording.JOURNAL), new byte[]{0, 0, 1, 77, 9, 9, 9, 9, '{', '"'},
            StandardOpenOption.APPEND);

        Recovery.Restored restored = takeUp(copy, left.id());
        assertEquals(1, restored.report().problems().size(), restored.report().problems().toString());
        assertTrue(restored.report().problems().get(0).contains("a record is cut short"),
            restored.report().problems().toString());
        assertEquals(left.seat(), Recordings.awaitPrompt(restored.game()));
        Recordings.assertSameButForNewObjects(left.shown(), Recordings.shown(restored.game()), "after the damage");
        // The half record is gone before anything is added: the journal reads whole again.
        Recording.Journal journal = recording.readJournal();
        assertNull(journal.problem());
        assertTrue(journal.records().size() > whole, "the recovery's own note follows the whole records");
    }

    /**
     * The journal's last answers are lost (its end is damaged) and the newest checkpoint already
     * holds them: that checkpoint is ahead of the journal and is not used, since a seat that sent
     * one of those commands again could not be told from one sending a new one. The game goes back
     * to the checkpoint before, and asks again what the lost answers answered.
     */
    @Test
    void aCheckpointAheadOfADamagedJournalIsNotUsed() throws Exception {
        // Played until the two checkpoints kept stand on different journal records. (They nearly
        // always do: one is written as a seat is asked. Two states between two answers are both
        // written only when the bots' interval has passed, on a machine that slow.)
        var player = new ScriptedPlayer(40);
        Tables.Policy policy = (seat, prompt, view) -> player.choose(prompt, view);
        HumanGame game = Recordings.start(root, duel(40L), HumanGame.Hooks.NONE);
        started.add(game);
        long ahead = 0;
        long behind = 0;
        for (int answered = 0; answered < 60 && (answered < 30 || ahead <= behind); answered++) {
            assertTrue(Recordings.answer(game, policy), "the game ended after " + answered + " answers");
            Recordings.awaitPrompt(game);
            assertTrue(game.recorder().awaitDurable());
            List<Integer> written = game.recorder().recording().checkpointSeqs();
            if (written.size() >= 2) {
                ahead = game.recorder().recording().checkpointHeader(written.get(written.size() - 1)).journalSeq();
                behind = game.recorder().recording().checkpointHeader(written.get(written.size() - 2)).journalSeq();
            }
        }
        assertTrue(ahead > behind, "the two checkpoints stand on different journal records");
        game.interrupt();
        Left left = new Left(game.id(), null, -1);
        Path copy = copyOf(left.id());
        Recording recording = Recording.of(copy, left.id());
        List<Integer> seqs = recording.checkpointSeqs();
        assertEquals(ahead, recording.checkpointHeader(seqs.get(seqs.size() - 1)).journalSeq());
        // Damage the journal inside the record the newest checkpoint stands on.
        byte[] bytes = Files.readAllBytes(recording.folder().resolve(Recording.JOURNAL));
        int offset = 0;
        for (long seq = 1; seq < ahead; seq++) {
            offset += 8 + java.nio.ByteBuffer.wrap(bytes, offset, 4).getInt();
        }
        flip(recording.folder().resolve(Recording.JOURNAL), offset + 12);

        Recovery.Restored restored = takeUp(copy, left.id());
        assertTrue(restored.report().problems().stream().anyMatch(problem -> problem.contains("fails its checksum")),
            restored.report().problems().toString());
        assertTrue(restored.report().problems().stream().anyMatch(problem -> problem.contains("ahead of the journal")),
            restored.report().problems().toString());
        assertEquals(seqs.get(seqs.size() - 2), restored.report().checkpoint());
        // A legal game, at a question: the one the lost answer had answered, or one before it.
        int seat = Recordings.awaitPrompt(restored.game());
        assertTrue(seat >= 0);
        assertNotNull(restored.game().snapshot(seat, -1, 0, 0).prompt());
    }

    // ------------------------------------------------------------------ a recording that is no recording

    @Test
    void aRecordingThatIsMissingDamagedOrAnotherBuildsIsRefusedInWords() throws Exception {
        Left left = playAndLeave(duel(41L), 12, 41);

        // No recording at all.
        Recording.Unusable missing = assertThrows(Recording.Unusable.class, () -> Recovery.restore(
            Recording.of(root, UUID.randomUUID().toString()), SeatChecks.DECKS, finished -> {}, HumanGame.Hooks.NONE));
        assertEquals("missing", missing.code);

        // A manifest that does not parse.
        Path damaged = copyOf(left.id());
        Files.writeString(damaged.resolve(left.id()).resolve(Recording.MANIFEST), "{\"format\": 1, \"game_id\": ");
        Recording.Unusable unreadable = assertThrows(Recording.Unusable.class, () -> Recovery.restore(
            Recording.of(damaged, left.id()), SeatChecks.DECKS, finished -> {}, HumanGame.Hooks.NONE));
        assertEquals("unreadable", unreadable.code);

        // Another layout.
        Path layout = copyOf(left.id());
        Path manifest = layout.resolve(left.id()).resolve(Recording.MANIFEST);
        JsonObject json = com.google.gson.JsonParser.parseString(Files.readString(manifest)).getAsJsonObject();
        json.addProperty("format", Recording.FORMAT + 1);
        Files.writeString(manifest, json.toString());
        Recording.Unusable otherLayout = assertThrows(Recording.Unusable.class, () -> Recovery.restore(
            Recording.of(layout, left.id()), SeatChecks.DECKS, finished -> {}, HumanGame.Hooks.NONE));
        assertEquals("incompatible", otherLayout.code);

        // Another engine build: its cards and rules may differ, and its saved objects are not this build's.
        Path build = copyOf(left.id());
        manifest = build.resolve(left.id()).resolve(Recording.MANIFEST);
        json = com.google.gson.JsonParser.parseString(Files.readString(manifest)).getAsJsonObject();
        json.getAsJsonObject("binding").addProperty("engine_build", "0123456789abcdef0123456789abcdef");
        Files.writeString(manifest, json.toString());
        Recording.Unusable otherBuild = assertThrows(Recording.Unusable.class, () -> Recovery.restore(
            Recording.of(build, left.id()), SeatChecks.DECKS, finished -> {}, HumanGame.Hooks.NONE));
        assertEquals("incompatible", otherBuild.code);
        assertTrue(otherBuild.getMessage().contains("0123456789abcdef0123456789abcdef"), otherBuild.getMessage());

        // A request that is no longer one.
        Path request = copyOf(left.id());
        manifest = request.resolve(left.id()).resolve(Recording.MANIFEST);
        json = com.google.gson.JsonParser.parseString(Files.readString(manifest)).getAsJsonObject();
        json.addProperty("request", "{\"format\":\"no such format\"}");
        Files.writeString(manifest, json.toString());
        Recording.Unusable noRequest = assertThrows(Recording.Unusable.class, () -> Recovery.restore(
            Recording.of(request, left.id()), SeatChecks.DECKS, finished -> {}, HumanGame.Hooks.NONE));
        assertEquals("unreadable", noRequest.code);

        // And the recording itself, untouched by all of that, still gives the game back.
        Recovery.Restored restored = takeUp(copyOf(left.id()), left.id());
        assertEquals(List.of(), restored.report().problems());
        assertEquals(left.seat(), Recordings.awaitPrompt(restored.game()));
    }

    /** A result that cannot be read still marks the recording as over: the game is not made again. */
    @Test
    void aRecordingWithADamagedResultIsStillOver() throws Exception {
        Left left = playAndLeave(duel(42L), 12, 42);
        Path copy = copyOf(left.id());
        Files.writeString(copy.resolve(left.id()).resolve(Recording.RESULT), "{\"kind\": \"comp");
        Recording.Unusable over = assertThrows(Recording.Unusable.class, () -> Recovery.restore(
            Recording.of(copy, left.id()), SeatChecks.DECKS, finished -> {}, HumanGame.Hooks.NONE));
        assertEquals("finished", over.code);
    }

    // ------------------------------------------------------------------ a recording that stopped

    private static String toolSays(Path folder, String id, String... options) {
        var bytes = new java.io.ByteArrayOutputStream();
        List<String> args = new ArrayList<>(List.of(folder.toString(), id));
        args.addAll(List.of(options));
        int exit = RecordingTool.run(args.toArray(String[]::new),
            new java.io.PrintStream(bytes, true, java.nio.charset.StandardCharsets.UTF_8));
        return exit + "\n" + bytes.toString(java.nio.charset.StandardCharsets.UTF_8);
    }

    /**
     * A recording that could not be kept up is behind its game, which went on without it. It says
     * that it stopped, and no game is made from it: the seats would be put back to wherever it
     * stopped, as if that were the game they were playing.
     */
    @Test
    void aRecordingThatStoppedIsNotPlayedOn() throws Exception {
        var player = new ScriptedPlayer(51);
        Tables.Policy policy = (seat, prompt, view) -> player.choose(prompt, view);
        HumanGame game = Recordings.start(root, duel(51L), HumanGame.Hooks.NONE);
        started.add(game);
        for (int answered = 0; answered < 20; answered++) {
            assertTrue(Recordings.answer(game, policy));
        }
        Recordings.awaitPrompt(game);
        assertTrue(game.recorder().awaitDurable());
        Recording recording = Recording.of(root, game.id());
        assertFalse(recording.checkpointSeqs().isEmpty());
        assertTrue(recording.stopped().isEmpty());

        // The disk refuses a write. The game goes on: its seats are asked and answer as before.
        game.recorder().failForTest("its journal could not be written: java.io.IOException: No space left on device");
        int records = recording.readJournal().records().size();
        for (int answered = 0; answered < 20; answered++) {
            assertTrue(Recordings.answer(game, policy), "the game stopped with its recording");
        }
        Recordings.awaitPrompt(game);
        assertEquals(records, recording.readJournal().records().size(), "nothing more is recorded");
        assertEquals(1, game.recorder().metrics().failures.get());
        game.interrupt();

        assertTrue(recording.stopped().isPresent());
        assertEquals(List.of(), recording.checkpointSeqs(), "its checkpoints are of no use now, and are gone");
        for (int asked = 0; asked < 2; asked++) {
            Recording.Unusable refused = assertThrows(Recording.Unusable.class, () -> Recovery.restore(
                recording, SeatChecks.DECKS, finished -> {}, HumanGame.Hooks.NONE));
            assertEquals("unrecoverable", refused.code);
            assertTrue(refused.getMessage().contains("stopped"), refused.getMessage());
            assertTrue(refused.getMessage().contains("No space left on device"), refused.getMessage());
        }
        assertEquals(records, recording.readJournal().records().size(), "being asked for adds nothing to it");
        String said = toolSays(root, game.id());
        assertTrue(said.startsWith("1\n"), said);
        assertTrue(said.contains("PROBLEMS (stopped)"), said);
    }

    /** The game that went on unrecorded still ends, and its result is the recording's: asked for, it is over. */
    @Test
    void aGameThatEndsAfterItsRecordingStoppedHasItsResult() throws Exception {
        var player = new ScriptedPlayer(52);
        Tables.Policy policy = (seat, prompt, view) -> player.choose(prompt, view);
        HumanGame game = Recordings.start(root, duel(52L), HumanGame.Hooks.NONE);
        started.add(game);
        for (int answered = 0; answered < 12; answered++) {
            assertTrue(Recordings.answer(game, policy));
        }
        Recordings.awaitPrompt(game);
        game.recorder().failForTest("a checkpoint could not be written: java.io.IOException: Input/output error");
        game.close("closed");
        assertEquals("closed", Tables.finalSnapshot(game, 0).result().kind());

        Recording recording = Recording.of(root, game.id());
        assertEquals("closed", recording.result().orElseThrow().get("kind").getAsString());
        Recording.Unusable over = assertThrows(Recording.Unusable.class, () -> Recovery.restore(
            recording, SeatChecks.DECKS, finished -> {}, HumanGame.Hooks.NONE));
        assertEquals("finished", over.code);
    }

    /**
     * A disk that refuses even the note: the manifest is taken away instead, which needs no room,
     * and what is left is no recording. The game is not found, and so not made.
     */
    @Test
    void aRecordingThatCannotEvenSayItStoppedIsNoRecording() throws Exception {
        var player = new ScriptedPlayer(53);
        Tables.Policy policy = (seat, prompt, view) -> player.choose(prompt, view);
        HumanGame game = Recordings.start(root, duel(53L), HumanGame.Hooks.NONE);
        started.add(game);
        for (int answered = 0; answered < 12; answered++) {
            assertTrue(Recordings.answer(game, policy));
        }
        Recordings.awaitPrompt(game);
        assertTrue(game.recorder().awaitDurable());
        Recording recording = Recording.of(root, game.id());
        // The note's name is taken by a folder that is not empty: writing the note fails.
        Path blocked = Files.createDirectory(recording.folder().resolve(Recording.STOPPED));
        Files.writeString(blocked.resolve("in-the-way"), "x");

        game.recorder().failForTest("its journal could not be written: java.io.IOException: No space left on device");
        assertTrue(Recordings.answer(game, policy), "the game stopped with its recording");
        game.interrupt();

        assertFalse(recording.exists(), "the manifest is gone");
        Recording.Unusable none = assertThrows(Recording.Unusable.class, () -> Recovery.restore(
            recording, SeatChecks.DECKS, finished -> {}, HumanGame.Hooks.NONE));
        assertEquals("missing", none.code);
    }

    /** Held by a game's state, and not something Java can write. */
    private static final class Unwritable implements mage.util.Copyable<Unwritable> {
        @Override
        public Unwritable copy() {
            return this;
        }
    }

    /**
     * A game whose state Java cannot write (a card that holds such an object) has no checkpoint:
     * each one is skipped, the game plays on all the same, and after {@link Recorder#MAX_UNWRITABLE}
     * in a row the recording stops and says so. What could not be written is named for the operator
     * only: it may be a card in someone's hand.
     */
    @Test
    void aGameWhoseStateCannotBeWrittenStopsItsRecordingAndIsNotPlayedOn() throws Exception {
        var player = new ScriptedPlayer(54);
        Tables.Policy policy = (seat, prompt, view) -> player.choose(prompt, view);
        HumanGame.Hooks hooks = new HumanGame.Hooks() {
            @Override
            public void beforeStart(mage.game.Game xmage, List<UUID> seatIds) {
                xmage.getState().setValue("cd-test-unwritable", new Unwritable());
            }
        };
        HumanGame game = Recordings.start(root, duel(54L), hooks);
        started.add(game);
        Recorder recorder = game.recorder();
        int answered = 0;
        while (recorder.failure() == null && answered < 200) {
            assertTrue(Recordings.answer(game, policy), "the game ended after " + answered + " answers");
            answered++;
        }
        assertNotNull(recorder.failure(), "the recording went on through " + answered + " answers");
        assertEquals(Recorder.MAX_UNWRITABLE + " checkpoints in a row could not be serialized", recorder.failure());
        assertEquals(0, recorder.metrics().checkpoints.get());
        assertEquals(Recorder.MAX_UNWRITABLE, recorder.metrics().skipped.get());
        // The game is none the worse: it is played on.
        for (int more = 0; more < 10; more++) {
            assertTrue(Recordings.answer(game, policy), "the game stopped with its recording");
        }
        Recordings.awaitPrompt(game);
        game.interrupt();

        Recording recording = Recording.of(root, game.id());
        Recording.Unusable refused = assertThrows(Recording.Unusable.class, () -> Recovery.restore(
            recording, SeatChecks.DECKS, finished -> {}, HumanGame.Hooks.NONE));
        assertEquals("unrecoverable", refused.code);
        assertFalse(refused.getMessage().contains("Unwritable"), refused.getMessage());
        String said = toolSays(root, game.id());
        assertTrue(said.contains("PROBLEMS (stopped)"), said);
        assertFalse(said.contains("Unwritable"), said);
        String asked = toolSays(root, game.id(), "--show-private");
        assertTrue(asked.contains("Unwritable"), asked);
    }

    // ------------------------------------------------------------------ nothing is done twice

    /**
     * A seat whose answer was accepted just before the interruption does not know whether it was,
     * and sends it again: it is told what it was told, and the answer is not given a second time.
     */
    @Test
    void anAnswerSentAgainAfterTheRecoveryIsAnsweredAsItWasAndNotGivenTwice() throws Exception {
        var player = new ScriptedPlayer(43);
        Tables.Policy policy = (seat, prompt, view) -> player.choose(prompt, view);
        HumanGame game = Recordings.start(root, duel(43L), HumanGame.Hooks.NONE);
        started.add(game);
        for (int answered = 0; answered < 16; answered++) {
            assertTrue(Recordings.answer(game, policy));
        }
        // One answer by hand, so that the command can be sent again exactly as it was.
        int seat = Recordings.awaitPrompt(game);
        HumanGame.Snapshot asked = game.snapshot(seat, -1, 0, 0);
        String option = policy.choose(seat, asked.prompt(), asked.view());
        SeatCommand command = Tables.answer(game, UUID.randomUUID().toString(), asked.revision(), asked.prompt().id(),
            option);
        HumanGame.Reply first = game.submit(seat, command);
        assertEquals(200, first.status(), first.body().toString());
        int next = Recordings.awaitPrompt(game);
        Recordings.Shown before = Recordings.shown(game);
        assertTrue(game.recorder().awaitDurable());
        game.interrupt();

        Recovery.Restored restored = takeUp(root, game.id());
        HumanGame again = restored.game();
        assertEquals(next, Recordings.awaitPrompt(again));
        long revision = again.snapshot(seat, -1, 0, 0).revision();
        HumanGame.Reply second = again.submit(seat, command);
        assertEquals(200, second.status(), second.body().toString());
        assertEquals(first.body().get("status"), second.body().get("status"));
        assertEquals(first.body().get("action_id"), second.body().get("action_id"));
        assertEquals(((Number) first.body().get("revision")).longValue(),
            ((Number) second.body().get("revision")).longValue(), "the reply is the one that was given");
        // Nothing moved: the same question is open, at the same revision, and the game is as it was.
        assertEquals(revision, again.snapshot(seat, -1, 0, 0).revision());
        assertEquals(next, Recordings.awaitPrompt(again));
        Recordings.assertSameButForNewObjects(before, Recordings.shown(again), "after the answer came again");
        // The same action id for another command is still refused.
        HumanGame.Snapshot open = again.snapshot(next, -1, 0, 0);
        SeatCommand other = Tables.answer(again, command.actionId(), open.revision(), open.prompt().id(),
            open.prompt().options().get(0).id());
        if (!other.fingerprint().equals(command.fingerprint())) {
            Tables.assertRejected(409, "action_id_reused", again.submit(seat, other));
        }
    }

    /**
     * A concession is one concession across an interruption: the seat is out, the others play on,
     * the seat's command sent again is answered as it was, and the result lists it once.
     */
    @Test
    void aConcessionStaysOneConcession() throws Exception {
        String body = Recordings.body(44L, "commander", 1, 12, "human:commander-mono-red-raiders",
            "human:commander-mono-white-soldiers", "bot:commander-mono-blue-flyers",
            "bot:commander-mono-green-stompers");
        var player = new ScriptedPlayer(44);
        Tables.Policy policy = (seat, prompt, view) -> player.choose(prompt, view);
        HumanGame game = Recordings.start(root, body, HumanGame.Hooks.NONE);
        started.add(game);
        for (int answered = 0; answered < 12; answered++) {
            assertTrue(Recordings.answer(game, policy));
        }
        Recordings.awaitPrompt(game);
        SeatCommand concede = Tables.concede(game, game.snapshot(1, -1, 0, 0).revision());
        HumanGame.Reply first = game.concede(1, concede);
        assertEquals(200, first.status(), first.body().toString());
        // The other person plays on to their next question, and the game is left there.
        int seat = Recordings.awaitPrompt(game);
        assertEquals(0, seat);
        assertTrue(game.recorder().awaitDurable());
        game.interrupt();

        Recovery.Restored restored = takeUp(root, game.id());
        HumanGame again = restored.game();
        assertEquals(0, Recordings.awaitPrompt(again));
        // The seat has conceded: another concession of its own is refused, as it always was, and
        // its command sent again is answered as it was.
        Tables.assertRejected(409, "eliminated",
            again.concede(1, Tables.concede(again, again.snapshot(1, -1, 0, 0).revision())));
        HumanGame.Reply second = again.concede(1, concede);
        assertEquals(200, second.status(), second.body().toString());
        assertEquals(first.body().get("action_id"), second.body().get("action_id"));
        // XMage applies another player's concession at the next answer of the player it waits for:
        // the other person answers, and the seat is out.
        assertTrue(Recordings.answer(again, policy));
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(30);
        while (!again.snapshot(1, -1, 0, 0).status().equals("eliminated") && System.nanoTime() < deadline) {
            Thread.sleep(20);
        }
        assertEquals("eliminated", again.snapshot(1, -1, 0, 0).status());
        // And a game left after that has the seat out from its checkpoint on.
        assertEquals(0, Recordings.awaitPrompt(again));
        assertTrue(again.recorder().awaitDurable());
        again.interrupt();
        again = takeUp(root, game.id()).game();
        assertEquals(0, Recordings.awaitPrompt(again));
        assertEquals("eliminated", again.snapshot(1, -1, 0, 0).status());
        again.close("closed");
        HumanGame.Snapshot last = Tables.finalSnapshot(again, 0);
        assertEquals(List.of(1), last.result().concededSeats());
        assertEquals("closed", last.result().kind());
        JsonObject recorded = Recording.of(root, game.id()).result().orElseThrow();
        assertEquals(1, recorded.getAsJsonArray("conceded_seats").size(), recorded.toString());
    }

    /**
     * A seat's priority settings and the switch for passive bots are commands like any other: they
     * are in the journal, and a game taken up again has them as they were set.
     */
    @Test
    void settingsSentBeforeTheInterruptionHold() throws Exception {
        var player = new ScriptedPlayer(45);
        Tables.Policy policy = (seat, prompt, view) -> player.choose(prompt, view);
        HumanGame game = Recordings.start(root, commanderWithBots(45L), HumanGame.Hooks.NONE);
        started.add(game);
        for (int answered = 0; answered < 10; answered++) {
            assertTrue(Recordings.answer(game, policy));
        }
        int seat = Recordings.awaitPrompt(game);
        HumanGame.Snapshot open = game.snapshot(seat, -1, 0, 0);
        SeatCommand settings = SeatCommand.parse("{\"v\":1,\"game_id\":\"" + game.id() + "\",\"action_id\":\""
            + UUID.randomUUID() + "\",\"expected_revision\":" + open.revision() + ",\"type\":\"set_priority\","
            + "\"payload\":{\"your_turn\":[\"upkeep\",\"draw\"],\"opponent_turn\":[\"end_of_turn\"],"
            + "\"stop_on_new_stack_objects\":false,\"stop_on_attackers\":true,\"stop_on_blockers\":false,"
            + "\"pass_after_casting\":true,\"full_control\":false}}", game.id());
        HumanGame.Reply set = game.setPriority(seat, settings);
        assertEquals(200, set.status(), set.body().toString());
        game.setPassiveBots(true);
        assertTrue(game.recorder().awaitDurable());
        game.interrupt();

        Recovery.Restored restored = takeUp(root, game.id());
        HumanGame again = restored.game();
        assertEquals(seat, Recordings.awaitPrompt(again));
        assertTrue(again.passiveBots(), "the bots are passive, as they were set");
        // The settings command sent again is answered as it was, controls and all.
        HumanGame.Reply resent = again.setPriority(seat, settings);
        assertEquals(200, resent.status());
        assertEquals(EngineServer.JSON.toJson(set.body().get("priority")),
            EngineServer.JSON.toJson(resent.body().get("priority")));
        // A seat's view shows its controls from its next view on, as it always did: after one more
        // answer they are the ones that were set.
        assertTrue(Recordings.answer(again, policy));
        Recordings.awaitPrompt(again);
        SeatView.PriorityControls controls = again.snapshot(seat, -1, 0, 0).view().priority();
        assertTrue(controls.passAfterCasting(), controls.toString());
        assertEquals(List.of("upkeep", "draw"), controls.yourTurn(), controls.toString());
        assertEquals(List.of("end_of_turn"), controls.opponentTurn(), controls.toString());
        assertFalse(controls.stopOnNewStackObjects(), controls.toString());
    }
}
