package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import mage.cards.Card;
import mage.cards.repository.CardInfo;
import mage.cards.repository.CardRepository;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The pack cards the engine learned in v0.9.4 (patches 0013 and 0014): Conspiracy's draft-matters
 * cards, played as printed outside a draft, and the first classic cards XMage lacked; and in v0.9.5
 * (patch 0015) the second batch of classic cards. Each is in the
 * card database under its printed name, is made with its printed cost and power and toughness,
 * shows its printed text, and copies as games copy cards. Needs ./db.
 */
class PackCardsTest {
    /** Name, then mana cost and power/toughness ("" for none), as printed. */
    private static final Map<String, List<String>> CARDS = Map.ofEntries(
        Map.entry("Aether Searcher", List.of("{7}", "6/4")),
        Map.entry("Animus of Predation", List.of("{4}{G}", "4/4")),
        Map.entry("Arcane Savant", List.of("{3}{U}{U}", "3/3")),
        Map.entry("Caller of the Untamed", List.of("{3}{G}", "2/4")),
        Map.entry("Cogwork Grinder", List.of("{6}", "0/0")),
        Map.entry("Cogwork Tracker", List.of("{4}", "4/4")),
        Map.entry("Custodi Peacekeeper", List.of("{2}{W}", "2/3")),
        Map.entry("Garbage Fire", List.of("{2}{R}", "")),
        Map.entry("Grenzo's Rebuttal", List.of("{4}{R}{R}", "")),
        Map.entry("Lurking Automaton", List.of("{5}", "0/0")),
        Map.entry("Noble Banneret", List.of("{2}{W}{W}", "3/3")),
        Map.entry("Paliano, the High City", List.of("", "")),
        Map.entry("Paliano Vanguard", List.of("{1}{W}", "2/2")),
        Map.entry("Pyretic Hunter", List.of("{4}{R}", "0/0")),
        Map.entry("Regicide", List.of("{B}", "")),
        Map.entry("Smuggler Captain", List.of("{3}{B}", "2/2")),
        Map.entry("Spire Phantasm", List.of("{2}{U}{U}", "3/2")),
        Map.entry("Volatile Chimera", List.of("{2}{R}", "3/2")),
        Map.entry("Barbarian Guides", List.of("{2}{R}", "1/2")),
        Map.entry("Chromatic Armor", List.of("{1}{W}{U}", "")),
        Map.entry("Taste of Paradise", List.of("{3}{G}", "")),
        Map.entry("Undergrowth", List.of("{G}", "")),
        Map.entry("Whippoorwill", List.of("{G}", "1/1")),
        // v0.9.5 (patch 0015): the second batch of classic cards.
        Map.entry("Arcum's Whistle", List.of("{3}", "")),
        Map.entry("Backdraft", List.of("{1}{R}", "")),
        Map.entry("Equinox", List.of("{W}", "")),
        Map.entry("Frankenstein's Monster", List.of("{X}{B}{B}", "0/1")),
        Map.entry("North Star", List.of("{4}", "")),
        Map.entry("Ogre Enforcer", List.of("{3}{R}{R}", "4/4")),
        Map.entry("Quarum Trench Gnomes", List.of("{3}{R}", "1/1")),
        Map.entry("Reflecting Mirror", List.of("{4}", "")),
        Map.entry("Silhouette", List.of("{1}{U}", "")),
        Map.entry("Spoils of War", List.of("{X}{B}", "")),
        Map.entry("Suffocation", List.of("{1}{U}", "")),
        Map.entry("Winter's Chill", List.of("{X}{U}", "")));

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
    }

    private static Card card(String name) {
        CardInfo info = CardRepository.instance.findCard(name);
        assertNotNull(info, name + " is not in the card database");
        Card card = info.createCard();
        assertNotNull(card, name + " made no card");
        return card;
    }

    @Test
    void everyCardIsMadeWithItsPrintedCostAndPowerAndToughness() {
        CARDS.forEach((name, printed) -> {
            Card card = card(name);
            assertEquals(name, card.getName());
            assertEquals(printed.get(0), card.getManaCost().getText(), name);
            if (!printed.get(1).isEmpty()) {
                assertEquals(printed.get(1), card.getPower().getValue() + "/" + card.getToughness().getValue(), name);
            }
            Card copy = card.copy();
            assertNotSame(card, copy);
            assertEquals(card.getRules(), copy.getRules(), name);
        });
    }

    @Test
    void theDraftTextShowsAsPrinted() {
        List<String> rules = card("Lurking Automaton").getRules();
        assertTrue(rules.stream().anyMatch(rule -> rule.startsWith("Reveal this card as you draft it")), "rules: " + rules);
        rules = card("Paliano, the High City").getRules();
        assertTrue(rules.stream().anyMatch(rule -> rule.contains("{T}: Add one mana of any color chosen as you drafted")),
            "rules: " + rules);
        rules = card("Regicide").getRules();
        assertTrue(rules.stream().anyMatch(rule -> rule.contains("one or more of the colors chosen as you drafted")),
            "rules: " + rules);
    }

    @Test
    void theOptionalAdditionalCostsReadAsPrinted() {
        List<String> rules = card("Taste of Paradise").getRules();
        assertTrue(rules.stream().anyMatch(rule -> rule.contains("you may pay {1}{G} any number of times")), "rules: " + rules);
        rules = card("Undergrowth").getRules();
        assertTrue(rules.stream().anyMatch(rule -> rule.contains("you may pay {2}{R}.")), "rules: " + rules);
    }

    @Test
    void theSecondBatchReadsAsPrinted() {
        Map.of(
            "Ogre Enforcer", "can't be destroyed by lethal damage unless lethal damage dealt by a single source",
            "Spoils of War", "Distribute X +1/+1 counters among any number of target creatures",
            "Winter's Chill", "X can't be greater than the number of snow lands you control",
            "Quarum Trench Gnomes", "it produces colorless mana instead of white mana",
            "Equinox", "Counter target spell if it would destroy a land you control",
            "Frankenstein's Monster", "exile X creature cards from your graveyard"
        ).forEach((name, words) -> {
            List<String> rules = card(name).getRules();
            assertTrue(rules.stream().anyMatch(rule -> rule.contains(words)), name + " rules: " + rules);
        });
    }
}
