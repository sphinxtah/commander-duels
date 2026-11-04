package com.commanderduels;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import mage.MageObject;
import mage.abilities.Ability;
import mage.abilities.ActivatedAbilityImpl;
import mage.abilities.common.SimpleStaticAbility;
import mage.abilities.costs.common.TapSourceCost;
import mage.abilities.effects.OneShotEffect;
import mage.abilities.effects.common.continuous.GainAbilityControlledEffect;
import mage.abilities.effects.common.continuous.GainControlTargetEffect;
import mage.constants.Duration;
import mage.constants.Outcome;
import mage.constants.TimingRule;
import mage.constants.WatcherScope;
import mage.constants.Zone;
import mage.filter.FilterPlayer;
import mage.filter.StaticFilters;
import mage.filter.predicate.ObjectSourcePlayer;
import mage.filter.predicate.ObjectSourcePlayerPredicate;
import mage.game.Game;
import mage.game.combat.Combat;
import mage.game.combat.CombatGroup;
import mage.game.command.Emblem;
import mage.game.events.GameEvent;
import mage.game.match.MatchImpl;
import mage.game.match.MatchOptions;
import mage.game.match.MatchType;
import mage.players.Player;
import mage.target.TargetPlayer;
import mage.target.targetpointer.FixedTarget;
import mage.watchers.Watcher;

/**
 * King's Table (v0.8.7): the owner's version of the Emperor variant (rule 809), for six players in
 * two teams of three. Each team has a King (the variant's emperor) and two Generals; the roles are
 * the players', apart from commanders and the monarch. The two game types, {@link KingsTableGame}
 * for Legacy decks and {@link KingsTableCommanderGame} for Commander decks, share these rules:
 *
 * <ul>
 *   <li><b>Seats and turns.</b> Seats in the circular order of {@link KingsTableRules}; each player
 *   takes their own turns in seat order, skipping those who have left (809.3, 101.4), with one stack
 *   and normal multiplayer priority. A King chosen at random takes the first turn and draws in it;
 *   the first mulligan is free (103.5c).
 *   <li><b>Allies.</b> Teammates are not opponents ({@code Game.getAllies}, XMage patch 0011), may
 *   look at each other's hands, and control their own things.
 *   <li><b>Range of influence</b> (801): a General's is one seat each way, a King's two (809.4a).
 *   It is set for every player as each turn begins (801.2c), by a watcher of the turn's beginning,
 *   with players who have left skipped; spells, abilities and effects keep to it.
 *   <li><b>Attacks</b> (809.4b): a player may attack only an opponent beside them who is in their
 *   range, so at the start the Generals face each other and neither King can attack; leaving
 *   players open new neighbours at once, and new range at the next turn. With the house rule "King
 *   can attack anyone", a King's creatures may attack any opponent still in the game, and the
 *   battles and planeswalkers that player defends. The permission follows the attacking player:
 *   a King's creature a General controls attacks as the General's. An attack across range is a
 *   whole combat ({@code Game.inCombatAcrossRange}): the defender blocks, both sides' creatures deal
 *   and are dealt combat damage, and each player's abilities see the combat's events; targets and
 *   effects keep to range.
 *   <li><b>Deploying creatures</b> (804): each creature has "{T}: Target teammate in your range
 *   gains control of this creature. Activate only as a sorcery." The bots never deploy (the owner's
 *   decision); they may be given creatures.
 *   <li><b>Life.</b> Each player's own starting life total ({@code Game.getStartingLife(UUID)}),
 *   which cards that name it read.
 *   <li><b>Winning and losing</b> (809.5): a General who loses leaves the game (800.4), and their
 *   team plays on. When a King loses or leaves, the King's team loses and the other team wins; both
 *   Kings at once is a draw. "Can't lose" and "can't win" effects apply to each player as usual. A
 *   player who wins by an effect makes their opponents in range lose (801.16, XMage's own rule), and
 *   wins only if that leaves no opponent, so a King out of reach still has to be beaten.
 * </ul>
 */
final class KingsTable implements Serializable {
    private static final long serialVersionUID = 1L;
    static final int MIN_LEGACY_DECK = 60;
    static final int MIN_COMMANDER_DECK = 100;

    private final KingsTableRules rules;
    /** The players in seat order, once seated. */
    private final ArrayList<UUID> seats = new ArrayList<>();

    KingsTable(KingsTableRules rules) {
        this.rules = rules;
    }

    KingsTable(KingsTable table) {
        this.rules = table.rules;
        this.seats.addAll(table.seats);
    }

    KingsTableRules rules() {
        return rules;
    }

    /** Names the players in seat order. Called once they are seated, before the start. */
    void seat(List<UUID> playerIds) {
        if (playerIds.size() != KingsTableRules.SEATS) {
            throw new IllegalArgumentException("King's Table seats six players, not " + playerIds.size());
        }
        seats.clear();
        seats.addAll(playerIds);
    }

    List<UUID> seats() {
        return List.copyOf(seats);
    }

    int seatOf(UUID playerId) {
        return seats.indexOf(playerId);
    }

    boolean isKing(UUID playerId) {
        int seat = seatOf(playerId);
        return seat >= 0 && KingsTableRules.king(seat);
    }

    /** The seat's team, or -1 for a player not seated here. */
    int teamOf(UUID playerId) {
        int seat = seatOf(playerId);
        return seat < 0 ? -1 : KingsTableRules.team(seat);
    }

    List<UUID> team(int team) {
        return seats.subList(team * 3, team * 3 + 3);
    }

    UUID king(int team) {
        return seats.get(team * 3 + 1);
    }

    Set<UUID> allies(UUID playerId) {
        int team = teamOf(playerId);
        if (team < 0) {
            return Set.of();
        }
        Set<UUID> allies = new LinkedHashSet<>(team(team));
        allies.remove(playerId);
        return allies;
    }

    int startingLife(UUID playerId, int fallback) {
        int seat = seatOf(playerId);
        return seat < 0 ? fallback : rules.startingLife(seat);
    }

    /**
     * The players beside the given one in the circular seat order, skipping those who have left the
     * game or lost: the next and the previous player still in it (one player if only two remain).
     */
    List<UUID> neighbours(Game game, UUID playerId) {
        int seat = seatOf(playerId);
        List<UUID> found = new ArrayList<>();
        if (seat < 0) {
            return found;
        }
        for (int step : new int[] {1, -1}) {
            for (int distance = 1; distance < seats.size(); distance++) {
                UUID other = seats.get(Math.floorMod(seat + step * distance, seats.size()));
                Player player = game.getPlayer(other);
                if (player != null && player.isInGame()) {
                    if (!other.equals(playerId) && !found.contains(other)) {
                        found.add(other);
                    }
                    break;
                }
            }
        }
        return found;
    }

    /**
     * 809.4b and the house rule: who the attacking player may attack, of the opponents in range
     * still in the game that XMage's attack option gives. A King under the house rule: every
     * opponent still in the game, in seat order. Otherwise those of them beside the player.
     */
    List<UUID> attackable(Game game, UUID attackingPlayerId, List<UUID> inRange) {
        if (seatOf(attackingPlayerId) < 0) {
            return inRange;
        }
        if (rules.kingAttacksAnyone() && isKing(attackingPlayerId)) {
            List<UUID> anyone = new ArrayList<>();
            for (UUID other : seats) {
                Player player = game.getPlayer(other);
                if (player != null && player.isInGame() && teamOf(other) != teamOf(attackingPlayerId)) {
                    anyone.add(other);
                }
            }
            return anyone;
        }
        List<UUID> beside = neighbours(game, attackingPlayerId);
        return inRange.stream().filter(beside::contains).toList();
    }

    /**
     * Whether the two players face each other in the current combat although one is out of the
     * other's range: only under the house rule, between a King whose creatures attack and a player
     * those creatures attack (or whose planeswalker or battle they attack).
     */
    boolean acrossRange(Game game, UUID playerId, UUID otherPlayerId) {
        if (!rules.kingAttacksAnyone() || teamOf(playerId) < 0 || teamOf(playerId) == teamOf(otherPlayerId)) {
            return false;
        }
        Combat combat = game.getCombat();
        if (combat == null) {
            return false;
        }
        UUID attacker = combat.getAttackingPlayerId();
        if (attacker == null || !isKing(attacker)) {
            return false;
        }
        UUID other = attacker.equals(playerId) ? otherPlayerId : attacker.equals(otherPlayerId) ? playerId : null;
        if (other == null) {
            return false;
        }
        for (CombatGroup group : combat.getGroups()) {
            if (!group.getAttackers().isEmpty() && other.equals(group.getDefendingPlayerId())) {
                return true;
            }
        }
        return false;
    }

    /**
     * 809.5: whether the game is over by its Kings, after making a beaten King's team lose. Null
     * while neither King is out, when XMage's own checks still apply (a player's concession, its
     * thread ending). Both Kings out at once is a draw: nobody wins.
     */
    Boolean over(Game game) {
        List<Integer> beaten = new ArrayList<>();
        for (int team = 0; team < 2; team++) {
            if (out(game.getPlayer(king(team)))) {
                beaten.add(team);
            }
        }
        if (beaten.isEmpty()) {
            return null;
        }
        for (int team : beaten) {
            for (UUID playerId : team(team)) {
                Player player = game.getPlayer(playerId);
                if (!player.hasLost() && !player.hasWon()) {
                    player.lost(game);
                }
            }
        }
        if (game.getState().isGameOver()) {
            return true;
        }
        game.end();
        if (beaten.size() == 1) {
            for (UUID playerId : team(1 - beaten.get(0))) {
                Player player = game.getPlayer(playerId);
                if (player.isInGame()) {
                    player.won(game);
                }
            }
        }
        return true;
    }

    /**
     * XMage keeps one winner and makes every other player lose at the end: here the winner's
     * teammates still in the game keep the win with them.
     */
    UUID winner(Game game) {
        UUID winner = seats.stream().filter(id -> game.getPlayer(id).hasWon()).findFirst().orElse(null);
        if (winner != null) {
            int team = teamOf(winner);
            for (UUID playerId : seats) {
                Player player = game.getPlayer(playerId);
                if (teamOf(playerId) != team && !player.hasLost()) {
                    player.lost(game);
                }
            }
        }
        return winner;
    }

    static boolean out(Player player) {
        return player == null || player.hasLost() || player.hasLeft();
    }

    /** Game thread, before the start: the range watcher, and each player's deploy emblem. */
    void prepare(Game game) {
        game.getState().addWatcher(new RangeWatcher());
        for (UUID playerId : seats) {
            game.addEmblem(new DeployEmblem(), null, playerId);
        }
    }

    /**
     * 801.2c: the players in each player's range of influence are set as each turn begins. XMage
     * sets only the active player's then; this sets everyone's, so a player who has left stops
     * counting for every range at the next turn.
     */
    static final class RangeWatcher extends Watcher {
        private static final long serialVersionUID = 1L;

        RangeWatcher() {
            super(WatcherScope.GAME);
        }

        @Override
        public void watch(GameEvent event, Game game) {
            if (event.getType() == GameEvent.EventType.BEGIN_TURN) {
                for (Player player : game.getPlayers().values()) {
                    if (player.isInGame()) {
                        player.updateRange(game);
                    }
                }
            }
        }
    }

    /** 804: each player's creatures may be deployed. The command zone shows it as "Deploy". */
    static final class DeployEmblem extends Emblem {
        private static final long serialVersionUID = 1L;
        static final String NAME = "Deploy";

        DeployEmblem() {
            super(NAME);
            this.getAbilities().add(new SimpleStaticAbility(Zone.COMMAND, new GainAbilityControlledEffect(
                new DeployAbility(), Duration.EndOfGame, StaticFilters.FILTER_PERMANENT_CREATURES)
                .setText("Creatures you control have \"{T}: Target teammate in your range gains control of "
                    + "this creature. Activate only as a sorcery.\" (804, deploying creatures)")));
        }

        private DeployEmblem(final DeployEmblem emblem) {
            super(emblem);
        }

        @Override
        public DeployEmblem copy() {
            return new DeployEmblem(this);
        }

        /** No image: XMage looks an emblem's image up by class name and throws when it has none. */
        @Override
        public void setSourceObjectAndInitImage(MageObject sourceObject) {
            this.sourceObject = sourceObject;
            this.setUsesVariousArt(false);
            this.setCardNumber("");
            this.setImageFileName("");
            this.setImageNumber(0);
        }
    }

    /**
     * "{T}: Target teammate gains control of this creature. Activate only as a sorcery." The tap
     * cost keeps the usual summoning-sickness rule (302.6), and a teammate is targeted only in the
     * controller's range. Only a human player may activate it: the bots never deploy.
     */
    static final class DeployAbility extends ActivatedAbilityImpl {
        private static final long serialVersionUID = 1L;
        private static final FilterPlayer TEAMMATE = new FilterPlayer("teammate");

        static {
            TEAMMATE.add(Ally.instance);
        }

        DeployAbility() {
            super(Zone.BATTLEFIELD, new Deploy(), new TapSourceCost());
            this.timing = TimingRule.SORCERY;
            this.addTarget(new TargetPlayer(1, 1, false, TEAMMATE));
        }

        private DeployAbility(final DeployAbility ability) {
            super(ability);
        }

        @Override
        public ActivationStatus canActivate(UUID playerId, Game game) {
            Player player = game.getPlayer(playerId);
            if (player == null || !player.isHuman()) {
                return ActivationStatus.getFalse();
            }
            return super.canActivate(playerId, game);
        }

        @Override
        public DeployAbility copy() {
            return new DeployAbility(this);
        }

        @Override
        public String getRule() {
            return "{T}: Target teammate in your range gains control of this creature. Activate only as a sorcery. "
                + "<i>(Deploy)</i>";
        }
    }

    /** A teammate of the ability's controller. */
    enum Ally implements ObjectSourcePlayerPredicate<Player> {
        instance;

        @Override
        public boolean apply(ObjectSourcePlayer<Player> input, Game game) {
            return game.getAllies(input.getPlayerId()).contains(input.getObject().getId());
        }
    }

    /** The target teammate gains control of the creature, for the rest of the game. */
    static final class Deploy extends OneShotEffect {
        private static final long serialVersionUID = 1L;

        Deploy() {
            super(Outcome.Benefit);
            this.staticText = "target teammate gains control of this creature";
        }

        private Deploy(final Deploy effect) {
            super(effect);
        }

        @Override
        public boolean apply(Game game, Ability source) {
            UUID teammate = getTargetPointer().getFirst(game, source);
            if (teammate == null || game.getPermanent(source.getSourceId()) == null) {
                return false;
            }
            game.addEffect(new GainControlTargetEffect(Duration.Custom, true, teammate)
                .setTargetPointer(new FixedTarget(source.getSourceId(), game)), source);
            return true;
        }

        @Override
        public Deploy copy() {
            return new Deploy(this);
        }
    }

    /** XMage's description of the game type: six players in two teams of three. */
    static final class Type extends MatchType {
        private static final long serialVersionUID = 1L;

        Type() {
            this.name = "King's Table";
            this.minPlayers = KingsTableRules.SEATS;
            this.maxPlayers = KingsTableRules.SEATS;
            this.numTeams = 2;
            this.playersPerTeam = 3;
            this.useAttackOption = false;
            this.useRange = false;
            this.sideboardingAllowed = false;
        }

        private Type(Type type) {
            super(type);
        }

        @Override
        public Type copy() {
            return new Type(this);
        }
    }

    /** The never-started match XMage's AI needs for its search (see {@link LegacyDuel}). */
    static final class Match extends MatchImpl {
        private static final long serialVersionUID = 1L;

        Match(MatchOptions options) {
            super(options);
        }

        @Override
        public void startGame() throws mage.game.GameException {
            throw new mage.game.GameException("Commander Duels starts its King's Table games itself");
        }
    }
}
