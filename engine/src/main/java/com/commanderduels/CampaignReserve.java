package com.commanderduels;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import mage.MageObject;
import mage.abilities.Ability;
import mage.abilities.StateTriggeredAbility;
import mage.abilities.common.SimpleStaticAbility;
import mage.abilities.condition.Condition;
import mage.abilities.effects.ContinuousRuleModifyingEffectImpl;
import mage.abilities.effects.OneShotEffect;
import mage.abilities.effects.ReplacementEffectImpl;
import mage.abilities.triggers.BeginningOfUpkeepTriggeredAbility;
import mage.cards.Card;
import mage.cards.repository.CardInfo;
import mage.constants.Duration;
import mage.constants.Outcome;
import mage.constants.TargetController;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.command.Commander;
import mage.game.command.Emblem;
import mage.game.events.GameEvent;
import mage.game.events.ZoneChangeEvent;
import mage.game.stack.Spell;
import mage.players.Player;
import mage.util.CardUtil;

/**
 * A campaign encounter's incarnation in reserve (v0.8.0): the rule the owner's finale gives its
 * opponent, written for any card, so this repository names none. A deck list's {@code reserve}
 * names the card and its threshold; before the game starts the seat's player gets an emblem that:
 *
 * <ul>
 *   <li>the first time the player is at the threshold's life or less (any life loss, payments
 *   included; healing later does not undo it), puts a trigger on the stack that brings the card
 *   into the game in the player's reserve and casts it from there without paying its mana cost,
 *   whatever the timing, as a spell that can be answered. The permission is spent if the trigger or
 *   the spell is countered;
 *   <li>whenever the card would leave the battlefield or the stack for anywhere but the battlefield
 *   (it dies, is exiled, bounced, tucked, or its spell is countered), returns it to the reserve
 *   instead, without restoring any life;
 *   <li>lets the player cast it from the reserve again, for its own mana cost, with its normal
 *   timing and no commander tax.
 * </ul>
 *
 * <p>The reserve is the command zone: the card waits there as XMage keeps a commander card, and is
 * cast from there by the same rules, but it is not a commander: no tax, no commander damage, and
 * none of the commander's own replacements. Only one copy ever exists. Its loyalty, its abilities
 * and its ultimate are the card's own, and every result the game reaches stands.
 *
 * <p><b>The court (v0.9.6).</b> Ward 15, The Unbound Court, is a King's Table game, and there the
 * owner's rule is another ({@link #applyCourt}): the incarnation starts the game on the battlefield,
 * as if it were a free card, and whenever it is not on the battlefield at the beginning of its
 * controller's upkeep it is put onto the battlefield again, for free, as often as that happens. It is
 * never cast, so it cannot be countered, and it cannot be cast from the reserve either: it only
 * returns. It enters at its printed loyalty each time. As in the duel, leaving the battlefield for
 * anywhere else sends it to the reserve instead.
 */
final class CampaignReserve {
    /** The emblem's name, as the command zone shows it. */
    static final String NAME = "Incarnation in reserve";
    /** The court's emblem's name (v0.9.6). */
    static final String COURT_NAME = "Incarnation of the court";
    private static final String CARD = "commander-duels:reserve-card:";
    private static final String UNLOCKED = "commander-duels:reserve-unlocked:";

    private CampaignReserve() {}

    /** Game thread, before the game starts: the reserve's rules for the seat's player. */
    static void apply(Game game, UUID playerId, String cardName, int threshold) {
        game.addEmblem(new ReserveEmblem(cardName, threshold), null, playerId);
    }

    /** Game thread, before the game starts: the court's rules for the seat's player (v0.9.6). */
    static void applyCourt(Game game, UUID playerId, String cardName) {
        game.addEmblem(new CourtEmblem(cardName), null, playerId);
    }

    /** The reserve card in the game, once it has been brought in. */
    static Card card(Game game, UUID emblemId) {
        Object id = game.getState().getValue(CARD + emblemId);
        return id instanceof UUID ? game.getCard((UUID) id) : null;
    }

    /** Whether the reserve's threshold has been reached once. */
    static boolean unlocked(Game game, UUID emblemId) {
        return Boolean.TRUE.equals(game.getState().getValue(UNLOCKED + emblemId));
    }

    static final class ReserveEmblem extends Emblem {
        private static final long serialVersionUID = 1L;

        ReserveEmblem(String cardName, int threshold) {
            super(NAME);
            this.getAbilities().add(new Unlock(cardName, threshold));
            this.getAbilities().add(new SimpleStaticAbility(Zone.COMMAND, new BackToReserve()));
        }

        private ReserveEmblem(final ReserveEmblem emblem) {
            super(emblem);
        }

        @Override
        public ReserveEmblem copy() {
            return new ReserveEmblem(this);
        }

        /** XMage looks an emblem's image up by class name and throws when it has none: this one
         * takes no image. */
        @Override
        public void setSourceObjectAndInitImage(MageObject sourceObject) {
            this.sourceObject = sourceObject;
            this.setUsesVariousArt(false);
            this.setCardNumber("");
            this.setImageFileName("");
            this.setImageNumber(0);
        }
    }

    /** The threshold: a state trigger that fires once in the game. */
    static final class Unlock extends StateTriggeredAbility {
        private static final long serialVersionUID = 1L;

        private final int threshold;

        Unlock(String cardName, int threshold) {
            super(Zone.COMMAND, new Incarnate(cardName));
            this.threshold = threshold;
        }

        private Unlock(final Unlock ability) {
            super(ability);
            this.threshold = ability.threshold;
        }

        @Override
        public Unlock copy() {
            return new Unlock(this);
        }

        @Override
        public boolean checkTrigger(GameEvent event, Game game) {
            if (unlocked(game, getSourceId())) {
                return false;
            }
            Player player = game.getPlayer(getControllerId());
            return player != null && player.isInGame() && !player.hasLost() && player.getLife() <= threshold;
        }

        @Override
        public void trigger(Game game, UUID controllerId, GameEvent triggeringEvent) {
            // Latched: the threshold unlocks the reserve once, whatever the life does afterwards.
            game.getState().setValue(UNLOCKED + getSourceId(), Boolean.TRUE);
            super.trigger(game, controllerId, triggeringEvent);
        }

        @Override
        public String getRule() {
            return "When you have " + threshold + " or less life for the first time, cast your incarnation from "
                + "your reserve without paying its mana cost. If it would leave the battlefield or the stack for "
                + "anywhere but the battlefield, it returns to your reserve instead; you may cast it from there "
                + "for its mana cost.";
        }
    }

    /** Brings the card into the reserve, the first time, and casts it from there for free. */
    static final class Incarnate extends OneShotEffect {
        private static final long serialVersionUID = 1L;

        private final String cardName;

        Incarnate(String cardName) {
            super(Outcome.PutCardInPlay);
            this.cardName = cardName;
            this.staticText = "cast your incarnation from your reserve without paying its mana cost";
        }

        private Incarnate(final Incarnate effect) {
            super(effect);
            this.cardName = effect.cardName;
        }

        @Override
        public Incarnate copy() {
            return new Incarnate(this);
        }

        @Override
        public boolean apply(Game game, Ability source) {
            Player controller = game.getPlayer(source.getControllerId());
            if (controller == null) {
                return false;
            }
            Card card = bringIn(game, source.getSourceId(), controller, cardName);
            if (card == null) {
                return false;
            }
            if (game.getState().getZone(card.getId()) != Zone.COMMAND) {
                // Already out of the reserve: nothing more to cast.
                return true;
            }
            return CardUtil.castSpellWithAttributesForFree(controller, source, game, card);
        }
    }

    /**
     * The reserve card, brought into the game in the controller's reserve the first time (the
     * command zone, as XMage keeps a commander card); the same card every time after. Null when the
     * engine does not know the card.
     */
    static Card bringIn(Game game, UUID emblemId, Player controller, String cardName) {
        Card card = card(game, emblemId);
        if (card != null) {
            return card;
        }
        CardInfo info = DeckLists.find(cardName);
        card = info == null ? null : info.createCard();
        if (card == null) {
            return null;
        }
        Set<Card> cards = new HashSet<>();
        cards.add(card);
        game.loadCards(cards, controller.getId());
        game.getState().setValue(CARD + emblemId, card.getId());
        game.addCommander(new Commander(card));
        game.informPlayers(controller.getLogName() + "'s incarnation waits in reserve: " + card.getLogName() + ".");
        return card;
    }

    /** Back to the reserve, from the battlefield or the stack, instead of any other zone. */
    static final class BackToReserve extends ReplacementEffectImpl {
        private static final long serialVersionUID = 1L;

        BackToReserve() {
            super(Duration.EndOfGame, Outcome.Benefit);
            this.staticText = "If your incarnation would leave the battlefield or the stack for anywhere but the "
                + "battlefield, it returns to your reserve instead";
        }

        private BackToReserve(final BackToReserve effect) {
            super(effect);
        }

        @Override
        public BackToReserve copy() {
            return new BackToReserve(this);
        }

        @Override
        public boolean checksEventType(GameEvent event, Game game) {
            return event.getType() == GameEvent.EventType.ZONE_CHANGE;
        }

        @Override
        public boolean applies(GameEvent event, Ability source, Game game) {
            Card reserve = card(game, source.getSourceId());
            if (reserve == null) {
                return false;
            }
            ZoneChangeEvent change = (ZoneChangeEvent) event;
            Zone from = change.getFromZone();
            Zone to = change.getToZone();
            if ((from != Zone.BATTLEFIELD && from != Zone.STACK)
                || to == Zone.BATTLEFIELD || to == Zone.STACK || to == Zone.COMMAND) {
                return false;
            }
            UUID moving = event.getTargetId();
            if (from == Zone.STACK) {
                Spell spell = game.getStack().getSpell(moving);
                if (spell != null) {
                    moving = spell.getSourceId();
                }
            }
            Card card = game.getCard(moving);
            UUID main = card == null ? moving : card.getMainCard().getId();
            return reserve.getId().equals(main);
        }

        @Override
        public boolean replaceEvent(GameEvent event, Ability source, Game game) {
            ((ZoneChangeEvent) event).setToZone(Zone.COMMAND);
            Card reserve = card(game, source.getSourceId());
            if (reserve != null && !game.isSimulation()) {
                game.informPlayers(reserve.getLogName() + " returns to its reserve.");
            }
            return false;
        }
    }

    static final class CourtEmblem extends Emblem {
        private static final long serialVersionUID = 1L;

        CourtEmblem(String cardName) {
            super(COURT_NAME);
            this.getAbilities().add(new CourtArrival(cardName));
            this.getAbilities().add(new BeginningOfUpkeepTriggeredAbility(Zone.COMMAND, TargetController.YOU,
                new Arrive(cardName), false).withInterveningIf(new InReserve()));
            this.getAbilities().add(new SimpleStaticAbility(Zone.COMMAND, new BackToReserve()));
            this.getAbilities().add(new SimpleStaticAbility(Zone.COMMAND, new NeverCast()));
        }

        private CourtEmblem(final CourtEmblem emblem) {
            super(emblem);
        }

        @Override
        public CourtEmblem copy() {
            return new CourtEmblem(this);
        }

        @Override
        public void setSourceObjectAndInitImage(MageObject sourceObject) {
            this.sourceObject = sourceObject;
            this.setUsesVariousArt(false);
            this.setCardNumber("");
            this.setImageFileName("");
            this.setImageNumber(0);
        }
    }

    /** The court's start: the first moment the game checks its state, once, the card enters. */
    static final class CourtArrival extends StateTriggeredAbility {
        private static final long serialVersionUID = 1L;

        CourtArrival(String cardName) {
            super(Zone.COMMAND, new Arrive(cardName));
        }

        private CourtArrival(final CourtArrival ability) {
            super(ability);
        }

        @Override
        public CourtArrival copy() {
            return new CourtArrival(this);
        }

        @Override
        public boolean checkTrigger(GameEvent event, Game game) {
            if (unlocked(game, getSourceId())) {
                return false;
            }
            Player player = game.getPlayer(getControllerId());
            return player != null && player.isInGame() && !player.hasLost();
        }

        @Override
        public void trigger(Game game, UUID controllerId, GameEvent triggeringEvent) {
            game.getState().setValue(UNLOCKED + getSourceId(), Boolean.TRUE);
            super.trigger(game, controllerId, triggeringEvent);
        }

        @Override
        public String getRule() {
            return "Your incarnation starts the game on the battlefield. At the beginning of your upkeep, if it is in "
                + "your reserve, put it onto the battlefield. If it would leave the battlefield for anywhere else, it "
                + "returns to your reserve instead. It can't be cast.";
        }
    }

    /** Puts the card onto the battlefield from the reserve, for free, bringing it in the first time. */
    static final class Arrive extends OneShotEffect {
        private static final long serialVersionUID = 1L;

        private final String cardName;

        Arrive(String cardName) {
            super(Outcome.PutCardInPlay);
            this.cardName = cardName;
            this.staticText = "put your incarnation onto the battlefield from your reserve";
        }

        private Arrive(final Arrive effect) {
            super(effect);
            this.cardName = effect.cardName;
        }

        @Override
        public Arrive copy() {
            return new Arrive(this);
        }

        @Override
        public boolean apply(Game game, Ability source) {
            Player controller = game.getPlayer(source.getControllerId());
            if (controller == null) {
                return false;
            }
            Card card = bringIn(game, source.getSourceId(), controller, cardName);
            if (card == null || game.getState().getZone(card.getId()) != Zone.COMMAND) {
                return card != null;
            }
            boolean moved = controller.moveCards(card, Zone.BATTLEFIELD, source, game);
            if (moved && !game.isSimulation()) {
                game.informPlayers(card.getLogName() + " takes the court.");
            }
            return moved;
        }
    }

    /** The upkeep's intervening "if": the card waits in the reserve. */
    static final class InReserve implements Condition {
        private static final long serialVersionUID = 1L;

        @Override
        public boolean apply(Game game, Ability source) {
            Card card = card(game, source.getSourceId());
            return card != null && game.getState().getZone(card.getId()) == Zone.COMMAND;
        }

        @Override
        public String toString() {
            return "your incarnation is in your reserve";
        }
    }

    /** The court's incarnation only returns: it is never cast from the reserve. */
    static final class NeverCast extends ContinuousRuleModifyingEffectImpl {
        private static final long serialVersionUID = 1L;

        NeverCast() {
            super(Duration.EndOfGame, Outcome.Detriment);
            this.staticText = "Your incarnation can't be cast";
        }

        private NeverCast(final NeverCast effect) {
            super(effect);
        }

        @Override
        public NeverCast copy() {
            return new NeverCast(this);
        }

        @Override
        public boolean checksEventType(GameEvent event, Game game) {
            return event.getType() == GameEvent.EventType.CAST_SPELL_LATE
                || event.getType() == GameEvent.EventType.CAST_SPELL;
        }

        @Override
        public boolean applies(GameEvent event, Ability source, Game game) {
            Card reserve = card(game, source.getSourceId());
            if (reserve == null) {
                return false;
            }
            Card card = game.getCard(event.getSourceId());
            return card != null && reserve.getId().equals(card.getMainCard().getId());
        }
    }
}
