package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

class BotMatchRequestTest {
    @Test
    void emptyBodyUsesDefaultsAndAGeneratedSeed() throws Exception {
        var request = BotMatchRequest.parse("", () -> 99L);
        assertEquals(new BotMatchRequest(99L, BotMatchRequest.DEFAULT_TURN_CAP,
            BotMatchRequest.DEFAULT_TIME_BUDGET_SECONDS, BotMatchRequest.DEFAULT_SKILL, false), request);
    }

    @Test
    void valuesOutsideTheSafeRangeAreClamped() throws Exception {
        var high = BotMatchRequest.parse(
            "{\"seed\":-5,\"turn_cap\":1e9,\"time_budget_seconds\":99999999999999,\"skill\":99}", () -> 0L);
        assertEquals(new BotMatchRequest(-5L, BotMatchRequest.MAX_TURN_CAP,
            BotMatchRequest.MAX_TIME_BUDGET_SECONDS, BotMatchRequest.MAX_SKILL, false), high);
        var low = BotMatchRequest.parse(
            "{\"turn_cap\":0,\"time_budget_seconds\":-1,\"skill\":-3,\"include_log\":true}", () -> 1L);
        assertEquals(new BotMatchRequest(1L, 1, 1, 1, true), low);
    }

    @Test
    void wholeNumbersWrittenWithAFractionAreAccepted() throws Exception {
        assertEquals(10, BotMatchRequest.parse("{\"turn_cap\":10.0}", () -> 0L).turnCap());
        assertFalse(BotMatchRequest.parse("{\"include_log\":false}", () -> 0L).includeLog());
        assertTrue(BotMatchRequest.parse("{\"include_log\":true}", () -> 0L).includeLog());
    }

    @ParameterizedTest
    @ValueSource(strings = {
        "not json", "[]", "7", "{\"unknown\":1}", "{\"turn_cap\":1.5}", "{\"seed\":\"7\"}",
        "{\"seed\":9223372036854775808}", "{\"skill\":null}", "{\"include_log\":1}", "{\"turn_cap\":[1]}"})
    void invalidBodiesAreRejected(String body) {
        assertThrows(JsonRequest.Invalid.class, () -> BotMatchRequest.parse(body, () -> 0L));
    }
}
