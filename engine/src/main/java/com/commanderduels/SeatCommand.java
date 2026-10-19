package com.commanderduels;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * One command from a seat, in the envelope of {@code contracts/engine-command.schema.json}. The
 * seat comes from the caller's seat token, never from the body. {@code submit_choice} answers the
 * open prompt with one option id, or an assign_amounts prompt with a list of amounts;
 * {@code concede} needs no prompt.
 *
 * @param fingerprint identifies the command's content, so a repeated action id with a different
 *                    body is refused instead of being treated as a retry
 */
public record SeatCommand(String actionId, long expectedRevision, String promptId, String type, String optionId,
                          List<Integer> amounts, String fingerprint) {
    static final int MAX_AMOUNTS = 32;
    static final int MAX_AMOUNT = 10_000;
    public static final String SUBMIT_CHOICE = "submit_choice";
    public static final String CONCEDE = "concede";
    private static final Set<String> FIELDS =
        Set.of("v", "game_id", "action_id", "expected_revision", "prompt_id", "type", "payload");
    private static final Set<String> ENVELOPE_TYPES = Set.of("create_game", "submit_choice", "get_authorized_view",
        "checkpoint", "restore", "advance_bot", "validate_deck", "close_game", "concede");

    public static SeatCommand parse(String body, String gameId) throws JsonRequest.Invalid {
        JsonObject json = JsonRequest.object(body, FIELDS);
        for (String field : FIELDS) {
            if (!field.equals("prompt_id") && !json.has(field)) {
                throw new JsonRequest.Invalid("Missing field: " + field);
            }
        }
        if (JsonRequest.integer(json, "v").compareTo(BigDecimal.valueOf(EngineServer.PROTOCOL_VERSION)) != 0) {
            throw new JsonRequest.Invalid("Unsupported protocol version");
        }
        if (!JsonRequest.uuid(json, "game_id").equals(gameId)) {
            throw new JsonRequest.Invalid("game_id does not match the game addressed");
        }
        String actionId = JsonRequest.uuid(json, "action_id");
        long revision = JsonRequest.integer(json, "expected_revision").longValueExact();
        if (revision < 0) {
            throw new JsonRequest.Invalid("expected_revision must not be negative");
        }
        String type = JsonRequest.string(json, "type", 32);
        if (!ENVELOPE_TYPES.contains(type)) {
            throw new JsonRequest.Invalid("Unknown command type");
        }
        if (!type.equals(SUBMIT_CHOICE) && !type.equals(CONCEDE)) {
            throw new JsonRequest.Invalid("A seat cannot send " + type);
        }
        JsonElement payloadElement = json.get("payload");
        if (!payloadElement.isJsonObject()) {
            throw new JsonRequest.Invalid("payload must be an object");
        }
        JsonObject payload = payloadElement.getAsJsonObject();
        String promptId = null;
        String optionId = null;
        List<Integer> amounts = null;
        if (type.equals(SUBMIT_CHOICE)) {
            if (!json.has("prompt_id")) {
                throw new JsonRequest.Invalid("submit_choice needs prompt_id");
            }
            promptId = JsonRequest.uuid(json, "prompt_id");
            JsonRequest.onlyFields(payload, Set.of("option_id", "amounts"), "payload.");
            if (payload.has("option_id") == payload.has("amounts")) {
                throw new JsonRequest.Invalid("payload needs exactly one of option_id and amounts");
            }
            if (payload.has("option_id")) {
                optionId = JsonRequest.string(payload, "option_id", 16);
            } else {
                amounts = amounts(payload.get("amounts"));
            }
        } else {
            if (json.has("prompt_id")) {
                promptId = JsonRequest.uuid(json, "prompt_id");
            }
            JsonRequest.onlyFields(payload, Set.of(), "payload.");
        }
        String fingerprint = type + "|" + promptId + "|" + optionId + "|" + amounts + "|" + revision;
        return new SeatCommand(actionId, revision, promptId, type, optionId, amounts, fingerprint);
    }

    private static List<Integer> amounts(JsonElement element) throws JsonRequest.Invalid {
        String problem = "payload.amounts must be 1 to " + MAX_AMOUNTS + " integers from 0 to " + MAX_AMOUNT;
        if (!element.isJsonArray() || element.getAsJsonArray().isEmpty()
                || element.getAsJsonArray().size() > MAX_AMOUNTS) {
            throw new JsonRequest.Invalid(problem);
        }
        List<Integer> values = new ArrayList<>();
        for (JsonElement item : element.getAsJsonArray()) {
            JsonObject holder = new JsonObject();
            holder.add("amount", item);
            BigDecimal value;
            try {
                value = JsonRequest.integer(holder, "amount");
            } catch (JsonRequest.Invalid e) {
                throw new JsonRequest.Invalid(problem);
            }
            if (value.signum() < 0 || value.compareTo(BigDecimal.valueOf(MAX_AMOUNT)) > 0) {
                throw new JsonRequest.Invalid(problem);
            }
            values.add(value.intValueExact());
        }
        return List.copyOf(values);
    }
}
