package com.commanderduels;

import java.util.List;
import java.util.Map;

/**
 * What one seat is authorized to see, built field by field from the game state rather than by
 * filtering a full snapshot. Every other player's hand, and every library, appear only as counts.
 * Object ids are opaque {@link ObjectRefs}; players are referred to by seat. {@code opponents} lists
 * every other player in seat order, including eliminated ones.
 */
public record SeatView(
    int seat,
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
    List<String> messages) {

    /**
     * @param colorIdentity the combined colour identity of the player's commanders in WUBRG order
     *                      ("" for colourless); null outside Commander and before the game starts
     * @param commandZone   the objects in the command zone that the player owns or controls
     * @param commanders    one entry per commander the player owns; empty outside Commander
     */
    public record PlayerState(int seat, String name, int life, Map<String, Integer> counters, int libraryCount,
                              int handCount, List<CardInfo> graveyard, List<CardInfo> exile, ManaPoolInfo manaPool,
                              boolean lost, boolean won, String colorIdentity, List<CardInfo> commandZone,
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
