package com.commanderduels;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.io.Serializable;
import java.util.List;
import java.util.Set;

/**
 * A King's Table game's settings (v0.8.7), which its host chooses before the game: the deck format
 * all six players use, the starting life, and the house rule "King can attack anyone". All twelve
 * combinations play. See {@link KingsTable} for the rules they set.
 *
 * <p>The six seats are in the table's circular order: 0 is team A's Left General, 1 team A's King,
 * 2 team A's Right General, 3 team B's Right General, 4 team B's King and 5 team B's Left General.
 * Seats 0 to 2 are team A (0) and 3 to 5 team B (1). The Generals face each other in pairs, 0 and 5,
 * 2 and 3; the order is circular, so seat 5 sits beside seat 0.
 *
 * @param commander         whether the decks are Commander decks (else Legacy)
 * @param life              {@link #ALL_20}, {@link #ALL_40} or {@link #GENERALS_20_KINGS_40}
 * @param kingAttacksAnyone the house rule: a King's creatures may attack any opponent still in the game
 */
record KingsTableRules(boolean commander, String life, boolean kingAttacksAnyone) implements Serializable {
    static final int SEATS = 6;
    static final String ALL_20 = "all_20";
    static final String ALL_40 = "all_40";
    static final String GENERALS_20_KINGS_40 = "generals_20_kings_40";
    static final List<String> LIFE = List.of(ALL_20, ALL_40, GENERALS_20_KINGS_40);
    static final String LEGACY = "legacy";
    static final String COMMANDER = "commander";
    /** The owner's suggested defaults: Commander decks, 40 life each, the house rule off. */
    static final KingsTableRules DEFAULT = new KingsTableRules(true, ALL_40, false);
    private static final Set<String> FIELDS = Set.of("deck_format", "life", "king_attacks_anyone");

    KingsTableRules {
        if (!LIFE.contains(life)) {
            throw new IllegalArgumentException("Unknown starting life " + life);
        }
    }

    /** The two Kings' seats. */
    static boolean king(int seat) {
        return seat == 1 || seat == 4;
    }

    /** The seat's team: 0 for seats 0 to 2, 1 for seats 3 to 5. */
    static int team(int seat) {
        return seat / 3;
    }

    /** "king" or "general", as the seat views name the seat's role. */
    static String role(int seat) {
        return king(seat) ? "king" : "general";
    }

    /** The seat's starting life total (103.4), which this game's settings override. */
    int startingLife(int seat) {
        return switch (life) {
            case ALL_20 -> 20;
            case ALL_40 -> 40;
            default -> king(seat) ? 40 : 20;
        };
    }

    String deckFormat() {
        return commander ? COMMANDER : LEGACY;
    }

    /** The settings as the request names them, which the game's settings echo. */
    JsonObject json() {
        JsonObject json = new JsonObject();
        json.addProperty("deck_format", deckFormat());
        json.addProperty("life", life);
        json.addProperty("king_attacks_anyone", kingAttacksAnyone);
        return json;
    }

    /** The request's {@code kings_table} object; each field left out takes its default. */
    static KingsTableRules parse(JsonElement element) throws JsonRequest.Invalid {
        if (element == null || element.isJsonNull()) {
            return DEFAULT;
        }
        if (!element.isJsonObject()) {
            throw new JsonRequest.Invalid("kings_table must be an object");
        }
        JsonObject json = element.getAsJsonObject();
        JsonRequest.onlyFields(json, FIELDS, "kings_table.");
        boolean commander = DEFAULT.commander;
        if (json.has("deck_format")) {
            String format = JsonRequest.string(json, "deck_format", 16);
            if (!format.equals(LEGACY) && !format.equals(COMMANDER)) {
                throw new JsonRequest.Invalid("kings_table.deck_format must be legacy or commander");
            }
            commander = format.equals(COMMANDER);
        }
        String life = DEFAULT.life;
        if (json.has("life")) {
            life = JsonRequest.string(json, "life", 32);
            if (!LIFE.contains(life)) {
                throw new JsonRequest.Invalid("kings_table.life must be one of " + LIFE);
            }
        }
        boolean anyone = DEFAULT.kingAttacksAnyone;
        if (json.has("king_attacks_anyone")) {
            anyone = JsonRequest.bool(json, "king_attacks_anyone");
        }
        return new KingsTableRules(commander, life, anyone);
    }
}
