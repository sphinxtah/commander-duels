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
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import mage.MageObject;
import mage.constants.PhaseStep;
import mage.constants.WatcherScope;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.events.DamagedEvent;
import mage.game.events.GameEvent;
import mage.game.events.ZoneChangeEvent;
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
 */
final class GameEvents {
    static final int VERSION = 1;
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
        private static final long serialVersionUID = 1L;
        private String gameId;

        Tap(String gameId) {
            super(WatcherScope.GAME);
            this.gameId = gameId;
        }

        @Override
        public void watch(GameEvent event, Game game) {
            if (gameId == null || game.isSimulation()) {
                return;
            }
            GameEvents events = LIVE.get(gameId);
            if (events != null) {
                events.on(event, game);
            }
        }
    }

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
        boolean tapped = game.getState().getWatcher(Tap.class) != null;
        if (!tapped) {
            game.getState().addWatcher(new Tap(gameId));
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
    synchronized void on(GameEvent event, Game game) {
        try {
            JsonObject made = make(event, game);
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
        add(marker, game);
    }

    private void add(JsonObject body, Game game) {
        JsonObject event = new JsonObject();
        event.addProperty("v", VERSION);
        event.addProperty("seq", seq() + 1);
        event.addProperty("epoch", epoch);
        event.addProperty("turn", game.getTurnNum());
        PhaseStep step = game.getTurnStepType();
        event.addProperty("step", step == null ? null : step.name().toLowerCase(Locale.ROOT));
        body.entrySet().forEach(entry -> event.add(entry.getKey(), entry.getValue()));
        events.add(event);
        write(event);
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
    private JsonObject make(GameEvent event, Game game) {
        JsonObject made = new JsonObject();
        switch (event.getType()) {
            case ZONE_CHANGE -> {
                ZoneChangeEvent move = (ZoneChangeEvent) event;
                made.addProperty("type", "zone_change");
                made.addProperty("from", zone(move.getFromZone()));
                made.addProperty("to", zone(move.getToZone()));
                made.add("player", seatOf(ownerOf(move.getTargetId(), game, move.getPlayerId())));
                made.add("object", moved(move, game));
                cause(made, move.getSource() == null ? event.getSourceId() : move.getSource().getSourceId(),
                    move.getTargetId(), game);
            }
            case SPELL_CAST -> {
                made.addProperty("type", "cast");
                made.add("player", seatOf(event.getPlayerId()));
                made.add("object", object(event.getTargetId(), game, null));
            }
            case ACTIVATED_ABILITY -> {
                made.addProperty("type", "activate");
                made.add("player", seatOf(event.getPlayerId()));
                made.add("object", object(event.getSourceId(), game, null));
            }
            case TRIGGERED_ABILITY -> {
                made.addProperty("type", "trigger");
                made.add("player", seatOf(event.getPlayerId()));
                made.add("object", object(event.getSourceId(), game, null));
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
            }
            case COUNTERED -> {
                made.addProperty("type", "countered");
                made.add("object", object(event.getTargetId(), game, null));
                cause(made, event.getSourceId(), event.getTargetId(), game);
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
