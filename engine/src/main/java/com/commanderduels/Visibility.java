package com.commanderduels;

import java.util.LinkedHashSet;
import java.util.Set;
import java.util.UUID;
import mage.cards.Card;
import mage.cards.Cards;
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
            if (player.equals(ownerId) || game.getTeammates(ownerId).contains(player)) {
                return true;
            }
        }
        return false;
    }

    static boolean identityVisible(Game game, UUID objectId, UUID viewerId) {
        if (objectId == null) {
            return false;
        }
        if (game.getPlayer(objectId) != null || revealedTo(game, objectId, viewerId)) {
            return true;
        }
        Zone zone = game.getState().getZone(objectId);
        if (zone == null) {
            // Stack objects (abilities and spells) are tracked by the stack rather than by zone.
            StackObject stackObject = game.getStack().getStackObject(objectId);
            return stackObject != null && stackObjectVisible(game, stackObject, viewerId);
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
                Card card = game.getCard(objectId);
                return card != null && !card.isFaceDown(game);
            }
            case HAND: {
                // 810.5: in a team game, teammates may look at each other's hands.
                Card card = game.getCard(objectId);
                return card != null && handVisible(game, card.getOwnerId(), viewerId);
            }
            default:
                return false;
        }
    }

    static boolean stackObjectVisible(Game game, StackObject stackObject, UUID viewerId) {
        if (stackObject instanceof Spell spell && spell.isFaceDown(game)) {
            return seesFor(game, viewerId).contains(spell.getControllerId());
        }
        return true;
    }

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
