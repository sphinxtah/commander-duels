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
    private static final Set<String> FIELDS = Set.of("cards", "commanders");
    private static final Set<String> ENTRY_FIELDS = Set.of("name", "count");
    /** Lower-case name to XMage's spelling, built from the database's names on first use. */
    private static volatile Map<String, String> namesIgnoringCase;

    record Entry(String name, int count) {}

    /** A deck as named in a request, before resolution. */
    record CustomDeck(List<Entry> cards, List<String> commanders) {
        CustomDeck {
            cards = List.copyOf(cards);
            commanders = List.copyOf(commanders);
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
        if (cards == null || !cards.isJsonArray() || cards.getAsJsonArray().isEmpty()
                || cards.getAsJsonArray().size() > MAX_ENTRIES) {
            throw new JsonRequest.Invalid("seats[].deck_list.cards must list 1 to " + MAX_ENTRIES + " entries");
        }
        List<Entry> entries = new ArrayList<>();
        int total = 0;
        for (JsonElement item : cards.getAsJsonArray()) {
            if (!item.isJsonObject()) {
                throw new JsonRequest.Invalid("each deck_list entry must be an object");
            }
            JsonObject entry = item.getAsJsonObject();
            JsonRequest.onlyFields(entry, ENTRY_FIELDS, "seats[].deck_list.cards[].");
            String name = JsonRequest.string(entry, "name", MAX_NAME).strip();
            BigDecimal count = entry.has("count") ? JsonRequest.integer(entry, "count") : BigDecimal.ONE;
            if (name.isEmpty() || count.signum() <= 0 || count.compareTo(BigDecimal.valueOf(MAX_COUNT)) > 0) {
                throw new JsonRequest.Invalid("each deck_list entry needs a name and a count from 1 to " + MAX_COUNT);
            }
            total += count.intValueExact();
            entries.add(new Entry(name, count.intValueExact()));
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
        return new CustomDeck(entries, commanders);
    }

    /** The names in {@code deck} that the card database does not know, in list order. */
    static List<String> unknown(CustomDeck deck) {
        Set<String> missing = new LinkedHashSet<>();
        for (String name : names(deck)) {
            if (find(name) == null) {
                missing.add(name);
            }
        }
        return List.copyOf(missing);
    }

    /** The deck as XMage cards: the list as its main deck, the commanders as its sideboard. */
    static Deck load(CustomDeck deck) throws GameException, UnknownCards {
        List<String> missing = unknown(deck);
        if (!missing.isEmpty()) {
            throw new UnknownCards(missing);
        }
        var lists = new DeckCardLists();
        lists.setName("custom");
        for (Entry entry : deck.cards()) {
            add(lists.getCards(), find(entry.name()), entry.count());
        }
        for (String commander : deck.commanders()) {
            add(lists.getSideboard(), find(commander), 1);
        }
        return Deck.load(lists, false, false);
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
