package com.commanderduels;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import mage.constants.MultiplayerAttackOption;
import mage.constants.PhaseStep;
import mage.constants.RangeOfInfluence;
import mage.game.GameException;
import mage.game.GameImpl;
import mage.game.match.MatchImpl;
import mage.game.match.MatchOptions;
import mage.game.match.MatchType;
import mage.game.mulligan.Mulligan;
import mage.game.turn.TurnMod;
import mage.players.Player;

/**
 * Two-Headed Giant (rule 810): two teams of two players, with shared team turns (rule 805).
 *
 * <p>The rules live in XMage, patched for this (engine/xmage/patches, 0001 and 0002, and v0.5.1's
 * card audit, 0004 to 0006, for the rest of rules 805 and 810 that cards rely on): a team takes
 * one turn together, in which both its players untap, draw, have main phases and attack together;
 * the defending team blocks together; teammates are not opponents; and each team shares one life
 * total. This game type names the teams for those rules ({@link #getTeammates}) and adds what
 * belongs to the format itself: 30 starting life (810.4), the team that plays first skipping the
 * draw step of its first turn (810.6), team poison counted against 15 (810.8d, 810.10), and teams
 * winning and losing together, a concession included (810.8a, 810.8b). Players attack any opponent
 * (805.10b) and see the whole table. The first mulligan is free, as in every multiplayer game
 * (103.5c).
 */
final class TwoHeadedGiant extends GameImpl {
    private static final long serialVersionUID = 1L;
    /** 810.4: each team's shared life total starts at 30. */
    static final int START_LIFE = 30;
    /** 810.8d: a team with 15 or more poison counters loses. */
    static final int POISON_TO_LOSE = 15;
    static final int MIN_DECK_SIZE = 60;
    static final int PLAYERS = 4;

    /** Each team's players in turn order. */
    private final ArrayList<List<UUID>> teams = new ArrayList<>();
    /** Each player's teammates, for XMage's rules, which ask often. */
    private final HashMap<UUID, Set<UUID>> teammates = new HashMap<>();

    TwoHeadedGiant(Mulligan mulligan, int startHandSize) {
        super(MultiplayerAttackOption.MULTIPLE, RangeOfInfluence.ALL, mulligan, MIN_DECK_SIZE, START_LIFE,
            startHandSize);
    }

    private TwoHeadedGiant(TwoHeadedGiant game) {
        super(game);
        teams.addAll(game.teams);
        teammates.putAll(game.teammates);
    }

    /** Names the teams, each its players in turn order. Called once the players are seated, before the start. */
    void setTeams(List<List<UUID>> players) {
        teams.clear();
        teammates.clear();
        for (List<UUID> team : players) {
            teams.add(List.copyOf(team));
            for (UUID playerId : team) {
                Set<UUID> others = new LinkedHashSet<>(team);
                others.remove(playerId);
                teammates.put(playerId, Collections.unmodifiableSet(others));
            }
        }
    }

    /** The team's index (0 for the team of the first seat), or -1 for a player on no team. */
    int teamOf(UUID playerId) {
        for (int team = 0; team < teams.size(); team++) {
            if (teams.get(team).contains(playerId)) {
                return team;
            }
        }
        return -1;
    }

    List<List<UUID>> teams() {
        return List.copyOf(teams);
    }

    @Override
    public Set<UUID> getTeammates(UUID playerId) {
        return teammates.getOrDefault(playerId, Set.of());
    }

    @Override
    public MatchType getGameType() {
        return new Type();
    }

    @Override
    public int getNumPlayers() {
        return PLAYERS;
    }

    @Override
    protected void init(UUID choosingPlayerId) {
        super.init(choosingPlayerId);
        // 810.6: the team that plays first skips the draw step of its first turn. The starting
        // player takes that turn for the team, and its draw step is the team's (805.4b).
        if (startingPlayerId != null) {
            state.getTurnMods().add(new TurnMod(startingPlayerId).withSkipStep(PhaseStep.DRAW));
        }
    }

    /**
     * 810.8d. Poison counters are given to each player, but the team has them all (810.10): the
     * patched XMage counts a player's teammates' with theirs ({@code Game.getPoisonCounters}).
     */
    @Override
    public int getPoisonCountersToLose() {
        return POISON_TO_LOSE;
    }

    /**
     * 810.8a, 810.8b: players win and lose as a team. When a player loses, or leaves the game by
     * conceding, the rest of their team loses too, and the game ends when one team is left: its
     * players win. Both teams losing at once is a draw.
     */
    @Override
    public boolean checkIfGameIsOver() {
        if (state.isGameOver() || Thread.currentThread().isInterrupted() || teams.isEmpty()) {
            return super.checkIfGameIsOver();
        }
        for (List<UUID> team : teams) {
            if (team.stream().map(this::getPlayer).anyMatch(TwoHeadedGiant::out)) {
                for (UUID playerId : team) {
                    Player player = getPlayer(playerId);
                    if (!player.hasLost() && !player.hasWon()) {
                        player.lostForced(this);
                    }
                }
            }
        }
        if (state.isGameOver()) {
            return true;
        }
        List<List<UUID>> standing = teams.stream()
            .filter(team -> team.stream().map(this::getPlayer).noneMatch(TwoHeadedGiant::out)).toList();
        if (standing.size() > 1) {
            return false;
        }
        end();
        for (List<UUID> team : standing) {
            for (UUID playerId : team) {
                getPlayer(playerId).won(this);
            }
        }
        return true;
    }

    /**
     * At the end of the game XMage keeps one winner and makes every other player lose, which would
     * take the win from the winner's teammate: here the winner's whole team keeps it (810.8a).
     */
    @Override
    protected UUID findWinnersAndLosers() {
        if (teams.isEmpty()) {
            return super.findWinnersAndLosers();
        }
        UUID winner = teams.stream().flatMap(List::stream).filter(id -> getPlayer(id).hasWon()).findFirst()
            .orElse(null);
        if (winner != null) {
            for (List<UUID> team : teams) {
                if (!team.contains(winner)) {
                    team.stream().map(this::getPlayer).filter(player -> !player.hasLost())
                        .forEach(player -> player.lost(this));
                }
            }
        }
        return winner;
    }

    private static boolean out(Player player) {
        return player.hasLost() || player.hasLeft();
    }

    @Override
    public TwoHeadedGiant copy() {
        return new TwoHeadedGiant(this);
    }

    /** XMage's description of the game type: four players in two teams of two. */
    static final class Type extends MatchType {
        private static final long serialVersionUID = 1L;

        Type() {
            this.name = "Two-Headed Giant";
            this.minPlayers = PLAYERS;
            this.maxPlayers = PLAYERS;
            this.numTeams = 2;
            this.playersPerTeam = 2;
            this.useAttackOption = false;
            this.useRange = false;
            // MTR 9.5: no sideboards in Two-Headed Giant Constructed.
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
        public void startGame() throws GameException {
            throw new GameException("Commander Duels starts its Two-Headed Giant games itself");
        }
    }
}
