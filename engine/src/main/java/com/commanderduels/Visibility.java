package com.commanderduels;

import java.util.UUID;
import mage.cards.Card;
import mage.cards.Cards;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.permanent.Permanent;
import mage.game.stack.Spell;
import mage.game.stack.StackObject;

/**
 * Whether a seat may see an object's identity, from its zone: public zones are visible, a hand only
 * to its owner, libraries to nobody. Revealed cards are visible to everyone and looked-at cards to
 * the player who looked, while XMage keeps them in its revealed and looked-at lists. Face-down
 * objects are visible to their controller only. Anything unrecognised is treated as hidden.
 */
final class Visibility {
    private Visibility() {}

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
                    && (!permanent.isFaceDown(game) || viewerId.equals(permanent.getControllerId()));
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
                Card card = game.getCard(objectId);
                return card != null && viewerId.equals(card.getOwnerId());
            }
            default:
                return false;
        }
    }

    static boolean stackObjectVisible(Game game, StackObject stackObject, UUID viewerId) {
        if (stackObject instanceof Spell spell && spell.isFaceDown(game)) {
            return viewerId.equals(spell.getControllerId());
        }
        return true;
    }

    static boolean revealedTo(Game game, UUID objectId, UUID viewerId) {
        for (Cards cards : game.getState().getRevealed().values()) {
            if (cards.contains(objectId)) {
                return true;
            }
        }
        for (Cards cards : game.getState().getLookedAt(viewerId).values()) {
            if (cards.contains(objectId)) {
                return true;
            }
        }
        return false;
    }
}
