package com.commanderduels;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import mage.MageObject;
import mage.abilities.Ability;
import mage.abilities.SpellAbility;
import mage.abilities.TriggeredAbility;
import mage.abilities.costs.VariableCost;
import mage.abilities.costs.mana.ManaCost;
import mage.abilities.effects.ContinuousEffectsList;
import mage.abilities.effects.CostModificationEffect;
import mage.abilities.effects.common.cost.CommanderCostModification;
import mage.constants.CostModificationType;
import mage.constants.PhaseStep;
import mage.constants.SpellAbilityCastMode;
import mage.constants.SubType;
import mage.constants.WatcherScope;
import mage.constants.Zone;
import mage.counters.CounterType;
import mage.game.Game;
import mage.game.events.DamagedEvent;
import mage.game.events.GameEvent;
import mage.game.events.ZoneChangeEvent;
import mage.game.permanent.Permanent;
import mage.game.stack.Spell;
import mage.game.stack.StackAbility;
import mage.game.stack.StackObject;
import mage.util.CardUtil;
import mage.watchers.Watcher;

/**
 * A game's structured events (v0.9.10; docs/engine/events.md): what happened, in order, made from
 * XMage's own {@link GameEvent}s on the game thread, for timelines, replays and spectators.
 *
 * <p>Each event is numbered in the game's sequence ({@code seq}), names the turn and step it
 * happened in, names seats by their number and objects by the ids the seat views use
 * ({@link ObjectRefs}), and carries its cause where XMage gives one (the source of a damage, of a
 * zone change, of a life change). Nothing XMage-internal reaches it: no XMage id, no presentation text.
 *
 * <p><b>Visibility.</b> The event's kind, its seats, zones and amounts are public: every seat sees
 * that a card was drawn, or put into a library. An object's identity (its id and name) carries the
 * seats that may see it ({@code seen_by}): every seat ({@code "all"}), or a list. It is decided by
 * the rules the seat views use ({@link Visibility}): where the object is after the event, and for a
 * zone change also where it was before it, so a card drawn is its owner's to see, a card discarded
 * everyone's, and a face-down one its controller's. The filter that applies it is the API's
 * ({@code api/events.py}), one for the seat, its teammate, the spectator and the replay.
 *
 * <p><b>Durability.</b> In a recorded game the events are written beside the journal
 * ({@value #FILE}), one JSON line each. A checkpoint holds the sequence number it was taken at
 * ({@link Checkpoint#eventSeq}); a game taken up again keeps the events up to it and makes the rest
 * again as the journal is played, under a new {@code epoch}, so the log is always the game's own.
 *
 * <p><b>Version 2 (v1.0.0, for the timeline).</b> What XMage's events do not say and the game still
 * knows as they happen: what a spell cost and what changed its cost ({@code cost} on a cast, the
 * printed {@code mana_cost} on its object), why a permanent left the battlefield ({@code why} on its
 * zone change: lethal damage, a toughness of 0, the legend rule, destroyed, sacrificed), a spell or
 * ability that left the stack without resolving ({@code fizzled}), and which resolutions never were
 * on the stack ({@code immediate}: a mana ability). Each is told only where the game is sure of it.
 */
final class GameEvents {
    static final int VERSION = 2;
    static final String FILE = "events.jsonl";
    /** The live games' event logs, by game id: the taps in their states find them here. */
    private static final Map<String, GameEvents> LIVE = new ConcurrentHashMap<>();

    /**
     * XMage's side: a watcher in the game's state that hands every event of the real game to the
     * game's log. A copy of the game (a bot's simulation, a checkpoint) keeps the watcher, and the
     * game's id with it; a simulation's events are not the game's and are left out, and a
     * checkpoint's copy is never played.
     */
    static final class Tap extends Watcher {
        private static final long serialVersionUID = 2L;
        private String gameId;
        /**
         * How often each commander was cast from the command zone before now (903.8), by its main
         * card: kept here, in the game's state, so that it is right after a recovery and a rollback,
         * and whatever the order XMage's own watcher of the same count is asked in.
         */
        private final HashMap<UUID, Integer> commandCasts = new HashMap<>();

        Tap(String gameId) {
            super(WatcherScope.GAME);
            this.gameId = gameId;
        }

        @Override
        public void watch(GameEvent event, Game game) {
            int castsBefore = 0;
            if (event.getType() == GameEvent.EventType.SPELL_CAST && event.getZone() == Zone.COMMAND) {
                UUID main = CardUtil.getMainCardId(game, event.getSourceId());
                if (main != null) {
                    castsBefore = commandCasts.merge(main, 1, Integer::sum) - 1;
                }
            }
            if (gameId == null || game.isSimulation()) {
                return;
            }
            GameEvents events = LIVE.get(gameId);
            if (events != null) {
                events.on(event, game, castsBefore);
            }
        }
    }

    /** A spell or ability on the stack that has neither resolved nor been countered yet. */
    private static final class Pending {
        final JsonObject object;
        final StackObject item;
        boolean resolved;
        boolean countered;

        Pending(JsonObject object, StackObject item) {
            this.object = object;
            this.item = item;
        }
    }

    /** How a permanent left the battlefield, as XMage said before its move was told. */
    private record Leaving(String why, int zoneChanges) {}

    private final String gameId;
    private final Path file;
    private final List<JsonObject> events = new ArrayList<>();
    private List<UUID> seatIds = List.of();
    private ObjectRefs refs;
    private int epoch;
    private int lastTurn = -1;
    private String lastStep;
    private BufferedWriter writer;
    private boolean writeFailed;
    /** What is on the stack, by its id there, in the order it was put there. */
    private final Map<UUID, Pending> pending = new LinkedHashMap<>();
    /** Permanents XMage said were destroyed or sacrificed, until their zone change is told. */
    private final Map<UUID, Leaving> leaving = new HashMap<>();
    /** Each seat's public counts as an event last told them: told again only when they change. */
    private String lastTally;

    /**
     * @param folder the game's recording folder, or null for a game that keeps no recording
     */
    GameEvents(String gameId, Path folder) {
        this.gameId = gameId;
        this.file = folder == null ? null : folder.resolve(FILE);
    }

    /**
     * A game taken up again (v0.9.9): the events up to its checkpoint's are kept, and the rest are
     * made again as the journal is played, under the next epoch.
     */
    synchronized void takeUp(long keepThrough) {
        List<JsonObject> kept = new ArrayList<>();
        int highest = 0;
        for (JsonObject event : read(file)) {
            highest = Math.max(highest, event.get("epoch").getAsInt());
            if (event.get("seq").getAsLong() <= keepThrough) {
                kept.add(event);
            }
        }
        events.clear();
        events.addAll(kept);
        epoch = highest + 1;
        // The counts as the kept events last told them, so that the events made again carry them
        // where the first telling did.
        lastTally = null;
        for (JsonObject event : kept) {
            if (event.has("tally")) {
                lastTally = event.get("tally").toString();
            }
        }
        if (!kept.isEmpty()) {
            JsonObject last = kept.get(kept.size() - 1);
            lastTurn = last.get("turn").getAsInt();
            lastStep = last.has("step") && !last.get("step").isJsonNull() ? last.get("step").getAsString() : null;
        }
        if (file != null) {
            try {
                StringBuilder text = new StringBuilder();
                for (JsonObject event : kept) {
                    text.append(event).append('\n');
                }
                Files.writeString(file, text, StandardCharsets.UTF_8);
            } catch (IOException e) {
                writeFailed = true;
                System.err.println("Events of game " + gameId + " could not be rewritten: " + e);
            }
        }
    }

    /** The game's thread, before the game starts or goes on: the game's seats and ids, and the tap. */
    synchronized void attach(Game game, List<UUID> seatIds, ObjectRefs refs) {
        this.seatIds = List.copyOf(seatIds);
        this.refs = refs;
        // Watchers.add keeps a tap already there (a game restored from a checkpoint carries its own);
        // looking it up first logged an error with a stack trace at the start of every game.
        game.getState().addWatcher(new Tap(gameId));
        // A game taken up again has what its checkpoint had on the stack: followed from here, so
        // that what leaves it without resolving is told as it was the first time.
        pending.clear();
        leaving.clear();
        for (StackObject item : game.getStack()) {
            com.google.gson.JsonElement made = object(item instanceof Spell ? item.getId() : item.getSourceId(),
                game, null);
            if (made.isJsonObject()) {
                pending.put(item.getId(), new Pending(made.getAsJsonObject(), item));
            }
        }
        LIVE.put(gameId, this);
    }

    /** The game is over or gone: its log takes no more events. */
    synchronized void detach() {
        LIVE.remove(gameId, this);
        if (writer != null) {
            try {
                writer.close();
            } catch (IOException e) {
                // the lines written are flushed; nothing more to do
            }
            writer = null;
        }
    }

    /** The highest sequence number so far: a checkpoint keeps it. */
    synchronized long seq() {
        return events.isEmpty() ? 0 : events.get(events.size() - 1).get("seq").getAsLong();
    }

    synchronized int epoch() {
        return epoch;
    }

    /** The events after {@code since}, at most {@code limit}, oldest first. */
    synchronized List<JsonObject> since(long since, int limit) {
        List<JsonObject> found = new ArrayList<>();
        for (JsonObject event : events) {
            if (event.get("seq").getAsLong() > since) {
                found.add(event.deepCopy());
                if (found.size() >= limit) {
                    break;
                }
            }
        }
        return found;
    }

    /** A recording's events, as written: for a game no process runs any more (the front process reads them). */
    static List<JsonObject> read(Path file) {
        List<JsonObject> events = new ArrayList<>();
        if (file == null) {
            return events;
        }
        try {
            for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
                if (line.isBlank()) {
                    continue;
                }
                try {
                    events.add(JsonParser.parseString(line).getAsJsonObject());
                } catch (RuntimeException e) {
                    // A line cut short by a dead process: the ones before it stand.
                    break;
                }
            }
        } catch (NoSuchFileException e) {
            return events;
        } catch (IOException e) {
            System.err.println("Events could not be read from " + file + ": " + e);
        }
        return events;
    }

    /** The game's thread: one of XMage's events, made into the game's if it is one the schema keeps. */
    synchronized void on(GameEvent event, Game game, int commandCastsBefore) {
        try {
            settleStack(game);
            JsonObject made = make(event, game, commandCastsBefore);
            if (made == null) {
                return;
            }
            stepIfChanged(game);
            add(made, game);
        } catch (RuntimeException e) {
            // An event that cannot be described is left out; the game is not the events' to stop.
            System.err.println("Game " + gameId + ": event " + event.getType() + " left out: " + e);
        }
    }

    private void stepIfChanged(Game game) {
        int turn = game.getTurnNum();
        PhaseStep step = game.getTurnStepType();
        String name = step == null ? null : step.name().toLowerCase(Locale.ROOT);
        if (turn == lastTurn && java.util.Objects.equals(name, lastStep)) {
            return;
        }
        lastTurn = turn;
        lastStep = name;
        JsonObject marker = new JsonObject();
        marker.addProperty("type", "step");
        marker.add("active", seatOf(game.getActivePlayerId()));
        // The marker stands before the event that brought it: that event tells the counts, which
        // are already what it made them.
        add(marker, game, false);
    }

    private void add(JsonObject body, Game game) {
        add(body, game, true);
    }

    private void add(JsonObject body, Game game, boolean counts) {
        JsonObject event = new JsonObject();
        event.addProperty("v", VERSION);
        event.addProperty("seq", seq() + 1);
        event.addProperty("epoch", epoch);
        event.addProperty("turn", game.getTurnNum());
        PhaseStep step = game.getTurnStepType();
        event.addProperty("step", step == null ? null : step.name().toLowerCase(Locale.ROOT));
        body.entrySet().forEach(entry -> event.add(entry.getKey(), entry.getValue()));
        if (counts) {
            JsonArray tally = tally(game);
            String told = tally.toString();
            if (!told.equals(lastTally)) {
                event.add("tally", tally);
                lastTally = told;
            }
        }
        events.add(event);
        write(event);
    }

    /**
     * Each seat's public counts as the game stands while the event is made, in the seats' order:
     * life, cards in hand, cards in library, cards in graveyard, permanents controlled. All of it
     * is what any player may count at a table (402.3, 401.3), and it is how a replay knows them:
     * the opening hands and their mulligans are dealt before the game's first event, so no count
     * of the moves that are told would find a hand's size.
     */
    private JsonArray tally(Game game) {
        JsonArray seats = new JsonArray();
        for (UUID id : seatIds) {
            JsonArray counts = new JsonArray();
            mage.players.Player player = game.getPlayer(id);
            if (player == null) {
                for (int count = 0; count < 5; count++) {
                    counts.add(0);
                }
            } else {
                counts.add(player.getLife());
                counts.add(player.getHand().size());
                counts.add(player.getLibrary().size());
                counts.add(player.getGraveyard().size());
                counts.add(game.getBattlefield().getAllActivePermanents(id).size());
            }
            seats.add(counts);
        }
        return seats;
    }

    private void write(JsonObject event) {
        if (file == null || writeFailed) {
            return;
        }
        try {
            if (writer == null) {
                writer = Files.newBufferedWriter(file, StandardCharsets.UTF_8, StandardOpenOption.CREATE,
                    StandardOpenOption.APPEND);
            }
            writer.write(event.toString());
            writer.write('\n');
            writer.flush();
        } catch (IOException e) {
            // The events stay readable from this process; only the copy on disk stops.
            writeFailed = true;
            System.err.println("Events of game " + gameId + " are no longer written: " + e);
        }
    }

    /** XMage's event in the schema's words, or null for one the schema does not keep. */
    private JsonObject make(GameEvent event, Game game, int commandCastsBefore) {
        JsonObject made = new JsonObject();
        switch (event.getType()) {
            case ZONE_CHANGE -> {
                ZoneChangeEvent move = (ZoneChangeEvent) event;
                made.addProperty("type", "zone_change");
                made.addProperty("from", zone(move.getFromZone()));
                made.addProperty("to", zone(move.getToZone()));
                made.add("player", seatOf(ownerOf(move.getTargetId(), game, move.getPlayerId())));
                made.add("object", moved(move, game));
                UUID source = move.getSource() == null ? event.getSourceId() : move.getSource().getSourceId();
                cause(made, source, move.getTargetId(), game);
                if (move.getFromZone() == Zone.BATTLEFIELD) {
                    String why = whyItLeft(move, source == null || source.equals(move.getTargetId()), game);
                    if (why != null) {
                        made.addProperty("why", why);
                    }
                }
            }
            case DESTROYED_PERMANENT, SACRIFICED_PERMANENT -> {
                // Told before the move itself, which XMage keeps for the end of the action: remembered
                // for the zone change, by how often the permanent has changed zones, so that a later
                // departure of the same card is never taken for this one.
                if (event.getTargetId() != null) {
                    leaving.put(event.getTargetId(), new Leaving(
                        event.getType() == GameEvent.EventType.DESTROYED_PERMANENT ? "destroyed" : "sacrificed",
                        game.getState().getZoneChangeCounter(event.getTargetId())));
                }
                return null;
            }
            case SPELL_CAST -> {
                made.addProperty("type", "cast");
                made.add("player", seatOf(event.getPlayerId()));
                JsonObject cast = object(event.getTargetId(), game, null).getAsJsonObject();
                made.add("object", cast);
                Spell spell = game.getStack().getSpell(event.getTargetId());
                if (spell != null) {
                    cost(made, cast, spell, commandCastsBefore, game);
                    pending.put(spell.getId(), new Pending(cast.deepCopy(), spell));
                }
            }
            case ACTIVATED_ABILITY -> {
                made.addProperty("type", "activate");
                made.add("player", seatOf(event.getPlayerId()));
                made.add("object", object(event.getSourceId(), game, null));
                onStack(event.getTargetId(), made, game);
            }
            case TRIGGERED_ABILITY -> {
                made.addProperty("type", "trigger");
                made.add("player", seatOf(event.getPlayerId()));
                made.add("object", object(event.getSourceId(), game, null));
                onStack(event.getTargetId(), made, game);
            }
            case TARGETED -> {
                made.addProperty("type", "target");
                made.add("player", seatOf(event.getPlayerId()));
                made.add("target", objectOrSeat(event.getTargetId(), game));
                cause(made, event.getSourceId(), null, game);
            }
            case RESOLVING_ABILITY -> {
                made.addProperty("type", "resolve");
                made.add("player", seatOf(event.getPlayerId()));
                made.add("object", object(event.getSourceId(), game, null));
                if (!resolvingFromTheStack(event, game)) {
                    // Never on the stack: a mana ability, a special action (605.3b, 116).
                    made.addProperty("immediate", true);
                }
            }
            case COUNTERED -> {
                made.addProperty("type", "countered");
                made.add("object", object(event.getTargetId(), game, null));
                cause(made, event.getSourceId(), event.getTargetId(), game);
                Pending countered = pending.get(event.getTargetId());
                if (countered != null) {
                    countered.countered = true;
                }
            }
            case ATTACKER_DECLARED -> {
                made.addProperty("type", "attack");
                made.add("player", seatOf(event.getPlayerId()));
                made.add("object", object(event.getSourceId(), game, null));
                made.add("target", objectOrSeat(event.getTargetId(), game));
            }
            case BLOCKER_DECLARED -> {
                made.addProperty("type", "block");
                made.add("player", seatOf(event.getPlayerId()));
                made.add("object", object(event.getSourceId(), game, null));
                made.add("target", object(event.getTargetId(), game, null));
            }
            case DAMAGED_PLAYER, DAMAGED_PERMANENT -> {
                made.addProperty("type", "damage");
                made.add("target", objectOrSeat(event.getTargetId(), game));
                made.addProperty("amount", event.getAmount());
                if (event instanceof DamagedEvent damaged) {
                    made.addProperty("combat", damaged.isCombatDamage());
                }
                cause(made, event.getSourceId(), event.getTargetId(), game);
            }
            case GAINED_LIFE, LOST_LIFE -> {
                made.addProperty("type", event.getType() == GameEvent.EventType.GAINED_LIFE ? "life_gained" : "life_lost");
                made.add("player", seatOf(event.getPlayerId() != null ? event.getPlayerId() : event.getTargetId()));
                made.addProperty("amount", event.getAmount());
                cause(made, event.getSourceId(), null, game);
            }
            case COUNTERS_ADDED, COUNTERS_REMOVED -> {
                made.addProperty("type", event.getType() == GameEvent.EventType.COUNTERS_ADDED
                    ? "counters_added" : "counters_removed");
                made.add("target", objectOrSeat(event.getTargetId(), game));
                made.addProperty("counter", event.getData());
                made.addProperty("amount", event.getAmount());
                cause(made, event.getSourceId(), event.getTargetId(), game);
            }
            case CREATED_TOKEN -> {
                made.addProperty("type", "token_created");
                made.add("player", seatOf(event.getPlayerId()));
                made.add("object", object(event.getTargetId(), game, null));
                cause(made, event.getSourceId(), event.getTargetId(), game);
            }
            case LOST -> {
                made.addProperty("type", "eliminated");
                made.add("player", seatOf(event.getPlayerId()));
            }
            case WINS -> {
                made.addProperty("type", "won");
                made.add("player", seatOf(event.getPlayerId()));
            }
            default -> {
                return null;
            }
        }
        return made;
    }

    /** An ability put onto the stack is followed until it leaves it. */
    private void onStack(UUID abilityId, JsonObject made, Game game) {
        StackObject item = abilityId == null ? null : game.getStack().getStackObject(abilityId);
        if (item != null && made.get("object").isJsonObject()) {
            pending.put(item.getId(), new Pending(made.getAsJsonObject("object").deepCopy(), item));
        }
    }

    /** Whether the ability XMage says is resolving is the stack's top: marks it resolved if so. */
    private boolean resolvingFromTheStack(GameEvent event, Game game) {
        StackObject top = game.getStack().getFirstOrNull();
        if (top == null) {
            return false;
        }
        Ability ability = top.getStackAbility();
        boolean same = ability != null && ability.getOriginalId() != null
            && ability.getOriginalId().equals(event.getTargetId());
        // A spell's further abilities (a spliced card's, a fused half's) resolve as the spell does.
        if (!same && !(top instanceof Spell && top.getSourceId() != null
                && top.getSourceId().equals(event.getSourceId()))) {
            return false;
        }
        Pending found = pending.get(top.getId());
        if (found != null) {
            found.resolved = true;
        }
        return true;
    }

    /**
     * What left the stack since the last event without resolving or being countered: a spell XMage
     * marked as countered by the rules (608.2b: every target illegal), an ability whose targets are
     * no longer legal, a triggered ability whose condition no longer holds (603.4). Anything else
     * that left it says nothing: a permanent spell that became a permanent, an optional ability its
     * player declined.
     */
    private void settleStack(Game game) {
        if (pending.isEmpty()) {
            return;
        }
        List<JsonObject> fizzled = new ArrayList<>();
        for (Iterator<Map.Entry<UUID, Pending>> entries = pending.entrySet().iterator(); entries.hasNext();) {
            Map.Entry<UUID, Pending> entry = entries.next();
            if (game.getStack().getStackObject(entry.getKey()) != null) {
                continue;
            }
            entries.remove();
            Pending gone = entry.getValue();
            if (gone.resolved || gone.countered) {
                continue;
            }
            String why = null;
            try {
                if (gone.item instanceof Spell held) {
                    MageObject last = game.getLastKnownInformation(entry.getKey(), Zone.STACK);
                    if (held.isCountered() || (last instanceof Spell spell && spell.isCountered())) {
                        why = "targets";
                    }
                } else if (gone.item instanceof StackAbility) {
                    Ability ability = gone.item.getStackAbility();
                    if (ability instanceof TriggeredAbility trigger && !trigger.checkInterveningIfClause(game)) {
                        why = "condition";
                    } else if (ability != null && !ability.getTargets().isEmpty()
                            && !ability.getTargets().stillLegal(ability, game)) {
                        why = "targets";
                    }
                }
            } catch (RuntimeException e) {
                // What cannot be judged any more is not claimed.
                why = null;
            }
            if (why != null) {
                JsonObject made = new JsonObject();
                made.addProperty("type", "fizzled");
                made.addProperty("of", gone.item instanceof Spell ? "spell" : "ability");
                made.add("player", seatOf(gone.item.getControllerId()));
                made.add("object", gone.object);
                made.addProperty("why", why);
                fizzled.add(made);
            }
        }
        for (JsonObject made : fizzled) {
            stepIfChanged(game);
            add(made, game);
        }
    }

    /**
     * Why a permanent left the battlefield, where the game is sure: XMage said it was destroyed or
     * sacrificed; destroyed by no source it had lethal damage (704.5g) or damage from deathtouch
     * (704.5h); put into the graveyard by no source it had a toughness of 0 or less (704.5f), no
     * loyalty (704.5i), a legendary namesake under the same control (704.5j), or was an Aura left
     * without what it enchanted (704.5m). Null where none of these is so.
     */
    private String whyItLeft(ZoneChangeEvent move, boolean byNoSource, Game game) {
        UUID id = move.getTargetId();
        Leaving told = leaving.remove(id);
        String why = told != null && told.zoneChanges() == game.getState().getZoneChangeCounter(id)
            ? told.why() : null;
        Permanent last = move.getTarget();
        if (last == null && game.getLastKnownInformation(id, Zone.BATTLEFIELD) instanceof Permanent known) {
            last = known;
        }
        if (last == null || !byNoSource) {
            return why;
        }
        if ("destroyed".equals(why)) {
            if (last.isCreature(game)) {
                if (last.isDeathtouched()) {
                    return "deathtouch";
                }
                if (last.getDamage() > 0 && last.getDamage() >= last.getToughness().getValue()) {
                    return "lethal_damage";
                }
            }
            return why;
        }
        if (why != null || move.getToZone() != Zone.GRAVEYARD) {
            return why;
        }
        if (last.isCreature(game) && last.getToughness().getValue() <= 0) {
            return "toughness";
        }
        if (last.isPlaneswalker(game) && last.getCounters(game).getCount(CounterType.LOYALTY) <= 0) {
            return "loyalty";
        }
        if (last.isLegendary(game)) {
            for (Permanent other : game.getBattlefield().getAllActivePermanents(last.getControllerId())) {
                if (!other.getId().equals(id) && other.isLegendary(game) && other.getName().equals(last.getName())) {
                    return "legend_rule";
                }
            }
        }
        if (last.hasSubtype(SubType.AURA, game)) {
            return "unattached";
        }
        return null;
    }

    private static final Pattern SYMBOL = Pattern.compile("\\{([^}]+)\\}");

    /** A mana cost in one line, its generic part first and summed: "{3}{R}"; "{0}" for nothing. */
    static String costText(Iterable<? extends ManaCost> costs) {
        int generic = 0;
        StringBuilder rest = new StringBuilder();
        for (ManaCost cost : costs) {
            if (cost instanceof VariableCost) {
                // X is in the cost as the mana it came to.
                continue;
            }
            Matcher symbols = SYMBOL.matcher(cost.getText());
            while (symbols.find()) {
                String symbol = symbols.group(1);
                if (symbol.chars().allMatch(Character::isDigit)) {
                    generic += Integer.parseInt(symbol);
                } else {
                    rest.append('{').append(symbol).append('}');
                }
            }
        }
        if (generic == 0 && rest.length() == 0) {
            return "{0}";
        }
        return (generic > 0 ? "{" + generic + "}" : "") + rest;
    }

    /**
     * What the spell cost (v1.0.0): the mana its player had to pay ({@code paid}), which every seat
     * sees paid, and the card's printed cost on the object itself, hidden with it. For a spell every
     * seat may see, also the X chosen, the way it was cast if not the usual one, and what changed its
     * cost: commander tax by its amount (903.8), and each cost-changing effect that applies to it by
     * its source. A spell cast face down says only what was paid: what applies to the card beneath
     * would tell what it is.
     */
    private void cost(JsonObject made, JsonObject cast, Spell spell, int commandCastsBefore, Game game) {
        SpellAbility ability = spell.getSpellAbility();
        if (ability == null) {
            return;
        }
        JsonObject cost = new JsonObject();
        String paid = costText(ability.getManaCostsToPay());
        cost.addProperty("paid", paid);
        made.add("cost", cost);
        String printed = spell.getCard() == null ? null : spell.getCard().getManaCost().getText();
        if (printed != null && !printed.isEmpty()) {
            cast.addProperty("mana_cost", printed);
        }
        if (!cast.has("seen_by") || !cast.get("seen_by").isJsonPrimitive()) {
            return;
        }
        if (printed != null && printed.contains("{X}")) {
            cost.addProperty("x", CardUtil.getSourceCostsTagX(game, ability, 0));
        }
        SpellAbilityCastMode mode = ability.getSpellAbilityCastMode();
        if (mode != null && mode != SpellAbilityCastMode.NORMAL) {
            cost.addProperty("mode", mode.name().toLowerCase(Locale.ROOT));
        }
        JsonArray changes = new JsonArray();
        if (commandCastsBefore > 0) {
            JsonObject tax = new JsonObject();
            tax.addProperty("how", "more");
            tax.addProperty("tax", true);
            tax.addProperty("amount", 2 * commandCastsBefore);
            changes.add(tax);
        }
        Set<String> named = new LinkedHashSet<>();
        for (ContinuousEffectsList<?> list : game.getContinuousEffects().allEffectsLists) {
            for (Object found : list) {
                if (!(found instanceof CostModificationEffect effect) || effect instanceof CommanderCostModification) {
                    continue;
                }
                for (Ability source : list.getAbility(effect.getId())) {
                    try {
                        if (effect.isInactive(source, game) || !source.isInUseableZone(game, null, null)
                                || !effect.applies(ability, source, game)) {
                            continue;
                        }
                    } catch (RuntimeException e) {
                        // An effect that cannot judge the spell after its cast names nothing.
                        continue;
                    }
                    String how = effect.getModificationType() == CostModificationType.INCREASE_COST ? "more"
                        : effect.getModificationType() == CostModificationType.REDUCE_COST ? "less" : "set";
                    if (source.getSourceId() == null || !named.add(how + source.getSourceId())) {
                        continue;
                    }
                    JsonObject change = new JsonObject();
                    change.addProperty("how", how);
                    change.add("by", object(source.getSourceId(), game, null));
                    changes.add(change);
                }
            }
        }
        if (!changes.isEmpty()) {
            cost.add("changes", changes);
        }
    }

    /** A seat's number, or null for no seat. */
    private com.google.gson.JsonElement seatOf(UUID playerId) {
        int seat = playerId == null ? -1 : seatIds.indexOf(playerId);
        return seat < 0 ? com.google.gson.JsonNull.INSTANCE : new com.google.gson.JsonPrimitive(seat);
    }

    private static UUID ownerOf(UUID objectId, Game game, UUID fallback) {
        UUID owner = game.getOwnerId(objectId);
        return owner != null ? owner : fallback;
    }

    /** A player as {@code {"seat": n}}, or an object with who may see it. */
    private com.google.gson.JsonElement objectOrSeat(UUID id, Game game) {
        if (id != null && game.getPlayer(id) != null) {
            JsonObject seat = new JsonObject();
            seat.add("seat", seatOf(id));
            return seat;
        }
        return object(id, game, null);
    }

    /**
     * An object: the id the seat views know it by, its name, its owner's seat, and who may see the
     * two; {@code before}, for a zone change, adds the seats that saw it where it was.
     */
    private com.google.gson.JsonElement object(UUID id, Game game, Set<Integer> before) {
        if (id == null) {
            return com.google.gson.JsonNull.INSTANCE;
        }
        MageObject object = game.getObject(id);
        if (object == null) {
            object = game.getLastKnownInformation(id, Zone.BATTLEFIELD);
        }
        JsonObject made = new JsonObject();
        int zcc = object == null ? 0 : object.getZoneChangeCounter(game);
        made.addProperty("ref", refs.ref(id, zcc));
        made.addProperty("name", object == null ? null : object.getName());
        made.add("owner", seatOf(game.getOwnerId(id)));
        Set<Integer> seen = new LinkedHashSet<>();
        for (int seat = 0; seat < seatIds.size(); seat++) {
            if (object != null && game.getState().getZone(id) == null && game.getStack().getStackObject(id) == null
                    && game.getPermanent(id) == null) {
                // Gone (a token that left the battlefield, a copy): what everyone saw of it stands.
                seen.add(seat);
            } else if (Visibility.identityVisible(game, id, seatIds.get(seat))) {
                seen.add(seat);
            }
        }
        if (before != null) {
            seen.addAll(before);
        }
        made.add("seen_by", seenBy(seen));
        return made;
    }

    /** A zone change's object: as it is now, with its id before it moved, seen by whoever saw it there or sees it here. */
    private JsonObject moved(ZoneChangeEvent move, Game game) {
        UUID id = move.getTargetId();
        Set<Integer> before = seenIn(move.getFromZone(), id, game);
        JsonObject made = object(id, game, before).getAsJsonObject();
        MageObject object = game.getObject(id);
        if (object != null) {
            int zcc = object.getZoneChangeCounter(game);
            if (zcc > 0) {
                made.addProperty("was", refs.ref(id, zcc - 1));
            }
        }
        return made;
    }

    /** The seats that could see a card in the zone it left: public zones every seat, a hand its owner's side. */
    private Set<Integer> seenIn(Zone zone, UUID id, Game game) {
        Set<Integer> seen = new LinkedHashSet<>();
        if (zone == null) {
            return seen;
        }
        for (int seat = 0; seat < seatIds.size(); seat++) {
            UUID viewer = seatIds.get(seat);
            boolean visible = switch (zone) {
                case BATTLEFIELD, GRAVEYARD, STACK, COMMAND -> true;
                // Face down in exile it stays hidden; face up, it was there for everyone.
                case EXILED -> !Visibility.faceDown(game, id) || Visibility.mayLookAtFaceDown(game, id, viewer);
                case HAND -> Visibility.handVisible(game, game.getOwnerId(id), viewer);
                default -> false;
            };
            if (visible) {
                seen.add(seat);
            }
        }
        return seen;
    }

    private com.google.gson.JsonElement seenBy(Set<Integer> seen) {
        if (seen.size() == seatIds.size()) {
            return new com.google.gson.JsonPrimitive("all");
        }
        JsonArray seats = new JsonArray();
        seen.stream().sorted().forEach(seats::add);
        return seats;
    }

    /**
     * The event's cause, where XMage names one: the object whose ability did it (a spell, a
     * permanent, a card in a graveyard), or a seat. Left out when XMage names none, and when the
     * cause is the event's own object.
     */
    private void cause(JsonObject made, UUID sourceId, UUID self, Game game) {
        if (sourceId == null || sourceId.equals(self)) {
            return;
        }
        if (game.getPlayer(sourceId) != null) {
            JsonObject seat = new JsonObject();
            seat.add("seat", seatOf(sourceId));
            made.add("cause", seat);
            return;
        }
        made.add("cause", object(sourceId, game, null));
    }

    private static String zone(Zone zone) {
        return zone == null ? null : zone.name().toLowerCase(Locale.ROOT);
    }
}
