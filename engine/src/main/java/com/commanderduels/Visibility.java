package com.commanderduels;

import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;
import mage.cards.Card;
import mage.cards.Cards;
import mage.constants.AsThoughEffectType;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.permanent.Permanent;
import mage.game.stack.Spell;
import mage.game.stack.StackObject;
import mage.players.Player;

/**
 * Whether a seat may see an object's identity, from its zone: public zones are visible, a hand only
 * to its owner (and, in a team game, the owner's teammate), libraries to nobody. Revealed cards are visible to everyone and looked-at cards to
 * the player who looked, while XMage keeps them in its revealed and looked-at lists. Face-down
 * objects are visible to their controller only. Anything unrecognised is treated as hidden. A null
 * viewer is a spectator: no hand, face-down object or looked-at card is theirs.
 *
 * <p>Since v0.8.3 the revealed and looked-at lists count only for a card in a hand, a library or
 * outside the game, the zones they can reveal something in. XMage records neither the zone a card
 * was revealed from nor its zone-change counter, and keeps a card listed after it moves, so a card
 * revealed or looked at and then exiled face down (foretold, for instance), turned face down or cast
 * face down stayed listed: its name was shown to every seat. A face-down object now follows the
 * face-down rules alone, whatever lists it is in: a face-down permanent or spell is visible to its
 * controller, a face-down exiled card to nobody but a player the rules let look at it.
 *
 * <p>Since v0.8.5 a face-down exiled card is visible to a player XMage lets look at it (its
 * look-at-face-down permission): the owner of a foretold card, the controller of a hideaway, any
 * "you may look at it" exile. Before, it was hidden from them too.
 *
 * <p>Since v0.5.1 a player who controls another player's turn sees what that player may see, for as
 * long as the control lasts (723.4): their hand, their face-down objects and the cards they looked
 * at. Without turn control every rule above reads exactly as before.
 */
final class Visibility {
    private Visibility() {}

    /**
     * The player controlling this player's turn (723), or null when they control it themselves.
     * Control by a player who has left the game or lost does not count: it ends when that player
     * leaves (800.4a), and the engine hands it back (see {@link HumanGame}).
     */
    static UUID controllerOf(Game game, UUID playerId) {
        Player player = playerId == null ? null : game.getPlayer(playerId);
        if (player == null || player.isGameUnderControl()) {
            return null;
        }
        UUID controllerId = player.getTurnControlledBy();
        Player controller = controllerId == null ? null : game.getPlayer(controllerId);
        if (controller == null || controllerId.equals(playerId) || !controller.isInGame()) {
            return null;
        }
        return controllerId;
    }

    /**
     * The players whose information the viewer shares: the viewer, and every player whose turn the
     * viewer controls (723.4). Empty for a spectator.
     */
    static Set<UUID> seesFor(Game game, UUID viewerId) {
        Set<UUID> players = new LinkedHashSet<>();
        if (viewerId == null) {
            return players;
        }
        players.add(viewerId);
        for (Player player : game.getPlayers().values()) {
            if (viewerId.equals(controllerOf(game, player.getId()))) {
                players.add(player.getId());
            }
        }
        return players;
    }

    /**
     * Whether the viewer may look at this player's hand: their own, a teammate's (810.5), or that of
     * a player whose turn they control, including that player's teammate's (723.4).
     */
    static boolean handVisible(Game game, UUID ownerId, UUID viewerId) {
        if (ownerId == null || viewerId == null) {
            return false;
        }
        for (UUID player : seesFor(game, viewerId)) {
            if (player.equals(ownerId) || game.getAllies(ownerId).contains(player)) {
                return true;
            }
        }
        return false;
    }

    static boolean identityVisible(Game game, UUID objectId, UUID viewerId) {
        if (objectId == null) {
            return false;
        }
        if (game.getPlayer(objectId) != null) {
            return true;
        }
        Zone zone = game.getState().getZone(objectId);
        if (zone == null) {
            // Stack objects (abilities and spells) are tracked by the stack rather than by zone.
            StackObject stackObject = game.getStack().getStackObject(objectId);
            if (stackObject != null) {
                return stackObjectVisible(game, stackObject, viewerId);
            }
            return revealedTo(game, objectId, viewerId);
        }
        switch (zone) {
            case BATTLEFIELD: {
                Permanent permanent = game.getPermanent(objectId);
                return permanent != null
                    && (!permanent.isFaceDown(game) || seesFor(game, viewerId).contains(permanent.getControllerId()));
            }
            case STACK: {
                StackObject stackObject = game.getStack().getStackObject(objectId);
                return stackObject != null && stackObjectVisible(game, stackObject, viewerId);
            }
            case GRAVEYARD:
            case COMMAND:
                return true;
            case EXILED: {
                // Face down, it stays hidden even while XMage still lists it as revealed (v0.8.3),
                // except from a player who may look at it (v0.8.5).
                Card card = game.getCard(objectId);
                return card != null && (!card.isFaceDown(game) || mayLookAtFaceDown(game, objectId, viewerId));
            }
            case HAND: {
                // 810.5: in a team game, teammates may look at each other's hands.
                Card card = game.getCard(objectId);
                return card != null && (handVisible(game, card.getOwnerId(), viewerId)
                    || revealedTo(game, objectId, viewerId));
            }
            case LIBRARY:
            case OUTSIDE:
                // A card revealed from a library (its top card, say) or from outside the game.
                return revealedTo(game, objectId, viewerId);
            default:
                return false;
        }
    }

    /**
     * Whether the object is face down where it is now: a face-down permanent, spell or exiled card
     * (v0.8.3). Its identity is then the controller's to see, whatever XMage's revealed and looked-at
     * lists say.
     */
    static boolean faceDown(Game game, UUID objectId) {
        if (objectId == null) {
            return false;
        }
        Permanent permanent = game.getPermanent(objectId);
        if (permanent != null) {
            return permanent.isFaceDown(game);
        }
        StackObject stackObject = game.getStack().getStackObject(objectId);
        if (stackObject instanceof Spell spell) {
            return spell.isFaceDown(game);
        }
        if (game.getState().getZone(objectId) == Zone.EXILED) {
            Card card = game.getCard(objectId);
            return card != null && card.isFaceDown(game);
        }
        return false;
    }

    /**
     * Whether the viewer, or a player whose turn the viewer controls, may look at this face-down card:
     * XMage's look-at-face-down permission, as foretell, hideaway and "you may look at it" exiles grant.
     */
    static boolean mayLookAtFaceDown(Game game, UUID objectId, UUID viewerId) {
        for (UUID player : seesFor(game, viewerId)) {
            if (!game.getContinuousEffects()
                    .asThough(objectId, AsThoughEffectType.LOOK_AT_FACE_DOWN, null, player, game).isEmpty()) {
                return true;
            }
        }
        return false;
    }

    static boolean stackObjectVisible(Game game, StackObject stackObject, UUID viewerId) {
        if (stackObject instanceof Spell spell && spell.isFaceDown(game)) {
            return seesFor(game, viewerId).contains(spell.getControllerId());
        }
        return true;
    }

    /**
     * Whether XMage lists the object as revealed, or as looked at by the viewer or a player whose
     * turn the viewer controls. The lists hold card ids only, so callers check the zone first: see
     * {@link #identityVisible}.
     */
    static boolean revealedTo(Game game, UUID objectId, UUID viewerId) {
        for (Cards cards : game.getState().getRevealed().values()) {
            if (cards.contains(objectId)) {
                return true;
            }
        }
        for (UUID player : seesFor(game, viewerId)) {
            for (Cards cards : game.getState().getLookedAt(player).values()) {
                if (cards.contains(objectId)) {
                    return true;
                }
            }
        }
        return false;
    }
}
