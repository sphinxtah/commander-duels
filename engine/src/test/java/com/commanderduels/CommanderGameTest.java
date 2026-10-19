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
import mage.game.CommanderDuel;
import mage.game.CommanderFreeForAll;
import mage.game.Game;
import mage.game.GameCommanderImpl;
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
        var check = new SeatChecks(request);
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
        System.out.printf("Commander %s seed %d: %s after %d turns in %d s, %d prompts answered %s, %d views checked;"
                + " highest tax %d, most commander damage %d%n", players, seed,
            result.kind() + (result.winnerSeat() == null ? "" : " (seat " + result.winnerSeat() + " won)"),
            result.turns(), TimeUnit.NANOSECONDS.toSeconds(System.nanoTime() - started), played.answered(),
            played.answeredBySeat(), check.viewsChecked.get(), check.maxTax.get(), check.maxCommanderDamage.get());
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
}
