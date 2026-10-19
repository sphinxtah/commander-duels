package com.commanderduels;

import com.google.gson.JsonObject;
import java.util.Set;
import java.util.function.LongSupplier;

/**
 * Optional inputs to the development-only bot match. Numbers outside the safe range are clamped,
 * not rejected; the response reports the values actually used.
 */
public record BotMatchRequest(long seed, int turnCap, int timeBudgetSeconds, int skill, boolean includeLog) {
    public static final int DEFAULT_TURN_CAP = 60;
    public static final int MAX_TURN_CAP = 200;
    public static final int DEFAULT_TIME_BUDGET_SECONDS = 120;
    public static final int MAX_TIME_BUDGET_SECONDS = 600;
    public static final int DEFAULT_SKILL = 4;
    public static final int MAX_SKILL = 6;
    private static final Set<String> FIELDS =
        Set.of("seed", "turn_cap", "time_budget_seconds", "skill", "include_log");

    /** Parses an empty body or a JSON object; {@code seedSource} supplies a seed when none is given. */
    public static BotMatchRequest parse(String body, LongSupplier seedSource) throws JsonRequest.Invalid {
        JsonObject json = JsonRequest.object(body, FIELDS);
        long seed = json.has("seed") ? JsonRequest.integer(json, "seed").longValueExact() : seedSource.getAsLong();
        return new BotMatchRequest(
            seed,
            JsonRequest.clamped(json, "turn_cap", DEFAULT_TURN_CAP, 1, MAX_TURN_CAP),
            JsonRequest.clamped(json, "time_budget_seconds", DEFAULT_TIME_BUDGET_SECONDS, 1, MAX_TIME_BUDGET_SECONDS),
            JsonRequest.clamped(json, "skill", DEFAULT_SKILL, 1, MAX_SKILL),
            json.has("include_log") && JsonRequest.bool(json, "include_log"));
    }
}
