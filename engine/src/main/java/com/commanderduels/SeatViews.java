package com.commanderduels;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.regex.Pattern;
import mage.MageObject;
import mage.abilities.Ability;
import mage.cards.Card;
import mage.cards.Cards;
import mage.counters.Counter;
import mage.counters.Counters;
import mage.game.ExileZone;
import mage.game.Game;
import mage.game.GameState;
import mage.game.combat.CombatGroup;
import mage.game.permanent.Permanent;
import mage.game.stack.Spell;
import mage.game.stack.StackObject;
import mage.players.ManaPool;
import mage.players.Player;
import mage.target.Target;

/**
 * Builds {@link SeatView}s. Runs on the game thread only, where XMage's state is consistent (XMage's
 * own server builds its per-player views there for the same reason).
 */
final class SeatViews {
    private static final Pattern SHORT_IDS = Pattern.compile(" \\[[0-9a-f]{3}]");

    private final Game game;
    private final List<UUID> seatIds;
    private final ObjectRefs refs;

    SeatViews(Game game, List<UUID> seatIds, ObjectRefs refs) {
        this.game = game;
        this.seatIds = seatIds;
        this.refs = refs;
    }

    SeatView build(int seat, List<String> messages) {
        UUID viewer = seatIds.get(seat);
        GameState state = game.getState();
        Player you = game.getPlayer(viewer);
        Player opponent = game.getPlayer(seatIds.get(1 - seat));

        List<SeatView.CardInfo> hand = new ArrayList<>();
        for (Card card : you.getHand().getCards(game)) {
            hand.add(card(card, true));
        }
        List<SeatView.PermanentInfo> battlefield = new ArrayList<>();
        for (Permanent permanent : state.getBattlefield().getAllPermanents()) {
            battlefield.add(permanent(permanent, viewer));
        }
        List<SeatView.StackItem> stack = new ArrayList<>();
        for (StackObject stackObject : state.getStack()) {
            stack.add(stackItem(stackObject, viewer));
        }
        List<SeatView.CombatInfo> combat = new ArrayList<>();
        for (CombatGroup group : state.getCombat().getGroups()) {
            combat.add(new SeatView.CombatInfo(
                group.getAttackers().stream().map(this::permanentRef).toList(),
                target(group.getDefenderId(), viewer),
                group.getBlockers().stream().map(this::permanentRef).toList(),
                group.getBlocked()));
        }
        List<SeatView.CardGroup> revealed = new ArrayList<>();
        state.getRevealed().forEach((name, cards) -> revealed.add(group(name, cards)));
        List<SeatView.CardGroup> lookedAt = new ArrayList<>();
        state.getLookedAt(viewer).forEach((name, cards) -> lookedAt.add(group(name, cards)));

        return new SeatView(
            seat,
            game.getTurnNum(),
            seatOrNull(game.getActivePlayerId()),
            seatOrNull(state.getPriorityPlayerId()),
            game.getTurnPhaseType() == null ? null : game.getTurnPhaseType().name().toLowerCase(Locale.ROOT),
            game.getTurnStepType() == null ? null : game.getTurnStepType().name().toLowerCase(Locale.ROOT),
            player(you, viewer),
            player(opponent, viewer),
            hand,
            battlefield,
            stack,
            combat,
            revealed,
            lookedAt,
            List.copyOf(messages));
    }

    private SeatView.PlayerState player(Player player, UUID viewer) {
        List<SeatView.CardInfo> graveyard = new ArrayList<>();
        for (Card card : player.getGraveyard().getCards(game)) {
            graveyard.add(card(card, true));
        }
        List<SeatView.CardInfo> exile = new ArrayList<>();
        for (ExileZone zone : game.getExile().getExileZones()) {
            for (Card card : zone.getCards(game)) {
                if (player.getId().equals(card.getOwnerId())) {
                    exile.add(card(card, Visibility.identityVisible(game, card.getId(), viewer)));
                }
            }
        }
        ManaPool pool = player.getManaPool();
        return new SeatView.PlayerState(
            seatIds.indexOf(player.getId()),
            player.getName(),
            player.getLife(),
            counters(player.getCountersAsCopy()),
            player.getLibrary().size(),
            player.getHand().size(),
            graveyard,
            exile,
            new SeatView.ManaPoolInfo(pool.getWhite(), pool.getBlue(), pool.getBlack(), pool.getRed(), pool.getGreen(),
                pool.getColorless()),
            player.hasLost(),
            player.hasWon());
    }

    private SeatView.PermanentInfo permanent(Permanent permanent, UUID viewer) {
        boolean visible = !permanent.isFaceDown(game) || viewer.equals(permanent.getControllerId());
        UUID attachedTo = permanent.getAttachedTo();
        return new SeatView.PermanentInfo(
            ref(permanent),
            seatOf(permanent.getControllerId()),
            seatOf(permanent.getOwnerId()),
            card(permanent, visible),
            permanent.isTapped(),
            permanent.isCreature(game) && permanent.hasSummoningSickness(),
            permanent.getDamage(),
            counters(permanent.getCounters(game)),
            permanent.isAttacking(),
            permanent.getBlocking() > 0,
            attachedTo == null ? null : objectRef(attachedTo));
    }

    private SeatView.StackItem stackItem(StackObject stackObject, UUID viewer) {
        boolean visible = Visibility.stackObjectVisible(game, stackObject, viewer);
        String id = refs.ref(stackObject.getId(), stackObject.getZoneChangeCounter(game));
        String kind;
        String name;
        String text;
        if (stackObject instanceof Spell spell) {
            kind = "spell";
            name = spell.getName();
            text = String.join(" ", rules(spell.getRules(game)));
        } else {
            kind = "ability";
            MageObject source = game.getObject(stackObject.getSourceId());
            if (source instanceof Permanent permanent && permanent.isFaceDown(game)
                    && !viewer.equals(permanent.getControllerId())) {
                visible = false;
            }
            name = source == null ? stackObject.getName() : source.getName();
            text = plain(stackObject.getStackAbility().getRule());
        }
        List<SeatView.TargetRef> targets = new ArrayList<>();
        Ability ability = stackObject.getStackAbility();
        for (UUID modeId : ability.getModes().getSelectedModes()) {
            for (Target target : ability.getModes().get(modeId).getTargets()) {
                for (UUID targetId : target.getTargets()) {
                    targets.add(target(targetId, viewer));
                }
            }
        }
        return new SeatView.StackItem(id, kind, seatOf(stackObject.getControllerId()),
            visible ? name : null, visible ? text : null, !visible, targets);
    }

    SeatView.TargetRef target(UUID id, UUID viewer) {
        if (id == null) {
            return null;
        }
        Player player = game.getPlayer(id);
        if (player != null) {
            return new SeatView.TargetRef("player", seatIds.indexOf(id), null, player.getName());
        }
        MageObject object = game.getObject(id);
        boolean visible = Visibility.identityVisible(game, id, viewer);
        String ref = refs.ref(id, object == null ? 0 : object.getZoneChangeCounter(game));
        return new SeatView.TargetRef("object", null, ref, visible && object != null ? object.getName() : null);
    }

    SeatView.CardInfo card(Card card, boolean visible) {
        String id = ref(card);
        if (!visible) {
            return new SeatView.CardInfo(id, true, null, null, null, null, null, List.of());
        }
        boolean creature = card.isCreature(game);
        return new SeatView.CardInfo(
            id,
            false,
            card.getName(),
            card.getManaCost().getText(),
            typeLine(card),
            creature ? String.valueOf(card.getPower().getValue()) : null,
            creature ? String.valueOf(card.getToughness().getValue()) : null,
            rules(card.getRules(game)));
    }

    String ref(MageObject object) {
        return refs.ref(object.getId(), object.getZoneChangeCounter(game));
    }

    String objectRef(UUID id) {
        MageObject object = game.getObject(id);
        return refs.ref(id, object == null ? 0 : object.getZoneChangeCounter(game));
    }

    private String permanentRef(UUID id) {
        Permanent permanent = game.getPermanent(id);
        return permanent == null ? objectRef(id) : ref(permanent);
    }

    private SeatView.CardGroup group(String name, Cards cards) {
        List<SeatView.CardInfo> shown = new ArrayList<>();
        for (Card card : cards.getCards(game)) {
            shown.add(card(card, true));
        }
        return new SeatView.CardGroup(plain(name), shown);
    }

    private String typeLine(MageObject object) {
        List<String> words = new ArrayList<>();
        object.getSuperType(game).forEach(type -> words.add(type.toString()));
        object.getCardType(game).forEach(type -> words.add(type.toString()));
        List<String> subtypes = object.getSubtype(game).stream().map(Object::toString).toList();
        String line = String.join(" ", words);
        return subtypes.isEmpty() ? line : line + " — " + String.join(" ", subtypes);
    }

    private static Map<String, Integer> counters(Counters counters) {
        Map<String, Integer> counts = new TreeMap<>();
        for (Counter counter : counters.values()) {
            if (counter.getCount() > 0) {
                counts.put(counter.getName(), counter.getCount());
            }
        }
        return counts;
    }

    private static List<String> rules(List<String> rules) {
        return rules.stream().map(SeatViews::plain).filter(line -> !line.isEmpty()).toList();
    }

    /** XMage's text without HTML and without its short object ids, which derive from internal UUIDs. */
    static String plain(String text) {
        return SHORT_IDS.matcher(MatchLog.plain(text)).replaceAll("");
    }

    private Integer seatOrNull(UUID playerId) {
        int seat = playerId == null ? -1 : seatIds.indexOf(playerId);
        return seat < 0 ? null : seat;
    }

    int seatOf(UUID playerId) {
        return seatIds.indexOf(playerId);
    }
}
