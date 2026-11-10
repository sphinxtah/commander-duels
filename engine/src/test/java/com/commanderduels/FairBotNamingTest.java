package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import mage.abilities.effects.common.ChooseACardNameEffect;
import mage.cards.Card;
import mage.choices.Choice;
import mage.constants.Outcome;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.match.Match;
import mage.game.stack.Spell;
import mage.players.Player;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Two of XMage's AI's ways of losing a game by itself, closed in v0.9.3. A bot's own Demonic
 * Consultation names a card its library holds, never one at random
 * from every card name: XMage's AI did, exiled its whole library and lost at its next draw (the
 * campaign finale's losses on turn two at 40 life). Any other card-name choice stays XMage's.
 * Tables are seated but not started. Needs ./db.
 */
class FairBotNamingTest {
    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
    }

    private record Table(Game game, FairBot bot, Player other) {}

    private static Table table(List<DeckLists.Entry> botCards) throws Exception {
        GameFormat format = GameFormat.LEGACY;
        Game game = format.newGame(2, 30, null);
        Match match = format.newMatch("naming test", 2);
        FairBot bot = new FairBot("Bot", format.range(0), 4, 7L);
        FairBot other = new FairBot("Other", format.range(1), 4, 8L);
        LegacyDuel.seat(game, match, bot, DeckLists.load(new DeckLists.CustomDeck(botCards, List.of())));
        LegacyDuel.seat(game, match, other, DeckLists.load(new DeckLists.CustomDeck(
            List.of(new DeckLists.Entry("Demonic Consultation", 1), new DeckLists.Entry("Swamp", 59)), List.of())));
        return new Table(game, bot, other);
    }

    private static void cast(Game game, Player caster, String name) {
        Card card = caster.getLibrary().getCards(game).stream().filter(c -> c.getName().equals(name))
            .findFirst().orElseThrow();
        caster.getLibrary().remove(card.getId(), game);
        game.getStack().push(game, new Spell(card, card.getSpellAbility().copy(), caster.getId(), Zone.HAND, game));
    }

    private static Choice names() {
        return ChooseACardNameEffect.TypeOfName.ALL.makeChoiceObject();
    }

    @Test
    void itsOwnConsultationNamesTheOracleInItsLibrary() throws Exception {
        Table table = table(List.of(new DeckLists.Entry("Demonic Consultation", 1),
            new DeckLists.Entry("Thassa's Oracle", 1), new DeckLists.Entry("Griselbrand", 1),
            new DeckLists.Entry("Island", 57)));
        cast(table.game(), table.bot(), "Demonic Consultation");
        Choice choice = names();
        assertTrue(table.bot().choose(Outcome.Detriment, choice, table.game()));
        assertEquals("Thassa's Oracle", choice.getChoice());
    }

    @Test
    void withoutTheOracleItNamesItsCostliestCard() throws Exception {
        Table table = table(List.of(new DeckLists.Entry("Demonic Consultation", 1),
            new DeckLists.Entry("Griselbrand", 1), new DeckLists.Entry("Llanowar Elves", 1),
            new DeckLists.Entry("Swamp", 57)));
        cast(table.game(), table.bot(), "Demonic Consultation");
        assertEquals("Griselbrand", table.bot().ownLibraryName(names(), table.game()));
    }

    /**
     * A Pact's cost comes due at the next upkeep, or the game is lost (v0.9.3): the bot casts one
     * only with as many mana sources as that cost, and anything else stays XMage's.
     */
    @Test
    void aPactIsHeldUntilItsUpkeepCanBePaid() throws Exception {
        Table table = table(List.of(new DeckLists.Entry("Pact of Negation", 1),
            new DeckLists.Entry("Counterspell", 1), new DeckLists.Entry("Island", 58)));
        FairBot bot = table.bot();
        Game game = table.game();
        Card pact = card(game, bot, "Pact of Negation");
        Card counterspell = card(game, bot, "Counterspell");
        var islands = bot.getLibrary().getCards(game).stream().filter(c -> c.getName().equals("Island")).toList();
        for (int lands = 0; lands < 5; lands++) {
            bot.moveCards(islands.get(lands), Zone.BATTLEFIELD, pact.getSpellAbility(), game);
            assertEquals(lands + 1 < 5, bot.unpayablePact(pact.getSpellAbility(), game), (lands + 1) + " lands");
            assertFalse(bot.unpayablePact(counterspell.getSpellAbility(), game), "not a Pact");
        }
    }

    private static Card card(Game game, Player owner, String name) {
        return owner.getLibrary().getCards(game).stream().filter(c -> c.getName().equals(name)).findFirst().orElseThrow();
    }

    @Test
    void anotherPlayersSpellOrNoSpellIsLeftToXmage() throws Exception {
        Table table = table(List.of(new DeckLists.Entry("Thassa's Oracle", 1), new DeckLists.Entry("Island", 59)));
        assertNull(table.bot().ownLibraryName(names(), table.game()), "nothing on the stack");
        cast(table.game(), table.other(), "Demonic Consultation");
        assertNull(table.bot().ownLibraryName(names(), table.game()), "the other player's Consultation");
    }
}
