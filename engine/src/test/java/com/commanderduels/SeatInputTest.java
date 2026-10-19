package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** Parsing of human game requests and seat commands; no XMage game is played. */
class SeatInputTest {
    private static final String GAME = UUID.randomUUID().toString();
    private static final String PROMPT = UUID.randomUUID().toString();
    private static final String ACTION = UUID.randomUUID().toString();

    private static String command(String type, String payload) {
        return "{\"v\":1,\"game_id\":\"" + GAME + "\",\"action_id\":\"" + ACTION + "\",\"expected_revision\":4,"
            + "\"prompt_id\":\"" + PROMPT + "\",\"type\":\"" + type + "\",\"payload\":" + payload + "}";
    }

    private static List<String> decks(HumanGameRequest request) {
        return request.seats().stream().map(HumanGameRequest.Seat::deck).toList();
    }

    private static List<String> players(HumanGameRequest request) {
        return request.seats().stream().map(HumanGameRequest.Seat::player).toList();
    }

    @Test
    void gameRequestsHaveSafeDefaultsAndClampedLimits() throws Exception {
        HumanGameRequest defaults = HumanGameRequest.parse("", () -> 99L);
        assertEquals(99L, defaults.seed());
        assertEquals(GameFormat.LEGACY, defaults.format());
        assertEquals(List.of("human", "bot"), players(defaults));
        assertEquals(List.of("legacy-mono-red-burn", "legacy-mono-green-creatures"), decks(defaults));
        assertEquals(HumanGameRequest.DEFAULT_SKILL, defaults.skill());
        assertEquals(HumanGameRequest.DEFAULT_TURN_CAP, defaults.turnCap());
        assertEquals(HumanGameRequest.DEFAULT_IDLE_TIMEOUT_SECONDS, defaults.idleTimeoutSeconds());

        HumanGameRequest green = HumanGameRequest.parse("{\"seats\":[{\"player\":\"human\",\"deck\":"
            + "\"legacy-mono-green-creatures\"},{\"player\":\"bot\"}],\"skill\":99,\"turn_cap\":0,"
            + "\"idle_timeout_seconds\":1}", () -> 0L);
        assertEquals(List.of("legacy-mono-green-creatures", "legacy-mono-red-burn"), decks(green),
            "the bot gets the other deck");
        assertEquals(HumanGameRequest.MAX_SKILL, green.skill());
        assertEquals(1, green.turnCap());
        assertEquals(HumanGameRequest.MIN_IDLE_TIMEOUT_SECONDS, green.idleTimeoutSeconds());

        HumanGameRequest commander = HumanGameRequest.parse("{\"format\":\"commander\"}", () -> 0L);
        assertEquals(List.of("human", "bot", "bot", "bot"), players(commander), "one human and three bots");
        assertEquals(GameFormat.COMMANDER.decks(), decks(commander));

        HumanGameRequest mixed = HumanGameRequest.parse("{\"format\":\"commander\",\"seats\":[{\"player\":\"bot\"},"
            + "{\"player\":\"human\",\"deck\":\"commander-mono-white-soldiers\"},{\"player\":\"human\"}]}", () -> 0L);
        assertEquals(List.of("bot", "human", "human"), players(mixed));
        assertEquals(List.of("commander-mono-blue-flyers", "commander-mono-white-soldiers",
            "commander-mono-red-raiders"), decks(mixed), "unnamed decks skip the ones other seats chose");
        assertEquals(2, mixed.humanSeats());

        for (String body : new String[]{"[]", "{\"seat\":1}", "{\"human_deck\":\"legacy-mono-red-burn\"}",
                "{\"seed\":1.5}", "{\"format\":\"vintage\"}", "{\"seats\":{}}", "{\"seats\":[]}",
                "{\"seats\":[{\"player\":\"human\"}]}",
                "{\"seats\":[{\"player\":\"human\"},{\"player\":\"bot\"},{\"player\":\"bot\"}]}",
                "{\"format\":\"commander\",\"seats\":[{\"player\":\"human\"},{\"player\":\"bot\"},"
                    + "{\"player\":\"bot\"},{\"player\":\"bot\"},{\"player\":\"bot\"}]}",
                "{\"seats\":[{\"player\":\"bot\"},{\"player\":\"bot\"}]}",
                "{\"seats\":[{\"player\":\"human\",\"deck\":\"../etc/passwd\"},{\"player\":\"bot\"}]}",
                "{\"seats\":[{\"player\":\"spectator\"},{\"player\":\"bot\"}]}",
                "{\"seats\":[{\"player\":\"human\",\"seat\":3},{\"player\":\"bot\"}]}",
                "{\"seats\":[\"human\",\"bot\"]}",
                "{\"format\":\"commander\",\"seats\":[{\"player\":\"human\",\"deck\":\"legacy-mono-red-burn\"},"
                    + "{\"player\":\"bot\"}]}"}) {
            assertThrows(JsonRequest.Invalid.class, () -> HumanGameRequest.parse(body, () -> 0L), body);
        }
    }

    @Test
    void choicesCarryOneOptionOrOneSplit() throws Exception {
        SeatCommand choice = SeatCommand.parse(command("submit_choice", "{\"option_id\":\"3\"}"), GAME);
        assertEquals(ACTION, choice.actionId());
        assertEquals(4, choice.expectedRevision());
        assertEquals(PROMPT, choice.promptId());
        assertEquals("3", choice.optionId());
        assertNull(choice.amounts());

        SeatCommand split = SeatCommand.parse(command("submit_choice", "{\"amounts\":[2,0,3]}"), GAME);
        assertEquals(List.of(2, 0, 3), split.amounts());
        assertFalse(split.fingerprint().equals(choice.fingerprint()));

        SeatCommand concede = SeatCommand.parse(command("concede", "{}"), GAME);
        assertEquals(SeatCommand.CONCEDE, concede.type());
        assertTrue(concede.fingerprint().startsWith("concede"));
    }

    @Test
    void malformedCommandsAreRefused() {
        for (String body : new String[]{
            command("submit_choice", "{}"),
            command("submit_choice", "{\"option_id\":\"1\",\"amounts\":[1]}"),
            command("submit_choice", "{\"option_id\":\"\"}"),
            command("submit_choice", "{\"option_id\":\"12345678901234567\"}"),
            command("submit_choice", "{\"amounts\":[]}"),
            command("submit_choice", "{\"amounts\":[-1]}"),
            command("submit_choice", "{\"amounts\":[1.5]}"),
            command("submit_choice", "{\"amounts\":[100000]}"),
            command("submit_choice", "{\"amounts\":\"1 2\"}"),
            command("concede", "{\"option_id\":\"1\"}"),
            command("restore", "{}"),
            command("teleport", "{}"),
            command("submit_choice", "[]"),
            command("submit_choice", "{\"option_id\":\"1\"}").replace("\"v\":1", "\"v\":1e400"),
            command("submit_choice", "{\"option_id\":\"1\"}").replace("\"expected_revision\":4", "\"expected_revision\":-1"),
            command("submit_choice", "{\"option_id\":\"1\"}").replace(ACTION, ACTION.toUpperCase()),
            command("submit_choice", "{\"option_id\":\"1\"}").replace("\"v\":1,", ""),
        }) {
            assertThrows(JsonRequest.Invalid.class, () -> SeatCommand.parse(body, GAME), body);
        }
        assertThrows(JsonRequest.Invalid.class,
            () -> SeatCommand.parse(command("submit_choice", "{\"option_id\":\"1\"}"), UUID.randomUUID().toString()));
    }

    @Test
    void splitsMustRespectEveryLimit() {
        var amounts = new PromptView.Amounts(3, 5, List.of(
            new PromptView.AmountEntry("Grizzly Bears, P/T: 2/2", 0, 5, 2),
            new PromptView.AmountEntry("Llanowar Elves, P/T: 1/1", 0, 5, 1)));
        assertTrue(amounts.accepts(List.of(2, 1)));
        assertTrue(amounts.accepts(List.of(5, 0)));
        assertFalse(amounts.accepts(List.of(1, 1)), "below the total");
        assertFalse(amounts.accepts(List.of(4, 2)), "above the total");
        assertFalse(amounts.accepts(List.of(6, -1)), "outside an entry's limits");
        assertFalse(amounts.accepts(List.of(3)), "one amount per entry");
        assertEquals("2 0 3", Prompts.encode(List.of(2, 0, 3)));
    }
}
