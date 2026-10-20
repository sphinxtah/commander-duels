package com.commanderduels;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
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
import mage.constants.CommanderCardType;
import mage.constants.Zone;
import mage.counters.Counter;
import mage.counters.Counters;
import mage.filter.FilterMana;
import mage.game.ExileZone;
import mage.game.Game;
import mage.game.GameCommanderImpl;
import mage.game.GameState;
import mage.game.combat.CombatGroup;
import mage.game.command.CommandObject;
import mage.game.command.Commander;
import mage.game.permanent.Permanent;
import mage.game.stack.Spell;
import mage.game.stack.StackObject;
import mage.players.ManaPool;
import mage.players.Player;
import mage.target.Target;
import mage.watchers.common.CommanderInfoWatcher;
import mage.watchers.common.CommanderPlaysCountWatcher;

/**
 * Builds {@link SeatView}s for any seat at the table. Runs on the game thread only, where XMage's state is consistent (XMage's
 * own server builds its per-player views there for the same reason).
 */
final class SeatViews {
    private static final Pattern SHORT_IDS = Pattern.compile(" \\[[0-9a-f]{3}]");

    private final Game game;
    private final List<UUID> seatIds;
    private final ObjectRefs refs;
    /** Commander names and colour identities, kept for commanders that left the game with their owner. */
    private final Map<UUID, String> commanderNames = new HashMap<>();
    private final Map<UUID, String> identities = new HashMap<>();

    SeatViews(Game game, List<UUID> seatIds, ObjectRefs refs) {
        this.game = game;
        this.seatIds = seatIds;
        this.refs = refs;
    }

    SeatView build(int seat, List<String> messages) {
        return build(seatIds.get(seat), messages);
    }

    /**
     * A spectator's view (NET14): public information only. There is no seat, no "you", no hand and no
     * looked-at cards, and {@code opponents} lists every player.
     */
    SeatView buildPublic() {
        return build(null, List.of());
    }

    private SeatView build(UUID viewer, List<String> messages) {
        GameState state = game.getState();
        Player you = viewer == null ? null : game.getPlayer(viewer);
        List<SeatView.PlayerState> opponents = new ArrayList<>();
        for (UUID playerId : seatIds) {
            if (!playerId.equals(viewer)) {
                opponents.add(player(game.getPlayer(playerId), viewer));
            }
        }

        List<SeatView.CardInfo> hand = new ArrayList<>();
        if (you != null) {
            for (Card card : you.getHand().getCards(game)) {
                hand.add(card(card, true));
            }
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
        if (viewer != null) {
            state.getLookedAt(viewer).forEach((name, cards) -> lookedAt.add(group(name, cards)));
        }

        return new SeatView(
            viewer == null ? null : seatIds.indexOf(viewer),
            game.getTurnNum(),
            seatOrNull(game.getActivePlayerId()),
            seatOrNull(state.getPriorityPlayerId()),
            game.getTurnPhaseType() == null ? null : game.getTurnPhaseType().name().toLowerCase(Locale.ROOT),
            game.getTurnStepType() == null ? null : game.getTurnStepType().name().toLowerCase(Locale.ROOT),
            you == null ? null : player(you, viewer),
            List.copyOf(opponents),
            hand,
            battlefield,
            stack,
            combat,
            revealed,
            lookedAt,
            List.copyOf(messages),
            you == null ? null : Priority.controls(you));
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
        List<SeatView.CardInfo> commandZone = new ArrayList<>();
        for (CommandObject object : game.getState().getCommand()) {
            if (object.isControlledBy(player.getId())) {
                commandZone.add(commandObject(object));
            }
        }
        boolean commanderGame = game instanceof GameCommanderImpl;
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
            player.hasWon(),
            commanderGame ? colorIdentity(player) : null,
            List.copyOf(commandZone),
            commanderGame ? commanders(player, viewer) : List.of());
    }

    /** A commander's card, or an emblem, plane or dungeon, which are not cards. */
    private SeatView.CardInfo commandObject(CommandObject object) {
        if (object instanceof Commander) {
            Card card = game.getCard(object.getId());
            if (card != null) {
                return card(card, true);
            }
        }
        return new SeatView.CardInfo(refs.ref(object.getId(), 0), false, object.getName(), null, typeLine(object),
            null, null, rules(object.getAbilities().getRules()));
    }

    /**
     * The combined colour identity of the player's commanders, in WUBRG order; null until XMage has
     * moved them to the command zone at the start of the game.
     */
    private String colorIdentity(Player player) {
        FilterMana identity = new FilterMana();
        var commanderIds = game.getCommandersIds(player, CommanderCardType.COMMANDER_OR_OATHBREAKER, false);
        if (commanderIds.isEmpty()) {
            return null;
        }
        for (UUID id : commanderIds) {
            Card card = game.getCard(id);
            if (card == null) {
                // The owner left the game, and XMage removed their cards.
                return identities.get(player.getId());
            }
            identity.addAll(card.getColorIdentity());
        }
        String colors = (identity.isWhite() ? "W" : "") + (identity.isBlue() ? "U" : "")
            + (identity.isBlack() ? "B" : "") + (identity.isRed() ? "R" : "") + (identity.isGreen() ? "G" : "");
        identities.put(player.getId(), colors);
        return colors;
    }

    /**
     * Each commander's zone, casts from the command zone, tax and combat damage dealt, read from
     * XMage's own watchers, so the view shows exactly what XMage applies.
     */
    private List<SeatView.CommanderState> commanders(Player owner, UUID viewer) {
        CommanderPlaysCountWatcher plays = game.getState().getWatcher(CommanderPlaysCountWatcher.class);
        List<UUID> ids = new ArrayList<>();
        for (UUID id : game.getCommandersIds(owner, CommanderCardType.COMMANDER_OR_OATHBREAKER, false)) {
            if (commanderName(id) != null) {
                ids.add(id);
            }
        }
        ids.sort(Comparator.comparing(this::commanderName));
        List<SeatView.CommanderState> commanders = new ArrayList<>();
        for (UUID id : ids) {
            String zone = commanderZone(id);
            if ((zone.equals("hand") || zone.equals("library")) && !owner.getId().equals(viewer)) {
                zone = "hidden";
            }
            String objectId = null;
            if (!zone.equals("hidden") && !zone.equals("outside") && Visibility.identityVisible(game, id, viewer)) {
                objectId = commanderObject(id, zone);
            }
            int casts = plays == null ? 0 : plays.getPlaysCount(id);
            List<SeatView.CommanderDamage> damage = new ArrayList<>();
            CommanderInfoWatcher watcher = game.getState().getWatcher(CommanderInfoWatcher.class, id);
            if (watcher != null) {
                watcher.getDamageToPlayer().forEach((playerId, amount) -> {
                    int seat = seatIds.indexOf(playerId);
                    if (seat >= 0 && amount > 0) {
                        damage.add(new SeatView.CommanderDamage(seat, amount));
                    }
                });
            }
            damage.sort(Comparator.comparingInt(SeatView.CommanderDamage::seat));
            commanders.add(new SeatView.CommanderState(commanderName(id), zone, objectId, casts, 2 * casts,
                List.copyOf(damage)));
        }
        return List.copyOf(commanders);
    }

    private String commanderName(UUID id) {
        Card card = game.getCard(id);
        if (card != null) {
            commanderNames.putIfAbsent(id, card.getName());
        }
        return commanderNames.get(id);
    }

    private String commanderZone(UUID id) {
        Zone zone = game.getCard(id) == null ? null : game.getState().getZone(id);
        if (zone == null) {
            return "outside";
        }
        return switch (zone) {
            case COMMAND -> "command";
            case BATTLEFIELD -> "battlefield";
            case STACK -> "stack";
            case GRAVEYARD -> "graveyard";
            case EXILED -> "exile";
            case HAND -> "hand";
            case LIBRARY -> "library";
            default -> "outside";
        };
    }

    /** The id the seat knows the commander by in its zone: the spell while it is on the stack, else the card. */
    private String commanderObject(UUID id, String zone) {
        if (zone.equals("stack")) {
            Spell spell = game.getStack().getSpell(id, false);
            return spell == null ? null : refs.ref(spell.getId(), spell.getZoneChangeCounter(game));
        }
        if (zone.equals("battlefield")) {
            Permanent permanent = game.getPermanent(id);
            return permanent == null ? null : ref(permanent);
        }
        return objectRef(id);
    }

    private SeatView.PermanentInfo permanent(Permanent permanent, UUID viewer) {
        boolean visible = !permanent.isFaceDown(game) || permanent.getControllerId().equals(viewer);
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
                    && !permanent.getControllerId().equals(viewer)) {
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
