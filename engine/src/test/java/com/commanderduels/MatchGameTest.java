package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import mage.cards.Card;
import mage.game.Game;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * What the API's best-of-three Legacy matches (v0.5.0) need of a game: the seat that plays first,
 * chosen before the game by the loser of the one before (FMT06), and a deck list's sideboard,
 * outside the game where wishes find it (FMT07) and no seat's view shows it. Needs ./db (the card
 * database) and ./decks.
 */
class MatchGameTest {
    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    @Test
    void theStartingSeatIsReadAndChecked() throws Exception {
        assertEquals(1, HumanGameRequest.parse("{\"format\":\"legacy\",\"starting_seat\":1}", () -> 1L)
            .startingSeat());
        assertNull(HumanGameRequest.parse("{\"format\":\"legacy\"}", () -> 1L).startingSeat());
        for (String wrong : List.of("2", "-1", "\"1\"", "1.5", "null")) {
            assertThrows(JsonRequest.Invalid.class, () -> HumanGameRequest.parse(
                "{\"format\":\"legacy\",\"starting_seat\":" + wrong + "}", () -> 1L), wrong);
        }
    }

    @Test
    void onlyLegacyListsHaveASideboard() throws Exception {
        String legacy = "{\"format\":\"legacy\",\"seats\":[{\"player\":\"human\",\"deck_list\":{\"cards\":"
            + "[{\"name\":\"Mountain\",\"count\":60}],\"sideboard\":[{\"name\":\"Lightning Bolt\",\"count\":2}]}},"
            + "{\"player\":\"bot\"}]}";
        var request = HumanGameRequest.parse(legacy, () -> 1L, true);
        assertEquals(List.of(new DeckLists.Entry("Lightning Bolt", 2)), request.seats().get(0).custom().sideboard());
        String commander = "{\"format\":\"commander\",\"seats\":[{\"player\":\"human\",\"deck_list\":{\"cards\":"
            + "[{\"name\":\"Mountain\",\"count\":99}],\"commanders\":[\"Krenko, Mob Boss\"],"
            + "\"sideboard\":[{\"name\":\"Lightning Bolt\"}]}},{\"player\":\"bot\"}]}";
        assertThrows(JsonRequest.Invalid.class, () -> HumanGameRequest.parse(commander, () -> 1L, true));
    }

    /**
     * The seat named takes the first turn, and nobody is asked who starts: not the human seat, and
     * not when the bot's seat starts.
     */
    @ParameterizedTest(name = "seat {0} starts")
    @ValueSource(ints = {0, 1})
    void theChosenSeatPlaysFirst(int starting) throws Exception {
        var request = new HumanGameRequest(808L + starting, GameFormat.LEGACY,
            List.of(Tables.human("legacy-mono-red-burn"), Tables.bot("legacy-mono-green-creatures")), 1, 6, 900, 0,
            starting);
        Map<String, Object> seen = new ConcurrentHashMap<>();
        List<UUID> ids = new CopyOnWriteArrayList<>();
        HumanGame game = Tables.start(request, new HumanGame.Hooks() {
            @Override
            public void beforeStart(Game game, List<UUID> seatIds) {
                ids.addAll(seatIds);
            }

            @Override
            public void published(Game game, ObjectRefs refs, int seat, SeatView view, PromptView prompt) {
                if (prompt != null && prompt.kind().equals("mulligan") && !seen.containsKey("starting")) {
                    seen.put("starting", ids.indexOf(game.getStartingPlayerId()));
                }
            }
        });
        List<String> asked = new ArrayList<>();
        HumanGame.Snapshot snapshot = Tables.nextPrompt(game, 0, -1);
        while (snapshot.prompt() != null && !snapshot.prompt().kind().equals("mulligan")) {
            asked.add(snapshot.prompt().kind() + ": " + snapshot.prompt().message());
            game.submit(0, Tables.answer(game, UUID.randomUUID().toString(), snapshot.revision(),
                snapshot.prompt().id(), snapshot.prompt().options().get(0).id()));
            snapshot = Tables.nextPrompt(game, 0, snapshot.revision());
        }
        game.close("closed");
        assertEquals(List.of(), asked, "the human seat was asked something before its mulligan");
        assertEquals(starting, seen.get("starting"));
        assertEquals("closed", Tables.finalSnapshot(game, 0).result().kind());
    }

    /**
     * A Legacy list's sideboard is the player's XMage sideboard, outside the game, and no other seat
     * ever sees its cards (SeatChecks treats them as part of the deck the other seat may not see).
     */
    @Test
    void aLegacySideboardWaitsOutsideTheGame() throws Exception {
        var red = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Mountain", 60)), List.of(),
            List.of(new DeckLists.Entry("Lightning Bolt", 2), new DeckLists.Entry("Shock", 1)));
        var green = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Forest", 60)), List.of(),
            List.of(new DeckLists.Entry("Giant Growth", 3)));
        var request = new HumanGameRequest(909L, GameFormat.LEGACY, List.of(
            new HumanGameRequest.Seat(HumanGameRequest.HUMAN, HumanGameRequest.CUSTOM_DECK, red),
            new HumanGameRequest.Seat(HumanGameRequest.HUMAN, HumanGameRequest.CUSTOM_DECK, green)), 1, 6, 900);
        Map<Integer, List<String>> sideboards = new ConcurrentHashMap<>();
        var check = new SeatChecks(request) {
            @Override
            public void beforeStart(Game game, List<UUID> seatIds) {
                super.beforeStart(game, seatIds);
                for (int seat = 0; seat < seatIds.size(); seat++) {
                    List<String> names = new ArrayList<>();
                    for (UUID card : game.getPlayer(seatIds.get(seat)).getSideboard()) {
                        Card found = game.getCard(card);
                        names.add(found == null ? "?" : found.getName());
                    }
                    names.sort(null);
                    sideboards.put(seat, names);
                }
            }
        };
        HumanGame game = Tables.start(request, check);
        var answered = new AtomicInteger();
        Map<Integer, ScriptedPlayer> scripted = new ConcurrentHashMap<>();
        // A few turns' prompts, then the first seat concedes and the second wins.
        Tables.Played played = Tables.play(game, (seat, prompt, view) -> seat == 0 && answered.incrementAndGet() > 40
            ? null : scripted.computeIfAbsent(seat, s -> new ScriptedPlayer(909L + s)).choose(prompt, view), 4,
            new Tables.Coverage());
        assertEquals(List.of("Lightning Bolt", "Lightning Bolt", "Shock"), sideboards.get(0));
        assertEquals(List.of("Giant Growth", "Giant Growth", "Giant Growth"), sideboards.get(1));
        HumanGame.Result result = played.last().result();
        assertTrue(List.of("completed", "turn_limit").contains(result.kind()), "result " + result);
        check.settle();
        assertTrue(check.failures.isEmpty(), "leaks or wrong views: " + check.failures);
        assertTrue(BotMatchRunner.join(game.thread(), 10_000), "game thread still running");
    }
}
