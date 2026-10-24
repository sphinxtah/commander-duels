package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import java.util.List;
import java.util.Map;
import mage.cards.Card;
import mage.cards.decks.Deck;
import mage.constants.CardType;
import mage.constants.SubType;
import mage.constants.SuperType;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Stand-ins (v0.6.2): cards the engine has no implementation of, made from the description the API
 * sends in a deck list, and played as their printed characteristics with no rules. Needs ./db.
 */
class StandInCardTest {
    private static final String BEAR = "Stand-in Bear";

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    private static StandInCard.Description bear() {
        return new StandInCard.Description(BEAR, "{1}{R}", List.of("Creature"), List.of("Bear"), List.of(),
            List.of("R"), "2", "2", null, null);
    }

    @Test
    void aStandInHasItsPrintedCharacteristicsAndNoRules() {
        StandInCard card = StandInCard.of(bear());
        assertEquals(BEAR, card.getName());
        assertEquals("{1}{R}", card.getManaCost().getText());
        assertEquals(2, card.getManaValue());
        assertTrue(card.isCreature());
        assertTrue(card.hasSubtype(SubType.BEAR, null));
        assertEquals(2, card.getPower().getValue());
        assertEquals(2, card.getToughness().getValue());
        assertTrue(card.getColor().isRed());
        assertTrue(card.getRules().stream().anyMatch(rule -> rule.contains("Stand-in")), "rules: " + card.getRules());
        // Its abilities are the spell itself and the rule that says it is a stand-in: nothing
        // triggers, nothing is activated.
        assertEquals(2, card.getAbilities().size());

        StandInCard copy = card.copy();
        assertNotSame(card, copy);
        assertEquals(card.getId(), copy.getId());
        assertEquals(BEAR, copy.getName());
        assertEquals(2, copy.getPower().getValue());
        assertTrue(copy.hasSubtype(SubType.BEAR, null));
        assertEquals("{1}{R}", copy.getManaCost().getText());
    }

    @Test
    void landsPlaneswalkersAndOddNumbersStandInToo() {
        StandInCard aura = StandInCard.of(new StandInCard.Description("Stand-in Farmstead", "",
            List.of("Enchantment"), List.of("Aura"), List.of(), List.of("W"), null, null, null, null));
        assertTrue(aura.getCardType().contains(CardType.ENCHANTMENT));
        assertTrue(aura.getColor().isWhite());
        StandInCard land = StandInCard.of(new StandInCard.Description("Stand-in Field", null, List.of("Land"),
            List.of(), List.of(), List.of(), null, null, null, null));
        assertTrue(land.isLand());
        assertTrue(land.getColor().isColorless());

        StandInCard walker = StandInCard.of(new StandInCard.Description("Stand-in Walker", "{2}{U}{U}",
            List.of("Planeswalker"), List.of("Jace"), List.of("Legendary"), List.of("U"), null, null, "3", null));
        assertTrue(walker.isPlaneswalker());
        assertTrue(walker.getSuperType().contains(SuperType.LEGENDARY));
        assertEquals(3, walker.getStartingLoyalty());

        StandInCard odd = StandInCard.of(new StandInCard.Description("Stand-in Tarmogoyf", "{1}{G}",
            List.of("Creature"), List.of("Lhurgoyf", "Not A Real Type"), List.of(), List.of("G"), "*", "1+*",
            null, null));
        assertEquals(0, odd.getPower().getValue());
        assertEquals(1, odd.getToughness().getValue());

        // A cost XMage cannot read leaves the card with none, not the game unable to start.
        StandInCard unreadable = StandInCard.of(new StandInCard.Description("Stand-in Oddity", "{HW}{∞}",
            List.of("Artifact"), List.of(), List.of(), List.of(), null, null, null, null));
        assertTrue(unreadable.isArtifact());
        assertEquals(-1, StandInCard.number("-1"));
        assertEquals(7, StandInCard.number("7"));
        assertEquals(0, StandInCard.number("X"));
    }

    @Test
    void aDeckListDescribesItsStandInsAndTheyBecomeCards() throws Exception {
        String body = """
            {"cards": [{"name": "Mountain", "count": 2}, {"name": "%s", "count": 3}],
             "commanders": ["Stand-in Leader"],
             "stand_ins": [
               {"name": "%s", "mana_cost": "{1}{R}", "types": ["Creature"], "subtypes": ["Bear"],
                "supertypes": [], "colors": ["R"], "power": "2", "toughness": "2"},
               {"name": "Stand-in Leader", "mana_cost": "{2}{R}{G}", "types": ["Creature"],
                "subtypes": ["Elf", "Warrior"], "supertypes": ["Legendary"], "colors": ["R", "G"],
                "power": "4", "toughness": "4"},
               {"name": "Grizzly Bears", "mana_cost": "{1}{G}", "types": ["Creature"], "subtypes": ["Bear"],
                "supertypes": [], "colors": ["G"], "power": "2", "toughness": "2"}
             ]}
            """.formatted(BEAR, BEAR);
        DeckLists.CustomDeck deck = DeckLists.parse(JsonParser.parseString(body), GameFormat.COMMANDER);
        assertEquals(3, deck.standIns().size());
        assertTrue(DeckLists.unknown(deck).isEmpty(), "a stand-in is never looked up in XMage's database");
        Deck loaded = DeckLists.load(deck);
        assertEquals(5, loaded.getCards().size());
        assertEquals(3, loaded.getCards().stream().filter(card -> card instanceof StandInCard).count());
        assertEquals(1, loaded.getSideboard().size());
        Card leader = loaded.getSideboard().iterator().next();
        assertInstanceOf(StandInCard.class, leader);
        assertTrue(leader.isLegendary() && leader.isCreature());

        // A name XMage implements plays as the stand-in the list describes, not XMage's card.
        DeckLists.CustomDeck held = DeckLists.parse(JsonParser.parseString("""
            {"cards": [{"name": "Grizzly Bears", "count": 1}],
             "stand_ins": [{"name": "Grizzly Bears", "mana_cost": "{1}{G}", "types": ["Creature"],
                            "power": "2", "toughness": "2"}]}
            """), GameFormat.LEGACY);
        assertInstanceOf(StandInCard.class, DeckLists.load(held).getCards().iterator().next());

        // A list from before v0.6.2 reads as it did; a bad description is refused.
        DeckLists.CustomDeck plain = DeckLists.parse(JsonParser.parseString(
            "{\"cards\": [{\"name\": \"Mountain\", \"count\": 1}]}"), GameFormat.LEGACY);
        assertEquals(Map.of(), plain.standIns());
        assertThrows(JsonRequest.Invalid.class, () -> DeckLists.parse(JsonParser.parseString("""
            {"cards": [{"name": "X", "count": 1}], "stand_ins": [{"name": "X", "rules": "draw a card"}]}
            """), GameFormat.LEGACY));
        assertThrows(JsonRequest.Invalid.class, () -> DeckLists.parse(JsonParser.parseString("""
            {"cards": [{"name": "X", "count": 1}], "stand_ins": [{"name": "X"}, {"name": "X"}]}
            """), GameFormat.LEGACY));
    }

    /** Plays a Mountain, casts every stand-in it can, and attacks with everything. */
    static final class Plan implements Tables.Policy {
        @Override
        public String choose(int seat, PromptView prompt, SeatView view) {
            List<PromptView.Option> options = prompt.options();
            switch (prompt.kind()) {
                case "priority": {
                    if (view.activeSeat() != null && view.activeSeat() == seat
                        && "precombat_main".equals(view.step())) {
                        var land = ScriptedPlayer.byAction(options, "play_land");
                        if (!land.isEmpty()) {
                            return land.get(0).id();
                        }
                        for (PromptView.Option option : ScriptedPlayer.byAction(options, "cast")) {
                            if (BEAR.equals(option.label())) {
                                return option.id();
                            }
                        }
                    }
                    return ScriptedPlayer.byAction(options, "pass").get(0).id();
                }
                case "pay_mana": {
                    var tap = ScriptedPlayer.byAction(options, "tap_source");
                    return tap.isEmpty() ? ScriptedPlayer.byAction(options, "cancel").get(0).id() : tap.get(0).id();
                }
                case "declare_attackers": {
                    var all = ScriptedPlayer.byAction(options, "all_attack");
                    return all.isEmpty() ? ScriptedPlayer.byAction(options, "done").get(0).id() : all.get(0).id();
                }
                case "mulligan":
                    return ScriptedPlayer.byAction(options, "keep").get(0).id();
                case "choose_target": {
                    var starting = options.stream().filter(option -> Integer.valueOf(seat).equals(option.seat()))
                        .findFirst();
                    if (prompt.message().contains("starting player") && starting.isPresent()) {
                        return starting.get().id();
                    }
                    var done = ScriptedPlayer.byAction(options, "done");
                    return done.isEmpty() ? options.get(0).id() : done.get(0).id();
                }
                case "declare_blockers":
                    return ScriptedPlayer.byAction(options, "done").get(0).id();
                default:
                    return options.stream().filter(option -> !option.action().equals("cancel")).findFirst()
                        .orElse(options.get(0)).id();
            }
        }
    }

    @Test
    void aStandInIsCastAttacksAndIsShownByItsName() throws Exception {
        var human = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Mountain", 20),
            new DeckLists.Entry(BEAR, 20)), List.of(), List.of(), Map.of(BEAR, bear()));
        var bot = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Island", 40)), List.of());
        var request = new HumanGameRequest(6202L, GameFormat.LEGACY, List.of(
            new HumanGameRequest.Seat(HumanGameRequest.HUMAN, HumanGameRequest.CUSTOM_DECK, human),
            new HumanGameRequest.Seat(HumanGameRequest.BOT, HumanGameRequest.CUSTOM_DECK, bot)), 1, 8, 900);
        var check = new SeatChecks(request);
        var coverage = new Tables.Coverage();
        HumanGame game = Tables.start(request, check);
        Tables.Played played = Tables.play(game, new Plan(), 4, coverage);

        check.settle();
        assertTrue(check.failures.isEmpty(), "leaks, wrong views or XMage errors: " + check.failures);
        assertTrue(coverage.unsupported.isEmpty(), "unsupported: " + coverage.unsupported);
        SeatView last = played.last().view();
        var bears = last.battlefield().stream().filter(permanent -> BEAR.equals(permanent.card().name())).toList();
        assertFalse(bears.isEmpty(), "no stand-in reached the battlefield: " + coverage.kinds);
        SeatView.CardInfo shown = bears.get(0).card();
        assertEquals("{1}{R}", shown.manaCost());
        assertEquals("2", shown.power());
        assertEquals("2", shown.toughness());
        assertTrue(shown.typeLine().contains("Creature") && shown.typeLine().contains("Bear"), shown.typeLine());
        assertTrue(shown.rules().stream().anyMatch(rule -> rule.contains("Stand-in")), "rules: " + shown.rules());
        assertTrue(last.opponents().get(0).life() < 20, "the stand-ins attacked: " + last.opponents().get(0).life());
    }
}
