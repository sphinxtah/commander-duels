package com.commanderduels;

import mage.cards.Cards;
import mage.constants.RangeOfInfluence;
import mage.game.Graveyard;
import mage.player.human.HumanPlayer;
import mage.player.human.PlayerResponse;
import mage.players.Library;
import mage.players.ManaPool;
import mage.players.Player;
import mage.players.PlayerImpl;

/**
 * A human seat's player: XMage's own {@link HumanPlayer}, which differs only when it controls a
 * bot's turn (723, v0.5.1).
 *
 * <p>XMage's bot hands each decision of a turn its controller controls to a stand-in that its
 * controller makes for it ({@link Player#prepareControllableProxy}): for a human, a human player
 * with the bot's identity, asking the human's client. XMage's stand-in is a copy of the bot, so what
 * it records on itself is lost when the decision ends: a land it plays was never counted, and the
 * controller could play a land for the bot at every priority. This seat's stand-in keeps the bot's
 * hand, library, graveyard, mana pool, life and land count on the bot itself, and has its own answer
 * channel, so an answer for the bot never reaches the seat's own requests. The engine routes the
 * stand-in's requests to this seat as prompts for the bot's seat and answers them through the bot
 * ({@link HumanGame}).
 */
final class HumanSeatPlayer extends HumanPlayer {
    private static final long serialVersionUID = 1L;

    HumanSeatPlayer(String name, RangeOfInfluence range) {
        super(name, range, 0);
    }

    private HumanSeatPlayer(HumanSeatPlayer player) {
        super(player);
    }

    @Override
    public HumanSeatPlayer copy() {
        // XMage copies players when it saves and restores the game's state.
        return new HumanSeatPlayer(this);
    }

    @Override
    public Player prepareControllableProxy(Player playerUnderControl) {
        if (!getId().equals(playerUnderControl.getTurnControlledBy())) {
            throw new IllegalArgumentException("A stand-in is made only by the player controlling the turn: "
                + getName());
        }
        // Like XMage's, the stand-in reads this seat's settings (XMage's getControllingPlayersUserData).
        return new StandIn((PlayerImpl) playerUnderControl);
    }

    /**
     * A human player standing in for a bot for one decision, with the bot's identity. Its zones, mana
     * pool, life and land count are the bot's own, read and changed on the bot.
     */
    static final class StandIn extends HumanPlayer {
        private static final long serialVersionUID = 1L;
        private final Player bot;

        StandIn(PlayerImpl bot) {
            super(bot, new PlayerResponse());
            this.bot = bot;
        }

        @Override
        public Cards getHand() {
            return bot.getHand();
        }

        @Override
        public Library getLibrary() {
            return bot.getLibrary();
        }

        @Override
        public Graveyard getGraveyard() {
            return bot.getGraveyard();
        }

        @Override
        public ManaPool getManaPool() {
            return bot.getManaPool();
        }

        @Override
        public int getLife() {
            return bot.getLife();
        }

        @Override
        public void incrementLandsPlayed() {
            bot.incrementLandsPlayed();
        }

        @Override
        public int getLandsPlayed() {
            return bot.getLandsPlayed();
        }

        @Override
        public boolean canPlayLand() {
            return bot.canPlayLand();
        }
    }
}
