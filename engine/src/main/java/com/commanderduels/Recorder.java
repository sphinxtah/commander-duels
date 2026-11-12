package com.commanderduels;

import com.google.gson.JsonObject;
import java.io.IOException;
import java.time.Instant;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Keeps one game's recording while it is played (v0.9.9): the journal of what the seats decide, and
 * checkpoints of the game's state ({@link Recording}, {@link Checkpoint}).
 *
 * <p><b>The journal comes first.</b> A seat's answer or command is appended and forced to disk
 * before the engine acts on it or tells the seat it was accepted, so nothing a seat was told is
 * lost with the process.
 *
 * <p><b>Checkpoints are taken often and written when they are needed.</b> The game hands one over
 * at each point it can later go on from (a player about to receive priority, every player having
 * passed), which costs it a copy of the game and nothing else: only the newest is kept in memory.
 * One is written, on this recorder's own thread, when a seat is asked something (the checkpoint
 * its answer will build on) and every {@link #INTERVAL_MILLIS} while bots play on alone. An answer
 * is not accepted until the checkpoint it builds on is on disk ({@link #awaitDurable}): by the
 * time a person has read a prompt it nearly always is.
 *
 * <p>Why both: a checkpoint cannot be taken in the middle of a decision (a spell half cast, a
 * blocker half declared: the rest is on XMage's game thread, not in its state), and the journal
 * alone cannot rebuild a game (a bot's search is cut off by the clock, and would not decide the
 * same twice). So recovery takes the newest checkpoint and plays the journal's records after it;
 * and because a checkpoint is taken after every decision at priority, no bot's search lies
 * between the checkpoint a seat's question stands on and the question.
 *
 * <p><b>A recording that fails stops, and says so.</b> If the disk refuses a write, the game goes
 * on unrecorded from there (a game is not ended because its insurance lapsed), and the failure is
 * logged and counted. From that moment the recording is behind its game, and a game taken up from
 * it would put its seats back to wherever it stopped, turns ago perhaps, as if that were the game.
 * So the recording is marked as stopped ({@link Recording#stop}) and recovery refuses it: an engine
 * that loses such a game has lost it, as every game was lost before there were recordings. Its
 * checkpoints are removed first (they are of no use now, and their room may be what the note
 * needs); if even the note cannot be written, the manifest is removed, which leaves no recording.
 * A state that cannot be serialized (XMage copies its objects, it does not serialize them, so a
 * card may hold one that Java cannot write) costs that one checkpoint: the one before it stands
 * and the next is tried; only {@link #MAX_UNWRITABLE} in a row stop the recording.
 */
final class Recorder implements AutoCloseable {
    /** How long bots may play on without a checkpoint reaching the disk. */
    static final long INTERVAL_MILLIS = TimeUnit.SECONDS.toMillis(
        Math.max(1, Long.parseLong(System.getenv().getOrDefault("CD_ENGINE_CHECKPOINT_SECONDS", "3"))));
    /** How long an answer waits for the checkpoint it builds on before it is taken regardless. */
    static final long DURABLE_WAIT_MILLIS = 5_000;
    /** The stack of a thread that writes or reads a checkpoint: reserved, and used only as far as needed. */
    static final long STACK_BYTES = 256L << 20;
    /** The journal's note that the game's first checkpoint is on disk. */
    static final String CHECKPOINTED = "checkpointed";
    /** After this many checkpoints in a row that could not be serialized, the recording stops. */
    static final int MAX_UNWRITABLE = 8;

    /** What the recorder did, for the engine's metrics and the tests. */
    static final class Metrics {
        final AtomicLong captures = new AtomicLong();
        /** What taking the states cost the game's own thread: the copy of the game and its digest. */
        final AtomicLong captureMicros = new AtomicLong();
        final AtomicLong longestCaptureMicros = new AtomicLong();
        final AtomicLong checkpoints = new AtomicLong();
        final AtomicLong skipped = new AtomicLong();
        final AtomicLong checkpointBytes = new AtomicLong();
        final AtomicLong checkpointMillis = new AtomicLong();
        final AtomicLong longestCheckpointMillis = new AtomicLong();
        final AtomicLong records = new AtomicLong();
        final AtomicLong journalMillis = new AtomicLong();
        final AtomicLong longestJournalMillis = new AtomicLong();
        final AtomicLong waits = new AtomicLong();
        final AtomicLong waitMillis = new AtomicLong();
        final AtomicLong failures = new AtomicLong();
    }

    private final Recording recording;
    private final Recording.Appender journal;
    private final String engineBuild;
    private final Thread writer;
    private final Metrics metrics = new Metrics();

    // Guarded by this.
    private Checkpoint pending;
    private int pendingSeq;
    private int captured;
    private int durable;
    private boolean wanted;
    private boolean closed;
    private boolean finished;
    private long lastWriteNanos = System.nanoTime();
    private String failure;
    /** Writer thread only: whether the journal says that the game has had a checkpoint. */
    private boolean noted;
    /** How many checkpoints in a row could not be serialized, and the newest of them. */
    private int unwritable;
    private int skippedUpTo;

    private Recorder(Recording recording, Recording.Appender journal, int lastCheckpoint) {
        this.recording = recording;
        this.journal = journal;
        this.engineBuild = EngineBuild.key();
        this.captured = lastCheckpoint;
        this.durable = lastCheckpoint;
        this.noted = lastCheckpoint > 0;
        // A game's objects nest deeply, and Java writes them by descending into them: a deep stack.
        this.writer = new Thread(null, this::write, "recording " + recording.folder().getFileName(), STACK_BYTES);
        this.writer.setDaemon(true);
        this.writer.start();
    }

    /** Starts a new game's recording: its folder and manifest are written before the game begins. */
    static Recorder create(Recording recording, Recording.Manifest manifest) throws IOException {
        recording.create(manifest);
        return new Recorder(recording, recording.appender(), 0);
    }

    /** Goes on with the recording of a game that is being taken up again. */
    static Recorder resume(Recording recording) throws IOException {
        var seqs = recording.checkpointSeqs();
        return new Recorder(recording, recording.appender(), seqs.isEmpty() ? 0 : seqs.get(seqs.size() - 1));
    }

    Recording recording() {
        return recording;
    }

    Metrics metrics() {
        return metrics;
    }

    /** Why the recording stopped, or null while it is kept. Nothing of the game is in it. */
    synchronized String failure() {
        return failure;
    }

    /** Test hook: the recording stops as it does when the disk refuses a write. */
    void failForTest(String why) {
        fail(why);
    }

    /** The number of the journal's last record. */
    long journalSeq() {
        return journal.seq();
    }

    /**
     * Game thread: the game's state at a point it can go on from. It replaces any checkpoint that
     * was waiting to be written: only the newest matters.
     */
    synchronized void captured(Checkpoint checkpoint, long tookNanos) {
        if (closed || failure != null) {
            return;
        }
        metrics.captures.incrementAndGet();
        long micros = TimeUnit.NANOSECONDS.toMicros(tookNanos);
        metrics.captureMicros.addAndGet(micros);
        metrics.longestCaptureMicros.accumulateAndGet(micros, Math::max);
        pending = checkpoint;
        pendingSeq = ++captured;
        notifyAll();
    }

    /** A seat is being asked something: the newest checkpoint is to be written now. */
    synchronized void want() {
        if (pending != null) {
            wanted = true;
            notifyAll();
        }
    }

    /**
     * Waits, up to {@link #DURABLE_WAIT_MILLIS}, until every checkpoint taken so far is on disk or
     * has been replaced by a newer one that is. Returns whether it is so.
     */
    boolean awaitDurable() {
        long started = System.nanoTime();
        boolean waited = false;
        try {
            synchronized (this) {
                int needed = captured;
                long deadline = started + TimeUnit.MILLISECONDS.toNanos(DURABLE_WAIT_MILLIS);
                while (durable < needed && skippedUpTo < needed && failure == null && !closed) {
                    long remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
                    if (remaining <= 0) {
                        return false;
                    }
                    waited = true;
                    if (pending != null) {
                        // Not yet being written: it is wanted now. (One that is being written needs
                        // no asking for, and asking would have the next state written unasked.)
                        wanted = true;
                        notifyAll();
                    }
                    wait(remaining);
                }
                return durable >= needed;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        } finally {
            if (waited) {
                metrics.waits.incrementAndGet();
                metrics.waitMillis.addAndGet(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started));
            }
        }
    }

    /**
     * Appends a record to the journal and forces it to disk. Returns its number, or 0 when the
     * recording has stopped: the caller goes on either way.
     */
    long journal(JsonObject record) {
        synchronized (this) {
            if (closed || failure != null) {
                return 0;
            }
        }
        long started = System.nanoTime();
        try {
            long seq = journal.append(record);
            long millis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
            metrics.records.incrementAndGet();
            metrics.journalMillis.addAndGet(millis);
            metrics.longestJournalMillis.accumulateAndGet(millis, Math::max);
            return seq;
        } catch (IOException | RuntimeException e) {
            fail("its journal could not be written: " + e);
            return 0;
        }
    }

    /** The game has a result: it is written, and the recording is over. */
    void finish(JsonObject result) {
        synchronized (this) {
            if (finished) {
                return;
            }
            finished = true;
        }
        try {
            recording.finish(result);
        } catch (IOException | RuntimeException e) {
            fail("its result could not be written: " + e);
        }
        close();
        // Over: what is kept is who played, what they answered and how it ended, not the game's state.
        recording.dropCheckpoints();
    }

    private void fail(String why) {
        fail(why, null);
    }

    /**
     * The recording stops here and the game goes on without it. {@code detail} is what only the
     * operator is told (an exception that may name a card's class).
     */
    private void fail(String why, String detail) {
        synchronized (this) {
            if (failure != null) {
                return;
            }
            failure = why;
            pending = null;
            notifyAll();
        }
        metrics.failures.incrementAndGet();
        String name = "Recording of game " + recording.folder().getFileName();
        System.err.println(name + " stopped: " + why + (detail == null ? "" : ": " + detail));
        // Behind its game from here on: nothing may ever be played on from it.
        recording.dropCheckpoints();
        try {
            recording.stop(why, detail);
        } catch (IOException | RuntimeException e) {
            boolean disowned = recording.disown();
            System.err.println(name + " could not be marked as stopped (" + e + "); " + (disowned
                ? "its manifest was removed instead, so that no game is made from it"
                : "its manifest could not be removed either: no game must be made from it"));
        }
    }

    /** The writer's thread: writes the newest checkpoint when one is wanted, or the interval has passed. */
    private void write() {
        while (true) {
            Checkpoint checkpoint;
            int seq;
            synchronized (this) {
                while (true) {
                    if (closed || failure != null) {
                        return;
                    }
                    long sinceLast = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - lastWriteNanos);
                    if (pending != null && (wanted || sinceLast >= INTERVAL_MILLIS)) {
                        break;
                    }
                    try {
                        wait(pending == null ? INTERVAL_MILLIS : Math.max(1, INTERVAL_MILLIS - sinceLast));
                    } catch (InterruptedException e) {
                        return;
                    }
                }
                checkpoint = pending;
                seq = pendingSeq;
                pending = null;
                wanted = false;
            }
            long started = System.nanoTime();
            Recording.Packed packed;
            try {
                packed = Recording.pack(checkpoint);
            } catch (IOException | RuntimeException | StackOverflowError | OutOfMemoryError e) {
                // This state could not be written down (an object of some card's that Java cannot
                // serialize, most likely): the checkpoint before it stands, and the next is tried.
                // A game in which none can be written has no recording worth the name, and stops it.
                skipped(seq, e);
                continue;
            }
            try {
                recording.writeCheckpoint(new Recording.CheckpointHeader(seq, checkpoint.journalSeq(), checkpoint.turn(),
                    checkpoint.step(), Instant.now().toString(), packed.body().length, packed.rawBytes(),
                    packed.crc32(), checkpoint.stateDigest(), engineBuild), packed);
                long millis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
                metrics.checkpoints.incrementAndGet();
                metrics.checkpointBytes.addAndGet(packed.body().length);
                metrics.checkpointMillis.addAndGet(millis);
                metrics.longestCheckpointMillis.accumulateAndGet(millis, Math::max);
                if (!noted) {
                    // Once, in the journal: from here on the game is taken up from a checkpoint. A
                    // recording that says so and has none left has lost them, and is not mistaken
                    // for a game that never had one (which is dealt again from its seed).
                    JsonObject note = new JsonObject();
                    note.addProperty("type", CHECKPOINTED);
                    note.addProperty("checkpoint", seq);
                    journal.append(note);
                    noted = true;
                }
                synchronized (this) {
                    durable = seq;
                    unwritable = 0;
                    lastWriteNanos = System.nanoTime();
                    notifyAll();
                }
            } catch (IOException | RuntimeException e) {
                fail("a checkpoint could not be written: " + e);
                return;
            }
        }
    }

    /** Writer thread: a checkpoint's state could not be serialized. */
    private void skipped(int seq, Throwable why) {
        metrics.skipped.incrementAndGet();
        boolean stop;
        synchronized (this) {
            unwritable++;
            stop = unwritable >= MAX_UNWRITABLE;
            // Whoever waits for this checkpoint waits no longer: there is none to wait for.
            skippedUpTo = seq;
            lastWriteNanos = System.nanoTime();
            notifyAll();
        }
        System.err.println("Recording of game " + recording.folder().getFileName() + ": checkpoint " + seq
            + " could not be serialized and is skipped: " + why);
        if (stop) {
            fail(MAX_UNWRITABLE + " checkpoints in a row could not be serialized", String.valueOf(why));
        }
    }

    /** Stops the writer and closes the journal. What was written stays. */
    @Override
    public void close() {
        synchronized (this) {
            if (closed) {
                return;
            }
            closed = true;
            pending = null;
            notifyAll();
        }
        // A checkpoint being written is finished or given up before the journal closes, so the
        // recording's files are still once this returns.
        if (Thread.currentThread() != writer) {
            try {
                writer.join(TimeUnit.SECONDS.toMillis(30));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        try {
            journal.close();
        } catch (IOException e) {
            System.err.println("Recording of game " + recording.folder().getFileName() + ": " + e.getMessage());
        }
    }
}
