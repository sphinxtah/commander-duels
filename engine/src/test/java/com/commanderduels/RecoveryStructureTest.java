package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Recovery and the turn's structure (v0.9.9, patch 0018). A game that is taken up goes on from the
 * middle of a turn: XMage must finish the step, the phase and the turn it was in, with the extra
 * steps, extra phases and extra turns that were due, and begin nothing a second time. These games
 * are built to have all three (Paradox Haze's second upkeep step, Relentless Assault's second
 * combat and main phases, Time Warp's extra turn: the three are in seat 0's opening hand, with the
 * lands for them) and are played twice by the same hand: once
 * straight through, once interrupted before every single answer. Both must come to the same log,
 * line for line, and to the same sequence of turns and steps.
 */
class RecoveryStructureTest {
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

    private static JsonObject entry(String name, int count) {
        JsonObject entry = new JsonObject();
        entry.addProperty("name", name);
        entry.addProperty("count", count);
        return entry;
    }

    /** Seat 0 plays the cards that bend the turn, from its stacked opening hand; seat 1 plays bears. */
    private static String body() {
        JsonObject json = new JsonObject();
        json.addProperty("seed", 77L);
        json.addProperty("format", "legacy");
        json.addProperty("skill", 1);
        json.addProperty("turn_cap", 12);
        json.addProperty("idle_timeout_seconds", 600);
        json.addProperty("starting_seat", 0);
        JsonArray seats = new JsonArray();

        JsonObject bender = new JsonObject();
        bender.addProperty("player", "human");
        JsonObject deck = new JsonObject();
        JsonArray cards = new JsonArray();
        cards.add(entry("Island", 22));
        cards.add(entry("Mountain", 22));
        cards.add(entry("Raging Goblin", 4));
        cards.add(entry("Paradox Haze", 4));
        cards.add(entry("Relentless Assault", 4));
        cards.add(entry("Time Warp", 4));
        deck.add("cards", cards);
        JsonArray opening = new JsonArray();
        // The opening hand; what is drawn after it is the seed's.
        for (String name : List.of("Mountain", "Island", "Mountain", "Island", "Paradox Haze", "Relentless Assault",
            "Time Warp")) {
            opening.add(name);
        }
        deck.add("opening", opening);
        bender.add("deck_list", deck);
        seats.add(bender);

        JsonObject bears = new JsonObject();
        bears.addProperty("player", "human");
        JsonObject bearDeck = new JsonObject();
        JsonArray bearCards = new JsonArray();
        bearCards.add(entry("Forest", 40));
        bearCards.add(entry("Grizzly Bears", 4));
        bearCards.add(entry("Runeclaw Bear", 4));
        bearCards.add(entry("Balduvian Bears", 4));
        bearCards.add(entry("Forest Bear", 4));
        bearCards.add(entry("Bear Cub", 4));
        bearDeck.add("cards", bearCards);
        bears.add("deck_list", bearDeck);
        seats.add(bears);
        json.add("seats", seats);
        return json.toString();
    }

    /**
     * A hand that plays by name alone, so that it plays the same game twice whatever ids the game's
     * objects have: lands in a fixed alternation, each spell as soon as it can be cast (Relentless
     * Assault after combat), itself as every target, every attack, no block.
     */
    private static String choose(int seat, PromptView prompt, SeatView view) {
        List<PromptView.Option> options = new ArrayList<>(prompt.options());
        options.sort(Comparator.comparing(PromptView.Option::action).thenComparing(PromptView.Option::label));
        switch (prompt.kind()) {
            case "priority" -> {
                boolean main = view.step().equals("precombat_main") || view.step().equals("postcombat_main");
                if (main && view.activeSeat() == seat && view.stack().isEmpty()) {
                    long lands = view.battlefield().stream().filter(permanent -> permanent.controllerSeat() == seat
                        && permanent.card().typeLine() != null && permanent.card().typeLine().contains("Land")).count();
                    String wanted = seat == 0 ? (lands % 2 == 0 ? "Mountain" : "Island") : "Forest";
                    for (PromptView.Option option : options) {
                        if (option.action().equals("play_land") && option.label().equals(wanted)) {
                            return option.id();
                        }
                    }
                    for (PromptView.Option option : options) {
                        if (option.action().equals("play_land")) {
                            return option.id();
                        }
                    }
                    for (PromptView.Option option : options) {
                        boolean assault = option.label().equals("Relentless Assault");
                        if (option.action().equals("cast") && (!assault || view.step().equals("postcombat_main"))) {
                            return option.id();
                        }
                    }
                }
                return ScriptedPlayer.byAction(options, "pass").get(0).id();
            }
            case "mulligan" -> {
                return ScriptedPlayer.byAction(options, "keep").get(0).id();
            }
            case "pay_mana" -> {
                var sources = ScriptedPlayer.byAction(options, "tap_source");
                return sources.isEmpty() ? ScriptedPlayer.byAction(options, "cancel").get(0).id() : sources.get(0).id();
            }
            case "choose_target" -> {
                var done = ScriptedPlayer.byAction(options, "done");
                boolean chosen = options.stream().anyMatch(PromptView.Option::selected);
                if (chosen && !done.isEmpty()) {
                    return done.get(0).id();
                }
                for (PromptView.Option option : options) {
                    if (option.action().equals("choose") && option.seat() != null && option.seat() == seat) {
                        return option.id();
                    }
                }
                return options.stream().filter(option -> option.action().equals("choose")).findFirst()
                    .orElse(options.get(0)).id();
            }
            case "declare_attackers" -> {
                var all = ScriptedPlayer.byAction(options, "all_attack");
                boolean attacking = options.stream().anyMatch(PromptView.Option::selected);
                return seat == 0 && !all.isEmpty() && !attacking ? all.get(0).id()
                    : ScriptedPlayer.byAction(options, "done").get(0).id();
            }
            case "declare_blockers" -> {
                return ScriptedPlayer.byAction(options, "done").get(0).id();
            }
            case "yes_no" -> {
                return ScriptedPlayer.byAction(options, "yes").get(0).id();
            }
            default -> {
                var done = ScriptedPlayer.byAction(options, "done");
                return done.isEmpty() ? options.get(0).id() : done.get(0).id();
            }
        }
    }

    /** What a game came to: where each answer was given, and its whole log. */
    private record Played(List<String> trace, List<String> log, String result, int interruptions) {}

    private Played play(boolean interrupted) throws Exception {
        Tables.Policy policy = RecoveryStructureTest::choose;
        HumanGame game = Recordings.start(root, body(), HumanGame.Hooks.NONE);
        String id = game.id();
        List<String> trace = new ArrayList<>();
        int interruptions = 0;
        while (true) {
            int seat = Recordings.awaitPrompt(game);
            if (seat == -2) {
                break;
            }
            if (interrupted) {
                Recordings.Shown before = Recordings.shown(game);
                assertTrue(game.recorder().awaitDurable());
                game.interrupt();
                Recovery.Restored restored = Recordings.restore(root, id, HumanGame.Hooks.NONE);
                assertEquals(List.of(), restored.report().problems());
                game = restored.game();
                assertEquals(seat, Recordings.awaitPrompt(game), "the seat asked, before answer " + (trace.size() + 1));
                assertEquals(0, game.replayDropped(), "before answer " + (trace.size() + 1));
                Recordings.assertSameButForNewObjects(before, Recordings.shown(game),
                    "before answer " + (trace.size() + 1));
                interruptions++;
            }
            HumanGame.Snapshot snapshot = game.snapshot(seat, -1, 0, 0);
            if (snapshot.prompt() == null) {
                continue;
            }
            SeatView view = snapshot.view();
            trace.add("turn " + view.turn() + " " + view.step() + " active " + view.activeSeat() + ": seat " + seat
                + " " + snapshot.prompt().kind());
            if (!Recordings.answer(game, policy)) {
                break;
            }
        }
        HumanGame.Snapshot last = Tables.finalSnapshot(game, 0);
        List<String> log = new ArrayList<>();
        for (int from = 0; from < last.logCount(); from += HumanGame.MAX_LOG_PAGE) {
            for (HumanGame.LogLine line : game.snapshot(0, -1, 0, from).log()) {
                log.add("turn " + line.turn() + " " + line.step() + " active " + line.activeSeat() + ": " + line.text());
            }
        }
        return new Played(trace, log, last.result().kind(), interruptions);
    }

    @Test
    void aGameInterruptedBeforeEveryAnswerIsTheGamePlayedStraightThrough() throws Exception {
        Played straight = play(false);
        if (Boolean.getBoolean("cd.test.showLog")) {
            straight.log().forEach(line -> System.out.println("LOG " + line));
            straight.trace().forEach(line -> System.out.println("TRACE " + line));
        }
        // The game has what it was built to have.
        assertTrue(straight.log().stream().anyMatch(line -> line.contains("takes an extra upkeep step")),
            "an extra step: " + extra(straight));
        assertTrue(straight.log().stream().anyMatch(line -> line.contains("starts an additional Combat phase")),
            "an extra phase: " + extra(straight));
        assertTrue(straight.log().stream().anyMatch(line -> line.contains("starts an additional Postcombat Main phase")),
            "a second extra phase: " + extra(straight));
        assertTrue(straight.log().stream().anyMatch(line -> line.contains("takes an extra turn")),
            "an extra turn: " + extra(straight));

        Played broken = play(true);
        System.out.println("Turn structure: " + straight.trace().size() + " answers, " + straight.log().size()
            + " log lines, ended " + straight.result() + "; played again with " + broken.interruptions()
            + " interruptions. The extra steps, phases and turns: " + extra(straight));
        assertEquals(straight.result(), broken.result());
        assertEquals(straight.trace().size(), broken.trace().size(), "the same number of answers");
        for (int index = 0; index < straight.trace().size(); index++) {
            assertEquals(straight.trace().get(index), broken.trace().get(index), "answer " + (index + 1));
        }
        assertEquals(straight.log().size(), broken.log().size(), "the same number of log lines");
        for (int index = 0; index < straight.log().size(); index++) {
            assertEquals(straight.log().get(index), broken.log().get(index), "log line " + index);
        }
        assertTrue(broken.interruptions() >= straight.trace().size(), "interrupted before every answer");
    }

    private static List<String> extra(Played played) {
        return played.log().stream().filter(line -> line.contains("extra") || line.contains("additional")).toList();
    }
}
