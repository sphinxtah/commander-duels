package com.commanderduels;

import java.util.List;
import java.util.Set;
import java.util.UUID;
import mage.constants.MultiplayerAttackOption;
import mage.constants.RangeOfInfluence;
import mage.game.GameCommanderImpl;
import mage.game.match.MatchType;
import mage.game.mulligan.Mulligan;

/**
 * King's Table with Commander decks: the command zone, commander tax and 21 combat damage from one commander (903.10a), whatever the starting life (v0.8.7). The rules are {@link KingsTable}'s; this class
 * hands XMage's questions to them.
 */
final class KingsTableCommanderGame extends GameCommanderImpl {
    private static final long serialVersionUID = 1L;

    private final KingsTable table;

    KingsTableCommanderGame(KingsTableRules rules, Mulligan mulligan, int startHandSize) {
        // Each player's range is their own (a General's one, a King's two: the players are made
        // with them); the game's is the larger. Attacks may go to several players (802).
        super(MultiplayerAttackOption.MULTIPLE, RangeOfInfluence.TWO, mulligan, KingsTable.MIN_COMMANDER_DECK,
            rules.startingLife(1), startHandSize);
        this.table = new KingsTable(rules);
    }

    private KingsTableCommanderGame(final KingsTableCommanderGame game) {
        super(game);
        this.table = new KingsTable(game.table);
    }

    KingsTable table() {
        return table;
    }

    @Override
    public Set<UUID> getAllies(UUID playerId) {
        return table.allies(playerId);
    }

    @Override
    public List<UUID> attackablePlayers(UUID attackingPlayerId, List<UUID> byAttackOption) {
        return table.attackable(this, attackingPlayerId, byAttackOption);
    }

    @Override
    public boolean attacksOnlyNamedPlayers() {
        return true;
    }

    @Override
    public boolean inCombatAcrossRange(UUID playerId, UUID otherPlayerId) {
        return table.acrossRange(this, playerId, otherPlayerId);
    }

    @Override
    public int getStartingLife(UUID playerId) {
        return table.startingLife(playerId, getStartingLife());
    }

    @Override
    protected void init(UUID choosingPlayerId) {
        // 103.8: a multiplayer game, so the starting player draws on their first turn.
        startingPlayerSkipsDraw = false;
        table.prepare(this);
        super.init(choosingPlayerId);
    }

    @Override
    public boolean checkIfGameIsOver() {
        if (state.isGameOver() || Thread.currentThread().isInterrupted() || table.seats().isEmpty()) {
            return super.checkIfGameIsOver();
        }
        Boolean over = table.over(this);
        return over != null ? over : super.checkIfGameIsOver();
    }

    @Override
    protected UUID findWinnersAndLosers() {
        return table.seats().isEmpty() ? super.findWinnersAndLosers() : table.winner(this);
    }

    @Override
    public MatchType getGameType() {
        return new KingsTable.Type();
    }

    @Override
    public int getNumPlayers() {
        return KingsTableRules.SEATS;
    }

    @Override
    public KingsTableCommanderGame copy() {
        return new KingsTableCommanderGame(this);
    }
}
