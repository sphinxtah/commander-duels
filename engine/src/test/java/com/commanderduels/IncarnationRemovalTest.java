package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.UUID;
import java.util.function.BiConsumer;
import mage.abilities.Ability;
import mage.cards.Card;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.command.CommandObject;
import mage.game.match.Match;
import mage.game.permanent.Permanent;
import mage.player.ai.ComputerPlayerControllableProxy;
import mage.players.Player;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The finale's incarnation against removal (v0.9.3), the handoff's checklist for the finale: once in
 * the game, every way off the battlefield but onto it sends it back to its reserve, whoever removes
 * it, and only one copy ever exists. A public planeswalker stands in for the owner's card, on a
 * Commander table seated but not started, with the card moved as each kind of removal moves it.
 * Needs ./db.
 */
class IncarnationRemovalTest {
    private static final String WALKER = "Ajani Goldmane";
    private static final String COMMANDER = "Isamaru, Hound of Konda";

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
    }

    private record Table(Game game, Player owner, Player foe, Ability source, Card incarnation) {}

    private static Table table() throws Exception {
        GameFormat format = GameFormat.COMMANDER;
        Game game = format.newGame(2, 30, null);
        Match match = format.newMatch("incarnation removal test", 2);
        var deck = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Plains", 99)), List.of(COMMANDER));
        Player owner = new ComputerPlayerControllableProxy("Owner", format.range(0), 1);
        Player foe = new ComputerPlayerControllableProxy("Foe", format.range(1), 1);
        LegacyDuel.seat(game, match, owner, DeckLists.load(deck));
        LegacyDuel.seat(game, match, foe, DeckLists.load(deck));
        CampaignReserve.apply(game, owner.getId(), WALKER, 15);
        CommandObject emblem = game.getState().getCommand().stream()
            .filter(object -> object instanceof CampaignReserve.ReserveEmblem)
            .findFirst().orElseThrow();
        Ability source = emblem.getAbilities().get(0);
        source.setControllerId(owner.getId());
        source.setSourceId(emblem.getId());
        Card card = CampaignReserve.bringIn(game, emblem.getId(), owner, WALKER);
        assertNotNull(card, "the engine knows " + WALKER);
        assertSame(card, CampaignReserve.bringIn(game, emblem.getId(), owner, WALKER), "one card, every time");
        assertEquals(Zone.COMMAND, game.getState().getZone(card.getId()), "it waits in the reserve");
        return new Table(game, owner, foe, source, card);
    }

    private static Permanent cross(Table table) {
        table.owner().moveCards(table.incarnation(), Zone.BATTLEFIELD, table.source(), table.game());
        Permanent permanent = table.game().getPermanent(table.incarnation().getId());
        assertNotNull(permanent, "the incarnation crossed onto the battlefield");
        return permanent;
    }

    private static void assertReserved(Table table, String how, int life) {
        Game game = table.game();
        UUID id = table.incarnation().getId();
        assertEquals(Zone.COMMAND, game.getState().getZone(id), how + ": back in the reserve");
        assertTrue(game.getPermanent(id) == null, how + ": off the battlefield");
        for (Player player : List.of(table.owner(), table.foe())) {
            assertTrue(!player.getHand().contains(id) && !player.getGraveyard().contains(id)
                && !player.getLibrary().getCardList().contains(id), how + ": in no other zone");
        }
        long copies = game.getCards().stream().filter(card -> card.getName().equals(WALKER)).count();
        assertEquals(1, copies, how + ": only one incarnation exists");
        assertEquals(life, table.owner().getLife(), how + ": no life restored or lost");
    }

    @Test
    void everyRemovalSendsItBackToItsReserve() throws Exception {
        Table table = table();
        List<java.util.Map.Entry<String, BiConsumer<Table, Permanent>>> removals = List.of(
            java.util.Map.entry("destroyed", (t, permanent) -> permanent.destroy(t.source(), t.game(), false)),
            java.util.Map.entry("sacrificed", (t, permanent) -> permanent.sacrifice(t.source(), t.game())),
            java.util.Map.entry("exiled by its opponent",
                (t, permanent) -> t.foe().moveCards(permanent, Zone.EXILED, t.source(), t.game())),
            java.util.Map.entry("bounced", (t, permanent) -> t.foe().moveCards(permanent, Zone.HAND, t.source(), t.game())),
            java.util.Map.entry("tucked into its library", (t, permanent) ->
                t.owner().putCardsOnBottomOfLibrary(new mage.cards.CardsImpl(permanent), t.game(), t.source(), false)),
            java.util.Map.entry("put into the graveyard", (t, permanent) ->
                t.foe().moveCards(permanent, Zone.GRAVEYARD, t.source(), t.game())));
        for (var removal : removals) {
            Permanent permanent = cross(table);
            int life = table.owner().getLife();
            removal.getValue().accept(table, permanent);
            assertReserved(table, removal.getKey(), life);
        }
        // It can cross again after all of them: the reserve is never spent.
        assertNotNull(cross(table));
    }

    @Test
    void aCounteredCastGoesBackToTheReserve() throws Exception {
        // v0.9.4: the free first cast, or a paid recast, countered on the stack: the spell's card goes
        // back to its reserve, not to the graveyard, with one copy in the game and no life changed.
        Table table = table();
        for (String how : List.of("countered on its first cast", "countered on a recast")) {
            Game game = table.game();
            Card card = table.incarnation();
            int life = table.owner().getLife();
            mage.game.stack.Spell spell = new mage.game.stack.Spell(card, card.getSpellAbility().copy(),
                table.owner().getId(), Zone.COMMAND, game);
            game.getStack().push(game, spell);
            game.getState().setZone(card.getId(), Zone.STACK);
            assertTrue(game.getStack().counter(spell.getId(), table.source(), game), how + ": countered");
            assertReserved(table, how, life);
            // The reserve keeps it castable for its mana cost: XMage offers a card's spell from the
            // command zone through the Commander object that holds it, as for any commander.
            assertTrue(game.getState().getCommand().stream().anyMatch(object ->
                    object instanceof mage.game.command.Commander && object.getSourceId().equals(card.getId())),
                how + ": castable from the reserve again");
        }
        // Countered twice, it can still cross.
        assertNotNull(cross(table));
    }
}
