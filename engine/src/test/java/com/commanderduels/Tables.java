package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/** Starting development games and answering every human seat's prompts, for the engine tests. */
final class Tables {
    private Tables() {}

    /** Prompt kinds a test class's games answered, and the XMage requests no prompt types. */
    static final class Coverage {
        final Map<String, Integer> kinds = new ConcurrentHashMap<>();
        final Set<String> unsupported = ConcurrentHashMap.newKeySet();

        void saw(PromptView prompt) {
            kinds.merge(prompt.kind(), 1, Integer::sum);
            if (prompt.kind().equals("unsupported")) {
                unsupported.add(prompt.xmageQuery() + " (" + prompt.message() + ")");
            }
        }

        List<String> summary() {
            return List.of("Prompt kinds answered: " + new java.util.TreeMap<>(kinds),
                "Unsupported requests: " + unsupported);
        }
    }

    /** A policy's answer that is a custom number, "amounts:3", rather than an option id. */
    static final String AMOUNTS = "amounts:";

    /** Chooses a seat's answer: an option id, {@link #AMOUNTS} and a number, or null to concede. */
    interface Policy {
        String choose(int seat, PromptView prompt, SeatView view);
    }

    /** What a played game did. */
    record Played(HumanGame.Snapshot last, int answered, Map<Integer, Integer> answeredBySeat) {}

    /**
     * XMage treats a thread named "main" as a game thread (for its own unit tests), so a seat
     * client on JUnit's main thread would run XMage's concession handling itself, racing the game
     * thread. Requests to the engine arrive on unnamed threads; tests rename theirs to match.
     */
    static void actAsClient() {
        if (Thread.currentThread().getName().equals("main")) {
            Thread.currentThread().setName("seat-client");
        }
    }

    static HumanGameRequest.Seat human(String deck) {
        return new HumanGameRequest.Seat(HumanGameRequest.HUMAN, deck);
    }

    static HumanGameRequest.Seat bot(String deck) {
        return new HumanGameRequest.Seat(HumanGameRequest.BOT, deck);
    }

    static HumanGame start(HumanGameRequest request, HumanGame.Hooks hooks) {
        var game = new HumanGame(UUID.randomUUID().toString(), request, SeatChecks.DECKS, finished -> {}, hooks);
        if (hooks instanceof SeatChecks check) {
            check.game = game;
        }
        game.start();
        return game;
    }

    static SeatCommand answer(HumanGame game, String actionId, long revision, String promptId, String option)
            throws JsonRequest.Invalid {
        return SeatCommand.parse("{\"v\":1,\"game_id\":\"" + game.id() + "\",\"action_id\":\"" + actionId
            + "\",\"expected_revision\":" + revision + ",\"prompt_id\":\"" + promptId
            + "\",\"type\":\"submit_choice\",\"payload\":{\"option_id\":\"" + option + "\"}}", game.id());
    }

    static SeatCommand amounts(HumanGame game, long revision, String promptId, List<Integer> values)
            throws JsonRequest.Invalid {
        return SeatCommand.parse("{\"v\":1,\"game_id\":\"" + game.id() + "\",\"action_id\":\"" + UUID.randomUUID()
            + "\",\"expected_revision\":" + revision + ",\"prompt_id\":\"" + promptId
            + "\",\"type\":\"submit_choice\",\"payload\":{\"amounts\":" + values + "}}", game.id());
    }

    static SeatCommand concede(HumanGame game, long revision) throws JsonRequest.Invalid {
        return SeatCommand.parse("{\"v\":1,\"game_id\":\"" + game.id() + "\",\"action_id\":\"" + UUID.randomUUID()
            + "\",\"expected_revision\":" + revision + ",\"type\":\"concede\",\"payload\":{}}", game.id());
    }

    static void assertRejected(int status, String code, HumanGame.Reply reply) {
        assertEquals(status, reply.status(), reply.body().toString());
        assertEquals(code, reply.body().get("code"), reply.body().toString());
    }

    /**
     * Answers every human seat's prompts until the game finishes. A seat whose request has no typed
     * prompt concedes, and the request is recorded as unsupported.
     */
    static Played play(HumanGame game, Policy policy, long timeoutMinutes, Coverage coverage) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.MINUTES.toNanos(timeoutMinutes);
        int answered = 0;
        Map<Integer, Integer> bySeat = new ConcurrentHashMap<>();
        while (true) {
            assertTrue(System.nanoTime() < deadline, "game did not finish in time");
            int seat = game.awaitPromptSeat(10_000);
            if (seat == -2) {
                break;
            }
            if (seat < 0) {
                continue;
            }
            HumanGame.Snapshot snapshot = game.snapshot(seat, -1, 0, 0);
            PromptView prompt = snapshot.prompt();
            if (prompt == null) {
                continue;
            }
            coverage.saw(prompt);
            assertEquals("your_prompt".equals(snapshot.status()), !prompt.kind().equals("unsupported"));
            if (prompt.kind().equals("unsupported")) {
                assertRejected(409, "unsupported_prompt", game.submit(seat,
                    answer(game, UUID.randomUUID().toString(), snapshot.revision(), prompt.id(), "1")));
                assertEquals(200, game.concede(seat, concede(game, snapshot.revision())).status());
                continue;
            }
            String option = policy.choose(seat, prompt, snapshot.view());
            HumanGame.Reply reply;
            if (option == null) {
                reply = game.concede(seat, concede(game, snapshot.revision()));
            } else if (option.startsWith(AMOUNTS)) {
                reply = game.submit(seat, amounts(game, snapshot.revision(), prompt.id(),
                    List.of(Integer.parseInt(option.substring(AMOUNTS.length())))));
                coverage.kinds.merge(prompt.kind() + " (custom)", 1, Integer::sum);
            } else {
                reply = game.submit(seat, answer(game, UUID.randomUUID().toString(), snapshot.revision(), prompt.id(),
                    option));
            }
            if (reply.status() == 409 && "stale_revision".equals(reply.body().get("code"))) {
                continue; // the seat's view changed while its prompt was open; read it again
            }
            assertEquals(200, reply.status(), prompt.kind() + " " + option + ": " + reply.body());
            answered++;
            bySeat.merge(seat, 1, Integer::sum);
        }
        return new Played(finalSnapshot(game, game.humanSeats().get(0)), answered, bySeat);
    }

    static HumanGame.Snapshot finalSnapshot(HumanGame game, int seat) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        HumanGame.Snapshot snapshot = game.snapshot(seat, -1, 0, 0);
        while (snapshot.result() == null) {
            assertTrue(System.nanoTime() < deadline, "game did not finish; status " + snapshot.status());
            snapshot = game.snapshot(seat, snapshot.revision(), 5_000, 0);
        }
        return snapshot;
    }

    /** Waits for the next snapshot of a seat with an open prompt, or the final one. */
    static HumanGame.Snapshot nextPrompt(HumanGame game, int seat, long since) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        HumanGame.Snapshot snapshot = game.snapshot(seat, since, 10_000, 0);
        while (snapshot.prompt() == null && snapshot.result() == null) {
            assertTrue(System.nanoTime() < deadline, "no prompt within 60 s; status " + snapshot.status());
            snapshot = game.snapshot(seat, snapshot.revision(), 10_000, 0);
        }
        return snapshot;
    }
}
