package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

/**
 * Recorded games for the engine's tests (v0.9.9): starting one with its recording, leaving it as a
 * dead process would ({@link HumanGame#interrupt}), taking it up again from what is on disk, and
 * reading what each seat is shown, so that before and after can be compared.
 */
final class Recordings {
    private Recordings() {}

    /** A request's body, as the service route takes it: the recording's manifest keeps it. */
    static String body(long seed, String format, int skill, int turnCap, String... seats) {
        JsonObject json = new JsonObject();
        json.addProperty("seed", seed);
        json.addProperty("format", format);
        json.addProperty("skill", skill);
        json.addProperty("turn_cap", turnCap);
        json.addProperty("idle_timeout_seconds", 600);
        JsonArray array = new JsonArray();
        for (String seat : seats) {
            // "human:deck" or "bot:deck"
            int colon = seat.indexOf(':');
            JsonObject entry = new JsonObject();
            entry.addProperty("player", seat.substring(0, colon));
            entry.addProperty("deck", seat.substring(colon + 1));
            array.add(entry);
        }
        json.add("seats", array);
        return json.toString();
    }

    /** Starts a game from a request's body, with its recording under {@code root}. */
    static HumanGame start(Path root, String body, HumanGame.Hooks hooks) throws Exception {
        HumanGameRequest request = HumanGameRequest.parse(body, () -> 1L, true);
        String id = UUID.randomUUID().toString();
        Recording recording = Recording.of(root, id);
        Recorder recorder = Recorder.create(recording,
            Recovery.manifest(id, request, body, true, request.format().rulesProfile(request.seats().size())));
        var game = new HumanGame(id, request, SeatChecks.DECKS, finished -> {}, hooks, recorder);
        if (hooks instanceof SeatChecks check) {
            check.game = game;
        }
        game.allowInspection();
        game.start();
        return game;
    }

    /** Takes a game up again from its recording, and starts it. */
    static Recovery.Restored restore(Path root, String id, HumanGame.Hooks hooks) throws Recording.Unusable {
        Recovery.Restored restored = Recovery.restore(Recording.of(root, id), SeatChecks.DECKS, finished -> {}, hooks);
        if (hooks instanceof SeatChecks check) {
            check.game = restored.game();
        }
        restored.game().allowInspection();
        restored.game().start();
        return restored;
    }

    /**
     * What a game shows at one moment: each human seat's view, status and open prompt (by what it
     * asks, {@link Prompts.Prompt#print}), its log, and every hand and library as SysOp's inspection
     * reads them. Two of these are equal when no seat could tell the two moments apart, whatever it
     * may look at.
     */
    record Shown(List<SeatShown> seats, HumanGame.Inspection inspection, ObjectRefs refs) {}

    record SeatShown(int seat, String status, SeatView view, String promptKind, String promptPrint, Integer promptFor,
                     List<String> options, List<HumanGame.LogLine> log, long revision) {}

    /** Reads what the game shows; it must be waiting for a seat (a prompt is open). */
    static Shown shown(HumanGame game) throws InterruptedException {
        List<SeatShown> seats = new ArrayList<>();
        for (int seat : game.humanSeats()) {
            HumanGame.Snapshot snapshot = game.snapshot(seat, -1, 0, 0);
            Prompts.Prompt prompt = game.openPrompt(seat);
            List<String> options = new ArrayList<>();
            if (snapshot.prompt() != null) {
                snapshot.prompt().options().forEach(option -> options.add(option.action() + " " + option.label()
                    + " " + option.objectId() + " " + option.seat() + " " + option.selected()));
                options.sort(null);
            }
            // The whole log, in pages.
            List<HumanGame.LogLine> log = new ArrayList<>();
            for (int from = 0; from < snapshot.logCount(); from += HumanGame.MAX_LOG_PAGE) {
                log.addAll(game.snapshot(seat, -1, 0, from).log());
            }
            seats.add(new SeatShown(seat, snapshot.status(), snapshot.view(),
                snapshot.prompt() == null ? null : snapshot.prompt().kind(),
                snapshot.prompt() == null || prompt == null ? null : prompt.print(),
                snapshot.prompt() == null ? null : snapshot.prompt().forSeat(), options, log, snapshot.revision()));
        }
        HumanGame.Inspection inspection = game.inspect(10_000);
        assertNotNull(inspection, "the game did not settle for an inspection");
        return new Shown(seats, inspection, game.refs().copy());
    }

    /** Asserts that nothing a seat or SysOp may look at differs, but for the revisions, which go on. */
    static void assertSame(Shown before, Shown after, String at) {
        assertEquals(before.seats().size(), after.seats().size(), at);
        for (int index = 0; index < before.seats().size(); index++) {
            SeatShown was = before.seats().get(index);
            SeatShown is = after.seats().get(index);
            assertEquals(was.status(), is.status(), at + ": seat " + was.seat() + "'s status");
            assertEquals(was.promptKind(), is.promptKind(), at + ": seat " + was.seat() + "'s prompt");
            assertEquals(was.promptPrint(), is.promptPrint(), at + ": what seat " + was.seat() + " is asked");
            assertEquals(was.promptFor(), is.promptFor(), at + ": whose decision seat " + was.seat() + " makes");
            sameEntries(was.options(), is.options(), at + ": seat " + was.seat() + "'s options");
            sameLog(before, was.log(), is.log(), at + ": seat " + was.seat() + "'s log");
            sameText(EngineServer.JSON.toJson(was.view()), EngineServer.JSON.toJson(is.view()),
                at + ": seat " + was.seat() + "'s view");
            assertEquals(was.view(), is.view(), at + ": seat " + was.seat() + "'s view");
            assertTrue(is.revision() > was.revision(), at + ": seat " + was.seat() + "'s revision goes on ("
                + was.revision() + " then " + is.revision() + ")");
        }
        sameText(EngineServer.JSON.toJson(before.inspection().view()), EngineServer.JSON.toJson(after.inspection().view()),
            at + ": the public view");
        assertEquals(before.inspection().view(), after.inspection().view(), at + ": the public view");
        sameText(EngineServer.JSON.toJson(before.inspection().players()),
            EngineServer.JSON.toJson(after.inspection().players()), at + ": every hand and library, in order");
        assertEquals(before.inspection().players(), after.inspection().players(),
            at + ": every hand and library, in order");
    }

    /**
     * A seat's log after a recovery: every line it was shown, in place, and then at most the lines
     * the game had already written. A seat is shown the log as it was when its view last changed
     * ({@code HumanGame.publish}), so a line that changed nothing on its board waits for the next
     * view; a game that is taken up shows every seat its view anew, and with it the log up to then.
     * No line is lost, written twice or made up.
     */
    private static void sameLog(Shown before, List<HumanGame.LogLine> was, List<HumanGame.LogLine> is, String at) {
        List<HumanGame.LogLine> written = before.seats().stream().map(SeatShown::log)
            .max(java.util.Comparator.comparingInt(List::size)).orElseThrow();
        if (is.size() < was.size() || is.size() > written.size()) {
            throw new AssertionError(at + ": " + was.size() + " lines were shown and " + written.size()
                + " written, and afterwards " + is.size() + " are shown");
        }
        sameEntries(written.subList(0, is.size()), is, at);
        sameEntries(was, is.subList(0, was.size()), at);
    }

    /** Two lists entry by entry, so a failure names the first entry that differs and not both lists. */
    private static <T> void sameEntries(List<T> was, List<T> is, String at) {
        int common = Math.min(was.size(), is.size());
        for (int index = 0; index < common; index++) {
            if (!was.get(index).equals(is.get(index))) {
                throw new AssertionError(at + ": entry " + index + " was <" + was.get(index) + "> and is <"
                    + is.get(index) + ">");
            }
        }
        if (was.size() != is.size()) {
            List<T> longer = was.size() > is.size() ? was : is;
            throw new AssertionError(at + ": " + was.size() + " entries were " + is.size() + " afterwards; the "
                + (longer == was ? "earlier" : "later") + " one goes on with <" + longer.get(common) + ">");
        }
    }

    /** Two texts, so a failure shows where they part and not both in full. */
    private static void sameText(String was, String is, String at) {
        if (was.equals(is)) {
            return;
        }
        int index = 0;
        while (index < was.length() && index < is.length() && was.charAt(index) == is.charAt(index)) {
            index++;
        }
        int from = Math.max(0, index - 160);
        throw new AssertionError(at + ": at " + index + " was <" + was.substring(from, Math.min(was.length(), index + 160))
            + "> and is <" + is.substring(from, Math.min(is.length(), index + 160)) + ">");
    }

    /**
     * Asserts that two moments look the same to every seat but for the ids of objects only one of
     * the two games knows, and returns how many places such an id stands in (0: the moments are
     * identical). Every object both games know is shown under the id it had. An object that came
     * into being between the checkpoint and the interruption is made again by a game that goes on
     * from the checkpoint, and XMage gives it a new identity: the same card or token in the same
     * place, under another id. A game dealt again from its seed (taken up before its first
     * checkpoint) knows none of the first game's objects.
     */
    static int assertSameButForNewObjects(Shown before, Shown after, String at) {
        int renamed = 0;
        assertEquals(before.seats().size(), after.seats().size(), at);
        for (int index = 0; index < before.seats().size(); index++) {
            SeatShown was = before.seats().get(index);
            SeatShown is = after.seats().get(index);
            assertEquals(was.status(), is.status(), at + ": seat " + was.seat() + "'s status");
            assertEquals(was.promptKind(), is.promptKind(), at + ": seat " + was.seat() + "'s prompt");
            assertEquals(was.promptFor(), is.promptFor(), at + ": whose decision seat " + was.seat() + " makes");
            List<String> wasOptions = was.options().stream().map(option -> kept(option, before, after)).sorted().toList();
            List<String> isOptions = is.options().stream().map(option -> kept(option, before, after)).sorted().toList();
            sameEntries(wasOptions, isOptions, at + ": seat " + was.seat() + "'s options");
            sameLog(before, was.log(), is.log(), at + ": seat " + was.seat() + "'s log");
            String wasView = EngineServer.JSON.toJson(was.view());
            sameText(kept(wasView, before, after), kept(EngineServer.JSON.toJson(is.view()), before, after),
                at + ": seat " + was.seat() + "'s view");
            renamed += count(wasView, before, after);
            assertTrue(is.revision() > was.revision(), at + ": seat " + was.seat() + "'s revision goes on ("
                + was.revision() + " then " + is.revision() + ")");
        }
        sameText(kept(EngineServer.JSON.toJson(before.inspection().view()), before, after),
            kept(EngineServer.JSON.toJson(after.inspection().view()), before, after), at + ": the public view");
        sameText(kept(EngineServer.JSON.toJson(before.inspection().players()), before, after),
            kept(EngineServer.JSON.toJson(after.inspection().players()), before, after),
            at + ": every hand and library, in order");
        return renamed;
    }

    private static final java.util.regex.Pattern REF = java.util.regex.Pattern.compile("o[0-9a-f]{16}");

    /** Text with every id only one of the two games knows left out. */
    private static String kept(String text, Shown before, Shown after) {
        return REF.matcher(text).replaceAll(match ->
            before.refs().knows(match.group()) && after.refs().knows(match.group()) ? match.group() : "o");
    }

    private static int count(String text, Shown before, Shown after) {
        int count = 0;
        var matcher = REF.matcher(text);
        while (matcher.find()) {
            if (!(before.refs().knows(matcher.group()) && after.refs().knows(matcher.group()))) {
                count++;
            }
        }
        return count;
    }

    /** Waits for a seat to be asked, the journal's playing again over; -2 once the game has a result. */
    static int awaitPrompt(HumanGame game) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120);
        while (System.nanoTime() < deadline) {
            int seat = game.awaitPromptSeat(1_000);
            if (seat != -1) {
                return seat;
            }
        }
        throw new AssertionError("No seat was asked within two minutes");
    }

    /** Answers the open prompt of a seat by the policy; returns false once the game has a result. */
    static boolean answer(HumanGame game, Tables.Policy policy) throws Exception {
        while (true) {
            int seat = awaitPrompt(game);
            if (seat == -2) {
                return false;
            }
            HumanGame.Snapshot snapshot = game.snapshot(seat, -1, 0, 0);
            PromptView prompt = snapshot.prompt();
            if (prompt == null) {
                continue;
            }
            String option = prompt.kind().equals("unsupported") ? null : policy.choose(seat, prompt, snapshot.view());
            HumanGame.Reply reply;
            if (option == null) {
                reply = game.concede(seat, Tables.concede(game, snapshot.revision()));
            } else if (option.startsWith(Tables.AMOUNTS)) {
                reply = game.submit(seat, Tables.amounts(game, snapshot.revision(), prompt.id(),
                    List.of(Integer.parseInt(option.substring(Tables.AMOUNTS.length())))));
            } else if (option.startsWith(Tables.TEXT)) {
                reply = game.submit(seat, Tables.text(game, snapshot.revision(), prompt.id(),
                    option.substring(Tables.TEXT.length())));
            } else {
                reply = game.submit(seat, Tables.answer(game, UUID.randomUUID().toString(), snapshot.revision(),
                    prompt.id(), option));
            }
            if (reply.status() == 409) {
                continue; // the view moved on while the prompt was open; read it again
            }
            assertEquals(200, reply.status(), prompt.kind() + " " + option + ": " + reply.body());
            return true;
        }
    }

    static void deleteAll(Path root) throws IOException {
        if (!java.nio.file.Files.isDirectory(root)) {
            return;
        }
        try (var files = java.nio.file.Files.walk(root)) {
            for (Path path : files.sorted(java.util.Comparator.reverseOrder()).toList()) {
                java.nio.file.Files.deleteIfExists(path);
            }
        }
    }
}
