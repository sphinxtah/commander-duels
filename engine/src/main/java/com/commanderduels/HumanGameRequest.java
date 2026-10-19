package com.commanderduels;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.LongSupplier;

/**
 * Inputs to a development game: a format and its seats in turn order, each a human or a bot with a
 * fixture deck. Legacy takes exactly two seats (by default a human then a bot), Commander two to
 * four (by default a human and three bots); at least one seat must be human. A seat without a deck
 * gets the format's first fixture deck that no other seat uses. On the service route a seat may
 * instead carry a {@code deck_list} naming any cards ({@link DeckLists}); the API allows that only
 * for SysOp. Spectators see the game {@code spectatorDelaySeconds} late (default 0). Numbers outside
 * the safe range are clamped. The seed exists for reproducible tests and is never shown to a seat:
 * it determines every shuffle.
 */
public record HumanGameRequest(long seed, GameFormat format, List<Seat> seats, int skill, int turnCap,
                               int idleTimeoutSeconds, int spectatorDelaySeconds) {
    public static final int DEFAULT_SKILL = 4;
    public static final int MAX_SKILL = 6;
    public static final int DEFAULT_TURN_CAP = 60;
    public static final int MAX_TURN_CAP = 200;
    public static final int DEFAULT_IDLE_TIMEOUT_SECONDS = 900;
    public static final int MIN_IDLE_TIMEOUT_SECONDS = 5;
    public static final int MAX_IDLE_TIMEOUT_SECONDS = 3600;
    public static final int MAX_SPECTATOR_DELAY_SECONDS = 300;
    public static final String HUMAN = "human";
    public static final String BOT = "bot";
    private static final Set<String> FIELDS =
        Set.of("seed", "format", "seats", "skill", "turn_cap", "idle_timeout_seconds", "spectator_delay_seconds");
    private static final Set<String> SEAT_FIELDS = Set.of("player", "deck");
    private static final Set<String> SERVICE_SEAT_FIELDS = Set.of("player", "deck", "deck_list");
    /** What a seat's settings call a deck from a deck list. */
    public static final String CUSTOM_DECK = "custom";

    /**
     * @param player human or bot
     * @param deck   a fixture deck's name, or {@link #CUSTOM_DECK} when {@code custom} holds the list
     */
    public record Seat(String player, String deck, DeckLists.CustomDeck custom) {
        public Seat(String player, String deck) {
            this(player, deck, null);
        }

        boolean human() {
            return player.equals(HUMAN);
        }
    }

    public HumanGameRequest {
        seats = List.copyOf(seats);
    }

    /** A request with no spectator delay. */
    public HumanGameRequest(long seed, GameFormat format, List<Seat> seats, int skill, int turnCap,
                            int idleTimeoutSeconds) {
        this(seed, format, seats, skill, turnCap, idleTimeoutSeconds, 0);
    }

    /** A request with every seat's deck already chosen, as tests build them. */
    static HumanGameRequest of(long seed, GameFormat format, int skill, int turnCap, int idleTimeoutSeconds,
                               Seat... seats) {
        return new HumanGameRequest(seed, format, List.of(seats), skill, turnCap, idleTimeoutSeconds);
    }

    int humanSeats() {
        return (int) seats.stream().filter(Seat::human).count();
    }

    /** Every deck list's names the card database does not know, in seat and list order. */
    List<String> unknownCards() {
        Set<String> unknown = new java.util.LinkedHashSet<>();
        for (Seat seat : seats) {
            if (seat.custom() != null) {
                unknown.addAll(DeckLists.unknown(seat.custom()));
            }
        }
        return List.copyOf(unknown);
    }

    /** The development route's request: fixture decks only. */
    public static HumanGameRequest parse(String body, LongSupplier seedSource) throws JsonRequest.Invalid {
        return parse(body, seedSource, false);
    }

    /** @param deckLists whether seats may carry a {@code deck_list} (the service route) */
    public static HumanGameRequest parse(String body, LongSupplier seedSource, boolean deckLists)
            throws JsonRequest.Invalid {
        JsonObject json = JsonRequest.object(body, FIELDS);
        long seed = json.has("seed") ? JsonRequest.integer(json, "seed").longValueExact() : seedSource.getAsLong();
        GameFormat format = GameFormat.LEGACY;
        if (json.has("format")) {
            format = GameFormat.of(JsonRequest.string(json, "format", 32));
            if (format == null) {
                throw new JsonRequest.Invalid("format must be one of " + GameFormat.ids());
            }
        }
        List<String> players = new ArrayList<>();
        List<String> decks = new ArrayList<>();
        List<DeckLists.CustomDeck> customs = new ArrayList<>();
        if (json.has("seats")) {
            JsonElement element = json.get("seats");
            if (!element.isJsonArray() || element.getAsJsonArray().size() < format.minSeats()
                    || element.getAsJsonArray().size() > format.maxSeats()) {
                throw new JsonRequest.Invalid("seats must be a list of " + format.minSeats()
                    + (format.minSeats() == format.maxSeats() ? "" : " to " + format.maxSeats()) + " seats for "
                    + format.id());
            }
            for (JsonElement item : element.getAsJsonArray()) {
                if (!item.isJsonObject()) {
                    throw new JsonRequest.Invalid("each seat must be an object");
                }
                JsonObject seat = item.getAsJsonObject();
                JsonRequest.onlyFields(seat, deckLists ? SERVICE_SEAT_FIELDS : SEAT_FIELDS, "seats[].");
                String player = JsonRequest.string(seat, "player", 8);
                if (!player.equals(HUMAN) && !player.equals(BOT)) {
                    throw new JsonRequest.Invalid("seats[].player must be human or bot");
                }
                if (seat.has("deck") && seat.has("deck_list")) {
                    throw new JsonRequest.Invalid("a seat has a deck or a deck_list, not both");
                }
                players.add(player);
                DeckLists.CustomDeck custom = seat.has("deck_list") ? DeckLists.parse(seat.get("deck_list"), format)
                    : null;
                decks.add(seat.has("deck") ? deck(seat, format) : custom != null ? CUSTOM_DECK : null);
                customs.add(custom);
            }
        } else {
            players.add(HUMAN);
            for (int seat = 1; seat < (format == GameFormat.LEGACY ? 2 : format.maxSeats()); seat++) {
                players.add(BOT);
            }
            players.forEach(player -> {
                decks.add(null);
                customs.add(null);
            });
        }
        if (!players.contains(HUMAN)) {
            throw new JsonRequest.Invalid("at least one seat must be human");
        }
        Set<String> taken = new HashSet<>(decks);
        List<Seat> seats = new ArrayList<>();
        for (int i = 0; i < players.size(); i++) {
            String deck = decks.get(i);
            if (deck == null) {
                deck = format.decks().stream().filter(name -> !taken.contains(name)).findFirst()
                    .orElse(format.decks().get(i % format.decks().size()));
                taken.add(deck);
            }
            seats.add(new Seat(players.get(i), deck, customs.get(i)));
        }
        return new HumanGameRequest(
            seed,
            format,
            seats,
            JsonRequest.clamped(json, "skill", DEFAULT_SKILL, 1, MAX_SKILL),
            JsonRequest.clamped(json, "turn_cap", DEFAULT_TURN_CAP, 1, MAX_TURN_CAP),
            JsonRequest.clamped(json, "idle_timeout_seconds", DEFAULT_IDLE_TIMEOUT_SECONDS, MIN_IDLE_TIMEOUT_SECONDS,
                MAX_IDLE_TIMEOUT_SECONDS),
            JsonRequest.clamped(json, "spectator_delay_seconds", 0, 0, MAX_SPECTATOR_DELAY_SECONDS));
    }

    private static String deck(JsonObject seat, GameFormat format) throws JsonRequest.Invalid {
        String deck = JsonRequest.string(seat, "deck", 64);
        if (!format.decks().contains(deck)) {
            throw new JsonRequest.Invalid("seats[].deck must be one of " + format.decks());
        }
        return deck;
    }
}
