package com.commanderduels;

import com.google.gson.JsonObject;
import java.util.Set;
import java.util.function.LongSupplier;

/**
 * Inputs to a development human-versus-bot game. The human always sits in seat 0 with one fixture
 * deck; the bot gets the other fixture deck unless one is named. Numbers outside the safe range are
 * clamped. The seed exists for reproducible tests and is never shown to the seat: it determines
 * every shuffle.
 */
public record HumanGameRequest(long seed, String humanDeck, String botDeck, int skill, int turnCap,
                               int idleTimeoutSeconds) {
    public static final int DEFAULT_SKILL = 4;
    public static final int MAX_SKILL = 6;
    public static final int DEFAULT_TURN_CAP = 60;
    public static final int MAX_TURN_CAP = 200;
    public static final int DEFAULT_IDLE_TIMEOUT_SECONDS = 900;
    public static final int MIN_IDLE_TIMEOUT_SECONDS = 5;
    public static final int MAX_IDLE_TIMEOUT_SECONDS = 3600;
    private static final Set<String> FIELDS =
        Set.of("seed", "human_deck", "bot_deck", "skill", "turn_cap", "idle_timeout_seconds");

    public static HumanGameRequest parse(String body, LongSupplier seedSource) throws JsonRequest.Invalid {
        JsonObject json = JsonRequest.object(body, FIELDS);
        long seed = json.has("seed") ? JsonRequest.integer(json, "seed").longValueExact() : seedSource.getAsLong();
        String humanDeck = json.has("human_deck") ? deck(json, "human_deck") : LegacyDuel.DECKS.get(0);
        String botDeck = json.has("bot_deck") ? deck(json, "bot_deck")
            : LegacyDuel.DECKS.stream().filter(deck -> !deck.equals(humanDeck)).findFirst().orElseThrow();
        return new HumanGameRequest(
            seed,
            humanDeck,
            botDeck,
            JsonRequest.clamped(json, "skill", DEFAULT_SKILL, 1, MAX_SKILL),
            JsonRequest.clamped(json, "turn_cap", DEFAULT_TURN_CAP, 1, MAX_TURN_CAP),
            JsonRequest.clamped(json, "idle_timeout_seconds", DEFAULT_IDLE_TIMEOUT_SECONDS, MIN_IDLE_TIMEOUT_SECONDS,
                MAX_IDLE_TIMEOUT_SECONDS));
    }

    private static String deck(JsonObject json, String field) throws JsonRequest.Invalid {
        String deck = JsonRequest.string(json, field, 64);
        if (!LegacyDuel.DECKS.contains(deck)) {
            throw new JsonRequest.Invalid(field + " must be one of " + LegacyDuel.DECKS);
        }
        return deck;
    }
}
