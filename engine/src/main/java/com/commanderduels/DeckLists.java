package com.commanderduels;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import mage.cards.Card;
import mage.cards.decks.Deck;
import mage.cards.decks.DeckCardInfo;
import mage.cards.decks.DeckCardLists;
import mage.cards.repository.CardInfo;
import mage.cards.repository.CardRepository;
import mage.game.GameException;

/**
 * Deck lists named card by card, for service games: SysOp's test decks from any card the engine
 * implements ({@code cards.any}). Names are resolved in XMage's card database, exactly first and
 * then ignoring case, to XMage's preferred printing. No format rules are checked: a list may hold
 * any card in any number. Commander lists name one or two commanders, which XMage seats in the
 * command zone from the sideboard.
 *
 * <p>Since v0.5.0 a Legacy list may also name its {@code sideboard}: XMage keeps those cards outside
 * the game, where only effects that reach for a card from outside it (Burning Wish, FMT07) find
 * them. No view shows a sideboard; the API sends players' own decks with theirs.
 *
 * <p>Since v0.6.2 a list may describe {@code stand_ins}: cards the engine has no implementation of,
 * each by its name, printed mana cost, types, subtypes, supertypes, colours, power and toughness,
 * loyalty and defense. Any entry or commander naming one is made as a {@link StandInCard} from its
 * description, never looked up in XMage's database, so a card XMage implements but the site's checks
 * held back plays as a stand-in too. A list without {@code stand_ins} reads as before.
 */
final class DeckLists {
    static final int MAX_ENTRIES = 250;
    static final int MAX_COUNT = 250;
    static final int MAX_CARDS = 1000;
    static final int MAX_NAME = 200;
    static final int MAX_COMMANDERS = 2;
    static final int MAX_SEARCH = 50;
    /** XMage refuses a deck entry above 99 copies; larger counts become several entries. */
    private static final int XMAGE_MAX_PER_ENTRY = 99;
    private static final Set<String> FIELDS = Set.of("cards", "commanders", "sideboard", "stand_ins");
    private static final Set<String> ENTRY_FIELDS = Set.of("name", "count");
    private static final Set<String> STAND_IN_FIELDS = Set.of("name", "mana_cost", "types", "subtypes", "supertypes",
        "colors", "power", "toughness", "loyalty", "defense");
    static final int MAX_STAND_IN_TEXT = 64;
    static final int MAX_STAND_IN_WORDS = 16;
    /** Lower-case name to XMage's spelling, built from the database's names on first use. */
    private static volatile Map<String, String> namesIgnoringCase;

    record Entry(String name, int count) {}

    /**
     * A deck as named in a request, before resolution; the sideboard is Legacy's only. Since v0.6.2
     * the stand-ins it describes, by name.
     */
    record CustomDeck(List<Entry> cards, List<String> commanders, List<Entry> sideboard,
                      Map<String, StandInCard.Description> standIns) {
        CustomDeck {
            cards = List.copyOf(cards);
            commanders = List.copyOf(commanders);
            sideboard = List.copyOf(sideboard);
            standIns = Map.copyOf(standIns);
        }

        CustomDeck(List<Entry> cards, List<String> commanders, List<Entry> sideboard) {
            this(cards, commanders, sideboard, Map.of());
        }

        CustomDeck(List<Entry> cards, List<String> commanders) {
            this(cards, commanders, List.of());
        }
    }

    /** Names the card database does not know. */
    static final class UnknownCards extends Exception {
        private static final long serialVersionUID = 1L;
        private final transient List<String> names;

        UnknownCards(List<String> names) {
            super("Unknown cards: " + String.join(", ", names));
            this.names = List.copyOf(names);
        }

        List<String> names() {
            return names;
        }
    }

    private DeckLists() {}

    /** Reads {@code {"cards": [{"name", "count"}], "commanders": [...]}}; commanders only in Commander. */
    static CustomDeck parse(JsonElement element, GameFormat format) throws JsonRequest.Invalid {
        if (element == null || !element.isJsonObject()) {
            throw new JsonRequest.Invalid("seats[].deck_list must be an object");
        }
        JsonObject json = element.getAsJsonObject();
        JsonRequest.onlyFields(json, FIELDS, "seats[].deck_list.");
        JsonElement cards = json.get("cards");
        if (cards == null || !cards.isJsonArray() || cards.getAsJsonArray().isEmpty()) {
            throw new JsonRequest.Invalid("seats[].deck_list.cards must list 1 to " + MAX_ENTRIES + " entries");
        }
        List<Entry> entries = entries(cards, "cards");
        List<Entry> sideboard = List.of();
        if (json.has("sideboard")) {
            if (format != GameFormat.LEGACY) {
                throw new JsonRequest.Invalid("only Legacy deck lists have a sideboard");
            }
            sideboard = entries(json.get("sideboard"), "sideboard");
        }
        int total = 0;
        for (Entry entry : entries) {
            total += entry.count();
        }
        for (Entry entry : sideboard) {
            total += entry.count();
        }
        if (total > MAX_CARDS) {
            throw new JsonRequest.Invalid("a deck_list holds at most " + MAX_CARDS + " cards");
        }
        List<String> commanders = new ArrayList<>();
        if (json.has("commanders")) {
            JsonElement list = json.get("commanders");
            if (!list.isJsonArray() || list.getAsJsonArray().size() > MAX_COMMANDERS) {
                throw new JsonRequest.Invalid("seats[].deck_list.commanders must list at most " + MAX_COMMANDERS);
            }
            for (JsonElement item : list.getAsJsonArray()) {
                JsonObject holder = new JsonObject();
                holder.add("commander", item);
                commanders.add(JsonRequest.string(holder, "commander", MAX_NAME).strip());
            }
        }
        if (format == GameFormat.COMMANDER && commanders.isEmpty()) {
            throw new JsonRequest.Invalid("a Commander deck_list names one or two commanders");
        }
        if (format != GameFormat.COMMANDER && !commanders.isEmpty()) {
            throw new JsonRequest.Invalid("only Commander deck lists have commanders");
        }
        Map<String, StandInCard.Description> standIns = json.has("stand_ins") ? standIns(json.get("stand_ins"))
            : Map.of();
        return new CustomDeck(entries, commanders, sideboard, standIns);
    }

    /** The {@code stand_ins} a list describes, by name. */
    private static Map<String, StandInCard.Description> standIns(JsonElement list) throws JsonRequest.Invalid {
        if (list == null || !list.isJsonArray() || list.getAsJsonArray().size() > MAX_ENTRIES) {
            throw new JsonRequest.Invalid("seats[].deck_list.stand_ins must list at most " + MAX_ENTRIES + " cards");
        }
        Map<String, StandInCard.Description> found = new HashMap<>();
        for (JsonElement item : list.getAsJsonArray()) {
            if (!item.isJsonObject()) {
                throw new JsonRequest.Invalid("each stand-in must be an object");
            }
            JsonObject card = item.getAsJsonObject();
            JsonRequest.onlyFields(card, STAND_IN_FIELDS, "seats[].deck_list.stand_ins[].");
            String name = JsonRequest.string(card, "name", MAX_NAME).strip();
            if (name.isEmpty() || found.containsKey(name)) {
                throw new JsonRequest.Invalid("each stand-in needs a name of its own");
            }
            found.put(name, new StandInCard.Description(
                name,
                optional(card, "mana_cost", MAX_NAME),
                words(card, "types"),
                words(card, "subtypes"),
                words(card, "supertypes"),
                words(card, "colors"),
                optional(card, "power", MAX_STAND_IN_TEXT),
                optional(card, "toughness", MAX_STAND_IN_TEXT),
                optional(card, "loyalty", MAX_STAND_IN_TEXT),
                optional(card, "defense", MAX_STAND_IN_TEXT)));
        }
        return found;
    }

    /** An optional string field: absent, null or empty is null. */
    private static String optional(JsonObject json, String field, int maxLength) throws JsonRequest.Invalid {
        JsonElement element = json.get(field);
        if (element == null || element.isJsonNull()) {
            return null;
        }
        if (!element.isJsonPrimitive() || !element.getAsJsonPrimitive().isString()
            || element.getAsString().length() > maxLength) {
            throw new JsonRequest.Invalid("stand_ins[]." + field + " must be a string of at most " + maxLength
                + " characters");
        }
        String value = element.getAsString().strip();
        return value.isEmpty() ? null : value;
    }

    /** An optional list of words, such as a stand-in's types. */
    private static List<String> words(JsonObject json, String field) throws JsonRequest.Invalid {
        JsonElement element = json.get(field);
        if (element == null || element.isJsonNull()) {
            return List.of();
        }
        if (!element.isJsonArray() || element.getAsJsonArray().size() > MAX_STAND_IN_WORDS) {
            throw new JsonRequest.Invalid("stand_ins[]." + field + " must list at most " + MAX_STAND_IN_WORDS
                + " words");
        }
        List<String> words = new ArrayList<>();
        for (JsonElement item : element.getAsJsonArray()) {
            if (!item.isJsonPrimitive() || !item.getAsJsonPrimitive().isString()
                || item.getAsString().length() > MAX_STAND_IN_TEXT) {
                throw new JsonRequest.Invalid("stand_ins[]." + field + " must list words of at most "
                    + MAX_STAND_IN_TEXT + " characters");
            }
            words.add(item.getAsString());
        }
        return words;
    }

    /** A list of {@code {"name", "count"}} entries: the main deck's ({@code cards}) or the sideboard's. */
    private static List<Entry> entries(JsonElement list, String field) throws JsonRequest.Invalid {
        if (list == null || !list.isJsonArray() || list.getAsJsonArray().size() > MAX_ENTRIES) {
            throw new JsonRequest.Invalid("seats[].deck_list." + field + " must list at most " + MAX_ENTRIES
                + " entries");
        }
        List<Entry> entries = new ArrayList<>();
        for (JsonElement item : list.getAsJsonArray()) {
            if (!item.isJsonObject()) {
                throw new JsonRequest.Invalid("each deck_list entry must be an object");
            }
            JsonObject entry = item.getAsJsonObject();
            JsonRequest.onlyFields(entry, ENTRY_FIELDS, "seats[].deck_list." + field + "[].");
            String name = JsonRequest.string(entry, "name", MAX_NAME).strip();
            BigDecimal count = entry.has("count") ? JsonRequest.integer(entry, "count") : BigDecimal.ONE;
            if (name.isEmpty() || count.signum() <= 0 || count.compareTo(BigDecimal.valueOf(MAX_COUNT)) > 0) {
                throw new JsonRequest.Invalid("each deck_list entry needs a name and a count from 1 to " + MAX_COUNT);
            }
            entries.add(new Entry(name, count.intValueExact()));
        }
        return entries;
    }

    /** The names in {@code deck} that the card database does not know and no stand-in describes. */
    static List<String> unknown(CustomDeck deck) {
        Set<String> missing = new LinkedHashSet<>();
        for (String name : names(deck)) {
            if (!deck.standIns().containsKey(name) && find(name) == null) {
                missing.add(name);
            }
        }
        return List.copyOf(missing);
    }

    /**
     * The deck as XMage cards: the list as its main deck, and as its sideboard the commanders (in
     * Commander) or the sideboard's cards (in Legacy).
     */
    static Deck load(CustomDeck deck) throws GameException, UnknownCards {
        List<String> missing = unknown(deck);
        if (!missing.isEmpty()) {
            throw new UnknownCards(missing);
        }
        var lists = new DeckCardLists();
        lists.setName("custom");
        List<Card> mainStandIns = new ArrayList<>();
        List<Card> sideStandIns = new ArrayList<>();
        for (Entry entry : deck.cards()) {
            if (!standIn(deck, entry.name(), entry.count(), mainStandIns)) {
                add(lists.getCards(), find(entry.name()), entry.count());
            }
        }
        for (String commander : deck.commanders()) {
            if (!standIn(deck, commander, 1, sideStandIns)) {
                add(lists.getSideboard(), find(commander), 1);
            }
        }
        for (Entry entry : deck.sideboard()) {
            if (!standIn(deck, entry.name(), entry.count(), sideStandIns)) {
                add(lists.getSideboard(), find(entry.name()), entry.count());
            }
        }
        Deck loaded = Deck.load(lists, false, false);
        loaded.getCards().addAll(mainStandIns);
        loaded.getSideboard().addAll(sideStandIns);
        return loaded;
    }

    /** Makes {@code count} stand-ins when {@code name} names one, into {@code into}. */
    private static boolean standIn(CustomDeck deck, String name, int count, List<Card> into) {
        StandInCard.Description description = deck.standIns().get(name);
        if (description == null) {
            return false;
        }
        for (int i = 0; i < count; i++) {
            into.add(StandInCard.of(description));
        }
        return true;
    }

    private static void add(List<DeckCardInfo> list, CardInfo card, int count) {
        for (int left = count; left > 0; left -= XMAGE_MAX_PER_ENTRY) {
            list.add(new DeckCardInfo(card.getName(), card.getCardNumber(), card.getSetCode(),
                Math.min(left, XMAGE_MAX_PER_ENTRY)));
        }
    }

    private static List<String> names(CustomDeck deck) {
        List<String> names = new ArrayList<>();
        deck.cards().forEach(entry -> names.add(entry.name()));
        names.addAll(deck.commanders());
        deck.sideboard().forEach(entry -> names.add(entry.name()));
        return names;
    }

    /** XMage's preferred printing of the card with this name (any face), or null. */
    static CardInfo find(String name) {
        CardInfo card = CardRepository.instance.findPreferredCoreExpansionCard(name);
        if (card == null) {
            String spelled = names().get(name.toLowerCase(Locale.ROOT));
            if (spelled != null && !spelled.equals(name)) {
                card = CardRepository.instance.findPreferredCoreExpansionCard(spelled);
            }
        }
        return card;
    }

    /**
     * Up to {@code limit} card names containing {@code query}, ignoring case: names that start with
     * it first, then the rest, each alphabetically.
     */
    static List<String> search(String query, int limit) {
        String needle = query.strip().toLowerCase(Locale.ROOT);
        if (needle.isEmpty()) {
            return List.of();
        }
        return names().entrySet().stream()
            .filter(entry -> entry.getKey().contains(needle))
            .sorted(Comparator.<Map.Entry<String, String>, Boolean>comparing(entry -> !entry.getKey().startsWith(needle))
                .thenComparing(Map.Entry::getKey))
            .limit(Math.max(1, Math.min(limit, MAX_SEARCH)))
            .map(Map.Entry::getValue)
            .toList();
    }

    private static Map<String, String> names() {
        Map<String, String> names = namesIgnoringCase;
        if (names == null) {
            synchronized (DeckLists.class) {
                names = namesIgnoringCase;
                if (names == null) {
                    Map<String, String> built = new HashMap<>();
                    for (String name : CardRepository.instance.getNames()) {
                        built.putIfAbsent(name.toLowerCase(Locale.ROOT), name);
                    }
                    names = Map.copyOf(built);
                    namesIgnoringCase = names;
                }
            }
        }
        return names;
    }
}
