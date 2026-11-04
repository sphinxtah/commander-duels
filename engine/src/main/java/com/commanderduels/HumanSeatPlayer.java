package com.commanderduels;

import mage.cards.Cards;
import mage.constants.RangeOfInfluence;
import mage.game.Game;
import mage.game.Graveyard;
import mage.player.human.HumanPlayer;
import mage.players.Library;
import mage.players.ManaPool;
import mage.players.Player;

/**
 * A human seat's player: XMage's own {@link HumanPlayer}, which differs only when it controls a
 * bot's turn (723, v0.5.1).
 *
 * <p>XMage's bot hands each decision of a turn its controller controls to a stand-in that its
 * controller makes for it ({@link Player#prepareControllableProxy}): for a human, a human player
 * with the bot's identity, asking the human's client. XMage's stand-in is a copy of the bot, so what
 * it records on itself is lost when the decision ends: a land it plays was never counted, and the
 * controller could play a land for the bot at every priority. This seat's stand-in keeps the bot's
 * hand, library, graveyard, mana pool, life and land count on the bot itself. The engine routes the
 * stand-in's requests to this seat as prompts for the bot's seat and answers them through the bot
 * ({@link HumanGame}); XMage asks one player at a time, so the stand-in and the seat itself never
 * wait at once.
 *
 * <p>Since v0.8.6 the seat, and any stand-in it makes, tells the game when XMage's game thread goes
 * into its wait for an answer and when it comes out ({@link Listening}): SysOp's inspection reads
 * XMage's state only in between (bug E4).
 */
final class HumanSeatPlayer extends HumanPlayer implements OpensResponse {
    private static final long serialVersionUID = 1L;

    @Override
    public boolean awaitResponseOpen() {
        return waitResponseOpen();
    }

    /**
     * Told on the game thread when XMage waits for a player's answer (v0.8.6). XMage publishes its
     * request to the seat (the engine's prompt) before it waits: it returns through the request's
     * listeners and its own code first. {@code waiting(player, true)} comes as it goes into
     * {@code waitForResponse}, {@code waiting(player, false)} once that returns, with the answer
     * taken or the wait given up. The player is the one XMage waits on: this seat's, or a stand-in
     * with a bot's identity.
     */
    interface Listening {
        void waiting(Player player, boolean waiting);
    }

    /** Shared by every copy: XMage replaces the seat's player with copies when it restores a state. */
    private final transient Listening listening;

    HumanSeatPlayer(String name, RangeOfInfluence range, Listening listening) {
        super(name, range, 0);
        this.listening = listening;
    }

    private HumanSeatPlayer(HumanSeatPlayer player) {
        super(player);
        this.listening = player.listening;
    }

    @Override
    public HumanSeatPlayer copy() {
        // XMage copies players when it saves and restores the game's state.
        return new HumanSeatPlayer(this);
    }

    @Override
    public Player prepareControllableProxy(Player playerUnderControl) {
        // XMage's stand-in (which checks that this player controls the turn), copied into ours. Like
        // XMage's it reads this seat's settings (getControllingPlayersUserData).
        return new StandIn((HumanPlayer) super.prepareControllableProxy(playerUnderControl), playerUnderControl,
            listening);
    }

    /** XMage's wait for this seat's answer, told to the game (v0.8.6, see {@link Listening}). */
    @Override
    protected void waitForResponse(Game game) {
        await(this, listening, () -> super.waitForResponse(game));
    }

    private static void await(Player player, Listening listening, Runnable wait) {
        listening.waiting(player, true);
        try {
            wait.run();
        } finally {
            listening.waiting(player, false);
        }
    }

    /**
     * A human player standing in for a bot for one decision, with the bot's identity. Its zones, mana
     * pool, life and land count are the bot's own, read and changed on the bot. Like XMage's own, it
     * shares the controlling seat's answer channel: XMage clears a concession it has handled only on
     * the channels of the game's players, and a channel of its own would stay marked and spin.
     */
    static final class StandIn extends HumanPlayer implements OpensResponse {
        private static final long serialVersionUID = 1L;

        @Override
        public boolean awaitResponseOpen() {
            return waitResponseOpen();
        }
        private final Player bot;
        private final transient Listening listening;

        /**
         * @param xmages    XMage's stand-in: a copy of the bot with the controlling seat's channel
         * @param listening the controlling seat's: XMage's wait for the stand-in's answer is the game's
         */
        StandIn(HumanPlayer xmages, Player bot, Listening listening) {
            super(xmages);
            this.bot = bot;
            this.listening = listening;
        }

        @Override
        protected void waitForResponse(Game game) {
            await(this, listening, () -> super.waitForResponse(game));
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
