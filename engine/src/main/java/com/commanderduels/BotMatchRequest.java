package com.commanderduels;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import java.math.BigDecimal;
import java.util.Map;
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

    public static final class InvalidRequest extends Exception {
        private static final long serialVersionUID = 1L;

        InvalidRequest(String message) {
            super(message);
        }
    }

    /** Parses an empty body or a JSON object; {@code seedSource} supplies a seed when none is given. */
    public static BotMatchRequest parse(String body, LongSupplier seedSource) throws InvalidRequest {
        JsonObject json = new JsonObject();
        if (!body.isBlank()) {
            try {
                JsonElement parsed = JsonParser.parseString(body);
                if (!parsed.isJsonObject()) {
                    throw new InvalidRequest("Body must be a JSON object");
                }
                json = parsed.getAsJsonObject();
            } catch (JsonParseException e) {
                throw new InvalidRequest("Body is not valid JSON");
            }
        }
        for (Map.Entry<String, JsonElement> field : json.entrySet()) {
            if (!FIELDS.contains(field.getKey())) {
                throw new InvalidRequest("Unknown field: " + field.getKey());
            }
        }
        long seed = json.has("seed") ? integer(json, "seed").longValueExact() : seedSource.getAsLong();
        return new BotMatchRequest(
            seed,
            clamped(json, "turn_cap", DEFAULT_TURN_CAP, 1, MAX_TURN_CAP),
            clamped(json, "time_budget_seconds", DEFAULT_TIME_BUDGET_SECONDS, 1, MAX_TIME_BUDGET_SECONDS),
            clamped(json, "skill", DEFAULT_SKILL, 1, MAX_SKILL),
            json.has("include_log") && bool(json, "include_log"));
    }

    private static int clamped(JsonObject json, String field, int fallback, int min, int max)
            throws InvalidRequest {
        if (!json.has(field)) {
            return fallback;
        }
        BigDecimal value = integer(json, field);
        return value.max(BigDecimal.valueOf(min)).min(BigDecimal.valueOf(max)).intValueExact();
    }

    private static BigDecimal integer(JsonObject json, String field) throws InvalidRequest {
        JsonElement element = json.get(field);
        if (element.isJsonPrimitive() && element.getAsJsonPrimitive().isNumber()) {
            BigDecimal value = element.getAsBigDecimal();
            boolean whole = value.signum() == 0 || value.stripTrailingZeros().scale() <= 0;
            BigDecimal longMin = BigDecimal.valueOf(Long.MIN_VALUE);
            BigDecimal longMax = BigDecimal.valueOf(Long.MAX_VALUE);
            if (whole && value.compareTo(longMin) >= 0 && value.compareTo(longMax) <= 0) {
                return value;
            }
        }
        throw new InvalidRequest(field + " must be a 64-bit integer");
    }

    private static boolean bool(JsonObject json, String field) throws InvalidRequest {
        JsonElement element = json.get(field);
        if (element.isJsonPrimitive() && ((JsonPrimitive) element).isBoolean()) {
            return element.getAsBoolean();
        }
        throw new InvalidRequest(field + " must be a boolean");
    }
}
