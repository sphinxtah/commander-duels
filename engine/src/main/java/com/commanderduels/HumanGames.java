package com.commanderduels;

import com.google.gson.JsonObject;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Stream;

/**
 * The games in this engine: development games, which scripts reach directly, and service games,
 * which only the API reaches (with the service token). A game belongs to one route and is not found
 * on the other. Each human seat has its own seat token, returned once when the game is created;
 * requests carry it as a bearer token and it alone selects the seat. Unknown games and wrong tokens
 * look the same (not found). At most {@code maxActive} games of both kinds run at once: each
 * holds a platform thread while it waits for a seat, and XMage's AI shares one search pool and one
 * random generator across games. Finished games stay readable for a while, then are dropped.
 *
 * <p>Since v0.8.3 the API may name a service game itself ({@link HumanGameRequest#gameId()}), so that a
 * create it retries after a time-out cannot start a second game, and a close it sends for a game it
 * gave up on cannot leave one running. A create naming an id that is in use is refused
 * ({@link Refusal#GAME_EXISTS}). A service close for an id that matches no game records the id as
 * cancelled, and a later create naming it is refused ({@link Refusal#GAME_CANCELLED}): the API's close
 * wins over a create that reaches the engine after it. Both run under this registry's lock, as game
 * registration does, so one always comes wholly before the other. Cancelled ids are kept for
 * {@link #RETAIN_CANCELLED_MILLIS}, at most {@link #MAX_CANCELLED} of them, the oldest dropped first.
 *
 * <p>Recordings (v0.9.9). Given a folder for them, every service game keeps a recording of itself
 * there ({@link Recording}), and a game that is no longer in this engine is taken up again from its
 * recording when the API asks for it ({@link #attach}): after the engine was restarted or died, the
 * API attaches to each game it still counts as running. The engine takes nothing up by itself: a
 * game nobody asks for is nobody's game. Attaching hands out new seat tokens, since the old ones
 * were kept nowhere, and the old ones stop working; so the API attaches to a game that is still
 * running here too, after its own restart, when it is the tokens it has lost. A game that ended
 * while the API was away is answered with its result, from the recording, which keeps it for
 * {@code retentionMillis}; recordings older than that, of games that ended or that nobody came
 * back for, are removed ({@link #sweepRecordings}).
 */
final class HumanGames {
    static final int DEFAULT_MAX_ACTIVE = 2;
    static final int MAX_ACTIVE_LIMIT = 64;
    static final long RETAIN_FINISHED_MILLIS = TimeUnit.MINUTES.toMillis(10);
    static final int MAX_FINISHED = 16;
    static final long RETAIN_CANCELLED_MILLIS = TimeUnit.MINUTES.toMillis(15);
    static final int MAX_CANCELLED = 1024;
    /** How long a recording is kept after its last change, unless the engine is told otherwise. */
    static final long DEFAULT_RECORDING_RETENTION_MILLIS = TimeUnit.HOURS.toMillis(24);
    /** How often old recordings are looked for. */
    static final long RECORDING_SWEEP_MILLIS = TimeUnit.MINUTES.toMillis(5);
    private static final SecureRandom RANDOM = new SecureRandom();

    /** What asking for a game again came to. */
    enum Attached {
        /** The game is running here; it has new tokens. */
        ATTACHED,
        /** The game was taken up from its recording; it has new tokens. */
        RECOVERED,
        /** The game is over: its result is given. */
        FINISHED,
        /** No such game, here or among the recordings. */
        UNKNOWN,
        /** The recording cannot give the game back: {@code code} and {@code message} say why. */
        UNUSABLE,
        /** {@code maxActive} games are already running. */
        BUSY
    }

    /**
     * @param created the game and its new tokens, when attached or recovered
     * @param result  the game's result, when finished
     * @param code    why a recording is unusable: unreadable, incompatible or unrecoverable
     * @param report  what taking the game up found, when recovered
     */
    record Attachment(Attached status, Created created, JsonObject result, String code, String message,
                      Recovery.Report report) {}

    /** Why no game was created. */
    enum Refusal {
        /** {@code maxActive} games are already running. */
        BUSY,
        /** A game with the requested id exists, running or finished and still readable. */
        GAME_EXISTS,
        /** The API closed the requested id before any game had it. */
        GAME_CANCELLED
    }

    /** A created game, or why none was: exactly one of the two is set. */
    record Creation(Created created, Refusal refusal) {}

    /**
     * @param seatTokens     each human seat's token, by seat, in seat order
     * @param spectatorToken a read-only token for the public, possibly delayed, view
     */
    record Created(HumanGame game, Map<Integer, String> seatTokens, String spectatorToken) {}

    /** A game and the seat a token selects; a null seat is the spectator. */
    record SeatHandle(HumanGame game, Integer seat) {
        boolean spectator() {
            return seat == null;
        }
    }

    private static final class Entry {
        final HumanGame game;
        /** SHA-256 of each human seat's token, by seat; replaced when the API attaches again (v0.9.9). */
        volatile Map<Integer, byte[]> tokenHashes;
        volatile byte[] spectatorHash;
        final boolean service;
        final AtomicBoolean closing = new AtomicBoolean();
        volatile long finishedAtNanos;

        Entry(HumanGame game, Map<Integer, byte[]> tokenHashes, byte[] spectatorHash, boolean service) {
            this.game = game;
            this.tokenHashes = tokenHashes;
            this.spectatorHash = spectatorHash;
            this.service = service;
        }
    }

    private final Path deckDirectory;
    private final int maxActive;
    private final Map<String, Entry> games = new ConcurrentHashMap<>();
    /** Ids the API closed before a game had them, with when, oldest first. Guarded by this. */
    private final LinkedHashMap<String, Long> cancelled = new LinkedHashMap<>();
    private final ScheduledExecutorService watchdog;
    /** Where service games keep their recordings (v0.9.9); null for an engine that keeps none. */
    private final Path recordings;
    private final long retentionMillis;
    private long lastRecordingSweepNanos = System.nanoTime();
    /** What the recorders of games that are over did, added up; the running games' are read live. */
    private final Recorder.Metrics ended = new Recorder.Metrics();
    private final AtomicLong recorded = new AtomicLong();
    private final AtomicLong unrecorded = new AtomicLong();
    private final AtomicLong attached = new AtomicLong();
    private final AtomicLong recovered = new AtomicLong();
    private final AtomicLong recoveredMillis = new AtomicLong();
    private final AtomicLong longestRecoveryMillis = new AtomicLong();
    private final AtomicLong answeredFinished = new AtomicLong();
    private final AtomicLong removed = new AtomicLong();
    /** Recordings that could not give their game back, by why. Guarded by this. */
    private final Map<String, Long> refused = new LinkedHashMap<>();
    /**
     * Since v0.9.10 a game may run in a process of its own ({@link GameProcesses}). The front
     * process sweeps the recordings and keeps those of games its processes run; a game's own
     * process sweeps none.
     */
    private volatile java.util.function.Predicate<String> runningElsewhere = id -> false;
    private volatile boolean sweeping = true;

    HumanGames(Path deckDirectory, int maxActive) {
        this(deckDirectory, maxActive, null, DEFAULT_RECORDING_RETENTION_MILLIS);
    }

    /**
     * @param recordings      the folder service games keep their recordings in, or null for none
     * @param retentionMillis how long a recording is kept after its last change
     */
    HumanGames(Path deckDirectory, int maxActive, Path recordings, long retentionMillis) {
        this.recordings = recordings;
        this.retentionMillis = Math.max(TimeUnit.MINUTES.toMillis(1), retentionMillis);
        this.deckDirectory = deckDirectory;
        this.maxActive = Math.max(1, Math.min(MAX_ACTIVE_LIMIT, maxActive));
        this.watchdog = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "human-game-watchdog");
            thread.setDaemon(true);
            return thread;
        });
        watchdog.scheduleWithFixedDelay(this::sweep, 1, 1, TimeUnit.SECONDS);
    }

    int maxActive() {
        return maxActive;
    }

    /** Where service games keep their recordings, or null for none. */
    Path recordings() {
        return recordings;
    }

    /**
     * A game's own process between games (v0.9.11): drops its games that are over, once their
     * threads have ended, so the process can take its front process's next game with the code its
     * last games loaded. Refused (false) while a game runs or is still ending. The wait for a
     * game's thread is outside this registry's lock: a handler waiting on a monitor holds its
     * virtual thread's carrier.
     */
    boolean releaseFinished() {
        List<Entry> over;
        synchronized (this) {
            for (Entry entry : games.values()) {
                if (!entry.game.finished() || entry.finishedAtNanos == 0) {
                    return false;
                }
            }
            over = List.copyOf(games.values());
        }
        for (Entry entry : over) {
            try {
                entry.game.thread().join(5_000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
            if (entry.game.thread().isAlive()) {
                return false;
            }
        }
        synchronized (this) {
            // The front process gives a process its next game only once this has answered.
            over.forEach(entry -> games.remove(entry.game.id(), entry));
            cancelled.clear();
        }
        return true;
    }

    /** The front process's registry (v0.9.10): a recording of a game running in another process is kept. */
    void keepRecordingsOf(java.util.function.Predicate<String> running) {
        runningElsewhere = running;
    }

    /** A game's own process (v0.9.10): the front process sweeps the recordings, not this one. */
    void stopSweepingRecordings() {
        sweeping = false;
    }

    /**
     * What a game's own process reports to the front process (v0.9.10): its games, whether each is
     * over and for how long, and its bots' numbers. Ids and numbers only, nothing of a game's content.
     */
    synchronized List<Map<String, Object>> processStatus() {
        long now = System.nanoTime();
        List<Map<String, Object>> list = new ArrayList<>();
        for (Entry entry : games.values()) {
            HumanGame game = entry.game;
            Map<String, Object> status = new LinkedHashMap<>();
            status.put("game_id", game.id());
            status.put("format", game.settings().format());
            status.put("seats", game.settings().seats().size());
            status.put("finished", game.finished());
            status.put("finished_millis", entry.finishedAtNanos == 0 ? 0
                : TimeUnit.NANOSECONDS.toMillis(now - entry.finishedAtNanos));
            status.put("idle_millis", game.idleMillis());
            status.put("bots", game.botMetrics());
            list.add(status);
        }
        return list;
    }

    /** Starts a development game, or returns empty when {@code maxActive} games are already running. */
    Optional<Created> create(HumanGameRequest request) {
        return create(request, false);
    }

    /**
     * Starts a game, or returns empty when {@code maxActive} games are already running or the
     * requested id is taken or cancelled. A service game can be inspected.
     */
    Optional<Created> create(HumanGameRequest request, boolean service) {
        return Optional.ofNullable(start(request, service).created());
    }

    /**
     * Starts a game, or says why it did not. A service request's {@link HumanGameRequest#gameId()} is
     * the game's id (v0.8.3); without one, and on the development route, the id is random.
     */
    Creation start(HumanGameRequest request, boolean service) {
        return start(request, service, null);
    }

    /**
     * @param body the request as it was received, which a service game's recording keeps (v0.9.9);
     *             null for a game that keeps no recording
     */
    synchronized Creation start(HumanGameRequest request, boolean service, String body) {
        evict();
        String requested = service ? request.gameId() : null;
        if (requested != null && games.containsKey(requested)) {
            return new Creation(null, Refusal.GAME_EXISTS);
        }
        if (requested != null && cancelled.containsKey(requested)) {
            return new Creation(null, Refusal.GAME_CANCELLED);
        }
        if (active() >= maxActive) {
            return new Creation(null, Refusal.BUSY);
        }
        String id = requested != null ? requested : UUID.randomUUID().toString();
        Recorder recorder = null;
        if (recordings != null && service && body != null) {
            Recording recording = Recording.of(recordings, id);
            if (recording.exists()) {
                // A game of that id was played here, whether or not it is over: it is not started anew.
                return new Creation(null, Refusal.GAME_EXISTS);
            }
            try {
                recorder = Recorder.create(recording, Recovery.manifest(id, request, body, true,
                    request.format().rulesProfile(request.seats().size())));
                recorded.incrementAndGet();
            } catch (IOException | RuntimeException e) {
                // The game is played all the same: a recording is what it has against a failure,
                // not what it needs to be played.
                unrecorded.incrementAndGet();
                System.err.println("Human game " + id + " keeps no recording: " + e);
            }
        }
        var game = new HumanGame(id, request, deckDirectory, this::finished, HumanGame.Hooks.NONE, recorder);
        Created created = register(game, service);
        game.start();
        return new Creation(created, null);
    }

    /** Caller holds the lock. Gives the game its tokens and its place in the registry; it is not started. */
    private Created register(HumanGame game, boolean service) {
        Map<Integer, String> tokens = new LinkedHashMap<>();
        Map<Integer, byte[]> hashes = new LinkedHashMap<>();
        for (int seat : game.humanSeats()) {
            String token = newToken();
            tokens.put(seat, token);
            hashes.put(seat, hash(token));
        }
        String spectatorToken = newToken();
        if (service) {
            game.allowInspection();
        }
        Entry entry = games.get(game.id());
        if (entry == null) {
            games.put(game.id(), new Entry(game, Map.copyOf(hashes), hash(spectatorToken), service));
        } else {
            // The same game, asked for again: from here on only the new tokens reach it.
            entry.tokenHashes = Map.copyOf(hashes);
            entry.spectatorHash = hash(spectatorToken);
        }
        return new Created(game, tokens, spectatorToken);
    }

    /**
     * The API asks for a service game again (v0.9.9): a game running here gets new tokens; one that
     * is not here is taken up from its recording, with new tokens; one that is over is answered
     * with its result. See the class comment.
     */
    synchronized Attachment attach(String id) {
        evict();
        Entry entry = games.get(id);
        if (entry != null) {
            if (!entry.service) {
                return new Attachment(Attached.UNKNOWN, null, null, null, null, null);
            }
            if (entry.game.finished()) {
                answeredFinished.incrementAndGet();
                return new Attachment(Attached.FINISHED, null, entry.game.resultJson(), null, null, null);
            }
            attached.incrementAndGet();
            return new Attachment(Attached.ATTACHED, register(entry.game, true), null, null, null, null);
        }
        if (recordings == null) {
            return new Attachment(Attached.UNKNOWN, null, null, null, null, null);
        }
        Recording recording = Recording.of(recordings, id);
        if (!recording.exists()) {
            return new Attachment(Attached.UNKNOWN, null, null, null, null, null);
        }
        Optional<JsonObject> result = recording.result();
        if (result.isPresent()) {
            answeredFinished.incrementAndGet();
            return new Attachment(Attached.FINISHED, null, result.get(), null, null, null);
        }
        if (active() >= maxActive) {
            return new Attachment(Attached.BUSY, null, null, null, null, null);
        }
        long started = System.nanoTime();
        Recovery.Restored restored;
        try {
            if (!recording.manifest().service()) {
                return new Attachment(Attached.UNKNOWN, null, null, null, null, null);
            }
            restored = Recovery.restore(recording, deckDirectory, this::finished, HumanGame.Hooks.NONE);
        } catch (Recording.Unusable e) {
            refused.merge(e.code, 1L, Long::sum);
            System.err.println("Human game " + id + " is not taken up (" + e.code + "): " + e.getMessage());
            return new Attachment(Attached.UNUSABLE, null, null, e.code, e.getMessage(), null);
        }
        Created created = register(restored.game(), true);
        restored.game().start();
        long millis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        recovered.incrementAndGet();
        recoveredMillis.addAndGet(millis);
        longestRecoveryMillis.accumulateAndGet(millis, Math::max);
        System.out.println("Human game " + id + " taken up from checkpoint " + restored.report().checkpoint()
            + " with " + restored.report().records() + " journal records to play, in " + millis + " ms"
            + (restored.report().problems().isEmpty() ? "" : "; passed over: " + restored.report().problems()));
        return new Attachment(Attached.RECOVERED, created, null, null, null, restored.report());
    }

    private static String newToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    /** A development game's seat (null for the spectator), if the id exists and the token is one of its tokens. */
    Optional<SeatHandle> find(String id, String token) {
        return find(id, token, false);
    }

    /** The game and seat (null for the spectator) on the route given by {@code service}. */
    Optional<SeatHandle> find(String id, String token, boolean service) {
        Entry entry = id == null ? null : games.get(id);
        if (entry == null || entry.service != service) {
            return Optional.empty();
        }
        byte[] presented = hash(token == null ? "" : token);
        List<Integer> matches = new ArrayList<>();
        // Every hash is compared, in constant time, so timing does not say which seat matched.
        entry.tokenHashes.forEach((seat, hash) -> {
            if (MessageDigest.isEqual(hash, presented)) {
                matches.add(seat);
            }
        });
        boolean spectator = MessageDigest.isEqual(entry.spectatorHash, presented);
        if (matches.size() == 1 && !spectator) {
            return Optional.of(new SeatHandle(entry.game, matches.get(0)));
        }
        return spectator && matches.isEmpty() ? Optional.of(new SeatHandle(entry.game, null)) : Optional.empty();
    }

    /** A service game by id alone: the service token already authorized the caller. */
    Optional<HumanGame> service(String id) {
        Entry entry = id == null ? null : games.get(id);
        return entry == null || !entry.service ? Optional.empty() : Optional.of(entry.game);
    }

    /**
     * The service game to close (v0.8.3): the game, if it is one; if no game has the id, the id is
     * recorded as cancelled, so a create naming it that reaches the engine later is refused. The
     * caller closes the game it gets outside the lock. An id that belongs to a development game is
     * neither closed nor cancelled.
     */
    synchronized Optional<HumanGame> serviceOrCancel(String id) {
        Entry entry = games.get(id);
        if (entry != null) {
            return entry.service ? Optional.of(entry.game) : Optional.empty();
        }
        evict();
        // Removed first, so a repeated close counts from now and moves to the end of the order.
        cancelled.remove(id);
        cancelled.put(id, System.nanoTime());
        while (cancelled.size() > MAX_CANCELLED) {
            cancelled.remove(cancelled.keySet().iterator().next());
        }
        return Optional.empty();
    }

    /** Whether the id is recorded as cancelled; for tests. */
    synchronized boolean cancelled(String id) {
        return cancelled.containsKey(id);
    }

    synchronized int active() {
        return (int) games.values().stream().filter(entry -> !entry.game.finished()).count();
    }

    private void finished(HumanGame game) {
        Entry entry = games.get(game.id());
        if (entry != null) {
            entry.finishedAtNanos = System.nanoTime();
        }
        Recorder recorder = game.recorder();
        if (recorder != null) {
            add(ended, recorder.metrics());
        }
    }

    private static void add(Recorder.Metrics to, Recorder.Metrics from) {
        to.captures.addAndGet(from.captures.get());
        to.captureMicros.addAndGet(from.captureMicros.get());
        to.longestCaptureMicros.accumulateAndGet(from.longestCaptureMicros.get(), Math::max);
        to.checkpoints.addAndGet(from.checkpoints.get());
        to.skipped.addAndGet(from.skipped.get());
        to.checkpointBytes.addAndGet(from.checkpointBytes.get());
        to.checkpointMillis.addAndGet(from.checkpointMillis.get());
        to.longestCheckpointMillis.accumulateAndGet(from.longestCheckpointMillis.get(), Math::max);
        to.records.addAndGet(from.records.get());
        to.journalMillis.addAndGet(from.journalMillis.get());
        to.longestJournalMillis.accumulateAndGet(from.longestJournalMillis.get(), Math::max);
        to.waits.addAndGet(from.waits.get());
        to.waitMillis.addAndGet(from.waitMillis.get());
        to.failures.addAndGet(from.failures.get());
    }

    /**
     * What recording and recovery are doing, for the operator's route (v0.9.9): numbers and game ids
     * only, nothing of any game's content.
     */
    synchronized Map<String, Object> recordingStatus() {
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("enabled", recordings != null);
        if (recordings == null) {
            return status;
        }
        status.put("retention_hours", TimeUnit.MILLISECONDS.toHours(retentionMillis));
        status.put("checkpoint_interval_seconds", TimeUnit.MILLISECONDS.toSeconds(Recorder.INTERVAL_MILLIS));
        status.put("engine_build", EngineBuild.key());
        Recorder.Metrics total = new Recorder.Metrics();
        add(total, ended);
        List<Map<String, Object>> running = new ArrayList<>();
        for (Entry entry : games.values()) {
            Recorder recorder = entry.game.recorder();
            if (recorder == null || entry.game.finished()) {
                continue;
            }
            add(total, recorder.metrics());
            Map<String, Object> game = new LinkedHashMap<>();
            game.put("game_id", entry.game.id());
            game.put("journal_records", recorder.journalSeq());
            game.put("checkpoints", recorder.metrics().checkpoints.get());
            game.put("checkpoint_bytes", recorder.metrics().checkpointBytes.get());
            game.put("stopped", recorder.failure());
            game.put("replaying", entry.game.replaying());
            running.add(game);
        }
        status.put("running", running);
        Map<String, Object> games = new LinkedHashMap<>();
        games.put("recorded", recorded.get());
        games.put("not_recorded", unrecorded.get());
        status.put("games", games);
        Map<String, Object> written = new LinkedHashMap<>();
        written.put("states_taken", total.captures.get());
        written.put("states_taken_micros", total.captureMicros.get());
        written.put("longest_state_taken_micros", total.longestCaptureMicros.get());
        written.put("checkpoints", total.checkpoints.get());
        written.put("checkpoints_skipped", total.skipped.get());
        written.put("checkpoint_bytes", total.checkpointBytes.get());
        written.put("checkpoint_millis", total.checkpointMillis.get());
        written.put("longest_checkpoint_millis", total.longestCheckpointMillis.get());
        written.put("journal_records", total.records.get());
        written.put("journal_millis", total.journalMillis.get());
        written.put("longest_journal_millis", total.longestJournalMillis.get());
        written.put("answers_that_waited", total.waits.get());
        written.put("answers_waited_millis", total.waitMillis.get());
        written.put("recordings_stopped", total.failures.get());
        status.put("written", written);
        Map<String, Object> asked = new LinkedHashMap<>();
        asked.put("attached", attached.get());
        asked.put("recovered", recovered.get());
        asked.put("recovery_millis", recoveredMillis.get());
        asked.put("longest_recovery_millis", longestRecoveryMillis.get());
        asked.put("finished", answeredFinished.get());
        asked.put("refused", new LinkedHashMap<>(refused));
        status.put("asked_for_again", asked);
        long count = 0;
        long bytes = 0;
        for (Recording recording : onDisk()) {
            count++;
            bytes += recording.bytes();
        }
        Map<String, Object> disk = new LinkedHashMap<>();
        disk.put("recordings", count);
        disk.put("bytes", bytes);
        disk.put("removed", removed.get());
        status.put("on_disk", disk);
        return status;
    }

    /** The recordings in the folder, whatever state they are in. */
    private List<Recording> onDisk() {
        if (recordings == null || !Files.isDirectory(recordings)) {
            return List.of();
        }
        try (Stream<Path> folders = Files.list(recordings)) {
            return folders.filter(Files::isDirectory).map(Recording::at).toList();
        } catch (IOException e) {
            return List.of();
        }
    }

    /**
     * Removes the recordings nothing has changed for {@code retentionMillis}: of games that are
     * over (their result was there for the API to ask for all that time) and of games nobody came
     * back for. A game running here keeps its recording however quiet it is. Safe to run twice: a
     * recording is removed or it is not.
     */
    synchronized int sweepRecordings() {
        int gone = 0;
        long now = System.currentTimeMillis();
        for (Recording recording : onDisk()) {
            String id = recording.folder().getFileName().toString();
            Entry entry = games.get(id);
            if (entry != null && !entry.game.finished() || runningElsewhere.test(id)) {
                continue;
            }
            long changed = recording.lastChanged();
            if (changed != 0 && now - changed > retentionMillis) {
                recording.delete();
                gone++;
            }
        }
        removed.addAndGet(gone);
        return gone;
    }

    /** For tests (v0.9.9): every game here that is still running, as a dead process leaves them. */
    synchronized List<HumanGame> runningForTest() {
        return games.values().stream().map(entry -> entry.game).filter(game -> !game.finished()).toList();
    }

    /** Closes games idle past their timeout; drops old finished games. */
    private void sweep() {
        try {
            for (Entry entry : games.values()) {
                HumanGame game = entry.game;
                long timeout = TimeUnit.SECONDS.toMillis(game.settings().idleTimeoutSeconds());
                if (!game.finished() && game.idleMillis() > timeout && entry.closing.compareAndSet(false, true)) {
                    Thread.ofVirtual().name("human-game-idle-close").start(() -> game.close("idle_timeout"));
                }
            }
            synchronized (this) {
                evict();
            }
            if (recordings != null && sweeping && TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - lastRecordingSweepNanos)
                    >= RECORDING_SWEEP_MILLIS) {
                lastRecordingSweepNanos = System.nanoTime();
                int gone = sweepRecordings();
                if (gone > 0) {
                    System.out.println("Removed " + gone + " recordings older than "
                        + TimeUnit.MILLISECONDS.toHours(retentionMillis) + " hours");
                }
            }
        } catch (RuntimeException e) {
            System.err.println("Human game watchdog: " + e);
        }
    }

    /** Caller holds the lock. */
    private void evict() {
        long now = System.nanoTime();
        cancelled.values().removeIf(at -> TimeUnit.NANOSECONDS.toMillis(now - at) > RETAIN_CANCELLED_MILLIS);
        games.values().removeIf(entry -> entry.game.finished() && entry.finishedAtNanos != 0
            && TimeUnit.NANOSECONDS.toMillis(now - entry.finishedAtNanos) > RETAIN_FINISHED_MILLIS);
        var finished = games.values().stream()
            .filter(entry -> entry.game.finished() && entry.finishedAtNanos != 0)
            .sorted(Comparator.comparingLong(entry -> entry.finishedAtNanos))
            .toList();
        // At least as many as may run, so games that end together all stay readable for the API.
        for (int i = 0; i < finished.size() - Math.max(MAX_FINISHED, maxActive); i++) {
            games.remove(finished.get(i).game.id());
        }
    }

    private static byte[] hash(String token) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
