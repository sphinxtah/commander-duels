package com.commanderduels;

import static com.commanderduels.Tables.answer;
import static com.commanderduels.Tables.amounts;
import static com.commanderduels.Tables.assertRejected;
import static com.commanderduels.Tables.bot;
import static com.commanderduels.Tables.concede;
import static com.commanderduels.Tables.finalSnapshot;
import static com.commanderduels.Tables.human;
import static com.commanderduels.Tables.nextPrompt;
import static com.commanderduels.Tables.start;
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
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

/**
 * Real Legacy human-versus-bot games: a scripted player answers every prompt through the seat API,
 * and every view and prompt published to the seat is checked, on the game thread, against XMage's
 * own state. Needs ./db (the card database) and ./decks.
 */
class HumanGameTest {
    private static final Tables.Coverage COVERAGE = new Tables.Coverage();

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    @AfterAll
    static void everyFixturePromptFamilyWasTyped() {
        COVERAGE.summary().forEach(System.out::println);
        assertTrue(COVERAGE.unsupported.isEmpty(),
            "XMage requests the fixture decks reach but no prompt types: " + COVERAGE.unsupported);
        for (String kind : List.of("priority", "mulligan", "choose_target", "pay_mana", "declare_attackers",
                "declare_blockers")) {
            assertTrue(COVERAGE.kinds.containsKey(kind), "the scripted games never saw a " + kind + " prompt");
        }
    }

    static HumanGameRequest legacy(long seed, String humanDeck, int turnCap, int idleTimeoutSeconds) {
        String botDeck = LegacyDuel.DECKS.stream().filter(deck -> !deck.equals(humanDeck)).findFirst().orElseThrow();
        return HumanGameRequest.of(seed, GameFormat.LEGACY, 1, turnCap, idleTimeoutSeconds, human(humanDeck),
            bot(botDeck));
    }

    @ParameterizedTest(name = "{0} against the bot, seed {1}")
    @CsvSource({
        "legacy-mono-red-burn, 101",
        "legacy-mono-red-burn, 102",
        "legacy-mono-red-burn, 103",
        "legacy-mono-green-creatures, 201",
        "legacy-mono-green-creatures, 202",
        "legacy-mono-green-creatures, 203",
    })
    void scriptedGamesFinishWithoutLeaks(String humanDeck, long seed) throws Exception {
        HumanGameRequest request = legacy(seed, humanDeck, 20, 600);
        var check = new SeatChecks(request);
        var player = new ScriptedPlayer(seed);
        HumanGame game = start(request, check);
        long deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(4);
        long since = -1;
        int answered = 0;
        boolean probed = false;
        HumanGame.Snapshot snapshot;
        while (true) {
            snapshot = nextPrompt(game, 0, since);
            since = snapshot.revision();
            if (snapshot.result() != null) {
                break;
            }
            assertTrue(System.nanoTime() < deadline, "game did not finish in time");
            PromptView prompt = snapshot.prompt();
            COVERAGE.saw(prompt);
            assertEquals("your_prompt".equals(snapshot.status()), !prompt.kind().equals("unsupported"));
            if (prompt.kind().equals("unsupported")) {
                assertRejected(409, "unsupported_prompt",
                    game.submit(0, answer(game, UUID.randomUUID().toString(), since, prompt.id(), "1")));
                assertEquals(200, game.concede(0, concede(game, since)).status());
                continue;
            }
            String option = player.choose(prompt, snapshot.view());
            if (!probed && prompt.options().size() > 1) {
                probeStaleAnswers(game, snapshot, option);
                probed = true;
            } else if (prompt.kind().equals("assign_amounts") && player.customAmounts) {
                List<Integer> split = prompt.amounts().entries().stream().map(PromptView.AmountEntry::suggested)
                    .toList();
                List<Integer> tooMany = new ArrayList<>(split);
                tooMany.add(0);
                assertRejected(422, "invalid_amounts", game.submit(0, amounts(game, since, prompt.id(), tooMany)));
                HumanGame.Reply reply = game.submit(0, amounts(game, since, prompt.id(), split));
                assertEquals(200, reply.status(), reply.body().toString());
                COVERAGE.kinds.merge("assign_amounts (custom)", 1, Integer::sum);
            } else {
                HumanGame.Reply reply = game.submit(0, answer(game, UUID.randomUUID().toString(), since, prompt.id(),
                    option));
                assertEquals(200, reply.status(), reply.body().toString());
            }
            answered++;
        }

        HumanGame.Result result = snapshot.result();
        assertEquals("finished", snapshot.status());
        assertTrue(Set.of("completed", "turn_limit").contains(result.kind()), "result " + result);
        assertNull(result.error());
        check.settle();
        assertTrue(check.failures.isEmpty(), "leaks or wrong views: " + check.failures);
        assertTrue(answered > 10, "only " + answered + " prompts answered");
        assertTrue(check.viewsChecked.get() > answered, "views checked " + check.viewsChecked.get());
        assertTrue(check.logLinesChecked.get() > 0);
        assertTrue(snapshot.logCount() > 0);
        assertNotNull(snapshot.view());
        assertEquals(1, snapshot.view().opponents().size());
        assertTrue(BotMatchRunner.join(game.thread(), 10_000), "game thread still running");
        System.out.printf("%s seed %d: %s after %d turns, %d prompts answered, %d views checked%n", humanDeck, seed,
            result.kind() + (result.winnerSeat() == null ? "" : " (seat " + result.winnerSeat() + " won)"),
            result.turns(), answered, check.viewsChecked.get());
    }

    /** Stale, forged and repeated answers are refused without consuming the open prompt. */
    private static void probeStaleAnswers(HumanGame game, HumanGame.Snapshot snapshot, String option)
            throws Exception {
        long revision = snapshot.revision();
        String promptId = snapshot.prompt().id();
        String other = snapshot.prompt().options().stream().map(PromptView.Option::id)
            .filter(id -> !id.equals(option)).findFirst().orElseThrow();
        assertRejected(409, "stale_prompt", game.submit(0,
            answer(game, UUID.randomUUID().toString(), revision, UUID.randomUUID().toString(), option)));
        assertRejected(409, "stale_revision",
            game.submit(0, answer(game, UUID.randomUUID().toString(), revision - 1, promptId, option)));
        assertRejected(422, "invalid_option",
            game.submit(0, answer(game, UUID.randomUUID().toString(), revision, promptId, "999")));
        assertEquals(promptId, game.snapshot(0, -1, 0, 0).prompt().id(), "refusals must leave the prompt open");

        String actionId = UUID.randomUUID().toString();
        HumanGame.Reply accepted = game.submit(0, answer(game, actionId, revision, promptId, option));
        assertEquals(200, accepted.status(), accepted.body().toString());
        assertEquals("accepted", accepted.body().get("status"));
        assertEquals(accepted, game.submit(0, answer(game, actionId, revision, promptId, option)),
            "a retried action returns its original result");
        assertRejected(409, "action_id_reused", game.submit(0, answer(game, actionId, revision, promptId, other)));
        assertRejected(409, "stale_prompt",
            game.submit(0, answer(game, UUID.randomUUID().toString(), revision, promptId, other)));
    }

    @Test
    void concedingEndsTheGameForTheBot() throws Exception {
        HumanGame game = start(legacy(7L, LegacyDuel.DECKS.get(0), 20, 600), HumanGame.Hooks.NONE);
        HumanGame.Snapshot snapshot = nextPrompt(game, 0, -1);
        assertNull(snapshot.result());
        assertEquals(200, game.concede(0, concede(game, snapshot.revision())).status());
        HumanGame.Snapshot last = finalSnapshot(game, 0);
        assertEquals("completed", last.result().kind(), last.result().toString());
        assertEquals(1, last.result().winnerSeat());
        assertEquals(List.of(0), last.result().concededSeats());
        assertNull(last.prompt());
        assertRejected(409, "game_over", game.concede(0, concede(game, last.revision())));
        assertTrue(BotMatchRunner.join(game.thread(), 10_000));
    }

    @Test
    void closingStopsAGameThatIsWaitingForTheSeat() throws Exception {
        HumanGame game = start(legacy(8L, LegacyDuel.DECKS.get(1), 20, 600), HumanGame.Hooks.NONE);
        nextPrompt(game, 0, -1);
        Map<String, Object> closed = game.close("closed");
        assertEquals("finished", closed.get("status"), closed.toString());
        HumanGame.Snapshot last = finalSnapshot(game, 0);
        assertEquals("closed", last.result().kind());
        assertNull(last.result().winnerSeat());
        assertEquals(List.of(), last.result().concededSeats(), "closing is not a concession");
        assertFalse(game.thread().isAlive());
        assertEquals("finished", game.close("closed").get("status"), "closing twice is harmless");
    }

    @Test
    void idleGamesAreClosed() throws Exception {
        var games = new HumanGames(SeatChecks.DECKS, 1);
        var request = legacy(9L, LegacyDuel.DECKS.get(0), 20, HumanGameRequest.MIN_IDLE_TIMEOUT_SECONDS);
        HumanGame game = games.create(request).orElseThrow().game();
        assertTrue(games.create(request).isEmpty(), "only one game may run");
        HumanGame.Snapshot last = finalSnapshot(game, 0);
        assertEquals("idle_timeout", last.result().kind());
        assertTrue(BotMatchRunner.join(game.thread(), 10_000));
        assertEquals(0, games.active());
        List<String> created = new ArrayList<>();
        games.create(request).ifPresent(next -> {
            created.add(next.game().id());
            next.game().close("closed");
        });
        assertEquals(1, created.size(), "a slot frees up once the idle game ends");
    }
}
