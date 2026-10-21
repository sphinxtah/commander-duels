package com.commanderduels;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import mage.cards.repository.CardCriteria;
import mage.cards.repository.CardInfo;
import mage.cards.repository.CardRepository;

/**
 * Names a seat may never be shown unprompted: the cards of the sets {@code CD_ENGINE_HIDDEN_SETS}
 * lists (comma-separated set codes; none by default). A derived image whose plugin adds cards only
 * some accounts may know of sets it, so a refused typed name never suggests them (see
 * {@link Prompts}); a name typed in full is still accepted, as the rules allow naming any card.
 */
final class HiddenCards {
    private static volatile Set<String> names;

    private HiddenCards() {}

    static boolean hidden(String name) {
        Set<String> found = names;
        if (found == null) {
            synchronized (HiddenCards.class) {
                if (names == null) {
                    names = load(System.getenv("CD_ENGINE_HIDDEN_SETS"));
                }
                found = names;
            }
        }
        return found.contains(name);
    }

    /** For tests: the names to hide, in place of the environment's sets. */
    static void use(Set<String> hidden) {
        names = Set.copyOf(hidden);
    }

    private static Set<String> load(String setting) {
        if (setting == null || setting.isBlank()) {
            return Set.of();
        }
        String[] codes = Arrays.stream(setting.split(",")).map(String::strip).filter(code -> !code.isEmpty())
            .toArray(String[]::new);
        Set<String> found = new HashSet<>();
        for (CardInfo card : CardRepository.instance.findCards(new CardCriteria().setCodes(codes))) {
            found.add(card.getName());
        }
        return Set.copyOf(found);
    }
}
