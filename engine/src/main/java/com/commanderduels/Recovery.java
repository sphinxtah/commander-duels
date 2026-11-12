package com.commanderduels;

import com.google.gson.JsonObject;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.function.Consumer;
import mage.game.Game;

/**
 * Starts a game's recording and takes a game up again from one (v0.9.9).
 *
 * <p>Taking a game up ({@link #restore}) trusts nothing it reads:
 * <ol>
 *   <li>The manifest must be whole, in this engine's layout, and bound to this engine's build
 *       ({@link EngineBuild}). A recording made by another build is refused: a saved state is that
 *       build's objects, and its cards and rules.
 *   <li>A recording with a result is over. A finished game is never made again, so its result
 *       cannot be reached twice.
 *   <li>The newest checkpoint that is whole is used: its checksum and length hold, it is this
 *       build's, it reads back, and the game it holds has the digest that was taken with it. One
 *       that fails is passed over for the one before it, and what failed is reported.
 *   <li>A game that never had a checkpoint (it was interrupted in its mulligans) is made again
 *       from its request and seed, which deal the same hands, and the journal's keeps and
 *       mulligans are played on it. A game that had checkpoints (its journal says so) and has none
 *       that can be used is refused: made again from its seed it would be another game, with new
 *       objects the journal's answers do not name and bots that decide by the clock.
 *   <li>The journal is read up to its first damaged record, and cut back to there before anything
 *       is added.
 *   <li>A game taken up {@link #MAX_FRUITLESS} times in a row with no seat answering in between is
 *       refused: what interrupts it comes back each time.
 * </ol>
 */
final class Recovery {
    /** How many times in a row a game is taken up with no seat answering in between. */
    static final int MAX_FRUITLESS = 5;

    private Recovery() {}

    /**
     * What a restore found.
     *
     * @param checkpoint the number of the checkpoint the game goes on from; 0 when it was made again
     *                   from its request
     * @param records    the journal's records after that, to be played again
     * @param problems   what was passed over, in words: damaged checkpoints, a damaged journal tail
     */
    record Report(int checkpoint, int records, List<String> problems) {}

    /** A game taken up again, not yet started, and what taking it up found. */
    record Restored(HumanGame game, Report report) {}

    /** The manifest of a new game's recording. */
    static Recording.Manifest manifest(String gameId, HumanGameRequest request, String body, boolean service,
                                       String rulesProfile) {
        XmagePin pin = XmagePin.load();
        List<Recording.SeatDeck> seats = new ArrayList<>();
        for (int index = 0; index < request.seats().size(); index++) {
            HumanGameRequest.Seat seat = request.seats().get(index);
            seats.add(new Recording.SeatDeck(index, seat.player(), seat.deck(),
                sha256(seat.custom() == null ? seat.deck() : EngineServer.JSON.toJson(seat.custom()))));
        }
        return new Recording.Manifest(Recording.FORMAT, gameId, Instant.now().toString(),
            new Recording.Binding(EngineBuild.key(), pin.version(), pin.commit(), request.format().id(),
                rulesProfile),
            service, request.seed(), seats, body);
    }

    /**
     * Takes a game up again from its recording. The game it returns is not started.
     *
     * @throws Recording.Unusable when the recording is missing, over, damaged beyond use, or
     *                            another build's
     */
    static Restored restore(Recording recording, Path deckDirectory, Consumer<HumanGame> onFinished,
                            HumanGame.Hooks hooks) throws Recording.Unusable {
        Recording.Manifest manifest = recording.manifest();
        if (!EngineBuild.key().equals(manifest.binding().engineBuild())) {
            throw new Recording.Unusable("incompatible", "The game was recorded by engine build "
                + manifest.binding().engineBuild() + " (XMage " + manifest.binding().xmageVersion()
                + "); this is build " + EngineBuild.key() + ", whose cards and rules may differ");
        }
        if (recording.result().isPresent()) {
            throw new Recording.Unusable("finished", "The game has a result and is over");
        }
        Optional<JsonObject> stopped = recording.stopped();
        if (stopped.isPresent()) {
            // The game went on after its recording stopped. Taken up from here, its seats would be
            // put back to wherever that was, as if it were the game: better no game than that one.
            JsonObject note = stopped.get();
            throw new Recording.Unusable("unrecoverable", "The game's recording stopped"
                + (note.has("at") ? " at " + note.get("at").getAsString() : "")
                + (note.has("why") ? " (" + note.get("why").getAsString() + ")" : "")
                + " and the game went on without it: it is not taken up from where the recording ends");
        }
        HumanGameRequest request;
        try {
            request = HumanGameRequest.parse(manifest.request(), manifest::seed, manifest.service());
        } catch (JsonRequest.Invalid e) {
            throw new Recording.Unusable("unreadable", "The recording's request is damaged: " + e.getMessage(), e);
        }
        List<String> problems = new ArrayList<>();
        Recording.Journal journal;
        List<Integer> seqs;
        try {
            journal = recording.readJournal();
            seqs = recording.checkpointSeqs();
        } catch (IOException e) {
            throw new Recording.Unusable("unreadable", "The recording cannot be read: " + e.getMessage(), e);
        }
        if (journal.problem() != null) {
            problems.add("The journal ends at record " + journal.lastSeq() + ": " + journal.problem() + " ("
                + journal.ignoredBytes() + " bytes after it are not used)");
        }
        // Taken up again and again with nothing answered in between: whatever interrupts the game
        // comes back each time (a board no heap holds, most likely), and with it would go every
        // other game the engine runs.
        int fruitless = 0;
        for (int index = journal.records().size() - 1; index >= 0; index--) {
            String type = journal.records().get(index).get("type").getAsString();
            if (type.equals("recovered")) {
                fruitless++;
            } else if (type.equals("answer") || type.equals("concede")) {
                break;
            }
        }
        if (fruitless >= MAX_FRUITLESS) {
            throw new Recording.Unusable("unrecoverable", "The game was taken up " + fruitless + " times in a row"
                + " without a seat answering anything, and is not taken up again");
        }
        Recording.Loaded loaded = null;
        for (int index = seqs.size() - 1; index >= 0 && loaded == null; index--) {
            int seq = seqs.get(index);
            try {
                Recording.Loaded candidate = load(recording, seq);
                if (!EngineBuild.key().equals(candidate.header().engineBuild())) {
                    problems.add("Checkpoint " + seq + " is another engine build's");
                } else if (candidate.header().journalSeq() > journal.lastSeq()) {
                    // Its state holds answers the journal no longer has: the commands they were
                    // could not be told apart from new ones.
                    problems.add("Checkpoint " + seq + " is ahead of the journal (record "
                        + candidate.header().journalSeq() + " of " + journal.lastSeq() + ")");
                } else if (!candidate.header().stateDigest().equals(Checkpoint.digest(candidate.checkpoint().game()))) {
                    problems.add("Checkpoint " + seq + " does not hold the game that was saved");
                } else {
                    loaded = candidate;
                }
            } catch (Recording.Unusable e) {
                problems.add(e.getMessage());
            }
        }
        if (loaded == null) {
            boolean had = !seqs.isEmpty() || journal.records().stream()
                .anyMatch(record -> Recorder.CHECKPOINTED.equals(record.get("type").getAsString()));
            if (had) {
                // Made again from its seed, the game would be another game: the cards are new
                // objects the journal's answers do not name, and a bot's search is cut off by the
                // clock and does not decide the same twice. The seats would find themselves at the
                // first turn of a game nobody played. Better no game than that one.
                throw new Recording.Unusable("unreadable", "None of the game's checkpoints can be used ("
                    + String.join("; ", problems) + "), and a game is not played again from its beginning");
            }
        }
        Recorder recorder;
        try {
            recorder = Recorder.resume(recording);
        } catch (IOException e) {
            throw new Recording.Unusable("unreadable", "The recording cannot be added to: " + e.getMessage(), e);
        }
        long base = loaded == null ? 0 : loaded.header().journalSeq();
        int after = (int) journal.records().stream().filter(record -> record.get("seq").getAsLong() > base).count();
        try {
            HumanGame game = HumanGame.restore(manifest.gameId(), request, deckDirectory, onFinished, hooks, recorder,
                loaded, journal.records());
            if (recorder.failure() != null) {
                // The note that the game was taken up could not be written: this recording cannot be
                // kept up, and a game that cannot be recorded is not started from a recording.
                recorder.close();
                throw new Recording.Unusable("unreadable", "The recording cannot be added to: " + recorder.failure());
            }
            for (String problem : problems) {
                System.err.println("Recording of game " + manifest.gameId() + ": " + problem);
            }
            return new Restored(game, new Report(loaded == null ? 0 : loaded.header().seq(), after,
                List.copyOf(problems)));
        } catch (RuntimeException e) {
            recorder.close();
            throw new Recording.Unusable("unreadable", "The recording does not make a game: " + e, e);
        }
    }

    /** Reads a checkpoint on a thread with a deep stack: Java makes nested objects by descending. */
    private static Recording.Loaded load(Recording recording, int seq) throws Recording.Unusable {
        Object[] found = new Object[1];
        Thread reader = new Thread(null, () -> {
            try {
                found[0] = recording.checkpoint(seq);
            } catch (Recording.Unusable | RuntimeException | StackOverflowError | OutOfMemoryError e) {
                found[0] = e;
            }
        }, "recording reader", Recorder.STACK_BYTES);
        reader.setDaemon(true);
        reader.start();
        try {
            reader.join();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new Recording.Unusable("unreadable", "Reading checkpoint " + seq + " was interrupted");
        }
        if (found[0] instanceof Recording.Loaded loaded) {
            return loaded;
        }
        if (found[0] instanceof Recording.Unusable unusable) {
            throw unusable;
        }
        throw new Recording.Unusable("unreadable", "Checkpoint " + seq + " cannot be made into a game: " + found[0],
            found[0] instanceof Throwable cause ? cause : null);
    }

    /** What a checkpoint's game looks like to XMage, for tests of what a restore gives back. */
    static String digest(Game game) {
        return Checkpoint.digest(game);
    }

    private static String sha256(String text) {
        try {
            return HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
