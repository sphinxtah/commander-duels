package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.UUID;
import mage.cards.Card;
import mage.abilities.effects.common.asthought.MayLookAtTargetCardEffect;
import mage.cards.CardsImpl;
import mage.constants.RangeOfInfluence;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.match.Match;
import mage.game.permanent.PermanentCard;
import mage.player.ai.ComputerPlayerControllableProxy;
import mage.players.Player;
import mage.players.net.UserData;
import mage.target.targetpointer.FixedTarget;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * A card revealed or looked at, then exiled or put onto the battlefield face down, is named to no one
 * who may not see it face down (v0.8.3). XMage keeps a card in its revealed and looked-at lists after
 * it moves, and once named every seat and spectator could tell which face-down object it was. Tables
 * are seated but not started, with the card moved by the test as foretell or a manifest would move
 * it. Needs ./db and ./decks.
 */
class RevealedFaceDownTest {
    /** The only nonland card in the owner's deck. */
    private static final String SECRET = "Llanowar Elves";

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
    }

    /** Seat 0 views, seat 1 owns the card, which starts in its hand. */
    private record Table(Game game, Player viewer, Player owner, Card secret) {}

    private static Table table() throws Exception {
        Game game = LegacyDuel.newGame(10);
        Match match = LegacyDuel.newMatch("revealed face-down test");
        var viewer = new ComputerPlayerControllableProxy("Viewer", RangeOfInfluence.ONE, 1);
        var owner = new ComputerPlayerControllableProxy("Owner", RangeOfInfluence.ONE, 1);
        LegacyDuel.seat(game, match, viewer, LegacyDuel.loadDeck(SeatChecks.DECKS, "legacy-mono-red-burn"));
        LegacyDuel.seat(game, match, owner, DeckLists.load(new DeckLists.CustomDeck(
            List.of(new DeckLists.Entry(SECRET, 1), new DeckLists.Entry("Forest", 59)), List.of())));
        // The seat views read each player's priority settings, which XMage's server sets on connect.
        viewer.setUserData(UserData.getDefaultUserDataView());
        owner.setUserData(UserData.getDefaultUserDataView());
        Card secret = owner.getLibrary().getCards(game).stream().filter(card -> card.getName().equals(SECRET))
            .findFirst().orElseThrow();
        owner.getLibrary().remove(secret.getId(), game);
        owner.getHand().add(secret);
        secret.setZone(Zone.HAND, game);
        return new Table(game, viewer, owner, secret);
    }

    /** From the owner's hand to exile, face down, as foretell moves it. */
    private static void exileFaceDown(Table table) {
        table.owner().getHand().remove(table.secret());
        table.game().getExile().add(table.secret());
        table.secret().setZone(Zone.EXILED, table.game());
        table.secret().setFaceDown(true, table.game());
    }

    private static SeatViews views(Table table) {
        return new SeatViews(table.game(), List.of(table.viewer().getId(), table.owner().getId()), new ObjectRefs());
    }

    /** The owner's entry in a view: seat 1. */
    private static SeatView.PlayerState owner(SeatView view) {
        return view.opponents().stream().filter(player -> player.seat() == 1).findFirst().orElseThrow();
    }

    @Test
    void aRevealedCardIsNotNamedOnceExiledFaceDown() throws Exception {
        Table table = table();
        Game game = table.game();
        UUID viewer = table.viewer().getId();
        UUID secret = table.secret().getId();
        game.getState().getRevealed().add("Thoughtseize", new CardsImpl(table.secret()));
        assertTrue(Visibility.identityVisible(game, secret, viewer), "revealed from the hand, it is public");
        assertTrue(Visibility.identityVisible(game, secret, null), "to spectators too");

        exileFaceDown(table);
        assertTrue(game.getState().getRevealed().values().stream().anyMatch(cards -> cards.contains(secret)),
            "XMage still lists the card as revealed");
        assertTrue(Visibility.faceDown(game, secret));
        assertFalse(Visibility.identityVisible(game, secret, viewer));
        assertFalse(Visibility.identityVisible(game, secret, null));

        SeatViews views = views(table);
        for (SeatView view : List.of(views.build(0, List.of()), views.buildPublic())) {
            List<SeatView.CardInfo> exile = owner(view).exile();
            assertEquals(1, exile.size());
            assertTrue(exile.get(0).hidden());
            assertNull(exile.get(0).name());
            // Nor in the revealed group, whose entry has the exiled card's id.
            assertTrue(view.revealed().get(0).cards().get(0).hidden());
            String json = EngineServer.JSON.toJson(view);
            assertFalse(json.contains(SECRET), json);
        }
        assertNull(views.target(secret, viewer).label(), "a target label");
    }

    @Test
    void aCardLookedAtIsNotNamedOnceExiledFaceDown() throws Exception {
        Table table = table();
        Game game = table.game();
        UUID viewer = table.viewer().getId();
        UUID secret = table.secret().getId();
        game.getState().getLookedAt(viewer).add("Peek", new CardsImpl(table.secret()));
        assertTrue(Visibility.identityVisible(game, secret, viewer), "the player who looked sees it");
        assertFalse(Visibility.identityVisible(game, secret, null), "no one else does");

        exileFaceDown(table);
        assertFalse(Visibility.identityVisible(game, secret, viewer));
        SeatView view = views(table).build(0, List.of());
        assertTrue(owner(view).exile().get(0).hidden());
        assertTrue(view.lookedAt().get(0).cards().get(0).hidden());
        assertFalse(EngineServer.JSON.toJson(view).contains(SECRET));
    }

    @Test
    void aRevealedCardPutOntoTheBattlefieldFaceDownIsItsControllersToSee() throws Exception {
        Table table = table();
        Game game = table.game();
        UUID viewer = table.viewer().getId();
        UUID owner = table.owner().getId();
        UUID secret = table.secret().getId();
        game.getState().getRevealed().add("Thoughtseize", new CardsImpl(table.secret()));

        table.owner().getHand().remove(table.secret());
        table.secret().setFaceDown(true, game);
        PermanentCard permanent = new PermanentCard(table.secret(), owner, game);
        permanent.setFaceDown(true, game);
        game.getBattlefield().addPermanent(permanent);
        game.getState().setZone(secret, Zone.BATTLEFIELD);
        assertTrue(Visibility.faceDown(game, secret));
        assertFalse(Visibility.identityVisible(game, secret, viewer));
        assertFalse(Visibility.identityVisible(game, secret, null));
        assertTrue(Visibility.identityVisible(game, secret, owner), "its controller sees it");

        SeatViews views = views(table);
        for (SeatView view : List.of(views.build(0, List.of()), views.buildPublic())) {
            assertTrue(view.battlefield().get(0).card().hidden());
            assertTrue(view.revealed().get(0).cards().get(0).hidden());
            assertFalse(EngineServer.JSON.toJson(view).contains(SECRET));
        }
        SeatView own = views.build(1, List.of());
        assertEquals(SECRET, own.battlefield().get(0).card().name());
        assertEquals(SECRET, own.revealed().get(0).cards().get(0).name());
    }

    /** What the reveal does show stays shown: a card in the hand it was revealed from, a library's top card. */
    @Test
    void revealedCardsStayVisibleInTheHandAndLibrary() throws Exception {
        Table table = table();
        Game game = table.game();
        UUID viewer = table.viewer().getId();
        UUID secret = table.secret().getId();
        Card top = table.owner().getLibrary().getFromTop(game);
        assertFalse(Visibility.identityVisible(game, secret, viewer));
        assertFalse(Visibility.identityVisible(game, top.getId(), viewer));

        game.getState().getRevealed().add("Thoughtseize", new CardsImpl(table.secret()));
        game.getState().getRevealed().add("Courser of Kruphix", new CardsImpl(top));
        assertFalse(Visibility.faceDown(game, secret));
        for (UUID seat : new UUID[]{viewer, null}) {
            assertTrue(Visibility.identityVisible(game, secret, seat), "the card revealed from the hand");
            assertTrue(Visibility.identityVisible(game, top.getId(), seat), "the library's revealed top card");
        }
        SeatView view = views(table).build(0, List.of());
        assertEquals(SECRET, view.revealed().stream().filter(group -> group.name().equals("Thoughtseize"))
            .findFirst().orElseThrow().cards().get(0).name());
    }

    @Test
    void aFaceDownExiledCardIsSeenByThePlayerAllowedToLookAtIt() throws Exception {
        // v0.8.5: foretell, hideaway and "you may look at it" exiles let a player look at the card.
        Table table = table();
        Game game = table.game();
        UUID viewer = table.viewer().getId();
        UUID owner = table.owner().getId();
        UUID secret = table.secret().getId();
        exileFaceDown(table);
        assertFalse(Visibility.identityVisible(game, secret, owner), "no permission yet");

        MayLookAtTargetCardEffect look = new MayLookAtTargetCardEffect(owner);
        look.setTargetPointer(new FixedTarget(secret, game));
        game.addEffect(look, table.secret().getSpellAbility());
        assertTrue(Visibility.identityVisible(game, secret, owner), "the owner may look at it");
        assertFalse(Visibility.identityVisible(game, secret, viewer), "the opponent may not");
        assertFalse(Visibility.identityVisible(game, secret, null), "nor may spectators");

        SeatViews views = views(table);
        SeatView ownerView = views.build(1, List.of());
        assertEquals(SECRET, ownerView.you().exile().get(0).name());
        for (SeatView view : List.of(views.build(0, List.of()), views.buildPublic())) {
            assertTrue(owner(view).exile().get(0).hidden());
            assertFalse(EngineServer.JSON.toJson(view).contains(SECRET));
        }
    }
}
