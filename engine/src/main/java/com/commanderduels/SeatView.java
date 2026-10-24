package com.commanderduels;

import java.util.List;
import java.util.Map;

/**
 * What one seat is authorized to see, built field by field from the game state rather than by
 * filtering a full snapshot. Every other player's hand, and every library, appear only as counts
 * (but a teammate's hand, and since v0.5.1 that of a player whose turn the seat controls).
 * Object ids are opaque {@link ObjectRefs}; players are referred to by seat. {@code opponents} lists
 * every other player in seat order, including eliminated ones. A spectator's view has no seat and
 * no {@code you}, its {@code opponents} lists every player, and it shows public information only.
 */
public record SeatView(
    Integer seat,
    int turn,
    Integer activeSeat,
    Integer prioritySeat,
    String phase,
    String step,
    PlayerState you,
    List<PlayerState> opponents,
    List<CardInfo> hand,
    List<PermanentInfo> battlefield,
    List<StackItem> stack,
    List<CombatInfo> combat,
    List<CardGroup> revealed,
    List<CardGroup> lookedAt,
    List<String> messages,
    PriorityControls priority) {

    /**
     * The seat's priority controls (UI07; see {@link Priority}); null for spectators.
     *
     * @param passing          how the seat is passing now (until_stack_resolved, until_next_main,
     *                         until_end_of_turn, until_next_turn, until_end_step_before_my_turn,
     *                         until_my_turn), or null
     * @param yourTurn         the steps it stops at in its own turns, with an empty stack
     * @param opponentTurn     the steps it stops at in other players' turns
     * @param passAfterCasting it passes as soon as it has cast a spell or activated an ability,
     *                         instead of holding priority
     */
    public record PriorityControls(String passing, List<String> yourTurn, List<String> opponentTurn,
                                   boolean stopOnNewStackObjects, boolean stopOnAttackers, boolean stopOnBlockers,
                                   boolean passAfterCasting, boolean fullControl) {}

    /**
     * @param team          the player's team in a team game (Two-Headed Giant, since v0.5.0): 0 for
     *                      seats 0 and 1, 1 for seats 2 and 3; null in other games. Teammates share
     *                      one life total, so both show the team's
     * @param controlledBy  the seat controlling this player's turn (723, since v0.5.1), shown to
     *                      everyone, as XMage's log announces it; null while the player controls it
     * @param hand          the player's hand, shown only to their teammate (810.5, FMT10) and, since
     *                      v0.5.1, to the player controlling their turn while the control lasts (723.4);
     *                      null for everyone else, whose hand appears only as a count
     * @param colorIdentity the combined colour identity of the player's commanders in WUBRG order
     *                      ("" for colourless); null outside Commander and before the game starts
     * @param commandZone   the objects in the command zone that the player owns or controls
     * @param commanders    one entry per commander the player owns; empty outside Commander
     */
    public record PlayerState(int seat, String name, Integer team, Integer controlledBy, int life,
                              Map<String, Integer> counters, int libraryCount, int handCount, List<CardInfo> hand,
                              List<CardInfo> graveyard, List<CardInfo> exile, ManaPoolInfo manaPool, boolean lost,
                              boolean won, String colorIdentity, List<CardInfo> commandZone,
                              List<CommanderState> commanders) {}

    /**
     * One commander (FMT01). Its identity is public from the start of the game; its current object and
     * zone are shown only while the seat can see it. A commander in a hand or library is reported as
     * {@code hidden} to everyone but its owner, so a draw cannot reveal that the drawn card was the
     * commander.
     *
     * @param zone        command, battlefield, stack, graveyard, exile, hand, library, hidden or outside
     * @param objectId    the commander's current object, while the seat can see it
     * @param castCount   times its owner has cast it from the command zone
     * @param tax         the commander tax: {2} for each of those casts
     * @param damageDealt combat damage this commander has dealt to each player, by seat (21 is lethal)
     */
    public record CommanderState(String name, String zone, String objectId, int castCount, int tax,
                                 List<CommanderDamage> damageDealt) {}

    public record CommanderDamage(int seat, int damage) {}

    /** A card face. {@code hidden} cards (face down, for instance) carry only their id. */
    public record CardInfo(String id, boolean hidden, String name, String manaCost, String typeLine, String power,
                           String toughness, List<String> rules) {}

    public record PermanentInfo(String id, int controllerSeat, int ownerSeat, CardInfo card, boolean tapped,
                                boolean summoningSick, int damage, Map<String, Integer> counters, boolean attacking,
                                boolean blocking, String attachedTo) {}

    public record StackItem(String id, String kind, int controllerSeat, String name, String text, boolean hidden,
                            List<TargetRef> targets) {}

    /** A player (by seat) or an object (by opaque id). Hidden objects have no label. */
    public record TargetRef(String kind, Integer seat, String objectId, String label) {}

    public record CombatInfo(List<String> attackers, TargetRef defender, List<String> blockers, boolean blocked) {}

    public record CardGroup(String name, List<CardInfo> cards) {}

    public record ManaPoolInfo(int white, int blue, int black, int red, int green, int colorless) {}
}
