package com.commanderduels;

import com.google.gson.JsonObject;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.stream.Stream;

/**
 * Looks at recordings (v0.9.9) and says whether each is whole and whether this engine could take
 * its game up, without showing anything of the game: no card, no hand, no library, no deck, no
 * answer. For the operator and the developer.
 *
 * <pre>
 * java -cp /app/engine.jar:/app/lib/*:/app/plugins/* com.commanderduels.RecordingTool FOLDER [GAME_ID] [options]
 *
 *   FOLDER          the recordings' folder (CD_ENGINE_RECORDINGS), or one recording's own folder
 *   GAME_ID         one game; without it every recording in the folder is listed, one line each
 *   --verify        also reads each checkpoint's state back and checks that it is the game that
 *                   was saved (slower: it makes the game's objects)
 *   --show-private  also prints the journal's records in full: what each seat answered, and what
 *                   stopped a recording that stopped, in the error's own words (which may name a
 *                   card). This is private to the players until the game is over, and is never
 *                   printed without being asked for
 * </pre>
 *
 * It exits with 0 when every recording it looked at is whole, 1 when one is not, 2 when it was
 * called wrongly. It only reads: a running engine's recordings can be looked at while it runs (a
 * checkpoint being replaced at that moment may be reported missing).
 */
public final class RecordingTool {
    private RecordingTool() {}

    public static void main(String[] args) {
        System.exit(run(args, System.out));
    }

    static int run(String[] args, PrintStream out) {
        List<String> names = new ArrayList<>();
        boolean verify = false;
        boolean showPrivate = false;
        for (String arg : args) {
            switch (arg) {
                case "--verify" -> verify = true;
                case "--show-private" -> showPrivate = true;
                default -> {
                    if (arg.startsWith("--")) {
                        out.println("Unknown option " + arg);
                        return usage(out);
                    }
                    names.add(arg);
                }
            }
        }
        if (names.isEmpty() || names.size() > 2) {
            return usage(out);
        }
        Path folder = Path.of(names.get(0));
        if (!Files.isDirectory(folder)) {
            out.println("No such folder: " + folder);
            return 2;
        }
        if (names.size() == 2) {
            Recording recording;
            try {
                recording = Recording.of(folder, names.get(1));
            } catch (IllegalArgumentException e) {
                out.println("Not a game id: " + names.get(1));
                return 2;
            }
            return one(recording, verify, showPrivate, out) ? 0 : 1;
        }
        if (Files.isRegularFile(folder.resolve(Recording.MANIFEST))) {
            return one(Recording.at(folder), verify, showPrivate, out) ? 0 : 1;
        }
        return all(folder, verify, out) ? 0 : 1;
    }

    private static int usage(PrintStream out) {
        out.println("Usage: RecordingTool FOLDER [GAME_ID] [--verify] [--show-private]");
        return 2;
    }

    /** One line for each recording in the folder; whether all of them are whole. */
    private static boolean all(Path folder, boolean verify, PrintStream out) {
        List<Path> folders;
        try (Stream<Path> entries = Files.list(folder)) {
            folders = entries.filter(Files::isDirectory).sorted().toList();
        } catch (IOException e) {
            out.println("The folder cannot be read: " + e.getMessage());
            return false;
        }
        out.println("This engine's build: " + EngineBuild.key());
        out.println(folders.size() + " recordings in " + folder.toAbsolutePath());
        boolean whole = true;
        long bytes = 0;
        for (Path entry : folders) {
            Recording recording = Recording.at(entry);
            Found found = look(recording, verify);
            bytes += recording.bytes();
            whole &= found.problems.isEmpty();
            out.printf("%s  %-11s %-12s %3d seats  turn %-3s %5d records  %d checkpoints  %7d KiB  changed %s ago%s%n",
                entry.getFileName(), found.state, found.format, found.seats, found.turn, found.records,
                found.checkpoints, recording.bytes() / 1024, ago(recording.lastChanged()),
                found.problems.isEmpty() ? "" : "  PROBLEMS: " + String.join("; ", found.problems));
        }
        out.println("Total " + bytes / 1024 + " KiB; " + (whole ? "every recording is whole" : "not every recording is whole"));
        return whole;
    }

    /** What looking at a recording found, with nothing of the game in it. */
    private static final class Found {
        String state = "unreadable";
        String format = "?";
        int seats;
        String turn = "?";
        long records;
        int checkpoints;
        final List<String> problems = new ArrayList<>();
        final List<String> lines = new ArrayList<>();
    }

    private static Found look(Recording recording, boolean verify) {
        Found found = new Found();
        Recording.Manifest manifest;
        try {
            manifest = recording.manifest();
        } catch (Recording.Unusable e) {
            found.problems.add(e.getMessage());
            return found;
        }
        found.format = manifest.binding().format();
        found.seats = manifest.seats().size();
        boolean ours = EngineBuild.key().equals(manifest.binding().engineBuild());
        found.lines.add("Game " + manifest.gameId() + ", " + (manifest.service() ? "a service game" : "a development game")
            + ", created " + manifest.createdAt());
        found.lines.add("Format " + manifest.binding().format() + ", rules profile " + manifest.binding().rulesProfile());
        found.lines.add("Recorded by engine build " + manifest.binding().engineBuild() + " (XMage "
            + manifest.binding().xmageVersion() + ", " + manifest.binding().xmageCommit() + "): "
            + (ours ? "this engine's build" : "NOT this engine's build, which is " + EngineBuild.key()));
        for (Recording.SeatDeck seat : manifest.seats()) {
            found.lines.add("  seat " + seat.seat() + ": " + seat.player() + ", deck " + seat.deck() + " (digest "
                + seat.deckSha256().substring(0, 12) + ")");
        }
        Optional<JsonObject> result = recording.result();
        Recording.Journal journal;
        try {
            journal = recording.readJournal();
        } catch (IOException e) {
            found.problems.add("The journal cannot be read: " + e.getMessage());
            return found;
        }
        found.records = journal.records().size();
        Map<String, Integer> types = new TreeMap<>();
        Map<Integer, Integer> answers = new TreeMap<>();
        int recoveries = 0;
        long dropped = 0;
        boolean checkpointed = false;
        for (JsonObject record : journal.records()) {
            String type = record.get("type").getAsString();
            types.merge(type, 1, Integer::sum);
            if (type.equals("answer")) {
                answers.merge(record.get("seat").getAsInt(), 1, Integer::sum);
            } else if (type.equals("recovered")) {
                recoveries++;
            } else if (type.equals("replayed") && record.has("dropped")) {
                dropped += record.get("dropped").getAsLong();
            } else if (type.equals(Recorder.CHECKPOINTED)) {
                checkpointed = true;
            }
        }
        found.lines.add("Journal: " + journal.records().size() + " records " + types + ", " + journal.validBytes()
            + " bytes" + (journal.records().isEmpty() ? "" : ", from " + journal.records().get(0).get("at").getAsString()
            + " to " + journal.records().get(journal.records().size() - 1).get("at").getAsString()));
        found.lines.add("  answers by seat: " + answers + "; taken up " + recoveries + " times; answers a recovery"
            + " could not play again: " + dropped);
        if (journal.problem() != null) {
            found.problems.add("The journal ends at record " + journal.lastSeq() + ": " + journal.problem() + " ("
                + journal.ignoredBytes() + " bytes after it are not used)");
        }
        List<Integer> seqs;
        try {
            seqs = recording.checkpointSeqs();
        } catch (IOException e) {
            found.problems.add("The checkpoints cannot be listed: " + e.getMessage());
            return found;
        }
        found.checkpoints = seqs.size();
        boolean usable = false;
        for (int index = seqs.size() - 1; index >= 0; index--) {
            int seq = seqs.get(index);
            try {
                Recording.CheckpointHeader header = recording.checkpointHeader(seq);
                List<String> wrong = new ArrayList<>();
                if (!EngineBuild.key().equals(header.engineBuild())) {
                    wrong.add("another engine build's");
                }
                if (header.journalSeq() > journal.lastSeq()) {
                    wrong.add("ahead of the journal (record " + header.journalSeq() + " of " + journal.lastSeq() + ")");
                }
                if (verify && wrong.isEmpty()) {
                    Recording.Loaded loaded = recording.checkpoint(seq);
                    if (!header.stateDigest().equals(Checkpoint.digest(loaded.checkpoint().game()))) {
                        wrong.add("does not hold the game that was saved");
                    }
                }
                if (index == seqs.size() - 1) {
                    found.turn = String.valueOf(header.turn());
                }
                found.lines.add("Checkpoint " + seq + ": turn " + header.turn() + ", " + header.step() + ", taken "
                    + header.takenAt() + ", stands on journal record " + header.journalSeq() + ", "
                    + header.bodyBytes() / 1024 + " KiB (" + header.rawBytes() / 1024 + " KiB unpacked), checksum holds"
                    + (verify && wrong.isEmpty() ? ", state read back and is the game that was saved" : "")
                    + (wrong.isEmpty() ? "" : "; NOT USABLE: " + String.join(", ", wrong)));
                if (wrong.isEmpty()) {
                    usable = true;
                } else {
                    found.problems.add("Checkpoint " + seq + " is " + String.join(", ", wrong));
                }
            } catch (Recording.Unusable e) {
                found.lines.add("Checkpoint " + seq + ": NOT USABLE: " + e.getMessage());
                found.problems.add(e.getMessage());
            }
        }
        if (result.isPresent()) {
            found.state = "finished";
            JsonObject outcome = result.get();
            found.lines.add("Result: " + (outcome.has("kind") ? outcome.get("kind").getAsString() : "?")
                + (outcome.has("turns") ? " after " + outcome.get("turns") + " turns" : "")
                + ". The game is over and is not taken up again" + (seqs.isEmpty() ? "" : "; its checkpoints are still"
                + " here (the engine removes them as the game ends)"));
        } else if (recording.stopped().isPresent()) {
            JsonObject note = recording.stopped().get();
            found.state = "stopped";
            found.problems.add("The recording stopped" + (note.has("at") ? " at " + note.get("at").getAsString() : "")
                + (note.has("why") ? " (" + note.get("why").getAsString() + ")" : "")
                + " and the game went on without it: it cannot be taken up");
        } else if (!ours) {
            found.state = "other build";
            found.lines.add("This engine cannot take the game up: it was recorded by another build");
        } else if (usable) {
            found.state = "resumable";
            found.lines.add("This engine can take the game up from its newest usable checkpoint");
        } else if (seqs.isEmpty() && !checkpointed) {
            found.state = "resumable";
            found.lines.add("The game was interrupted before its first checkpoint (in its mulligans): this engine"
                + " can deal it again from its seed");
        } else {
            found.state = "lost";
            found.problems.add("The game had checkpoints and none can be used: it cannot be taken up");
        }
        return found;
    }

    private static boolean one(Recording recording, boolean verify, boolean showPrivate, PrintStream out) {
        if (!Files.isDirectory(recording.folder())) {
            out.println("No recording in " + recording.folder());
            return false;
        }
        Found found = look(recording, verify);
        found.lines.forEach(out::println);
        out.println("On disk: " + recording.bytes() / 1024 + " KiB, last changed " + ago(recording.lastChanged()) + " ago");
        if (found.problems.isEmpty()) {
            out.println("The recording is whole (" + found.state + ")");
        } else {
            out.println("PROBLEMS (" + found.state + "):");
            found.problems.forEach(problem -> out.println("  " + problem));
        }
        if (showPrivate) {
            Optional<JsonObject> stopped = recording.stopped();
            if (stopped.isPresent() && stopped.get().has("detail")) {
                out.println("What stopped the recording, in full (it may name a card of the game): "
                    + stopped.get().get("detail").getAsString());
            }
            out.println("The journal in full, as asked (--show-private): what each seat answered is private to the"
                + " players until the game is over.");
            try {
                for (JsonObject record : recording.readJournal().records()) {
                    out.println("  " + record);
                }
            } catch (IOException e) {
                out.println("  The journal cannot be read: " + e.getMessage());
            }
        }
        return found.problems.isEmpty();
    }

    private static String ago(long millis) {
        if (millis == 0) {
            return "?";
        }
        Duration age = Duration.between(Instant.ofEpochMilli(millis), Instant.now());
        if (age.toHours() >= 48) {
            return age.toDays() + " d";
        }
        if (age.toMinutes() >= 120) {
            return age.toHours() + " h";
        }
        return age.toMinutes() >= 2 ? age.toMinutes() + " min" : Math.max(0, age.toSeconds()) + " s";
    }
}
