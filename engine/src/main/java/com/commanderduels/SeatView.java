package com.commanderduels;

import java.util.List;
import java.util.Map;

/**
 * What one seat is authorized to see, built field by field from the game state rather than by
 * filtering a full snapshot. The opponent's hand and both libraries appear only as counts. Object
 * ids are opaque {@link ObjectRefs}; players are referred to by seat.
 */
public record SeatView(
    int seat,
    int turn,
    Integer activeSeat,
    Integer prioritySeat,
    String phase,
    String step,
    PlayerState you,
    PlayerState opponent,
    List<CardInfo> hand,
    List<PermanentInfo> battlefield,
    List<StackItem> stack,
    List<CombatInfo> combat,
    List<CardGroup> revealed,
    List<CardGroup> lookedAt,
    List<String> messages) {

    public record PlayerState(int seat, String name, int life, Map<String, Integer> counters, int libraryCount,
                              int handCount, List<CardInfo> graveyard, List<CardInfo> exile, ManaPoolInfo manaPool,
                              boolean lost, boolean won) {}

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
