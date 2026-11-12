package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.IntPredicate;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Recovery (v0.9.9): a game whose process is gone is taken up again from its recording, and no seat
 * can tell. Each test plays a real game, leaves it as a dead process would at some point, takes it
 * up from what is on disk, and compares what every seat and SysOp's inspection are shown before and
 * after; then the game is played on, interrupted again and again, to its end.
 *
 * <p>What is compared ({@link Recordings.Shown}): every human seat's whole view, its status, the
 * question it is asked (kind, whose decision, every choice), its log, and every hand and library in
 * order. The same checks that watch a game's views for concealed information ({@link SeatChecks})
 * watch the game across every interruption.
 *
 * <p>At a priority prompt, where a game rests nearly all the time, the two must be identical, the
 * ids objects are shown under included. At a question inside an action or a resolution (a payment,
 * a target, blockers) the game is taken up from the checkpoint before that action and the journal
 * plays the seat's answers again; an object that came into being on the way (a token, a triggered
 * ability) is then made a second time, and XMage gives it a new identity. Such an object may be
 * shown under another id; everything else must be identical.
 */
class RecoveryTest {
    /** What an interruption takes away besides the process. */
    enum Lost {
        /** Nothing: every checkpoint the game was told to write is on disk. */
        NOTHING,
        /**
         * The newest checkpoint: the process died before it was written, or the file is gone. The
         * game goes on from the one before it and the journal.
         */
        NEWEST_CHECKPOINT
    }

    /** What a game's interruptions came to. */
    record Told(Map<String, Integer> kinds, Map<String, Integer> situations, int interruptions, int identical,
                int renamed, int dealtAgain, int played, int dropped, int answered, HumanGame.Snapshot last) {}

    /** What a game was in the middle of at an interruption, read from what its seats were shown. */
    private static void situations(Recordings.Shown shown, String kind, Map<String, Integer> found) {
        java.util.Set<String> now = new java.util.TreeSet<>();
        if (!kind.equals("priority")) {
            now.add("a decision pending inside an action");
        }
        for (Recordings.SeatShown seat : shown.seats()) {
            SeatView view = seat.view();
            if (!view.stack().isEmpty()) {
                now.add("objects on the stack");
            }
            if (view.stack().size() > 1) {
                now.add("a response on the stack");
            }
            if (!view.combat().isEmpty()) {
                now.add("attackers declared");
            }
            if (view.combat().stream().anyMatch(SeatView.CombatInfo::blocked)) {
                now.add("blockers declared");
            }
            if (!view.hand().isEmpty()) {
                now.add("cards in hand");
            }
            if (view.battlefield().stream().anyMatch(permanent -> !permanent.counters().isEmpty())) {
                now.add("counters on permanents");
            }
            if (view.battlefield().stream().anyMatch(permanent -> permanent.attachedTo() != null)) {
                now.add("attachments");
            }
            List<SeatView.PlayerState> players = new java.util.ArrayList<>(view.opponents());
            players.add(view.you());
            for (SeatView.PlayerState player : players) {
                if (!player.graveyard().isEmpty()) {
                    now.add("cards in graveyards");
                }
                if (!player.exile().isEmpty()) {
                    now.add("cards in exile");
                }
                if (player.lost()) {
                    now.add("a player out of the game");
                }
                if (player.team() != null) {
                    now.add("teams");
                }
                if (player != view.you() && player.hand() != null) {
                    now.add("a teammate's hand in view");
                }
                if (player.role() != null) {
                    now.add("Kings and Generals");
                }
                for (SeatView.CommanderState commander : player.commanders()) {
                    now.add("commander in " + (commander.zone().equals("command") ? "the command zone"
                        : commander.zone().equals("battlefield") ? "play" : "another zone"));
                    if (commander.tax() > 0) {
                        now.add("commander tax");
                    }
                    if (commander.damageDealt().stream().anyMatch(damage -> damage.damage() > 0)) {
                        now.add("commander damage dealt");
                    }
                }
            }
        }
        now.forEach(situation -> found.merge(situation, 1, Integer::sum));
    }

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

    /**
     * Plays a game to its end or to {@code most} answers, interrupting it before each answer whose
     * number {@code at} accepts (1 is the first) and taking it up again.
     */
    private Told play(String body, IntPredicate at, long policySeed, int most, Lost lost) throws Exception {
        HumanGameRequest request = HumanGameRequest.parse(body, () -> 1L, true);
        boolean bots = request.seats().stream().anyMatch(seat -> !seat.human());
        var check = new SeatChecks(request);
        var player = new ScriptedPlayer(policySeed);
        Tables.Policy policy = (seat, prompt, view) -> player.choose(prompt, view);
        HumanGame game = Recordings.start(root, body, check);
        String id = game.id();
        Map<String, Integer> kinds = new TreeMap<>();
        Map<String, Integer> situations = new TreeMap<>();
        int answered = 0;
        int interruptions = 0;
        int identical = 0;
        int renamed = 0;
        int dealtAgain = 0;
        int played = 0;
        int dropped = 0;
        while (answered < most) {
            int seat = Recordings.awaitPrompt(game);
            if (seat == -2) {
                break;
            }
            if (at.test(answered + 1)) {
                Recordings.Shown before = Recordings.shown(game);
                String kind = before.seats().stream().filter(shown -> shown.promptKind() != null)
                    .map(Recordings.SeatShown::promptKind).findFirst().orElse("none");
                String where = "before answer " + (answered + 1) + " (" + kind + ", turn "
                    + before.seats().get(0).view().turn() + ")";
                boolean durable = game.recorder().awaitDurable();
                Recorder.Metrics metrics = game.recorder().metrics();
                assertTrue(durable, "the checkpoint is on disk, " + where + ": " + game.recorder().failure()
                    + ", captures " + metrics.captures.get() + ", checkpoints " + metrics.checkpoints.get()
                    + ", longest write " + metrics.longestCheckpointMillis.get() + " ms, bytes "
                    + metrics.checkpointBytes.get());
                assertNull(game.recorder().failure(), where);
                game.interrupt();
                Recording recording = Recording.of(root, id);
                if (lost == Lost.NEWEST_CHECKPOINT) {
                    List<Integer> seqs = recording.checkpointSeqs();
                    if (!seqs.isEmpty()) {
                        Files.delete(recording.folder().resolve(
                            String.format("checkpoint-%010d.bin", seqs.get(seqs.size() - 1))));
                    }
                }
                Recovery.Restored restored = Recordings.restore(root, id, check);
                game = restored.game();
                interruptions++;
                kinds.merge(kind, 1, Integer::sum);
                situations(before, kind, situations);
                int asked = Recordings.awaitPrompt(game);
                played += game.replayed();
                dropped += game.replayDropped();
                boolean again = restored.report().checkpoint() == 0;
                if (again) {
                    dealtAgain++;
                }
                if (lost == Lost.NOTHING) {
                    assertEquals(List.of(), restored.report().problems(), where);
                    assertEquals(0, game.replayDropped(), "nothing of the journal is left unplayed, " + where);
                }
                if (game.replayDropped() == 0 && !(bots && lost == Lost.NEWEST_CHECKPOINT)) {
                    assertEquals(seat, asked, "the seat asked, " + where);
                    Recordings.Shown after = Recordings.shown(game);
                    int newIds = Recordings.assertSameButForNewObjects(before, after, where);
                    if (lost == Lost.NOTHING && kind.equals("priority") && !again) {
                        assertEquals(0, newIds, "at priority every object keeps its id, " + where);
                    }
                    if (again) {
                        // counted above: dealt again, every object is a new one
                    } else if (newIds == 0) {
                        identical++;
                    } else {
                        renamed++;
                    }
                }
            }
            if (!Recordings.answer(game, policy)) {
                break;
            }
            answered++;
        }
        HumanGame.Snapshot last = game.snapshot(game.humanSeats().get(0), -1, 0, 0);
        if (last.result() == null) {
            game.close("closed");
            last = Tables.finalSnapshot(game, game.humanSeats().get(0));
        }
        assertTrue(List.of("completed", "turn_limit", "closed", "humans_eliminated").contains(last.result().kind()),
            last.result().toString());
        assertNull(last.result().error());
        check.settle();
        assertTrue(check.failures.isEmpty(), "leaks or wrong views across the interruptions: " + check.failures);
        // The game is over, and so is its recording: it has the result, and is never made again.
        Recording recording = Recording.of(root, id);
        assertEquals(last.result().kind(), recording.result().orElseThrow().get("kind").getAsString());
        Recording.Unusable over = org.junit.jupiter.api.Assertions.assertThrows(Recording.Unusable.class,
            () -> Recovery.restore(recording, SeatChecks.DECKS, finished -> {}, HumanGame.Hooks.NONE));
        assertEquals("finished", over.code);
        return new Told(kinds, situations, interruptions, identical, renamed, dealtAgain, played, dropped, answered,
            last);
    }

    private static void report(String what, Told told) {
        System.out.println(what + ": " + told.interruptions() + " interruptions in " + told.answered()
            + " answers, with these questions open " + told.kinds() + "; identical afterwards " + told.identical()
            + ", identical but for new objects' ids " + told.renamed() + ", dealt again " + told.dealtAgain()
            + "; journal records played again " + told.played() + ", left unplayed " + told.dropped()
            + "; ended " + told.last().result().kind());
        System.out.println(what + ", interrupted with: " + told.situations());
    }

    private static void assertReached(Told told, String... situations) {
        for (String situation : situations) {
            assertTrue(told.situations().containsKey(situation), "no interruption with " + situation + ": "
                + told.situations());
        }
    }

    @Test
    void aLegacyDuelIsTakenUpAtEveryPrompt() throws Exception {
        String body = Recordings.body(21L, "legacy", 1, 30, "human:" + LegacyDuel.DECKS.get(0),
            "human:" + LegacyDuel.DECKS.get(1));
        Told told = play(body, answer -> answer <= 150, 5, 400, Lost.NOTHING);
        report("Legacy duel", told);
        assertTrue(told.kinds().containsKey("priority") && told.kinds().containsKey("pay_mana")
            && told.kinds().containsKey("choose_target") && told.kinds().containsKey("declare_attackers")
            && told.kinds().containsKey("mulligan"), told.kinds().toString());
        assertTrue(told.dealtAgain() >= 1, "a game interrupted in its mulligans is dealt again from its seed");
        assertEquals(told.interruptions(), told.identical() + told.renamed() + told.dealtAgain());
        assertReached(told, "a decision pending inside an action", "objects on the stack", "a response on the stack",
            "attackers declared", "blockers declared", "cards in hand", "cards in graveyards");
    }

    /**
     * Commander, one person and three bots (skill 1 searches: the bots decide by the clock). The
     * game is interrupted before every third of the person's answers. A bot's search is never run
     * again to get back to the person's question, so the game is the same game afterwards: the
     * person's view, every hand and library, the commanders, tax and damage, are as they were.
     */
    @Test
    void aCommanderTableWithBotsIsTakenUp() throws Exception {
        String body = Recordings.body(23L, "commander", 1, 28, "human:commander-mono-red-raiders",
            "bot:commander-mono-white-soldiers", "bot:commander-mono-blue-flyers", "bot:commander-mono-green-stompers");
        Told told = play(body, answer -> answer % 3 == 0, 7, 600, Lost.NOTHING);
        report("Commander with three bots", told);
        assertTrue(told.interruptions() >= 40, told.toString());
        assertEquals(told.interruptions(), told.identical() + told.renamed() + told.dealtAgain());
        assertReached(told, "a decision pending inside an action", "objects on the stack", "attackers declared",
            "commander in the command zone", "commander in play", "commander tax", "cards in graveyards");
    }

    /** Commander between two people and two bots: both people's views, and what each may not see. */
    @Test
    void aCommanderTableOfTwoPeopleAndTwoBotsIsTakenUp() throws Exception {
        String body = Recordings.body(24L, "commander", 1, 24, "human:commander-mono-green-stompers",
            "bot:commander-mono-white-soldiers", "human:commander-mono-blue-flyers", "bot:commander-mono-red-raiders");
        Told told = play(body, answer -> answer % 4 == 0, 8, 700, Lost.NOTHING);
        report("Commander, two people and two bots", told);
        assertTrue(told.interruptions() >= 40, told.toString());
        assertEquals(told.interruptions(), told.identical() + told.renamed() + told.dealtAgain());
        assertReached(told, "a decision pending inside an action", "objects on the stack", "attackers declared",
            "commander in the command zone", "commander in play");
    }

    /**
     * Two-Headed Giant: two people as a team against two bots. The team's shared life and turn, and
     * each teammate's sight of the other's hand, are what they were.
     */
    @Test
    void twoHeadedGiantIsTakenUp() throws Exception {
        String body = Recordings.body(25L, "two_headed_giant", 1, 30, "human:legacy-mono-red-burn",
            "human:legacy-mono-green-creatures", "bot:legacy-mono-white-weenie", "bot:legacy-mono-blue-skies");
        Told told = play(body, answer -> answer % 3 == 0, 9, 600, Lost.NOTHING);
        report("Two-Headed Giant, a team of two people", told);
        assertTrue(told.interruptions() >= 40, told.toString());
        assertEquals(told.interruptions(), told.identical() + told.renamed() + told.dealtAgain());
        assertReached(told, "teams", "a teammate's hand in view", "a decision pending inside an action",
            "objects on the stack", "attackers declared");
    }

    /** King's Table: six seats, a person as a General on each team, four bots. */
    @Test
    void kingsTableIsTakenUp() throws Exception {
        String body = Recordings.body(26L, "kings_table", 1, 36, "human:commander-mono-white-soldiers",
            "bot:commander-mono-blue-flyers", "bot:commander-mono-red-raiders", "human:commander-mono-green-stompers",
            "bot:commander-mono-white-soldiers", "bot:commander-mono-blue-flyers");
        Told told = play(body, answer -> answer % 4 == 0, 10, 700, Lost.NOTHING);
        report("King's Table, two people and four bots", told);
        assertTrue(told.interruptions() >= 30, told.toString());
        assertEquals(told.interruptions(), told.identical() + told.renamed() + told.dealtAgain());
        assertReached(told, "Kings and Generals", "teams", "a teammate's hand in view",
            "a decision pending inside an action", "objects on the stack", "attackers declared",
            "commander in the command zone", "commander in play");
    }

    /**
     * With bots at the table and the newest checkpoint lost, the game goes on from the one before
     * it: a bot may decide otherwise than it did (its search is cut off by the clock), so the game
     * need not come back to the same question. It must still be a legal game that shows no seat
     * anything it may not see, and it must end with one result.
     */
    @Test
    void aCommanderTableWithBotsGoesOnLegallyWhenTheNewestCheckpointIsLost() throws Exception {
        String body = Recordings.body(27L, "commander", 1, 20, "human:commander-mono-blue-flyers",
            "bot:commander-mono-white-soldiers", "bot:commander-mono-red-raiders", "bot:commander-mono-green-stompers");
        Told told = play(body, answer -> answer % 5 == 0, 11, 500, Lost.NEWEST_CHECKPOINT);
        report("Commander with three bots, newest checkpoint lost", told);
        assertTrue(told.interruptions() >= 15, told.toString());
    }

    /**
     * The process dies before the checkpoint a question stands on is written (it takes a fraction of
     * a second), or the newest checkpoint is lost: the game goes on from the one before it, and the
     * journal plays every answer since. Between people nothing is decided by a clock, so the game
     * comes back to the same question.
     */
    @Test
    void aLegacyDuelGoesOnFromTheCheckpointBeforeWhenTheNewestIsLost() throws Exception {
        String body = Recordings.body(22L, "legacy", 1, 30, "human:" + LegacyDuel.DECKS.get(0),
            "human:" + LegacyDuel.DECKS.get(1));
        Told told = play(body, answer -> answer % 3 == 0 && answer <= 150, 6, 400, Lost.NEWEST_CHECKPOINT);
        report("Legacy duel, newest checkpoint lost", told);
        assertTrue(told.played() > 0, "answers were played again from the journal");
        assertTrue(told.interruptions() >= 30, told.toString());
    }
}
