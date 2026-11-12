package com.commanderduels;

import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.io.InvalidClassException;
import java.io.ObjectInputFilter;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import java.util.zip.CRC32;
import java.util.zip.Deflater;
import java.util.zip.DeflaterOutputStream;
import java.util.zip.InflaterInputStream;

/**
 * One game's recording on disk (v0.9.9): what the engine needs to take the game up again after it
 * was interrupted, in a folder of its own named for the game.
 *
 * <ul>
 *   <li>{@code manifest.json}, written once when the game is created: the game, the request it was
 *       made from (with its seed and its decks) and what it is bound to ({@link Binding}).
 *   <li>{@code checkpoint-NNNNNNNNNN.bin}: the game's whole state as a player received priority
 *       ({@link Checkpoint}), the newest two kept. A header (which checkpoint, where the journal
 *       stood, sizes and a checksum) and the state, serialized and compressed.
 *   <li>{@code journal.bin}: every decision a seat made and every command it sent, appended in
 *       order and forced to disk before the engine acts on it. Each record is framed with its
 *       length and a checksum.
 *   <li>{@code result.json}: the result, once the game has one. A recording with a result is over.
 *   <li>{@code stopped.json}: written if the recording could not be kept up (a disk that refused a
 *       write, states that could not be serialized). The game went on without it, so the recording
 *       is behind its game, and no game is ever made from it.
 * </ul>
 *
 * <p>Recovery reads the newest checkpoint that is whole and plays the journal's records after it
 * ({@link Recorder}, {@link HumanGame}). Nothing here trusts the files: a manifest that does not
 * parse, a checkpoint whose checksum or length is wrong, and a journal frame that is cut short or
 * damaged are told apart and reported, and the reader goes on with what is whole. A journal's
 * damaged tail (the usual mark of a write cut off by the interruption itself) ends the journal
 * there. Files are written to a temporary name, forced to disk and renamed, so a file that exists
 * is complete.
 *
 * <p>A recording holds everything about a game, each player's hand, library and deck included. It
 * lives in the engine's own folder ({@code CD_ENGINE_RECORDINGS}), is reached by no route, and
 * {@link RecordingTool} reports on one without showing any of that.
 */
final class Recording {
    /** The layout's version: a recording with another is refused. */
    static final int FORMAT = 1;
    static final String MANIFEST = "manifest.json";
    static final String JOURNAL = "journal.bin";
    static final String RESULT = "result.json";
    static final String STOPPED = "stopped.json";
    /** How many checkpoints are kept: the newest, and the one before it should the newest be damaged. */
    static final int KEPT_CHECKPOINTS = 2;
    /** A journal record is small; a length beyond this is damage, not a record. */
    static final int MAX_RECORD_BYTES = 1 << 20;
    /** A checkpoint's state beyond this is refused unread. */
    static final long MAX_CHECKPOINT_BYTES = 512L << 20;
    private static final byte[] MAGIC = {'C', 'D', 'C', 'K'};
    private static final Pattern CHECKPOINT_FILE = Pattern.compile("checkpoint-(\\d{10})\\.bin");
    private static final Pattern GAME_ID = Pattern.compile("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    /**
     * What a checkpoint may hold: XMage's classes, the engine's and the JDK's, and the libraries
     * XMage's game objects use. Anything else in a file is refused before it is made.
     */
    private static final ObjectInputFilter CLASSES = ObjectInputFilter.Config.createFilter(
        "mage.**;org.mage.**;com.commanderduels.**;java.**;javax.**;com.google.common.**;org.apache.log4j.**;"
            + "maxdepth=20000;!*");

    /**
     * What a recording is bound to. A game goes on only in an engine with the same build: the same
     * engine code, XMage, patches and card implementations, which {@link EngineBuild} sums up in one
     * key. The other fields say what that build was, for a person reading a manifest.
     */
    record Binding(String engineBuild, String xmageVersion, String xmageCommit, String format, String rulesProfile) {}

    /** A seat as the manifest lists it: who sits there and a digest of its deck, never the deck. */
    record SeatDeck(int seat, String player, String deck, String deckSha256) {}

    /**
     * @param seed    the game's seed, as the request gave it or the engine drew it
     * @param service whether the game is the API's (a service game) or a development game
     * @param request the request's body as it was received: the decks are in it
     */
    record Manifest(int format, String gameId, String createdAt, Binding binding, boolean service, long seed,
                    List<SeatDeck> seats, String request) {}

    /** A checkpoint's header: what it is and what must hold for its state to be read. */
    record CheckpointHeader(int seq, long journalSeq, int turn, String step, String takenAt, long bodyBytes,
                            long rawBytes, long bodyCrc32, String stateDigest, String engineBuild) {}

    /** A checkpoint read whole: its header and its state. */
    record Loaded(CheckpointHeader header, Checkpoint checkpoint) {}

    /** What reading a journal found: the records that are whole, in order, and what was not. */
    record Journal(List<JsonObject> records, long validBytes, long ignoredBytes, String problem) {
        long lastSeq() {
            return records.isEmpty() ? 0 : records.get(records.size() - 1).get("seq").getAsLong();
        }
    }

    /** A recording that cannot be used, and why, in words fit for a log and an operator. */
    static final class Unusable extends Exception {
        private static final long serialVersionUID = 1L;
        /** unreadable, incompatible, unrecoverable, finished or missing */
        final String code;

        Unusable(String code, String message) {
            super(message);
            this.code = code;
        }

        Unusable(String code, String message, Throwable cause) {
            super(message, cause);
            this.code = code;
        }
    }

    private final Path folder;

    private Recording(Path folder) {
        this.folder = folder;
    }

    /** The recording of a game under the recordings' folder; nothing is read or made yet. */
    static Recording of(Path root, String gameId) {
        if (!GAME_ID.matcher(gameId).matches()) {
            throw new IllegalArgumentException("Not a game id");
        }
        return new Recording(root.resolve(gameId));
    }

    /** The recording in a folder, for the tool and the tests. */
    static Recording at(Path folder) {
        return new Recording(folder);
    }

    Path folder() {
        return folder;
    }

    boolean exists() {
        return Files.isRegularFile(folder.resolve(MANIFEST));
    }

    // ------------------------------------------------------------------ the manifest and the result

    /** Makes the folder and writes the manifest; a recording that exists is not written over. */
    void create(Manifest manifest) throws IOException {
        Files.createDirectories(folder);
        if (exists()) {
            throw new IOException("A recording of game " + manifest.gameId() + " exists");
        }
        writeWhole(MANIFEST, EngineServer.JSON.toJson(manifest).getBytes(StandardCharsets.UTF_8));
    }

    Manifest manifest() throws Unusable {
        String text;
        try {
            text = Files.readString(folder.resolve(MANIFEST));
        } catch (NoSuchFileException e) {
            throw new Unusable("missing", "The game has no recording");
        } catch (IOException e) {
            throw new Unusable("unreadable", "The recording's manifest cannot be read: " + e.getMessage(), e);
        }
        Manifest manifest;
        try {
            manifest = EngineServer.JSON.fromJson(text, Manifest.class);
        } catch (JsonParseException e) {
            throw new Unusable("unreadable", "The recording's manifest is damaged", e);
        }
        if (manifest == null || manifest.gameId() == null || manifest.binding() == null || manifest.request() == null
                || manifest.seats() == null) {
            throw new Unusable("unreadable", "The recording's manifest is incomplete");
        }
        if (manifest.format() != FORMAT) {
            throw new Unusable("incompatible", "The recording is in layout " + manifest.format()
                + "; this engine reads layout " + FORMAT);
        }
        return manifest;
    }

    /** Writes the game's result: from now on the recording is over, and no game is made from it. */
    void finish(JsonObject result) throws IOException {
        writeWhole(RESULT, result.toString().getBytes(StandardCharsets.UTF_8));
    }

    /** The result, if the game has one. A result that cannot be read still marks the recording over. */
    Optional<JsonObject> result() {
        Path file = folder.resolve(RESULT);
        if (!Files.exists(file)) {
            return Optional.empty();
        }
        try {
            return Optional.of(JsonParser.parseString(Files.readString(file)).getAsJsonObject());
        } catch (IOException | RuntimeException e) {
            JsonObject damaged = new JsonObject();
            damaged.addProperty("kind", "error");
            damaged.addProperty("damaged", true);
            return Optional.of(damaged);
        }
    }

    /**
     * Notes that the recording stopped while its game went on: from now on no game is made from it.
     * {@code why} is for anyone who may know of the game; {@code detail} (an exception's own words,
     * which may name a card's class) is for the operator who asks for it.
     */
    void stop(String why, String detail) throws IOException {
        JsonObject note = new JsonObject();
        note.addProperty("at", Instant.now().toString());
        note.addProperty("why", why);
        if (detail != null) {
            note.addProperty("detail", detail);
        }
        writeWhole(STOPPED, note.toString().getBytes(StandardCharsets.UTF_8));
    }

    /** The note that the recording stopped, if it did. A note that cannot be read still says so. */
    Optional<JsonObject> stopped() {
        Path file = folder.resolve(STOPPED);
        if (!Files.exists(file)) {
            return Optional.empty();
        }
        try {
            return Optional.of(JsonParser.parseString(Files.readString(file)).getAsJsonObject());
        } catch (IOException | RuntimeException e) {
            JsonObject damaged = new JsonObject();
            damaged.addProperty("why", "its note cannot be read");
            return Optional.of(damaged);
        }
    }

    /**
     * Removes the manifest, which leaves no recording to speak of: the last way to keep a recording
     * that stopped from ever being used, for when it cannot even be noted ({@link #stop}). Taking a
     * file away needs no room on a full disk. Returns whether the manifest is gone.
     */
    boolean disown() {
        try {
            Files.deleteIfExists(folder.resolve(MANIFEST));
            return true;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    // ------------------------------------------------------------------ the journal

    /**
     * The journal's writer: appends a record and forces it to disk before it returns. Opening it
     * cuts the file back to its last whole record, so a tail the interruption left half written is
     * gone before anything follows it.
     */
    final class Appender implements AutoCloseable {
        private final FileChannel channel;
        private long seq;

        private Appender(Journal found) throws IOException {
            channel = FileChannel.open(folder.resolve(JOURNAL), StandardOpenOption.CREATE, StandardOpenOption.WRITE);
            channel.truncate(found.validBytes());
            channel.position(found.validBytes());
            channel.force(true);
            seq = found.lastSeq();
        }

        /** The number the last record written has; 0 before the first. */
        synchronized long seq() {
            return seq;
        }

        /** Appends the record under the next number, which it is given, and returns that number. */
        synchronized long append(JsonObject record) throws IOException {
            record.addProperty("seq", seq + 1);
            record.addProperty("at", Instant.now().toString());
            byte[] payload = record.toString().getBytes(StandardCharsets.UTF_8);
            if (payload.length > MAX_RECORD_BYTES) {
                throw new IOException("A journal record of " + payload.length + " bytes is too large");
            }
            ByteBuffer frame = ByteBuffer.allocate(8 + payload.length);
            frame.putInt(payload.length);
            frame.putInt((int) crc(payload));
            frame.put(payload);
            frame.flip();
            long start = channel.position();
            try {
                while (frame.hasRemaining()) {
                    channel.write(frame);
                }
                channel.force(false);
            } catch (IOException e) {
                // Whatever part was written is not a record: the file ends where it did before.
                try {
                    channel.truncate(start);
                    channel.position(start);
                } catch (IOException ignored) {
                    // the reader stops at the damaged frame all the same
                }
                throw e;
            }
            seq++;
            return seq;
        }

        @Override
        public synchronized void close() throws IOException {
            channel.close();
        }
    }

    /** Opens the journal for writing after the records it holds. */
    Appender appender() throws IOException {
        Files.createDirectories(folder);
        return new Appender(readJournal());
    }

    /**
     * Reads the journal: every record that is whole, in order, up to the first frame that is cut
     * short, fails its checksum, is not a record or is out of order. What follows that point is
     * not read; its size and what was wrong are reported.
     */
    Journal readJournal() throws IOException {
        Path file = folder.resolve(JOURNAL);
        List<JsonObject> records = new ArrayList<>();
        if (!Files.exists(file)) {
            return new Journal(records, 0, 0, null);
        }
        byte[] bytes = Files.readAllBytes(file);
        long valid = 0;
        String problem = null;
        long expected = 1;
        ByteBuffer buffer = ByteBuffer.wrap(bytes);
        while (buffer.remaining() > 0) {
            if (buffer.remaining() < 8) {
                problem = "a record's frame is cut short";
                break;
            }
            int length = buffer.getInt();
            int sum = buffer.getInt();
            if (length < 0 || length > MAX_RECORD_BYTES) {
                problem = "a record's length is not one";
                break;
            }
            if (buffer.remaining() < length) {
                problem = "a record is cut short";
                break;
            }
            byte[] payload = new byte[length];
            buffer.get(payload);
            if ((int) crc(payload) != sum) {
                problem = "a record fails its checksum";
                break;
            }
            JsonObject record;
            try {
                record = JsonParser.parseString(new String(payload, StandardCharsets.UTF_8)).getAsJsonObject();
                if (record.get("seq").getAsLong() != expected || !record.has("type")) {
                    problem = "a record is out of order";
                    break;
                }
            } catch (RuntimeException e) {
                problem = "a record is not a record";
                break;
            }
            records.add(record);
            expected++;
            valid = buffer.position();
        }
        return new Journal(List.copyOf(records), valid, bytes.length - valid, problem);
    }

    // ------------------------------------------------------------------ checkpoints

    /** The state, serialized and compressed, and the sizes and checksum its header carries. */
    record Packed(byte[] body, long rawBytes, long crc32) {}

    /** Serializes and compresses a checkpoint's state; its own method so that what it costs can be timed. */
    static Packed pack(Checkpoint checkpoint) throws IOException {
        var counted = new CountingStream();
        var packed = new ByteArrayOutputStream(1 << 20);
        // Fast compression: a checkpoint is written many times and read once in a while.
        var deflater = new Deflater(Deflater.BEST_SPEED);
        try (var out = new ObjectOutputStream(new Tee(new DeflaterOutputStream(packed, deflater, 1 << 16), counted))) {
            out.writeObject(checkpoint);
        } finally {
            deflater.end();
        }
        byte[] body = packed.toByteArray();
        return new Packed(body, counted.count, crc(body));
    }

    /** Writes a checkpoint under its number, then drops those older than the newest {@link #KEPT_CHECKPOINTS}. */
    void writeCheckpoint(CheckpointHeader header, Packed packed) throws IOException {
        byte[] head = EngineServer.JSON.toJson(header).getBytes(StandardCharsets.UTF_8);
        var file = new ByteArrayOutputStream(packed.body().length + head.length + 16);
        try (var out = new DataOutputStream(file)) {
            out.write(MAGIC);
            out.writeShort(FORMAT);
            out.writeInt(head.length);
            out.write(head);
            out.write(packed.body());
        }
        writeWhole(checkpointName(header.seq()), file.toByteArray());
        List<Integer> kept = checkpointSeqs();
        for (int index = 0; index < kept.size() - KEPT_CHECKPOINTS; index++) {
            Files.deleteIfExists(folder.resolve(checkpointName(kept.get(index))));
        }
    }

    private static String checkpointName(int seq) {
        return String.format("checkpoint-%010d.bin", seq);
    }

    /** The checkpoints' numbers, oldest first. */
    List<Integer> checkpointSeqs() throws IOException {
        if (!Files.isDirectory(folder)) {
            return List.of();
        }
        try (Stream<Path> files = Files.list(folder)) {
            return files.map(path -> CHECKPOINT_FILE.matcher(path.getFileName().toString()))
                .filter(Matcher::matches).map(matcher -> Integer.parseInt(matcher.group(1)))
                .sorted(Comparator.naturalOrder()).toList();
        }
    }

    /** A checkpoint's header, read and checked against the file without reading its state. */
    CheckpointHeader checkpointHeader(int seq) throws Unusable {
        return read(seq, false).header();
    }

    /** A checkpoint read whole, its state made again. */
    Loaded checkpoint(int seq) throws Unusable {
        return read(seq, true);
    }

    private Loaded read(int seq, boolean state) throws Unusable {
        Path file = folder.resolve(checkpointName(seq));
        byte[] bytes;
        try {
            if (Files.size(file) > MAX_CHECKPOINT_BYTES) {
                throw new Unusable("unreadable", "Checkpoint " + seq + " is larger than a checkpoint can be");
            }
            bytes = Files.readAllBytes(file);
        } catch (IOException e) {
            throw new Unusable("unreadable", "Checkpoint " + seq + " cannot be read: " + e.getMessage(), e);
        }
        CheckpointHeader header;
        int bodyStart;
        try (var in = new DataInputStream(new ByteArrayInputStream(bytes))) {
            byte[] magic = in.readNBytes(MAGIC.length);
            if (!java.util.Arrays.equals(magic, MAGIC)) {
                throw new Unusable("unreadable", "Checkpoint " + seq + " is not a checkpoint");
            }
            int format = in.readUnsignedShort();
            if (format != FORMAT) {
                throw new Unusable("incompatible", "Checkpoint " + seq + " is in layout " + format
                    + "; this engine reads layout " + FORMAT);
            }
            int length = in.readInt();
            if (length <= 0 || length > MAX_RECORD_BYTES) {
                throw new Unusable("unreadable", "Checkpoint " + seq + " has a damaged header");
            }
            byte[] head = in.readNBytes(length);
            if (head.length < length) {
                throw new Unusable("unreadable", "Checkpoint " + seq + " is cut short");
            }
            header = EngineServer.JSON.fromJson(new String(head, StandardCharsets.UTF_8), CheckpointHeader.class);
            bodyStart = MAGIC.length + 2 + 4 + length;
        } catch (IOException | JsonParseException e) {
            throw new Unusable("unreadable", "Checkpoint " + seq + " has a damaged header", e);
        }
        if (header == null || header.seq() != seq) {
            throw new Unusable("unreadable", "Checkpoint " + seq + " has another checkpoint's header");
        }
        int bodyLength = bytes.length - bodyStart;
        if (bodyLength != header.bodyBytes()) {
            throw new Unusable("unreadable", "Checkpoint " + seq + " is cut short: " + bodyLength + " of "
                + header.bodyBytes() + " bytes");
        }
        var sum = new CRC32();
        sum.update(bytes, bodyStart, bodyLength);
        if (sum.getValue() != header.bodyCrc32()) {
            throw new Unusable("unreadable", "Checkpoint " + seq + " fails its checksum");
        }
        if (!state) {
            return new Loaded(header, null);
        }
        try (var in = new ObjectInputStream(
                new InflaterInputStream(new ByteArrayInputStream(bytes, bodyStart, bodyLength), new java.util.zip.Inflater(), 1 << 16))) {
            in.setObjectInputFilter(CLASSES);
            return new Loaded(header, (Checkpoint) in.readObject());
        } catch (InvalidClassException e) {
            // The classes changed since it was written, or the file names one no checkpoint holds.
            throw new Unusable("incompatible", "Checkpoint " + seq + " was written by another engine build: "
                + e.getMessage(), e);
        } catch (IOException | ClassNotFoundException | RuntimeException e) {
            throw new Unusable("unreadable", "Checkpoint " + seq + " cannot be made into a game: " + e, e);
        }
    }

    // ------------------------------------------------------------------ files

    /** Writes a file whole: to a temporary name, forced to disk, then renamed over the name. */
    private void writeWhole(String name, byte[] bytes) throws IOException {
        Path target = folder.resolve(name);
        Path temporary = folder.resolve(name + ".tmp");
        try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.CREATE,
                StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE)) {
            ByteBuffer buffer = ByteBuffer.wrap(bytes);
            while (buffer.hasRemaining()) {
                channel.write(buffer);
            }
            channel.force(true);
        }
        try {
            Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING);
        }
        // The rename itself is in the folder: force that too, where the system allows it.
        try (FileChannel directory = FileChannel.open(folder, StandardOpenOption.READ)) {
            directory.force(true);
        } catch (IOException | UnsupportedOperationException ignored) {
            // some file systems cannot force a folder; the file's own bytes are safe
        }
    }

    /**
     * Removes the checkpoints: for a game that is over, whose recording keeps only its manifest,
     * its journal and its result. A checkpoint is a game's whole state, and is of no use once the
     * game cannot be taken up.
     */
    void dropCheckpoints() {
        try {
            for (int seq : checkpointSeqs()) {
                Files.deleteIfExists(folder.resolve(checkpointName(seq)));
            }
        } catch (IOException e) {
            System.err.println("Recording " + folder.getFileName() + ": its checkpoints could not be removed: "
                + e.getMessage());
        }
    }

    /** When any of the recording's files last changed, in milliseconds since the epoch; 0 for none. */
    long lastChanged() {
        if (!Files.isDirectory(folder)) {
            return 0;
        }
        try (Stream<Path> files = Files.list(folder)) {
            return files.mapToLong(path -> {
                try {
                    return Files.getLastModifiedTime(path).toMillis();
                } catch (IOException e) {
                    return 0;
                }
            }).max().orElse(0);
        } catch (IOException e) {
            return 0;
        }
    }

    /** Removes the recording's folder and everything in it. */
    void delete() {
        if (!Files.isDirectory(folder)) {
            return;
        }
        try (Stream<Path> files = Files.walk(folder)) {
            files.sorted(Comparator.reverseOrder()).forEach(path -> {
                try {
                    Files.deleteIfExists(path);
                } catch (IOException e) {
                    throw new UncheckedIOException(e);
                }
            });
        } catch (IOException | UncheckedIOException e) {
            System.err.println("Recording " + folder.getFileName() + " could not be removed: " + e.getMessage());
        }
    }

    /** How many bytes the recording's files take. */
    long bytes() {
        if (!Files.isDirectory(folder)) {
            return 0;
        }
        try (Stream<Path> files = Files.list(folder)) {
            return files.mapToLong(path -> {
                try {
                    return Files.size(path);
                } catch (IOException e) {
                    return 0;
                }
            }).sum();
        } catch (IOException e) {
            return 0;
        }
    }

    static long crc(byte[] bytes) {
        var sum = new CRC32();
        sum.update(bytes);
        return sum.getValue();
    }

    /** Counts the bytes written through it. */
    private static final class CountingStream extends java.io.OutputStream {
        long count;

        @Override
        public void write(int b) {
            count++;
        }

        @Override
        public void write(byte[] b, int off, int len) {
            count += len;
        }
    }

    /** Writes to one stream and counts through another. */
    private static final class Tee extends java.io.FilterOutputStream {
        private final CountingStream counted;

        Tee(java.io.OutputStream out, CountingStream counted) {
            super(out);
            this.counted = counted;
        }

        @Override
        public void write(int b) throws IOException {
            out.write(b);
            counted.write(b);
        }

        @Override
        public void write(byte[] b, int off, int len) throws IOException {
            out.write(b, off, len);
            counted.write(b, off, len);
        }
    }
}
