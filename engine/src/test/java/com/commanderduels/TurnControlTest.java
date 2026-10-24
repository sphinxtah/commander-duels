package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import mage.game.turn.TurnMod;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Turn control (723, v0.5.1): a seat controlling another player's turn is asked for that player's
 * decisions, marked with that player's seat, and its answers are that player's; its view shows what
 * that player may see for as long as the control lasts, and nobody else's does. Each game is played
 * to its end, so none may hang, and every view and prompt goes through {@link SeatChecks}, whose
 * leak checks allow the controller's view only while the control lasts. Mindslaver is put onto the
 * battlefield with four lands in turn 1 (XMage's cheat) and activated by seat 0's policy; the other
 * games give the control directly, as Mindslaver's effect does (a turn modification). Needs ./db.
 */
class TurnControlTest {
    private static final List<String> LEGACY = LegacyDuel.DECKS;

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    /** What a game's views and prompts showed, by "turn:seat" and the like. */
    static final class Seen {
        /** By "turn:seat": prompts that seat answered for another seat, by that seat. */
        final Map<String, Set<Integer>> answeredFor = new ConcurrentHashMap<>();
        /** By "turn:seat": prompts the seat answered for itself. */
        final Map<String, AtomicInteger> ownPrompts = new ConcurrentHashMap<>();
        /** By "turn:viewer": the seats whose hands the viewer's views showed. */
        final Map<String, Set<Integer>> handsShown = new ConcurrentHashMap<>();
        /** By "turn:viewer": the controlling seat the viewer's own entry named. */
        final Map<String, Set<Integer>> controlledBy = new ConcurrentHashMap<>();
        final List<String> problems = new CopyOnWriteArrayList<>();

        void prompt(int seat, PromptView prompt, SeatView view) {
            if (prompt.forSeat() != null) {
                answeredFor.computeIfAbsent(view.turn() + ":" + seat, key -> ConcurrentHashMap.newKeySet())
                    .add(prompt.forSeat());
            } else {
                ownPrompts.computeIfAbsent(view.turn() + ":" + seat, key -> new AtomicInteger()).incrementAndGet();
            }
        }

        TwoHeadedGiantAuditTest.Probe probe() {
            return (game, ids, seat, view) -> {
                for (SeatView.PlayerState player : view.opponents()) {
                    if (player.hand() != null) {
                        handsShown.computeIfAbsent(view.turn() + ":" + seat, key -> ConcurrentHashMap.newKeySet())
                            .add(player.seat());
                    }
                }
                if (view.you() != null && view.you().controlledBy() != null) {
                    controlledBy.computeIfAbsent(view.turn() + ":" + seat, key -> ConcurrentHashMap.newKeySet())
                        .add(view.you().controlledBy());
                }
            };
        }

        Set<Integer> forOthers(int turn, int seat) {
            return answeredFor.getOrDefault(turn + ":" + seat, Set.of());
        }

        int own(int turn, int seat) {
            AtomicInteger count = ownPrompts.get(turn + ":" + seat);
            return count == null ? 0 : count.get();
        }

        Set<Integer> hands(int turn, int viewer) {
            return handsShown.getOrDefault(turn + ":" + viewer, Set.of());
        }

        Set<Integer> controllers(int turn, int viewer) {
            return controlledBy.getOrDefault(turn + ":" + viewer, Set.of());
        }

        Set<Integer> turnsAnsweringFor(int seat) {
            Set<Integer> turns = new java.util.TreeSet<>();
            answeredFor.forEach((key, seats) -> {
                if (key.endsWith(":" + seat) && !seats.isEmpty()) {
                    turns.add(Integer.parseInt(key.substring(0, key.indexOf(':'))));
                }
            });
            return turns;
        }
    }

    /**
     * Seat 0 activates Mindslaver on {@code target} in turn 1. A seat answering for another plays a
     * land (only one: a second offered land is a problem), casts what it can and attacks with
     * everything; otherwise it passes like {@link TwoHeadedGiantAuditTest#passing}.
     */
    static Tables.Policy mindslaver(int target, Seen seen) {
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        AtomicBoolean activated = new AtomicBoolean();
        Map<String, Integer> lands = new ConcurrentHashMap<>();
        Map<String, Boolean> attacked = new ConcurrentHashMap<>();
        Map<String, Integer> casts = new ConcurrentHashMap<>();
        AtomicInteger payments = new AtomicInteger();
        return (seat, prompt, view) -> {
            seen.prompt(seat, prompt, view);
            List<PromptView.Option> options = prompt.options();
            payments.set(prompt.kind().equals("pay_mana") ? payments.get() + 1 : 0);
            if (prompt.kind().equals("pay_mana")) {
                var sources = ScriptedPlayer.byAction(options, "tap_source");
                return !sources.isEmpty() && payments.get() <= 8 ? sources.get(0).id()
                    : ScriptedPlayer.byAction(options, "cancel").get(0).id();
            }
            if (prompt.forSeat() == null && seat == 0 && !activated.get()) {
                if (prompt.kind().equals("priority")) {
                    var slaver = options.stream()
                        .filter(option -> option.action().equals("activate") && "Mindslaver".equals(option.label()))
                        .findFirst();
                    if (slaver.isPresent()) {
                        return slaver.get().id();
                    }
                }
                if (prompt.kind().equals("choose_target")) {
                    var player = options.stream().filter(option -> Integer.valueOf(target).equals(option.seat()))
                        .findFirst();
                    if (player.isPresent()) {
                        activated.set(true);
                        return player.get().id();
                    }
                }
            }
            if (prompt.forSeat() != null) {
                if (prompt.message().contains("(as ")
                        || (prompt.detail() != null && prompt.detail().contains("(as "))) {
                    seen.problems.add("XMage's controlled-player hint left in: " + prompt.message());
                }
                String turn = view.turn() + ":" + prompt.forSeat();
                switch (prompt.kind()) {
                    case "priority": {
                        var land = ScriptedPlayer.byAction(options, "play_land");
                        if (!land.isEmpty()) {
                            if (lands.getOrDefault(turn, 0) > 0) {
                                seen.problems.add("a second land was offered for seat " + prompt.forSeat()
                                    + " in turn " + view.turn());
                            } else {
                                lands.merge(turn, 1, Integer::sum);
                                return land.get(0).id();
                            }
                        }
                        var spells = ScriptedPlayer.byAction(options, "cast");
                        if (!spells.isEmpty() && casts.getOrDefault(turn, 0) < 3) {
                            casts.merge(turn, 1, Integer::sum);
                            return spells.get(0).id();
                        }
                        if (options.stream().anyMatch(option -> option.action().startsWith("pass_until"))) {
                            seen.problems.add("a pass mode was offered to the seat answering for seat "
                                + prompt.forSeat());
                        }
                        return ScriptedPlayer.byAction(options, "pass").get(0).id();
                    }
                    case "declare_attackers": {
                        var all = ScriptedPlayer.byAction(options, "all_attack");
                        if (!all.isEmpty() && attacked.putIfAbsent(turn, true) == null) {
                            return all.get(0).id();
                        }
                        return ScriptedPlayer.byAction(options, "done").get(0).id();
                    }
                    default:
                        break;
                }
            }
            return pass.choose(seat, prompt, view);
        };
    }

    private static HumanGameRequest request(long seed, GameFormat format, int turnCap, HumanGameRequest.Seat... seats) {
        return new HumanGameRequest(seed, format, List.of(seats), 1, turnCap, 900, 0, 0);
    }

    record Run(HumanGame game, Tables.Played played, TwoHeadedGiantAuditTest.Scenario scenario) {
        HumanGame.Result result() {
            return played.last().result();
        }

        List<String> log() throws InterruptedException {
            List<String> lines = new ArrayList<>();
            while (true) {
                HumanGame.Snapshot page = game.snapshot(game.humanSeats().get(0), -1, 0, lines.size());
                page.log().forEach(line -> lines.add(line.text()));
                if (page.log().size() < HumanGame.MAX_LOG_PAGE) {
                    return lines;
                }
            }
        }
    }

    /** Plays the game to its end with the policy, which may read the running game; it must not hang. */
    private static Run play(TwoHeadedGiantAuditTest.Scenario scenario, AtomicReference<HumanGame> running,
                            Tables.Policy policy) throws Exception {
        HumanGame game = Tables.start(scenario.gameRequest, scenario);
        running.set(game);
        Tables.Played played = Tables.play(game, policy, 4, new Tables.Coverage());
        scenario.settle();
        assertTrue(scenario.failures.isEmpty(), "leaks or wrong views: " + scenario.failures);
        assertNotNull(played.last().result(), "the game finished");
        assertFalse("error".equals(played.last().result().kind()), "no engine error: " + played.last().result());
        return new Run(game, played, scenario);
    }

    @Test
    void aHumanControlsABotsTurnWithMindslaver() throws Exception {
        // Seat 0 activates Mindslaver on the bot in turn 1 and makes the bot's decisions in turn 2,
        // through the stand-in it makes for the bot (one land only), seeing the bot's hand that turn.
        Seen seen = new Seen();
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request(7101L, GameFormat.LEGACY, 5,
                Tables.human(LEGACY.get(0)), Tables.bot(LEGACY.get(1))))
            .battlefield(0, "Mindslaver", "Mountain", "Mountain", "Mountain", "Mountain")
            .probe(seen.probe());
        Run run = play(scenario, new AtomicReference<>(), mindslaver(1, seen));
        System.out.println("Answered for others by turn: " + seen.answeredFor + "; hands shown: " + seen.handsShown);
        System.out.println("The controlled turn: " + run.log().stream().filter(line -> line.contains("Bot 2")).toList());

        assertTrue(seen.problems.isEmpty(), "problems: " + seen.problems);
        assertEquals(Set.of(2), seen.turnsAnsweringFor(0), "seat 0 answered for the bot in turn 2 only");
        assertEquals(Set.of(1), seen.forOthers(2, 0));
        assertEquals(Set.of(1), seen.hands(2, 0), "the bot's hand shown to seat 0 in turn 2");
        assertTrue(seen.hands(3, 0).isEmpty() && seen.hands(1, 0).isEmpty(), "and in no other turn: "
            + seen.handsShown);
        assertTrue(run.scenario().reached.contains("prompt for a controlled player"));
        assertTrue(run.log().stream().anyMatch(line -> line.contains("taken turn control")), "XMage's log line");
        // The bot played one land at most in the turn seat 0 controlled.
        assertTrue(scenario.count.getOrDefault("3:Forest:1", 0) - scenario.count.getOrDefault("2:Forest:1", 0) <= 1,
            "lands: " + scenario.count);
    }

    @Test
    void aHumanControlsAnotherHumansTurn() throws Exception {
        // Seat 0 controls seat 1's turn 2: every decision of seat 1 that turn is seat 0's, seat 1 is
        // asked nothing, sees that seat 0 controls its turn, and never sees seat 0's hand; an answer
        // from seat 1 to seat 0's prompt is refused, and so is a stale one from seat 0.
        Seen seen = new Seen();
        AtomicReference<HumanGame> running = new AtomicReference<>();
        AtomicBoolean probed = new AtomicBoolean();
        Tables.Policy slaver = mindslaver(1, seen);
        Tables.Policy policy = (seat, prompt, view) -> {
            HumanGame game = running.get();
            if (prompt.forSeat() != null && probed.compareAndSet(false, true)) {
                try {
                    HumanGame.Snapshot snapshot = game.snapshot(seat, -1, 0, 0);
                    Tables.assertRejected(409, "stale_prompt", game.submit(prompt.forSeat(), Tables.answer(game,
                        UUID.randomUUID().toString(), snapshot.revision(), prompt.id(), "1")));
                    Tables.assertRejected(409, "stale_revision", game.submit(seat, Tables.answer(game,
                        UUID.randomUUID().toString(), snapshot.revision() - 1, prompt.id(), "1")));
                    HumanGame.Snapshot controlled = game.snapshot(prompt.forSeat(), -1, 0, 0);
                    assertNull(controlled.prompt(), "the controlled seat has no prompt");
                    assertEquals("waiting", controlled.status());
                    assertEquals(Integer.valueOf(seat), controlled.view().you().controlledBy());
                } catch (Exception e) {
                    seen.problems.add("probe: " + e);
                }
            }
            return slaver.choose(seat, prompt, view);
        };
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request(7102L, GameFormat.LEGACY, 5,
                Tables.human(LEGACY.get(0)), Tables.human(LEGACY.get(1))))
            .battlefield(0, "Mindslaver", "Mountain", "Mountain", "Mountain", "Mountain")
            .probe(seen.probe());
        play(scenario, running, policy);
        System.out.println("Answered for others: " + seen.answeredFor + "; own prompts: " + seen.ownPrompts);

        assertTrue(probed.get(), "a prompt for seat 1 reached seat 0");
        assertTrue(seen.problems.isEmpty(), "problems: " + seen.problems);
        assertEquals(Set.of(2), seen.turnsAnsweringFor(0));
        assertEquals(Set.of(1), seen.forOthers(2, 0));
        assertEquals(0, seen.own(2, 1), "seat 1 was asked nothing in the turn seat 0 controlled");
        assertTrue(seen.own(4, 1) > 0, "seat 1 decided for itself again in turn 4");
        assertEquals(Set.of(0), seen.controllers(2, 1), "seat 1 saw who controls its turn");
        assertTrue(seen.controllers(3, 1).isEmpty() && seen.controllers(4, 1).isEmpty());
        assertEquals(Set.of(1), seen.hands(2, 0), "seat 1's hand shown to seat 0 in turn 2");
        assertTrue(seen.hands(4, 0).isEmpty(), "and not in seat 1's next turn");
        for (int turn = 1; turn <= 5; turn++) {
            assertTrue(seen.hands(turn, 1).isEmpty(), "seat 0's hand is never shown to seat 1");
        }
    }

    @Test
    void theControlledPlayerStillConcedes() throws Exception {
        // 723.6: seat 1 concedes while seat 0 holds its prompt; seat 0 wins.
        Seen seen = new Seen();
        AtomicReference<HumanGame> running = new AtomicReference<>();
        Tables.Policy slaver = mindslaver(1, seen);
        Tables.Policy policy = (seat, prompt, view) -> {
            if (prompt.forSeat() != null) {
                HumanGame game = running.get();
                try {
                    HumanGame.Snapshot controlled = game.snapshot(prompt.forSeat(), -1, 0, 0);
                    assertEquals(200, game.concede(prompt.forSeat(), Tables.concede(game, controlled.revision()))
                        .status());
                } catch (Exception e) {
                    seen.problems.add("concede: " + e);
                }
            }
            return slaver.choose(seat, prompt, view);
        };
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request(7103L, GameFormat.LEGACY, 6,
                Tables.human(LEGACY.get(0)), Tables.human(LEGACY.get(1))))
            .battlefield(0, "Mindslaver", "Mountain", "Mountain", "Mountain", "Mountain");
        HumanGame game = Tables.start(scenario.gameRequest, scenario);
        running.set(game);
        Tables.Played played;
        try {
            played = Tables.play(game, policy, 4, new Tables.Coverage());
        } catch (AssertionError e) {
            // Seat 0's answer to the prompt seat 1's concession closed is refused.
            assertTrue(e.getMessage().contains("stale_prompt"), e.getMessage());
            played = new Tables.Played(Tables.finalSnapshot(game, 0), 0, Map.of());
        }
        scenario.settle();
        assertTrue(seen.problems.isEmpty(), "problems: " + seen.problems);
        assertTrue(scenario.failures.isEmpty(), "leaks or wrong views: " + scenario.failures);
        HumanGame.Result result = played.last().result();
        assertEquals("completed", result.kind(), result.toString());
        assertEquals(Integer.valueOf(0), result.winnerSeat());
        assertEquals(List.of(1), result.concededSeats());
    }

    @Test
    void theControllerLeavingHandsTheTurnBack() throws Exception {
        // 800.4a: in a game of three, seat 0 controls seat 1's turn 2 and concedes while it holds seat
        // 1's prompt; seat 1 then decides that prompt and the rest of its turn itself, and the game
        // goes on to its end with the bot.
        Seen seen = new Seen();
        AtomicReference<HumanGame> running = new AtomicReference<>();
        AtomicBoolean conceded = new AtomicBoolean();
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        Tables.Policy policy = (seat, prompt, view) -> {
            seen.prompt(seat, prompt, view);
            if (prompt.forSeat() != null && conceded.compareAndSet(false, true)) {
                HumanGame game = running.get();
                try {
                    HumanGame.Snapshot snapshot = game.snapshot(seat, -1, 0, 0);
                    assertEquals(200, game.concede(seat, Tables.concede(game, snapshot.revision())).status());
                    HumanGame.Snapshot handed = Tables.nextPrompt(game, prompt.forSeat(), -1);
                    assertNotNull(handed.prompt(), "seat 1 holds its own prompt");
                    assertNull(handed.prompt().forSeat());
                    assertEquals(prompt.kind(), handed.prompt().kind());
                } catch (Exception e) {
                    seen.problems.add("hand-over: " + e);
                }
                return null; // seat 0 has conceded: Tables.play concedes again, which is refused
            }
            return pass.choose(seat, prompt, view);
        };
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request(7104L, GameFormat.COMMANDER, 5,
                Tables.human("commander-mono-red-raiders"), Tables.human("commander-mono-green-stompers"),
                Tables.bot("commander-mono-white-soldiers")))
            .setup((game, ids, seat, view) -> game.getState().getTurnMods()
                .add(new TurnMod(ids.get(1)).withNewController(ids.get(0))))
            .probe(seen.probe());
        HumanGame game = Tables.start(scenario.gameRequest, scenario);
        running.set(game);
        try {
            Tables.play(game, policy, 4, new Tables.Coverage());
        } catch (AssertionError e) {
            // Tables.play's own concession of seat 0 is refused: it has conceded already.
            assertTrue(e.getMessage().contains("eliminated"), e.getMessage());
            Tables.play(game, pass, 4, new Tables.Coverage());
        }
        scenario.settle();
        assertTrue(seen.problems.isEmpty(), "problems: " + seen.problems);
        assertTrue(scenario.failures.isEmpty(), "leaks or wrong views: " + scenario.failures);
        HumanGame.Result result = Tables.finalSnapshot(game, 1).result();
        assertFalse("error".equals(result.kind()), result.toString());
        assertEquals(List.of(0), result.concededSeats());
        assertTrue(conceded.get(), "seat 0 held a prompt for seat 1");
    }

    @Test
    void theControllerLeavingLetsTheBotPlayOn() throws Exception {
        // 800.4a, for a bot: seat 0 controls the bot's turn 2 in a game of three and concedes while it
        // holds the bot's prompt; the bot's stand-in gets the answer that does the least, the bot plays
        // on by itself, and the game reaches its end.
        AtomicReference<HumanGame> running = new AtomicReference<>();
        AtomicBoolean conceded = new AtomicBoolean();
        List<String> problems = new CopyOnWriteArrayList<>();
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        Tables.Policy policy = (seat, prompt, view) -> {
            if (prompt.forSeat() != null && conceded.compareAndSet(false, true)) {
                HumanGame game = running.get();
                try {
                    HumanGame.Snapshot snapshot = game.snapshot(seat, -1, 0, 0);
                    assertEquals(200, game.concede(seat, Tables.concede(game, snapshot.revision())).status());
                } catch (Exception e) {
                    problems.add("concede: " + e);
                }
                return null;
            }
            return pass.choose(seat, prompt, view);
        };
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request(7105L, GameFormat.COMMANDER, 5,
                Tables.human("commander-mono-red-raiders"), Tables.bot("commander-mono-green-stompers"),
                Tables.human("commander-mono-white-soldiers")))
            .setup((game, ids, seat, view) -> game.getState().getTurnMods()
                .add(new TurnMod(ids.get(1)).withNewController(ids.get(0))));
        HumanGame game = Tables.start(scenario.gameRequest, scenario);
        running.set(game);
        try {
            Tables.play(game, policy, 4, new Tables.Coverage());
        } catch (AssertionError e) {
            assertTrue(e.getMessage().contains("eliminated"), e.getMessage());
            Tables.play(game, pass, 4, new Tables.Coverage());
        }
        scenario.settle();
        assertTrue(problems.isEmpty(), "problems: " + problems);
        assertTrue(scenario.failures.isEmpty(), "leaks or wrong views: " + scenario.failures);
        HumanGame.Result result = Tables.finalSnapshot(game, 2).result();
        assertFalse("error".equals(result.kind()), result.toString());
        assertTrue(conceded.get(), "seat 0 held a prompt for the bot");
        assertTrue(result.turns() >= 3, "the game went on after the controller left: " + result);
    }

    @Test
    void aBotDoesNotTakeControlOfAHumansTurn() throws Exception {
        // XMage lets no computer player control a turn: the bot's control of seat 1's turn 2 does not
        // happen ("is AI and can't take control"), and seat 1 plays that turn itself.
        Seen seen = new Seen();
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request(7106L, GameFormat.LEGACY, 4,
                Tables.bot(LEGACY.get(0)), Tables.human(LEGACY.get(1))))
            .setup((game, ids, seat, view) -> game.getState().getTurnMods()
                .add(new TurnMod(ids.get(1)).withNewController(ids.get(0))))
            .probe(seen.probe());
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        Run run = play(scenario, new AtomicReference<>(), (seat, prompt, view) -> {
            seen.prompt(seat, prompt, view);
            return pass.choose(seat, prompt, view);
        });
        assertTrue(seen.own(2, 1) > 0, "seat 1 decided its own turn 2");
        assertTrue(seen.answeredFor.isEmpty(), "no prompt for another seat: " + seen.answeredFor);
        assertTrue(seen.controllers(2, 1).isEmpty(), "nobody controlled seat 1");
        assertTrue(run.log().stream().anyMatch(line -> line.contains("can't take control")), "XMage's log line");
    }

    @Test
    void controllingAPlayerControlsTheirTeamForAHumanSeat() throws Exception {
        // 805.8: seat 0 controlling seat 3's next turn controls team B's turn 2, both seat 2 (a human
        // seat) and seat 3 (a bot): seat 0 answers for both, sees both hands (and its teammate's) that
        // turn, its teammate does not, and seat 2 is asked nothing and sees that seat 0 controls it.
        Seen seen = new Seen();
        List<String> decks = GameFormat.TWO_HEADED_GIANT.decks();
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request(7107L, GameFormat.TWO_HEADED_GIANT, 4,
                Tables.human(decks.get(0)), Tables.human(decks.get(1)), Tables.human(decks.get(2)),
                Tables.bot(decks.get(3))))
            .setup((game, ids, seat, view) -> game.getState().getTurnMods()
                .add(new TurnMod(ids.get(3)).withNewController(ids.get(0))))
            .probe(seen.probe());
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        Run run = play(scenario, new AtomicReference<>(), (seat, prompt, view) -> {
            seen.prompt(seat, prompt, view);
            if (prompt.forSeat() != null && prompt.kind().equals("declare_attackers")) {
                // Team B attacks with everything it can, as seat 0 decides.
                var all = ScriptedPlayer.byAction(prompt.options(), "all_attack");
                boolean fresh = prompt.options().stream()
                    .anyMatch(option -> option.action().equals("toggle_attacker") && !option.selected());
                if (fresh && !all.isEmpty()) {
                    return all.get(0).id();
                }
            }
            return pass.choose(seat, prompt, view);
        });
        System.out.println("Answered for others: " + seen.answeredFor + "; hands: " + seen.handsShown);

        assertEquals(Set.of(2), seen.turnsAnsweringFor(0), "seat 0 answered for team B in turn 2 only");
        assertTrue(seen.forOthers(2, 0).contains(2), "for seat 2: " + seen.answeredFor);
        assertTrue(seen.forOthers(2, 0).contains(3), "for seat 3, the bot: " + seen.answeredFor);
        assertEquals(0, seen.own(2, 2), "seat 2 was asked nothing in team B's controlled turn");
        assertEquals(Set.of(1, 2, 3), seen.hands(2, 0), "seat 0 saw its teammate's hand and team B's");
        assertEquals(Set.of(1), seen.hands(3, 0), "then its teammate's only");
        for (int turn = 1; turn <= 4; turn++) {
            assertEquals(Set.of(0), seen.hands(turn, 1), "seat 0's teammate sees only seat 0's hand");
            assertEquals(Set.of(3), seen.hands(turn, 2), "seat 2 sees only its teammate's hand");
        }
        assertEquals(Set.of(0), seen.controllers(2, 2), "seat 2 saw that seat 0 controls its turn");
        assertTrue(seen.controllers(3, 2).isEmpty() && seen.controllers(4, 2).isEmpty());
        assertTrue(run.scenario().reached.contains("controlled player's hand shown"));
    }

    @Test
    void gamesWithoutTurnControlShowNoControl() throws Exception {
        // Nobody controls a turn: no prompt is for another seat, no player entry names a controller,
        // and no hand is shown outside a team.
        Seen seen = new Seen();
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request(7108L, GameFormat.LEGACY, 4,
                Tables.human(LEGACY.get(0)), Tables.human(LEGACY.get(1))))
            .probe(seen.probe())
            .probe((game, ids, seat, view) -> {
                for (SeatView.PlayerState player : view.opponents()) {
                    if (player.controlledBy() != null) {
                        seen.problems.add("seat " + player.seat() + " shown as controlled");
                    }
                }
            });
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        play(scenario, new AtomicReference<>(), (seat, prompt, view) -> {
            seen.prompt(seat, prompt, view);
            return pass.choose(seat, prompt, view);
        });
        assertTrue(seen.problems.isEmpty(), "problems: " + seen.problems);
        assertTrue(seen.answeredFor.isEmpty() && seen.handsShown.isEmpty() && seen.controlledBy.isEmpty());
    }
}
