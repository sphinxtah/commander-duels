package com.commanderduels;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import java.math.BigDecimal;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Strict readers for the engine's small JSON request bodies. */
final class JsonRequest {
    /** A request body the engine refuses; the message is safe to return to the caller. */
    static final class Invalid extends Exception {
        private static final long serialVersionUID = 1L;

        Invalid(String message) {
            super(message);
        }
    }

    private JsonRequest() {}

    /** Parses an empty body (as {}) or a JSON object whose fields are all in {@code allowed}. */
    static JsonObject object(String body, Set<String> allowed) throws Invalid {
        JsonObject json = new JsonObject();
        if (!body.isBlank()) {
            try {
                JsonElement parsed = JsonParser.parseString(body);
                if (!parsed.isJsonObject()) {
                    throw new Invalid("Body must be a JSON object");
                }
                json = parsed.getAsJsonObject();
            } catch (JsonParseException e) {
                throw new Invalid("Body is not valid JSON");
            }
        }
        onlyFields(json, allowed, "");
        return json;
    }

    static void onlyFields(JsonObject json, Set<String> allowed, String prefix) throws Invalid {
        for (Map.Entry<String, JsonElement> field : json.entrySet()) {
            if (!allowed.contains(field.getKey())) {
                throw new Invalid("Unknown field: " + prefix + field.getKey());
            }
        }
    }

    static BigDecimal integer(JsonObject json, String field) throws Invalid {
        JsonElement element = json.get(field);
        if (element != null && element.isJsonPrimitive() && element.getAsJsonPrimitive().isNumber()) {
            BigDecimal value = element.getAsBigDecimal();
            boolean whole = value.signum() == 0 || value.stripTrailingZeros().scale() <= 0;
            BigDecimal longMin = BigDecimal.valueOf(Long.MIN_VALUE);
            BigDecimal longMax = BigDecimal.valueOf(Long.MAX_VALUE);
            if (whole && value.compareTo(longMin) >= 0 && value.compareTo(longMax) <= 0) {
                return value;
            }
        }
        throw new Invalid(field + " must be a 64-bit integer");
    }

    /** An optional integer, clamped into [min, max] rather than rejected. */
    static int clamped(JsonObject json, String field, int fallback, int min, int max) throws Invalid {
        if (!json.has(field)) {
            return fallback;
        }
        BigDecimal value = integer(json, field);
        return value.max(BigDecimal.valueOf(min)).min(BigDecimal.valueOf(max)).intValueExact();
    }

    static boolean bool(JsonObject json, String field) throws Invalid {
        JsonElement element = json.get(field);
        if (element != null && element.isJsonPrimitive() && ((JsonPrimitive) element).isBoolean()) {
            return element.getAsBoolean();
        }
        throw new Invalid(field + " must be a boolean");
    }

    static String string(JsonObject json, String field, int maxLength) throws Invalid {
        JsonElement element = json.get(field);
        if (element != null && element.isJsonPrimitive() && ((JsonPrimitive) element).isString()) {
            String value = element.getAsString();
            if (!value.isEmpty() && value.length() <= maxLength) {
                return value;
            }
        }
        throw new Invalid(field + " must be a string of 1 to " + maxLength + " characters");
    }

    /** A UUID in canonical lower-case form, so ids compare as plain strings. */
    static String uuid(JsonObject json, String field) throws Invalid {
        String value = string(json, field, 36);
        try {
            if (UUID.fromString(value).toString().equals(value)) {
                return value;
            }
        } catch (IllegalArgumentException e) {
            // reported below
        }
        throw new Invalid(field + " must be a lower-case UUID");
    }
}
