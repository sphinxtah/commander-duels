package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import mage.cards.decks.Deck;
import mage.constants.RangeOfInfluence;
import mage.game.CommanderDuel;
import mage.game.CommanderFreeForAll;
import mage.game.Game;
import mage.game.GameCommanderImpl;
import mage.players.Player;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * Commander tables of two, three and four seats, with any mix of human and bot seats. Scripted
 * players answer every human seat's prompts, and every view published to every human seat is checked
 * against XMage's state: concealed cards, counts, and each commander's zone, tax and commander damage.
 * Needs ./db (the card database) and ./decks.
 */
class CommanderGameTest {
    private static final Tables.Coverage COVERAGE = new Tables.Coverage();
    private static final Set<String> REACHED = ConcurrentHashMap.newKeySet();
    private static final List<Integer> MAX_TAX = new CopyOnWriteArrayList<>();
    private static final List<Integer> MAX_DAMAGE = new CopyOnWriteArrayList<>();

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    @AfterAll
    static void report() {
        COVERAGE.summary().forEach(System.out::println);
        System.out.println("Commander situations reached: " + new java.util.TreeSet<>(REACHED)
            + "; highest tax " + MAX_TAX.stream().max(Integer::compare).orElse(0)
            + "; most commander damage " + MAX_DAMAGE.stream().max(Integer::compare).orElse(0));
        assertTrue(COVERAGE.unsupported.isEmpty(),
            "XMage requests the Commander fixtures reach but no prompt types: " + COVERAGE.unsupported);
        for (String kind : List.of("priority", "mulligan", "choose_target", "choose_defender", "pay_mana",
                "declare_attackers", "declare_blockers")) {
            assertTrue(COVERAGE.kinds.containsKey(kind), "the Commander games never saw a " + kind + " prompt");
        }
        assertTrue(REACHED.contains("commander zone battlefield"), "no commander was ever cast: " + REACHED);
    }

    /** Seat i plays fixture deck (i + offset) mod 4, so every deck meets every seat across the tables. */
    static HumanGameRequest table(String players, long seed, int turnCap) {
        String[] kinds = players.split(",");
        List<String> decks = GameFormat.COMMANDER.decks();
        List<HumanGameRequest.Seat> seats = new ArrayList<>();
        for (int i = 0; i < kinds.length; i++) {
            seats.add(new HumanGameRequest.Seat(kinds[i].trim(), decks.get((int) ((i + seed) % decks.size()))));
        }
        return new HumanGameRequest(seed, GameFormat.COMMANDER, seats, 1, turnCap, 900);
    }

    @Test
    void fixtureDecksAreCommanderLegalAndShareNoCardName() throws Exception {
        Set<String> seen = new java.util.HashSet<>();
        for (String name : GameFormat.COMMANDER.decks()) {
            Deck deck = GameFormat.COMMANDER.loadDeck(SeatChecks.DECKS, name);
            assertEquals(99, deck.getMaindeckCards().size(), name);
            assertEquals(1, deck.getSideboard().size(), name + " has one commander");
            for (String card : SeatChecks.deckNames(name)) {
                assertTrue(seen.add(card), card + " appears in two Commander fixtures");
            }
        }
    }

    @ParameterizedTest(name = "{0}, seed {1}")
    @CsvSource(delimiter = ';', value = {
        "human,bot; 301",
        "bot,human; 302",
        "human,human; 303",
        "human,bot,bot; 311",
        "bot,human,human; 312",
        "human,bot,bot,bot; 321",
        "human,human,bot,bot; 322",
        "human,human,human,human; 323",
        "human,human,human,human; 324",
    })
    void scriptedCommanderTablesFinishWithoutLeaks(String players, long seed) throws Exception {
        int seatCount = players.split(",").length;
        HumanGameRequest request = table(players, seed, 8 * seatCount + 6);
        List<FairBot> bots = new CopyOnWriteArrayList<>();
        var check = new SeatChecks(request) {
            @Override
            public Player bot(int seat, String name, RangeOfInfluence range, int skill, long botSeed) {
                var bot = (FairBot) super.bot(seat, name, range, skill, botSeed);
                bots.add(bot);
                return bot;
            }
        };
        Map<Integer, ScriptedPlayer> scripted = new ConcurrentHashMap<>();
        HumanGame game = Tables.start(request, check);
        long started = System.nanoTime();
        Tables.Played played = Tables.play(game, (seat, prompt, view) ->
            scripted.computeIfAbsent(seat, s -> new ScriptedPlayer(seed * 10 + s)).choose(prompt, view), 6, COVERAGE);

        HumanGame.Result result = played.last().result();
        assertEquals("finished", played.last().status());
        assertTrue(Set.of("completed", "turn_limit", "humans_eliminated").contains(result.kind()), "result " + result);
        assertNull(result.error());
        check.settle();
        assertTrue(check.failures.isEmpty(), "leaks or wrong views: " + check.failures);
        assertTrue(played.answered() > 10, "only " + played.answered() + " prompts answered");
        assertEquals(request.humanSeats(), played.answeredBySeat().size(), "every human seat was asked");
        assertTrue(BotMatchRunner.join(game.thread(), 10_000), "game thread still running");
        REACHED.addAll(check.reached);
        MAX_TAX.add(check.maxTax.get());
        MAX_DAMAGE.add(check.maxCommanderDamage.get());
        // AI05 on the largest boards the fixtures reach: every search stopped when told to, and no
        // decision took longer than its budget and the stop grace.
        long searches = 0;
        long continued = 0;
        long timedOut = 0;
        long longest = 0;
        for (FairBot bot : bots) {
            FairBot.Stats stats = bot.stats();
            assertEquals(0, stats.abandoned(), bot.getName() + " abandoned a search");
            assertTrue(stats.longestMillis() <= bot.budget().thinkMillis() + FairBot.STOP_GRACE_MILLIS + 1_000,
                bot.getName() + " took " + stats.longestMillis() + " ms over one decision");
            searches += stats.searches();
            continued += stats.continued();
            timedOut += stats.timedOut();
            longest = Math.max(longest, stats.longestMillis());
        }
        System.out.printf("Commander %s seed %d: %s after %d turns in %d s, %d prompts answered %s, %d views checked;"
                + " highest tax %d, most commander damage %d; bots searched %d times, continued %d chains,"
                + " %d searches timed out, longest %d ms%n", players, seed,
            result.kind() + (result.winnerSeat() == null ? "" : " (seat " + result.winnerSeat() + " won)"),
            result.turns(), TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - started), played.answered(),
            played.answeredBySeat(), check.viewsChecked.get(), check.maxTax.get(), check.maxCommanderDamage.get(),
            searches, continued, timedOut, longest);
    }

    /**
     * FMT02: two seats use XMage's CommanderDuel, where the starting player skips the first draw and
     * no mulligan is free; three and four use CommanderFreeForAll, where nobody skips the draw and the
     * first mulligan is free. Everyone starts at 40 life.
     */
    @ParameterizedTest(name = "{0} seats")
    @ValueSource(ints = {2, 3, 4})
    void tablesFollowTheirRulesProfile(int seats) throws Exception {
        List<String> players = new ArrayList<>(List.of("human"));
        for (int i = 1; i < seats; i++) {
            players.add("bot");
        }
        HumanGameRequest request = table(String.join(",", players), 40 + seats, 10);
        Map<String, Object> seen = new ConcurrentHashMap<>();
        HumanGame game = Tables.start(request, new HumanGame.Hooks() {
            @Override
            public void beforeStart(Game game, List<UUID> seatIds) {
                for (int seat = 0; seat < seatIds.size(); seat++) {
                    SEATS.put(seatIds.get(seat), seat);
                }
            }

            @Override
            public void published(Game game, ObjectRefs refs, int seat, SeatView view, PromptView prompt) {
                // XMage sets life totals once the starting player is chosen, before the mulligans.
                if (prompt != null && prompt.kind().equals("mulligan") && !seen.containsKey("skipsDraw")) {
                    seen.put("class", game.getClass());
                    seen.put("freeMulligans", game.getMulligan().getFreeMulligans());
                    seen.put("skipsDraw", startingPlayerSkipsDraw(game));
                    seen.put("life", view.you().life());
                    var order = game.getState().getPlayerList(game.getState().getPlayerList().get(0));
                    List<Integer> turns = new ArrayList<>();
                    UUID first = order.get();
                    UUID next = first;
                    do {
                        turns.add(game.getState().getPlayerList().indexOf(next) < 0 ? -1 : seatOf(game, next));
                        next = order.getNext();
                    } while (!next.equals(first));
                    seen.put("turnOrder", turns);
                    seen.put("opponentLife", view.opponents().stream().map(SeatView.PlayerState::life).toList());
                }
            }
        });
        HumanGame.Snapshot first = Tables.nextPrompt(game, 0, -1);
        assertEquals(seats == 2 ? "commander_two_seat" : "commander_free_for_all", first.settings().rulesProfile());
        assertEquals("commander", first.settings().format());
        while (!seen.containsKey("skipsDraw") && first.prompt() != null) {
            // Answer the starting-player choice, if the human makes it, to reach the mulligan.
            game.submit(0, Tables.answer(game, java.util.UUID.randomUUID().toString(), first.revision(),
                first.prompt().id(), first.prompt().options().get(0).id()));
            first = Tables.nextPrompt(game, 0, first.revision());
        }
        game.close("closed");
        assertEquals(seats == 2 ? CommanderDuel.class : CommanderFreeForAll.class, seen.get("class"));
        assertEquals(seats == 2 ? 0 : 1, seen.get("freeMulligans"));
        assertEquals(seats == 2, seen.get("skipsDraw"));
        assertEquals(GameFormat.COMMANDER_START_LIFE, seen.get("life"));
        List<?> turns = (List<?>) seen.get("turnOrder");
        int start = turns.indexOf(0);
        for (int i = 0; i < seats; i++) {
            assertEquals(i, turns.get((start + i) % seats), "turns pass in seat order: " + turns);
        }
        assertEquals(java.util.Collections.nCopies(seats - 1, GameFormat.COMMANDER_START_LIFE), seen.get("opponentLife"));
        assertEquals("closed", Tables.finalSnapshot(game, 0).result().kind());
    }

    private static final Map<UUID, Integer> SEATS = new ConcurrentHashMap<>();

    private static int seatOf(Game game, UUID playerId) {
        return SEATS.getOrDefault(playerId, -1);
    }

    private static boolean startingPlayerSkipsDraw(Game game) {
        try {
            Field field = GameCommanderImpl.class.getDeclaredField("startingPlayerSkipsDraw");
            field.setAccessible(true);
            return field.getBoolean(game);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * NET14: a spectator sees public information only, and sees it late. Every spectator snapshot
     * must be a public view published at least the delay before it was read, and the result arrives
     * only after the same delay.
     */
    @Test
    void spectatorsSeeThePublicGameLate() throws Exception {
        List<HumanGameRequest.Seat> seats = List.of(Tables.human(GameFormat.COMMANDER.decks().get(0)),
            Tables.bot(GameFormat.COMMANDER.decks().get(1)));
        var request = new HumanGameRequest(61L, GameFormat.COMMANDER, seats, 1, 40, 900, 1);
        var check = new SeatChecks(request);
        HumanGame game = Tables.start(request, check);
        long delay = TimeUnit.SECONDS.toNanos(1);
        List<String> problems = new CopyOnWriteArrayList<>();
        var reads = new java.util.concurrent.atomic.AtomicInteger();
        Thread spectator = Thread.ofPlatform().name("spectator-client").start(() -> {
            long since = -1;
            try {
                while (true) {
                    long asked = System.nanoTime();
                    HumanGame.Snapshot snapshot = game.spectatorSnapshot(since, 2_000, -1);
                    reads.incrementAndGet();
                    if (snapshot.seat() != null || snapshot.prompt() != null) {
                        problems.add("a spectator snapshot has a seat or a prompt");
                    }
                    if (snapshot.view() != null) {
                        // The view must have been published at least the delay before this read began.
                        boolean oldEnough = check.spectatorHistory.stream().anyMatch(entry ->
                            entry.getValue().equals(snapshot.view())
                                && entry.getKey() <= System.nanoTime() - delay + TimeUnit.MILLISECONDS.toNanos(50));
                        if (!oldEnough) {
                            problems.add("a spectator saw a view younger than the delay at revision "
                                + snapshot.revision() + " (asked " + asked + ")");
                        }
                    }
                    if (snapshot.result() != null) {
                        return;
                    }
                    since = snapshot.revision();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        Map<Integer, ScriptedPlayer> scripted = new ConcurrentHashMap<>();
        Tables.Played played = Tables.play(game, (seat, prompt, view) ->
            scripted.computeIfAbsent(seat, s -> new ScriptedPlayer(61 + s)).choose(prompt, view), 4, COVERAGE);
        HumanGame.Snapshot early = game.spectatorSnapshot(Long.MAX_VALUE - 1, 0, -1);
        assertNull(early.result(), "the result reaches spectators only after the delay");
        assertTrue(BotMatchRunner.join(spectator, 10_000), "the spectator saw the result");
        HumanGame.Snapshot last = game.spectatorSnapshot(-1, 0, -1);
        assertEquals("finished", last.status());
        assertEquals(played.last().result(), last.result());
        assertEquals(1, last.settings().spectatorDelaySeconds());
        assertTrue(last.settings().seats().stream().allMatch(entry -> entry.deck() == null), "no deck names");
        check.settle();
        assertTrue(check.failures.isEmpty(), "leaks or wrong views: " + check.failures);
        assertTrue(problems.isEmpty(), "spectator problems: " + problems);
        assertTrue(reads.get() > 2 && check.spectatorViewsChecked.get() > 2, "the spectator read " + reads.get()
            + " snapshots of " + check.spectatorViewsChecked.get() + " views");
    }

    /**
     * A seat that concedes while the decks load leaves at its first request from XMage. It must not
     * be shown that request as an open prompt: XMage no longer waits for it, and the seat is out.
     */
    @Test
    void aSeatThatConcedesBeforeTheStartIsNeverAsked() throws Exception {
        HumanGameRequest request = table("human,human,bot", 81, 6);
        List<Integer> concessions = new CopyOnWriteArrayList<>();
        var check = new SeatChecks(request) {
            @Override
            public void beforeStart(Game started, List<UUID> ids) {
                super.beforeStart(started, ids);
                // On the game thread before XMage starts: the concession waits for the seat's first request.
                try {
                    concessions.add(this.game.concede(1, Tables.concede(this.game, 0)).status());
                } catch (JsonRequest.Invalid e) {
                    throw new IllegalStateException(e);
                }
            }
        };
        HumanGame game = Tables.start(request, check);
        List<String> seen = new CopyOnWriteArrayList<>();
        Thread client = Thread.ofPlatform().name("seat-1-client").start(() -> {
            long since = -1;
            try {
                while (true) {
                    HumanGame.Snapshot snapshot = game.snapshot(1, since, 2_000, 0);
                    seen.add(snapshot.status() + (snapshot.prompt() == null ? "" : " with a prompt"));
                    if (snapshot.result() != null) {
                        return;
                    }
                    since = snapshot.revision();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        var player = new ScriptedPlayer(81);
        Tables.Played played = Tables.play(game, (seat, prompt, view) -> player.choose(prompt, view), 4, COVERAGE);
        assertTrue(BotMatchRunner.join(client, 10_000), "seat 1's client saw the result");

        assertEquals(List.of(200), concessions);
        assertEquals(Set.of(0), played.answeredBySeat().keySet(), "seat 1 was asked after conceding");
        assertTrue(seen.stream().noneMatch(status -> status.contains("prompt")), "seat 1 was shown: " + seen);
        assertTrue(seen.contains("eliminated"), "seat 1 was not shown as out while the game went on: " + seen);
        assertEquals(List.of(1), played.last().result().concededSeats());
        check.settle();
        assertTrue(check.failures.isEmpty(), "leaks or wrong views: " + check.failures);
    }

    /** With bots left but no human, the engine stops the game instead of letting the bots play on. */
    @Test
    void aTableWhoseHumansAreAllOutStops() throws Exception {
        HumanGameRequest request = table("human,bot,bot", 77, 30);
        HumanGame game = Tables.start(request, HumanGame.Hooks.NONE);
        HumanGame.Snapshot snapshot = Tables.nextPrompt(game, 0, -1);
        assertEquals(200, game.concede(0, Tables.concede(game, snapshot.revision())).status());
        HumanGame.Snapshot last = Tables.finalSnapshot(game, 0);
        assertEquals("humans_eliminated", last.result().kind(), last.result().toString());
        assertNull(last.result().winnerSeat());
        assertEquals(List.of(0), last.result().concededSeats());
        Tables.assertRejected(409, "game_over", game.concede(0, Tables.concede(game, last.revision())));
        assertTrue(BotMatchRunner.join(game.thread(), 10_000));
    }

    /**
     * With one bot left, XMage ends the game and names that bot the winner. The engine does not
     * start a close of its own, which raced XMage's end ("Non-game thread can't concede").
     */
    @Test
    void aTableLeftToOneBotEndsWithThatBotWinning() throws Exception {
        HumanGameRequest request = table("human,human,bot", 78, 30);
        HumanGame game = Tables.start(request, HumanGame.Hooks.NONE);
        // Both humans keep their hands and concede at their first prompt of the game itself, so the
        // last of them leaves a started game to one bot. XMage asks one player at a time, in its order.
        List<Integer> playing = new ArrayList<>(List.of(0, 1));
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (!playing.isEmpty()) {
            assertTrue(System.nanoTime() < deadline, "seats " + playing + " were not asked within 60 s");
            boolean asked = false;
            for (Integer seat : List.copyOf(playing)) {
                HumanGame.Snapshot snapshot = game.snapshot(seat, -1, 0, 0);
                PromptView prompt = snapshot.prompt();
                if (prompt == null) {
                    continue;
                }
                asked = true;
                if (prompt.kind().equals("mulligan")) {
                    String keep = prompt.options().stream().filter(option -> option.action().equals("keep"))
                        .findFirst().orElseThrow().id();
                    assertEquals(200, game.submit(seat, Tables.answer(game, UUID.randomUUID().toString(),
                        snapshot.revision(), prompt.id(), keep)).status());
                } else {
                    assertEquals(200, game.concede(seat, Tables.concede(game, snapshot.revision())).status());
                    playing.remove(seat);
                }
            }
            if (!asked) {
                Thread.sleep(50);
            }
        }
        HumanGame.Snapshot last = Tables.finalSnapshot(game, 0);
        assertEquals("completed", last.result().kind(), last.result().toString());
        assertEquals(2, last.result().winnerSeat());
        assertEquals(Set.of(0, 1), Set.copyOf(last.result().concededSeats()));
        assertTrue(BotMatchRunner.join(game.thread(), 10_000));
    }

    /**
     * Two players at a human table (v0.4.0): one concedes while the other holds a prompt, and the
     * game ends at once with the other's win. XMage alone would wait for the winner's next answer.
     */
    @Test
    void aConcessionThatLeavesOnePlayerEndsTheGameAtOnce() throws Exception {
        Tables.actAsClient();
        HumanGame game = Tables.start(table("human,human", 79, 30), HumanGame.Hooks.NONE);
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        Integer holder = null;
        while (holder == null) {
            assertTrue(System.nanoTime() < deadline, "no prompt of the game itself within 60 s");
            for (int seat : List.of(0, 1)) {
                HumanGame.Snapshot snapshot = game.snapshot(seat, -1, 0, 0);
                PromptView prompt = snapshot.prompt();
                if (prompt == null) {
                    continue;
                }
                if (prompt.kind().equals("priority")) {
                    holder = seat;
                } else {
                    // Who plays first, then the mulligans: answered until the game itself asks.
                    String choice = prompt.options().stream()
                        .filter(option -> option.action().equals("keep") || option.action().equals("yes"))
                        .findFirst().orElse(prompt.options().get(0)).id();
                    assertEquals(200, game.submit(seat, Tables.answer(game, UUID.randomUUID().toString(),
                        snapshot.revision(), prompt.id(), choice)).status());
                }
                break;
            }
            if (holder == null) {
                Thread.sleep(50);
            }
        }
        int other = 1 - holder;
        HumanGame.Snapshot theirs = game.snapshot(other, -1, 0, 0);
        assertNull(theirs.prompt(), "both seats hold a prompt");
        assertEquals(200, game.concede(other, Tables.concede(game, theirs.revision())).status());
        // The holder never answers: the end comes without it.
        HumanGame.Snapshot last = Tables.finalSnapshot(game, holder);
        assertEquals("completed", last.result().kind(), last.result().toString());
        assertEquals(holder, last.result().winnerSeat());
        assertEquals(List.of(other), last.result().concededSeats());
        assertTrue(BotMatchRunner.join(game.thread(), 10_000));
    }
}
