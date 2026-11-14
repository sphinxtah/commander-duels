package com.commanderduels;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.ToNumberPolicy;
import com.google.gson.reflect.TypeToken;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import mage.cards.decks.Deck;
import mage.constants.PhaseStep;
import mage.constants.RangeOfInfluence;
import mage.game.Game;
import mage.game.events.PlayerQueryEvent;
import mage.game.events.TableEvent;
import mage.game.match.Match;
import mage.player.human.HumanPlayer;
import mage.players.Player;
import mage.players.net.UserData;
import mage.util.RandomUtil;
import mage.util.ThreadUtils;

/**
 * One development game: two to four seats in turn order, each XMage's own {@link HumanPlayer} or a
 * {@link FairBot} (XMage's "Computer - mad" AI with only its seat's information), with fixture decks
 * under Legacy or Commander rules.
 *
 * <p>XMage's human player blocks the game thread until it gets an answer, and XMage asks one player
 * at a time, so at most one prompt is open per game. Each request it fires (a
 * {@link PlayerQueryEvent}) becomes a typed prompt with a new id, published to that seat together
 * with its view at a new revision. Every human seat has its own revision, prompt and view: a seat's
 * revision moves only when what that seat sees changes, so it says nothing about other seats'
 * choices. A seat's log stops at the entries that existed when its view was built, so it does not
 * run ahead of the board. An answer is accepted only for the seat's open prompt at its current
 * revision. Views and prompts are built on the game thread, the only place XMage's state is
 * consistent; request threads read the published snapshots.
 *
 * <p>Recording and recovery (v0.9.9). A game given a {@link Recorder} keeps a recording of itself
 * ({@link Recording}): every answer and command a seat sends is journalled, on disk, before it is
 * acted on, and at each point XMage can later go on from (a player about to receive priority, every
 * player having passed; patch 0018) the game's state is taken as a checkpoint ({@link Checkpoint}).
 * A game whose process is gone is taken up again from its recording ({@link #restore}): from the
 * newest checkpoint, at the point it was taken at, with the journal's later records played again
 * as the game asks for them ({@link #replayNext}). A seat sees its game as it was: the same objects
 * under the same ids, its log, its revisions going on from where they were, the prompt that was
 * open. A bot's search is cut off by the clock and may find something else the second time, so no
 * search is ever run again to get back to a question a seat was asked: the checkpoint a seat's
 * question stands on is taken after the last decision at priority before it. Where the game after
 * an older checkpoint (the newest was unreadable) does not ask what the journal answered, the rest
 * of the journal is dropped and the game goes on, legally, from there: nothing is ever applied to a
 * question it was not the answer to. Before its first checkpoint (the mulligans) a game is taken up from its
 * request and its seed, which deal the same hands. A game with no recorder is played as before
 * v0.9.9 and lives in memory only.
 *
 * <p>A service game can also be inspected ({@link #inspect}): every hand and library, in order,
 * for SysOp. That view is built only while XMage is waiting for a human seat's answer, when the
 * game thread is parked and XMage's state holds still. Since v0.8.6 (bug E4) "waiting" means the
 * game thread is inside XMage's wait itself, as the seat's player reports it
 * ({@link HumanSeatPlayer.Listening}), not merely that a prompt has been published: XMage publishes
 * a request before it waits for the answer.
 *
 * <p>Passive bots (v0.8.6): one switch per game ({@link #setPassiveBots}) makes every bot at the
 * table pass every priority, keep its opening hand, attack and block with nothing and decline every
 * optional choice, for SysOp's tests of campaign and card mechanics ({@link FairBot}). It can be
 * turned on and off at any time; each change writes a line in the game's log.
 *
 * <p>Turn control (723, v0.5.1): while a player's turn is controlled by a human seat, XMage's
 * requests for that player (for a bot, through the stand-in its controller makes for it, see
 * {@link HumanSeatPlayer}) open a prompt on the controlling seat, marked with the controlled
 * player's seat and built from what that player may see, and its answer goes to that player. The
 * controlling seat's view shows what the controlled player may see while the control lasts
 * ({@link Visibility}). The controlled player still concedes for themselves (723.6). Control ends
 * when its controller leaves the game (800.4a); a request already open then goes to the
 * controlled player's own seat, or a bot's gets the answer that does the least. Since v0.6.1 a bot
 * may control a turn too (patch 0008): XMage's AI then decides for the controlled player, and
 * nobody is asked.
 */
final class HumanGame {
    static final long CLOSE_GRACE_MILLIS = 5_000;
    private static final int MAX_MESSAGES = 10;
    private static final int DEFAULT_LOG_PAGE = 20;
    static final int MAX_LOG_PAGE = 200;
    private static final int MAX_RECORDED_ACTIONS = 512;
    private static final String ENGINE_ERROR_PREFIX = "ENGINE ERROR:";
    /** The log's line when the passive bot switch changes (v0.8.6). */
    static final String BOTS_PASSIVE = "Bots set to passive.";
    static final String BOTS_NORMAL = "Bots set to normal.";
    /**
     * How often an inspection looks again while XMage has said it will wait but its game thread has
     * not yet parked (v0.8.6): a few lines of XMage's code, so a short poll.
     */
    private static final long PARK_POLL_MILLIS = 2;
    /**
     * How far apart the revisions of two recoveries start (v0.9.9): more than a game shows a seat
     * between a checkpoint and an interruption, and small enough that a browser counts them exactly.
     */
    static final long RECOVERY_STRIDE = 1_000_000;
    /**
     * Whether an answer's journal record lists every choice its question had
     * ({@code CD_ENGINE_JOURNAL_CHOICES=1}): for finding out why a game taken up again asked something
     * else. Off by default: a priority question has dozens of choices, and every record is forced
     * to disk.
     */
    static final boolean JOURNAL_CHOICES = "1".equals(System.getenv("CD_ENGINE_JOURNAL_CHOICES"))
        || Boolean.getBoolean("cd.engine.journalChoices");
    /** The journal's record types that are played again (v0.9.9); its other records are notes. */
    private static final Set<String> REPLAYED = Set.of("answer", "concede", "priority", "bots");
    /** Reads a journalled reply back as the map it was, whole numbers as whole numbers. */
    private static final Gson REPLIES = new GsonBuilder().setObjectToNumberStrategy(ToNumberPolicy.LONG_OR_DOUBLE)
        .create();

    /** A seat at the table. A seat's snapshot names only its own deck. */
    record SeatSettings(int seat, String player, String deck) {}

    /** A King's Table game's settings (v0.8.7), as the request named them. */
    record KingsTableSettings(String deckFormat, String life, boolean kingAttacksAnyone, boolean guardedKings) {
        static KingsTableSettings of(KingsTableRules rules) {
            return rules == null ? null : new KingsTableSettings(rules.deckFormat(), rules.life(),
                rules.kingAttacksAnyone(), rules.guardedKings());
        }
    }

    record Settings(String format, String rulesProfile, List<SeatSettings> seats, int skill, int turnCap,
                    int idleTimeoutSeconds, int spectatorDelaySeconds, KingsTableSettings kingsTable) {
        /** What one seat is told (other seats' decks are private); a spectator, seat -1, sees no deck. */
        Settings forSeat(int seat) {
            return new Settings(format, rulesProfile, seats.stream()
                .map(entry -> entry.seat() == seat ? entry : new SeatSettings(entry.seat(), entry.player(), null))
                .toList(), skill, turnCap, idleTimeoutSeconds, spectatorDelaySeconds, kingsTable);
        }
    }

    /**
     * @param kind          completed (a winner or a draw), turn_limit, closed, idle_timeout,
     *                      humans_eliminated (every human seat lost while bots remained) or error
     * @param winnerSeat    the winning seat; in a team game the winning team's first seat
     * @param winnerSeats   every winning seat (since v0.5.0): the winner, or in a team game the
     *                      winning team; empty without a winner
     * @param concededSeats the seats that conceded, in the order they did
     */
    record Result(String kind, Integer winnerSeat, List<Integer> winnerSeats, boolean draw,
                  List<Integer> concededSeats, int turns, String error) {
        Result {
            winnerSeats = List.copyOf(winnerSeats);
        }

        /** A result without a winner. */
        Result(String kind, List<Integer> concededSeats, int turns, String error) {
            this(kind, null, List.of(), false, concededSeats, turns, error);
        }
    }

    record LogLine(int index, int turn, Integer activeSeat, String step, String text) {}

    /**
     * What one seat, or a spectator, is shown. {@code status} is starting, your_prompt,
     * unsupported_prompt, waiting (another player is acting or XMage is processing), eliminated (this
     * seat has lost; the game goes on), spectating (for a spectator, while the game runs) or finished.
     * A spectator's snapshot has no seat and no prompt.
     */
    record Snapshot(String gameId, long revision, String status, Integer seat, Settings settings, PromptView prompt,
                    SeatView view, Result result, int logCount, int logFrom, List<LogLine> log) {}

    /** One public view kept for spectators, with when it was published and the log up to then. */
    private record Watched(long revision, long publishedNanos, SeatView view, int logEntries, Result result) {}

    /** One player's concealed zones, for inspection: the hand, and the library from the top. */
    record Concealed(int seat, String name, List<SeatView.CardInfo> hand, List<SeatView.CardInfo> library) {}

    /**
     * SysOp's inspection view (an exception to SEC05 and NET14, for SysOp only): the public view
     * plus every player's hand and library in order, and every seat's deck. It is its own type, built
     * field by field like the seat views, and served only on the service route. {@code version}
     * counts the game's published changes; {@code status} is live or finished.
     */
    record Inspection(String gameId, long version, String status, Settings settings, SeatView view,
                      List<Concealed> players, Result result) {}

    /** A response to a seat command: an HTTP status and its JSON body. */
    record Reply(int status, Map<String, Object> body) {}

    private record Recorded(String fingerprint, Reply reply) {}

    /** Test hooks, called on the game thread while XMage's state is consistent (except {@link #bot}). */
    interface Hooks {
        Hooks NONE = new Hooks() {};

        /**
         * The player for a bot seat, made when the game is created: the fair bot, with a random
         * source seeded from the game's seed and the seat. Tests may substitute XMage's own bot.
         */
        default Player bot(int seat, String name, RangeOfInfluence range, int skill, long seed) {
            return new FairBot(name, range, skill, FairBot.seedFor(seed, seat));
        }

        default void beforeStart(Game game, List<UUID> seatIds) {}

        /** A game taken up from a checkpoint (v0.9.9) is about to go on, in place of {@link #beforeStart}. */
        default void resumed(Game game, List<UUID> seatIds) {}

        /** Every view (and prompt, if one opens) published to a human seat. */
        default void published(Game game, ObjectRefs refs, int seat, SeatView view, PromptView prompt) {}

        /** Every public view published for spectators, when it is published (before any delay). */
        default void spectated(Game game, ObjectRefs refs, SeatView view) {}

        /**
         * A prompt has just opened for a seat (v0.8.6), at the end of the engine's listener: XMage
         * has yet to return to its own code and wait for the answer.
         */
        default void prompted(int seat) {}

        /** Building the final views failed; the seats keep their last published ones. */
        default void failed(RuntimeException error) {}
    }

    /**
     * A human seat: XMage's HumanPlayer and what this seat has been shown. XMage replaces player
     * objects with copies when it restores a saved state (a cancelled cast, for instance); the copies
     * share the answer channel but not the flag that says XMage is listening, so answers always go to
     * the game's current object, as XMage's own server sends them.
     */
    private static final class Seat {
        final int index;
        final UUID id;
        final HumanPlayer player;
        // Game thread only.
        final Deque<String> messages = new ArrayDeque<>();
        // Guarded by the game's lock.
        long revision;
        String status = "starting";
        Prompts.Prompt prompt;
        /**
         * Whose request the open prompt answers: this seat's, or (v0.5.1) that of the seat whose
         * turn this seat controls. XMage waits for that player's answer.
         */
        int promptFor;
        SeatView view;
        /** The log entries that existed when {@code view} was built: the seat's log stops there. */
        int logEntries;
        String lastAttacker;
        boolean concedeRequested;
        final Map<String, Recorded> actions = new LinkedHashMap<>() {
            private static final long serialVersionUID = 1L;

            @Override
            protected boolean removeEldestEntry(Map.Entry<String, Recorded> eldest) {
                return size() > MAX_RECORDED_ACTIONS;
            }
        };

        Seat(int index, HumanPlayer player) {
            this.index = index;
            this.id = player.getId();
            this.player = player;
            this.promptFor = index;
        }
    }

    private final String id;
    private final HumanGameRequest request;
    private final Settings settings;
    private final Path deckDirectory;
    private final Consumer<HumanGame> onFinished;
    private final Hooks hooks;
    private final List<Player> players;
    private final List<UUID> seatIds;
    /** By seat; null for a bot seat. */
    private final List<Seat> seats;
    private final List<Seat> humans;
    private final ObjectRefs refs;
    private final MatchLog log;
    private final Thread thread;
    /** The game's recording (v0.9.9); null for a game that keeps none. */
    private final Recorder recorder;
    /** The game's structured events (v0.9.10, {@link GameEvents}). */
    private final GameEvents events;
    /** The checkpoint this game goes on from (v0.9.9); null for a game played from its start. */
    private final Checkpoint restored;
    /** The checkpoint's number in the recording, for the recording's own notes; 0 without one. */
    private final int restoredSeq;
    /** Whether the game was taken up again from a recording (v0.9.9), with a checkpoint or without. */
    private final boolean takenUp;
    /** An event fired off the game thread asked for a refresh the game thread has not yet made. */
    private volatile boolean missedRefresh;
    /**
     * The game's switch for passive bots (v0.8.6), followed by every {@link FairBot} at the table and
     * every copy and stand-in XMage makes of one. Changed under this game's lock, so the log's lines
     * follow the changes in order.
     */
    private final AtomicBoolean passiveBots = new AtomicBoolean();

    // Game thread only.
    private SeatViews views;
    /** The answers the engine gives on a seat's standing instruction (v0.9.12): batches and yields. */
    private final Automation automation = new Automation();

    private volatile Game game;

    // Guarded by this.
    private Result result;
    private boolean inspectable;
    private Inspection finalInspection;
    private long version;
    private String endRequest;
    /**
     * The player XMage's game thread is waiting on, inside its wait for an answer (v0.8.6): a human
     * seat's player, or a stand-in with the identity of the bot whose turn a seat controls. Null
     * while the thread runs. Set and cleared by the game thread ({@link #waiting}); cleared too,
     * before the engine itself wakes the waiting thread for anything but an answer to an open prompt.
     */
    private UUID listening;
    private final List<Integer> conceded = new ArrayList<>();
    private long lastActivityNanos = System.nanoTime();
    // Spectators: public views, kept long enough to serve them spectatorDelaySeconds late.
    private final Deque<Watched> watched = new ArrayDeque<>();
    private SeatView spectatorView;
    private long spectatorRevision;
    /**
     * Recovery (v0.9.9): the journal's records after the checkpoint, still to be played again, in
     * order; and whether any are. While they are, no seat is shown a prompt or may answer one: the
     * journal answers.
     */
    private final Deque<JsonObject> replay = new ArrayDeque<>();
    private boolean replaying;
    private int replayed;
    private int replayDropped;
    private long replayedSeq;
    /** Set by {@link #interrupt}: the recording was left as it stood, and takes no result. */
    private boolean interrupted;

    HumanGame(String id, HumanGameRequest request, Path deckDirectory, Consumer<HumanGame> onFinished) {
        this(id, request, deckDirectory, onFinished, Hooks.NONE);
    }

    HumanGame(String id, HumanGameRequest request, Path deckDirectory, Consumer<HumanGame> onFinished,
              Hooks hooks) {
        this(id, request, deckDirectory, onFinished, hooks, null);
    }

    /** A game that keeps a recording of itself (v0.9.9). */
    HumanGame(String id, HumanGameRequest request, Path deckDirectory, Consumer<HumanGame> onFinished,
              Hooks hooks, Recorder recorder) {
        this(id, request, deckDirectory, onFinished, hooks, recorder, false, null, 0, List.of());
    }

    /**
     * A game taken up again from its recording (v0.9.9): from the checkpoint, or from its request
     * when it has none yet, with the journal's records after that to be played again. The request
     * is the one the game was made from, its seed included. Its players are the checkpoint's.
     */
    static HumanGame restore(String id, HumanGameRequest request, Path deckDirectory, Consumer<HumanGame> onFinished,
                             Hooks hooks, Recorder recorder, Recording.Loaded checkpoint, List<JsonObject> journal) {
        return new HumanGame(id, request, deckDirectory, onFinished, hooks, recorder, true,
            checkpoint == null ? null : checkpoint.checkpoint(), checkpoint == null ? 0 : checkpoint.header().seq(),
            journal);
    }

    private HumanGame(String id, HumanGameRequest request, Path deckDirectory, Consumer<HumanGame> onFinished,
                      Hooks hooks, Recorder recorder, boolean takenUp, Checkpoint restored, int restoredSeq,
                      List<JsonObject> journal) {
        this.id = id;
        this.hooks = hooks;
        this.request = request;
        this.recorder = recorder;
        this.events = new GameEvents(id, recorder == null ? null : recorder.recording().folder());
        if (takenUp) {
            // The events up to the checkpoint stand; the journal's records make the rest again.
            events.takeUp(restored == null ? 0 : restored.eventSeq());
        }
        this.takenUp = takenUp;
        this.restored = restored;
        this.restoredSeq = restoredSeq;
        GameFormat format = request.format();
        List<SeatSettings> seatSettings = new ArrayList<>();
        List<Player> seated = new ArrayList<>();
        List<Seat> bySeat = new ArrayList<>();
        if (restored != null && restored.seatIds().size() != request.seats().size()) {
            throw new IllegalArgumentException("The checkpoint seats " + restored.seatIds().size()
                + " players and the request " + request.seats().size());
        }
        for (int index = 0; index < request.seats().size(); index++) {
            HumanGameRequest.Seat seat = request.seats().get(index);
            seatSettings.add(new SeatSettings(index, seat.player(), seat.deck()));
            // A game that goes on from a checkpoint has the checkpoint's players: XMage's state is
            // theirs, and so is everything each has decided so far.
            Player saved = restored == null ? null : restored.game().getPlayer(restored.seatIds().get(index));
            if (restored != null && (saved == null || seat.human() != (saved instanceof HumanSeatPlayer))) {
                throw new IllegalArgumentException("The checkpoint's seat " + index + " is not the request's");
            }
            if (seat.human()) {
                HumanSeatPlayer human;
                if (saved != null) {
                    human = (HumanSeatPlayer) saved;
                    human.attach(this::waiting);
                } else {
                    human = new HumanSeatPlayer(name(seat, index), format.range(index), this::waiting);
                    // XMage's server sets each human's preferences on connect; these are its defaults (stop
                    // in both main phases, at declare attackers and blockers, and whenever something new is
                    // on the stack).
                    human.setUserData(UserData.getDefaultUserDataView());
                    // Learn Commander's training hand (v0.9.1): the deck list's opening, on top after the
                    // game's first shuffle.
                    if (seat.custom() != null) {
                        human.stackOpening(seat.custom().opening());
                    }
                }
                seated.add(human);
                bySeat.add(new Seat(index, human));
            } else {
                Player bot = saved != null ? saved
                    : hooks.bot(index, name(seat, index), format.range(index), request.skill(), request.seed());
                if (bot instanceof FairBot fair) {
                    // Every fair bot follows the game's one switch (v0.8.6); a test's other bot ignores it.
                    fair.followPassive(passiveBots);
                }
                seated.add(bot);
                bySeat.add(null);
            }
        }
        this.settings = new Settings(format.id(), format.rulesProfile(seated.size()), List.copyOf(seatSettings),
            request.skill(), request.turnCap(), request.idleTimeoutSeconds(), request.spectatorDelaySeconds(),
            KingsTableSettings.of(request.kingsTable()));
        this.players = List.copyOf(seated);
        // Stream.toList tolerates indexOf(null): XMage has no active player before the first turn.
        this.seatIds = seated.stream().map(Player::getId).toList();
        this.seats = Collections.unmodifiableList(bySeat);
        this.humans = bySeat.stream().filter(seat -> seat != null).toList();
        this.deckDirectory = deckDirectory;
        this.onFinished = onFinished;
        this.thread = new Thread(this::run, ThreadUtils.THREAD_PREFIX_GAME + " human_game " + id);
        this.thread.setDaemon(true);
        if (restored == null) {
            this.refs = new ObjectRefs();
            this.log = new MatchLog();
        } else {
            // What the seats had been shown and told: the same ids, the same log, revisions that go on.
            this.refs = restored.refs();
            this.log = new MatchLog(restored.log());
            this.passiveBots.set(restored.passiveBots());
            this.conceded.addAll(restored.conceded());
            this.spectatorRevision = restored.spectatorRevision();
            this.version = restored.version();
            for (Checkpoint.SeatState state : restored.seats()) {
                Seat seat = bySeat.get(state.index());
                seat.revision = state.revision();
                seat.lastAttacker = state.lastAttacker();
                seat.messages.addAll(state.messages());
                seat.concedeRequested = state.concedeRequested();
            }
        }
        // The journal. Records an earlier recovery could not play again were dropped by a note that
        // follows them, and are no part of the game. Of the others, what is already in the
        // checkpoint's state is remembered as answered (a seat that sends one of those commands
        // again is told what it was told), and the rest is played again.
        long base = restored == null ? 0 : restored.journalSeq();
        this.replayedSeq = base;
        int recoveries = 0;
        List<JsonObject> kept = new ArrayList<>();
        for (JsonObject record : journal) {
            String type = record.get("type").getAsString();
            if (type.equals("recovered")) {
                recoveries++;
            } else if (type.equals("replayed") && record.has("after")) {
                long after = record.get("after").getAsLong();
                kept.removeIf(earlier -> earlier.get("seq").getAsLong() > after);
            } else if (REPLAYED.contains(type)) {
                kept.add(record);
            }
        }
        for (JsonObject record : kept) {
            if (record.get("seq").getAsLong() <= base) {
                remember(record);
            } else {
                this.replay.addLast(record);
            }
        }
        this.replaying = !this.replay.isEmpty();
        if (takenUp) {
            // Revisions go on, and past any the seats were shown after the checkpoint and before the
            // interruption, which nothing kept: each recovery starts a new stretch of them, so a
            // seat waiting for something newer than what it last saw is always answered.
            long floor = (recoveries + 1) * RECOVERY_STRIDE;
            for (Seat seat : this.humans) {
                seat.revision = Math.max(seat.revision, floor);
            }
            this.spectatorRevision = Math.max(this.spectatorRevision, floor);
            this.version = Math.max(this.version, floor);
            if (recorder != null) {
                JsonObject record = new JsonObject();
                record.addProperty("type", "recovered");
                record.addProperty("checkpoint", restoredSeq);
                record.addProperty("to_play", this.replay.size());
                record.addProperty("engine_build", EngineBuild.key());
                recorder.journal(record);
            }
        }
    }

    /** Caller holds the lock, or is the constructor. A journalled command's reply, should it come again. */
    private void remember(JsonObject record) {
        if (!record.has("action") || !record.has("reply") || !record.has("seat")) {
            return;
        }
        Seat seat = seats == null ? null : seats.get(record.get("seat").getAsInt());
        if (seat == null) {
            return;
        }
        Map<String, Object> body = REPLIES.fromJson(record.get("reply"),
            new TypeToken<LinkedHashMap<String, Object>>() {}.getType());
        seat.actions.put(record.get("action").getAsString(),
            new Recorded(record.get("fp").getAsString(), new Reply(200, body)));
    }

    /** Players are named by kind and seat number (seat + 1), for example "Human 1" or "Bot 2". */
    private static String name(HumanGameRequest.Seat seat, int index) {
        return (seat.human() ? "Human " : "Bot ") + (index + 1);
    }

    void start() {
        thread.start();
    }

    String id() {
        return id;
    }

    Settings settings() {
        return settings;
    }

    Thread thread() {
        return thread;
    }

    /** The human seats, in seat order. */
    List<Integer> humanSeats() {
        return humans.stream().map(seat -> seat.index).toList();
    }

    synchronized boolean finished() {
        return result != null;
    }

    synchronized long idleMillis() {
        return TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - lastActivityNanos);
    }

    private void run() {
        Throwable failure = null;
        try {
            play();
        } catch (Throwable t) {
            failure = t;
            System.err.println("Human game " + id + " failed");
            t.printStackTrace();
        } finally {
            finish(failure);
            events.detach();
            onFinished.accept(this);
            logBots();
        }
    }

    /** Each fair bot's searches, for the engine's log: shows whether bots ran short of time or threads. */
    private void logBots() {
        for (Player player : players) {
            if (player instanceof FairBot bot && bot.stats().searches() > 0) {
                System.out.println("Human game " + id + " bot " + bot.getName() + ": " + bot.stats());
            }
        }
    }

    /** The game's structured events (v0.9.10). */
    GameEvents events() {
        return events;
    }

    /** The fair bots' metrics added up (v0.9.10): what the operator reads for this game. */
    Map<String, Long> botMetrics() {
        Map<String, Long> total = new LinkedHashMap<>();
        for (Player player : players) {
            if (player instanceof FairBot bot) {
                bot.stats().metrics().forEach((name, value) ->
                    total.merge(name, value, name.startsWith("longest") ? Math::max : Long::sum));
            }
        }
        return total;
    }

    private void play() throws Exception {
        if (restored != null) {
            resume();
            return;
        }
        // XMage's only seed control: since v0.8.5 (patch 0010) it seeds this game thread's own generator
        // for shuffles, coin flips and AI ties, which no other game draws from or reseeds.
        RandomUtil.setSeed(request.seed());
        GameFormat format = request.format();
        List<Deck> decks = new ArrayList<>();
        for (HumanGameRequest.Seat seat : request.seats()) {
            decks.add(seat.custom() != null ? DeckLists.load(seat.custom()) : format.loadDeck(deckDirectory, seat.deck()));
        }
        Game created = format.newGame(players.size(), request.turnCap(), request.kingsTable());
        Match match = format.newMatch("Commander Duels development game", players.size());
        // XMage's player list inserts each player it is given at the front, so turns pass in the
        // opposite order to the one players were added in. Adding seat 0 and then the others in
        // reverse makes the turn order follow the seat numbers: 0, 1, 2, 3.
        for (int index : additionOrder(players.size())) {
            LegacyDuel.seat(created, match, players.get(index), decks.get(index));
        }
        format.seatTeams(created, seatIds);
        // A campaign finale's incarnation in reserve (v0.8.0; the court's since v0.9.6): its rules for the seat's player.
        for (int index = 0; index < request.seats().size(); index++) {
            DeckLists.CustomDeck custom = request.seats().get(index).custom();
            if (custom != null) {
                for (DeckLists.Reserve reserve : custom.reserve()) {
                    if (reserve.court()) {
                        CampaignReserve.applyCourt(created, seatIds.get(index), reserve.name());
                    } else {
                        CampaignReserve.apply(created, seatIds.get(index), reserve.name(), reserve.threshold());
                    }
                }
            }
        }
        views = new SeatViews(created, seatIds, refs);
        views.yielding = seat -> automation.yielding(seat, created.getTurnNum());
        log.attach(created, seatIds);
        created.addTableEventListener(event -> {
            if (event.getEventType() == TableEvent.EventType.UPDATE) {
                refresh();
            }
        });
        created.addPlayerQueryEventListener(this::onQuery);
        created.watchResumable(this::atResumable);
        events.attach(created, seatIds, refs);
        game = created;
        hooks.beforeStart(created, seatIds);
        refresh();
        boolean closing;
        synchronized (this) {
            closing = endRequest != null;
        }
        if (!closing) {
            Integer starting = request.startingSeat();
            if (starting != null) {
                // The seat chosen before the game (v0.5.0: a match's loser chose to play or draw)
                // takes the first turn, and XMage asks nobody who starts.
                created.setStartingPlayerId(seatIds.get(starting));
                created.start(seatIds.get(starting));
            } else if (format.kingsTable()) {
                // King's Table (v0.8.7): a King chosen at random takes the first turn.
                UUID king = seatIds.get(RandomUtil.nextBoolean() ? 1 : 4);
                created.setStartingPlayerId(king);
                created.start(king);
            } else {
                created.start(seatIds.get(RandomUtil.nextInt(seatIds.size())));
            }
        }
    }

    /**
     * Game thread: takes the game up from its checkpoint (v0.9.9). The generator is the one the game
     * had, as it stood; XMage's state is the checkpoint's, with its players, which the constructor
     * attached to this game; the listeners are new, as for a new game. XMage then goes on from the
     * priority the checkpoint was taken at (patch 0018): nothing that began before it is begun or
     * said again, and the player who had priority is given it.
     */
    private void resume() {
        RandomUtil.setRandom(restored.random());
        Game current = restored.game();
        views = new SeatViews(current, seatIds, refs);
        views.yielding = seat -> automation.yielding(seat, current.getTurnNum());
        log.attach(current, seatIds);
        current.addTableEventListener(event -> {
            if (event.getEventType() == TableEvent.EventType.UPDATE) {
                refresh();
            }
        });
        current.addPlayerQueryEventListener(this::onQuery);
        current.watchResumable(this::atResumable);
        events.attach(current, seatIds, refs);
        game = current;
        hooks.resumed(current, seatIds);
        // A concession XMage had been handed and had yet to apply is not in its state (XMage keeps
        // those beside it, and applies one the next time a player would receive priority): a seat
        // that conceded and is still in the checkpoint's game concedes again, here, before the game
        // goes on. One the journal holds after the checkpoint is given again as the journal is played.
        List<UUID> pending = new ArrayList<>();
        synchronized (this) {
            for (Seat seat : humans) {
                HumanPlayer human = current(seat);
                if (seat.concedeRequested && !human.hasLost() && !human.hasLeft()) {
                    pending.add(seat.id);
                }
            }
        }
        pending.forEach(current::setConcedingPlayer);
        refresh();
        boolean closing;
        synchronized (this) {
            closing = endRequest != null;
        }
        if (!closing) {
            current.resumeAtPriority();
        }
    }

    /**
     * Game thread: the game is at a point it can later go on from (v0.9.9, patch 0018's
     * {@code watchResumable}): a player is about to receive priority, or every player has passed.
     * The game's state is whole, and it is taken as a checkpoint: XMage's own copy of the game, the
     * generators as they stand (the game's, and each bot's own), and what the seats have been shown.
     * The copy is this thread's only cost; writing it is the recorder's, on its own thread, when a
     * seat is asked something or bots have played on for a while.
     *
     * <p>Between two such points lies at most one decision at priority, so the checkpoint a seat's
     * question is answered on is never older than the last such decision: what a bot's search found
     * in the time it had is in the checkpoint, and is not searched for again.
     *
     * <p>Nothing is taken while the journal is being played again: the journal is then ahead of the
     * game.
     */
    private void atResumable(Game current) {
        if (recorder == null || current != game || recorder.failure() != null) {
            return;
        }
        synchronized (this) {
            if (replaying || result != null || endRequest != null) {
                return;
            }
        }
        long started = System.nanoTime();
        try {
            Game copy = current.copy();
            Random random = copyOf(RandomUtil.getRandom());
            Map<Random, Random> bots = new IdentityHashMap<>();
            for (Player seated : copy.getPlayers().values()) {
                if (seated instanceof FairBot bot) {
                    bot.detach(bots);
                }
            }
            String digest = Checkpoint.digest(copy);
            PhaseStep step = current.getTurnStepType();
            Checkpoint checkpoint;
            synchronized (this) {
                List<Checkpoint.SeatState> states = new ArrayList<>();
                for (Seat seat : humans) {
                    states.add(new Checkpoint.SeatState(seat.index, seat.revision, seat.lastAttacker,
                        List.copyOf(seat.messages), seat.concedeRequested));
                }
                // The journal's number is read under the lock every record is written under: each
                // record up to it has been acted on, since XMage asks one player at a time and
                // gives nobody priority while it waits for an answer.
                checkpoint = new Checkpoint(copy, random, seatIds, refs.copy(), log.save(), states, conceded,
                    passiveBots.get(), spectatorRevision, version, recorder.journalSeq(), current.getTurnNum(),
                    step == null ? null : step.name(), digest, events.seq());
            }
            recorder.captured(checkpoint, System.nanoTime() - started);
        } catch (RuntimeException | IOException | ClassNotFoundException e) {
            // A checkpoint that cannot be taken is not the game's failure: the last one stands.
            System.err.println("Human game " + id + ": no checkpoint at turn " + current.getTurnNum() + ": " + e);
        }
    }

    /** The generator as it stands, apart from the one the game goes on drawing from. */
    private static Random copyOf(Random random) throws IOException, ClassNotFoundException {
        var bytes = new ByteArrayOutputStream(128);
        try (var out = new ObjectOutputStream(bytes)) {
            out.writeObject(random);
        }
        try (var in = new ObjectInputStream(new ByteArrayInputStream(bytes.toByteArray()))) {
            return (Random) in.readObject();
        }
    }

    /** The order to add seats to XMage so that its turn order is seat order (see {@link #play}). */
    static List<Integer> additionOrder(int seatCount) {
        List<Integer> order = new ArrayList<>(List.of(0));
        for (int seat = seatCount - 1; seat > 0; seat--) {
            order.add(seat);
        }
        return order;
    }

    /**
     * Game thread: XMage is about to wait for a human seat's answer, or (v0.5.1) for the answer of a
     * player whose turn a human seat controls, which that seat gives.
     */
    private void onQuery(PlayerQueryEvent event) {
        if (event.getQueryType() == PlayerQueryEvent.QueryType.PERSONAL_MESSAGE) {
            message(event);
            return;
        }
        if (missedRefresh) {
            refresh();
        }
        UUID asking = asking(event);
        endLostControl();
        if (controlledByBot(asking)) {
            // v0.6.1: a bot controls the asked player's turn, and XMage's AI decides for them (its
            // stand-in's priority still fires XMage's request); nobody is asked.
            refresh();
            return;
        }
        Seat askingSeat = humanSeat(asking);
        Seat seat = decider(asking, askingSeat);
        if (seat == null) {
            if (askingSeat == null) {
                answerForBot(event, asking);
            }
            return;
        }
        // The seat answers for another player whose turn it controls (723.5).
        Integer forSeat = seat == askingSeat ? null : seatIds.indexOf(asking);
        String attacker;
        boolean leaving;
        boolean automate;
        synchronized (this) {
            attacker = seat.lastAttacker;
            leaving = (askingSeat != null && askingSeat.concedeRequested) || endRequest != null;
            // While the journal is played again its records answer, the automatic ones among them.
            automate = !leaving && !replaying;
        }
        // The object XMage waits on: a human seat's player, or the bot whose stand-in asks.
        Player human = askingSeat != null ? current(askingSeat) : game.getPlayer(asking);
        Prompts.Prompt next = Prompts.build(event, game, human, views, UUID.randomUUID().toString(), attacker,
            forSeat);
        // The seat's batch or yield may answer it (v0.9.12): then the seat is shown no prompt.
        Automation.Step step = automate && next.supported()
            ? automation.opened(seat.index, seatIds.indexOf(asking), next, game.getTurnNum(), Automation.offer(game, ""))
            : Automation.Step.ASK;
        Prompts.Answer automatic = step.optionId() == null ? null : next.answers().get(step.optionId());
        if (step.note() != null) {
            seat.messages.addLast(step.note());
            while (seat.messages.size() > MAX_MESSAGES) {
                seat.messages.removeFirst();
            }
        }
        SeatView seatView = views.build(seat.index, List.copyOf(seat.messages));
        int logged = log.size();
        // Every other seat sees the game as it is while XMage waits. Their views go out before the
        // prompt opens: an answer that reaches XMage before it starts listening waits in 100 ms steps.
        for (Seat other : humans) {
            if (other != seat) {
                publish(other);
            }
        }
        publishSpectators();
        hooks.published(game, refs, seat.index, seatView, leaving || automatic != null ? null : next.view());
        boolean concede;
        boolean closing;
        Runnable deliver = null;
        synchronized (this) {
            concede = askingSeat != null && askingSeat.concedeRequested;
            closing = endRequest != null;
            // A seat that has conceded, or any seat of a game being closed, is not asked: the
            // concession below makes XMage drop this request, and the seat leaves the game.
            boolean ask = !concede && !closing;
            seat.revision++;
            seat.prompt = ask && automatic == null ? next : null;
            seat.promptFor = seatIds.indexOf(asking);
            seat.view = seatView;
            seat.logEntries = logged;
            seat.status = !ask || automatic != null ? "waiting"
                : next.supported() ? "your_prompt" : "unsupported_prompt";
            if (ask && automatic != null) {
                // Answered as the seat's own answer is (submit), and kept in the journal as one: a
                // game taken up again plays it as any other, with no batch or yield to know of.
                int promptFor = seat.promptFor;
                PromptView.Option chosen = next.view().options().stream()
                    .filter(option -> option.id().equals(step.optionId())).findFirst().orElseThrow();
                if (next.view().kind().equals("declare_attackers")) {
                    seat.lastAttacker = chosen.label();
                }
                if (recorder != null) {
                    JsonObject record = new JsonObject();
                    record.addProperty("type", "answer");
                    record.addProperty("seat", seat.index);
                    record.addProperty("for", promptFor);
                    record.addProperty("print", next.print());
                    record.addProperty("kind", next.view().kind());
                    record.addProperty("options", next.view().options().size());
                    record.addProperty("code", next.code(step.optionId()));
                    record.addProperty("automatic", step.yielded() ? "yield" : "batch");
                    if (next.view().kind().equals("declare_attackers") && seat.lastAttacker != null) {
                        record.addProperty("attacker", seat.lastAttacker);
                    }
                    recorder.journal(record);
                }
                deliver = () -> {
                    Player answering = answering(promptFor);
                    if (answering != null) {
                        automatic.apply(answering);
                    }
                };
            }
            touch();
            notifyAll();
        }
        if (closing) {
            // The game is being closed: every seat concedes, here on the game thread. This also covers
            // a close that arrived before the game had started, when XMage takes no concessions from
            // other threads.
            for (UUID playerId : seatIds) {
                Player player = game.getPlayer(playerId);
                if (player != null && !player.hasLeft()) {
                    game.setConcedingPlayer(playerId);
                }
            }
            human.signalPlayerConcede(true);
        } else if (concede) {
            // A concession that arrived before the game had started is applied here, on the game thread.
            game.setConcedingPlayer(askingSeat.id);
            human.signalPlayerConcede(true);
            // XMage has removed the seat: its view now says it is out.
            publish(askingSeat);
        } else if (deliver != null) {
            // From another thread, as any answer: XMage listens only once this request has been fired.
            Thread.ofVirtual().name("human-game-automation").start(deliver);
        } else {
            hooks.prompted(seat.index);
            if (recorder != null) {
                // The seat's answer will build on the newest checkpoint: it is written now.
                recorder.want();
            }
            replayNext(seat);
        }
    }

    /**
     * Game thread, as a prompt has opened (v0.9.9): while the journal is being played again, its
     * next records are. Commands that are not answers (priority controls, the bots' switch, a
     * concession) come first, in their order, as they came between the answers around them. Then
     * the next answer, if it is the answer to this prompt: the same seat, deciding for the same
     * player, asked the same thing ({@link Prompts.Prompt#print}), with an answer the prompt still
     * offers. It closes the prompt as the seat's own answer did and reaches XMage the same way. An
     * answer to anything else is not given: the game after the checkpoint has gone another way (a
     * bot decided otherwise), so the rest of the journal is dropped (a note in the journal says
     * from where), and the game goes on from here with the seats asked for themselves.
     */
    private void replayNext(Seat asked) {
        Runnable deliver = null;
        List<Runnable> concessions = new ArrayList<>();
        int dropped = -1;
        synchronized (this) {
            if (!replaying) {
                return;
            }
            while (!replay.isEmpty() && !replay.peekFirst().get("type").getAsString().equals("answer")) {
                JsonObject command = replay.pollFirst();
                Seat seat = command.has("seat") ? seats.get(command.get("seat").getAsInt()) : null;
                switch (command.get("type").getAsString()) {
                    case "priority" -> {
                        if (seat != null) {
                            Priority.apply(current(seat), game, EngineServer.JSON.fromJson(command.get("settings"),
                                Priority.Settings.class));
                        }
                    }
                    case "bots" -> {
                        boolean passive = command.get("passive").getAsBoolean();
                        if (passiveBots.getAndSet(passive) != passive) {
                            note(passive ? BOTS_PASSIVE : BOTS_NORMAL);
                        }
                    }
                    default -> {
                        if (seat != null && !seat.concedeRequested) {
                            Runnable handover = handOver(seat);
                            boolean promptOpen = markConcession(seat);
                            conceded.add(seat.index);
                            UUID conceding = seat.id;
                            // As a seat's own concession: from another thread, once this one waits.
                            concessions.add(() -> {
                                applyConcession(conceding, promptOpen);
                                if (handover != null) {
                                    handover.run();
                                }
                            });
                        }
                    }
                }
                remember(command);
                replayed++;
                replayedSeq = command.get("seq").getAsLong();
            }
            JsonObject head = replay.peekFirst();
            Prompts.Prompt prompt = asked.prompt;
            Prompts.Answer answer = head == null || prompt == null ? null : recorded(head, asked, prompt);
            if (answer != null) {
                replay.pollFirst();
                if (prompt.view().kind().equals("declare_attackers")) {
                    asked.lastAttacker = head.has("attacker") ? head.get("attacker").getAsString() : null;
                }
                int promptFor = asked.promptFor;
                asked.prompt = null;
                asked.revision++;
                asked.status = "waiting";
                touch();
                remember(head);
                replayed++;
                replayedSeq = head.get("seq").getAsLong();
                deliver = () -> {
                    Player answering = answering(promptFor);
                    if (answering != null) {
                        answer.apply(answering);
                    }
                };
            } else if (head != null && prompt != null) {
                // Asked something the journal did not answer: what is left of it was never said here.
                dropped = replay.size();
                replayDropped += dropped;
                System.err.println("Human game " + id + ": taken up again, the game asks seat " + asked.index
                    + " (for seat " + asked.promptFor + ") a " + prompt.view().kind() + " question with "
                    + prompt.view().options().size() + " choices at turn " + (game == null ? "?" : game.getTurnNum())
                    + ", and the journal's record " + head.get("seq") + " answers seat " + head.get("seat")
                    + " (for seat " + head.get("for") + ") a " + (head.has("kind") ? head.get("kind").getAsString() : "?")
                    + " question with " + (head.has("options") ? head.get("options") : "?") + " choices; "
                    + dropped + " records are left unplayed and the game goes on from here"
                    + differing(head, prompt));
                replay.clear();
            }
            if (replay.isEmpty()) {
                replaying = false;
                if (recorder != null) {
                    // The journal's note of how the playing again went. With records dropped it
                    // says after which record: they stay in the file, and are no part of the game.
                    JsonObject record = new JsonObject();
                    record.addProperty("type", "replayed");
                    record.addProperty("played", replayed);
                    record.addProperty("dropped", Math.max(0, dropped));
                    if (dropped > 0) {
                        record.addProperty("after", replayedSeq);
                    }
                    recorder.journal(record);
                }
            }
            notifyAll();
        }
        for (Runnable concession : concessions) {
            Thread.ofVirtual().name("human-game-replay").start(concession);
        }
        if (deliver != null) {
            // From another thread, as any answer: XMage listens only once this request has been fired.
            Thread.ofVirtual().name("human-game-replay").start(deliver);
        }
    }

    /** With the journal's choices kept ({@link #JOURNAL_CHOICES}): which choices only one of the two questions has. */
    private static String differing(JsonObject record, Prompts.Prompt prompt) {
        if (!record.has("choices")) {
            return "";
        }
        List<String> was = new ArrayList<>();
        record.getAsJsonArray("choices").forEach(choice -> was.add(choice.getAsString()));
        List<String> is = prompt.codes();
        List<String> gone = new ArrayList<>(was);
        gone.removeAll(is);
        List<String> added = new ArrayList<>(is);
        added.removeAll(was);
        return ". Choices only the journal's question had: " + gone + "; only this one has: " + added;
    }

    /**
     * Caller holds the lock. The answer a journal record holds, as the open prompt offers it; null
     * when the record answers another seat, another player's decision or another question, or the
     * prompt no longer offers that answer.
     */
    private Prompts.Answer recorded(JsonObject record, Seat seat, Prompts.Prompt prompt) {
        if (record.get("seat").getAsInt() != seat.index || record.get("for").getAsInt() != seat.promptFor
                || !prompt.supported() || !record.get("print").getAsString().equals(prompt.print())) {
            return null;
        }
        if (record.has("amounts")) {
            List<Integer> amounts = new ArrayList<>();
            for (JsonElement amount : record.getAsJsonArray("amounts")) {
                amounts.add(amount.getAsInt());
            }
            return prompt.amounts(amounts);
        }
        if (record.has("text")) {
            return prompt.name(record.get("text").getAsString());
        }
        return prompt.coded(record.get("code").getAsString());
    }

    /**
     * The player XMage asks. Its requests name that player, but for a priority request, which names
     * the player controlling its turn (XMage's own server shows it to that player's client). XMage
     * makes the player it asks the priority player before every human player's request.
     */
    private UUID asking(PlayerQueryEvent event) {
        UUID named = event.getPlayerId();
        UUID priority = game.getState().getPriorityPlayerId();
        Player prioritised = priority == null || priority.equals(named) ? null : game.getPlayer(priority);
        if (prioritised != null && !prioritised.isGameUnderControl()
                && named.equals(prioritised.getTurnControlledBy())) {
            return priority;
        }
        return named;
    }

    /**
     * Whether a bot controls the player's turn (723, v0.6.1): XMage's AI then makes the player's
     * decisions through a stand-in its controller makes (patch 0008), a human seat's included.
     */
    private boolean controlledByBot(UUID playerId) {
        UUID controller = Visibility.controllerOf(game, playerId);
        return controller != null && humanSeat(controller) == null;
    }

    /**
     * The human seat that answers the asked player's request: the seat controlling its turn (723.5),
     * else its own; null for a bot whose controller has left or is leaving. A player whose turn a
     * bot controls is asked nothing ({@link #controlledByBot}).
     */
    private Seat decider(UUID asking, Seat askingSeat) {
        Seat controller = humanSeat(Visibility.controllerOf(game, asking));
        if (controller == null) {
            return askingSeat;
        }
        synchronized (this) {
            return controller.concedeRequested ? askingSeat : controller;
        }
    }

    /**
     * Game thread: XMage's stand-in for a bot whose turn a human seat controlled asks, but that seat
     * has left the game or is leaving it: the request gets the answer that does the least, and the
     * bot makes its own decisions once XMage has let it go (800.4a, see {@link #endLostControl}).
     */
    private void answerForBot(PlayerQueryEvent event, UUID botId) {
        Player bot = game.getPlayer(botId);
        if (bot == null) {
            return;
        }
        Prompts.Answer answer = Prompts.build(event, game, bot, views, UUID.randomUUID().toString(), null,
            seatIds.indexOf(botId)).fallback();
        if (answer != null) {
            // From another thread, as any answer: XMage listens only once this request has been fired.
            Thread.ofVirtual().name("human-game-fallback").start(() -> answer.apply(bot));
        }
    }

    /**
     * Game thread: control of a turn ends when its controller leaves the game (800.4a). XMage keeps
     * it until the next turn begins, still asking the player who left; the engine hands it back at
     * once. Without turn control this changes nothing.
     */
    private void endLostControl() {
        Game current = game;
        if (current == null) {
            return;
        }
        for (Player player : current.getPlayers().values()) {
            if (player.isGameUnderControl()) {
                continue;
            }
            Player controller = current.getPlayer(player.getTurnControlledBy());
            if (controller == null || !controller.isInGame()) {
                player.setGameUnderYourControl(current, true);
            }
        }
    }

    /**
     * Game thread: one of XMage's personal messages ("You have to attack with..."), for the seat it
     * names and, while another seat controls that player's turn, for that seat too (723.4); a bot's
     * reach only the seat controlling its turn.
     */
    private void message(PlayerQueryEvent event) {
        UUID named = event.getPlayerId();
        List<Seat> to = new ArrayList<>();
        Seat own = humanSeat(named);
        if (own != null) {
            to.add(own);
        }
        Seat controller = humanSeat(Visibility.controllerOf(game, named));
        if (controller != null && controller != own) {
            to.add(controller);
        }
        if (to.isEmpty()) {
            return;
        }
        String text = SeatViews.plain(event.getMessage());
        if (!text.isEmpty()) {
            for (Seat seat : to) {
                seat.messages.addLast(text);
                while (seat.messages.size() > MAX_MESSAGES) {
                    seat.messages.removeFirst();
                }
            }
        }
        refresh();
    }

    /**
     * Game thread: the state changed without a request to a human seat. XMage can also fire its
     * events on the thread that called it (a concession applied from a request thread, when the game
     * has no player to hand it to); the views are the game thread's alone ({@link SeatViews}), so
     * such a call only marks them stale, and the game thread publishes at its next event or prompt
     * (v0.8.5).
     */
    private void refresh() {
        if (views == null) {
            return;
        }
        if (Thread.currentThread() != thread) {
            missedRefresh = true;
            return;
        }
        missedRefresh = false;
        endLostControl();
        for (Seat seat : humans) {
            publish(seat);
        }
        publishSpectators();
        Game current = game;
        if (current != null && current.getStartTime() != null && !current.hasEnded()
                && GameFormat.kingsTableOf(current) == null
                && humans.stream().map(this::current).allMatch(human -> human.hasLost() || human.hasLeft())
                && current.getPlayers().values().stream().filter(p -> !p.hasLost() && !p.hasLeft()).count() > 1) {
            // Every human seat is out and two or more bots play on: there is nobody left to play for.
            // With one player left XMage ends the game itself, and a close would race it. At King's
            // Table (v0.8.7) the bots play on: an eliminated General's team may still win, and the
            // team's result is theirs too.
            boolean first;
            synchronized (this) {
                first = endRequest == null && result == null;
                if (first) {
                    endRequest = "humans_eliminated";
                }
            }
            if (first) {
                Thread.ofVirtual().name("human-game-close").start(() -> close("humans_eliminated"));
            }
        }
    }

    /**
     * Game thread: publishes the seat's current view at a new revision if it changed, with the log
     * up to now. An open prompt stays open (XMage is still waiting for it), but its answer must name
     * the new revision.
     */
    private void publish(Seat seat) {
        SeatView seatView = views.build(seat.index, List.copyOf(seat.messages));
        int logged = log.size();
        HumanPlayer human = current(seat);
        boolean out = human.hasLost() || human.hasLeft();
        PromptView open;
        synchronized (this) {
            String status = seat.prompt != null ? seat.status : out ? "eliminated" : "waiting";
            if (result != null || (seatView.equals(seat.view) && status.equals(seat.status))) {
                return;
            }
            seat.revision++;
            seat.view = seatView;
            seat.logEntries = logged;
            seat.status = status;
            open = seat.prompt == null ? null : seat.prompt.view();
            touch();
            notifyAll();
        }
        hooks.published(game, refs, seat.index, seatView, open);
    }

    /** Game thread: keeps the public view for spectators if it changed. */
    private void publishSpectators() {
        SeatView publicView = views.buildPublic();
        synchronized (this) {
            if (result != null || publicView.equals(spectatorView)) {
                return;
            }
            spectatorView = publicView;
            watch(publicView, null);
        }
        hooks.spectated(game, refs, publicView);
    }

    /**
     * Caller holds the lock. Adds a public view to the spectators' history. The kept views are about
     * a second apart: a view less than a second after the one before the newest replaces the newest.
     * Every view keeps its own publication time, so none is shown before the delay has passed. Views
     * older than the newest one past the delay are dropped, so the history holds about one view per
     * second of delay.
     */
    private void watch(SeatView publicView, Result outcome) {
        long now = System.nanoTime();
        if (watched.size() >= 2) {
            var newestFirst = watched.descendingIterator();
            Watched last = newestFirst.next();
            Watched beforeLast = newestFirst.next();
            if (last.result() == null && now - beforeLast.publishedNanos() < TimeUnit.SECONDS.toNanos(1)) {
                watched.pollLast();
            }
        }
        watched.addLast(new Watched(++spectatorRevision, now, publicView, log.size(), outcome));
        long delay = TimeUnit.SECONDS.toNanos(settings.spectatorDelaySeconds());
        while (watched.size() > 1) {
            Watched next = watched.stream().skip(1).findFirst().orElseThrow();
            if (now - next.publishedNanos() < delay) {
                break;
            }
            watched.pollFirst();
        }
        notifyAll();
    }

    /** Caller holds the lock. The newest public view at least the spectator delay old, or null. */
    private Watched matured(long now) {
        long delay = TimeUnit.SECONDS.toNanos(settings.spectatorDelaySeconds());
        Watched shown = null;
        for (Watched entry : watched) {
            if (now - entry.publishedNanos() >= delay) {
                shown = entry;
            }
        }
        return shown;
    }

    private void finish(Throwable failure) {
        Game finished = game;
        List<SeatView> finalViews = new ArrayList<>();
        SeatView finalPublic = null;
        if (finished != null && views != null) {
            try {
                for (Seat seat : humans) {
                    SeatView seatView = views.build(seat.index, List.copyOf(seat.messages));
                    hooks.published(finished, refs, seat.index, seatView, null);
                    finalViews.add(seatView);
                }
                finalPublic = views.buildPublic();
                hooks.spectated(finished, refs, finalPublic);
            } catch (RuntimeException e) {
                finalViews.clear(); // keep the last published views
                finalPublic = null;
                System.err.println("Final views of human game " + id + " failed");
                e.printStackTrace();
                hooks.failed(e);
            }
        }
        Result outcome = outcome(finished, failure);
        boolean inspect;
        synchronized (this) {
            inspect = inspectable;
        }
        Inspection lastInspection = inspect && finished != null && views != null
            ? buildInspection(finished, "finished", outcome) : null;
        boolean left;
        synchronized (this) {
            left = interrupted;
        }
        if (recorder != null && !left) {
            // The result is the recording's before any seat hears of it (v0.9.9): a recording with a
            // result is over, and a game that is over is never taken up again. Were it the other way
            // round, a process that died in between would leave a game whose result had been told
            // and which could be played on to another.
            recorder.finish(EngineServer.JSON.toJsonTree(outcome).getAsJsonObject());
        }
        synchronized (this) {
            // Spectators learn the result after the same delay as everything else.
            watch(finalPublic != null ? finalPublic : spectatorView, outcome);
            result = outcome;
            finalInspection = lastInspection;
            for (int i = 0; i < humans.size(); i++) {
                Seat seat = humans.get(i);
                seat.revision++;
                seat.prompt = null;
                if (i < finalViews.size()) {
                    seat.view = finalViews.get(i);
                }
                // The final snapshot carries the whole log.
                seat.logEntries = Integer.MAX_VALUE;
                seat.status = "finished";
            }
            replay.clear();
            replaying = false;
            touch();
            notifyAll();
        }
        views = null;
        game = null;
    }

    private Result outcome(Game finished, Throwable failure) {
        int turns = finished == null ? 0 : Math.min(finished.getTurnNum(), request.turnCap());
        String requested;
        List<Integer> concededSeats;
        synchronized (this) {
            requested = endRequest;
            concededSeats = List.copyOf(conceded);
        }
        if (failure != null) {
            // Every seat is sent the result: the details stay in the engine's log (see run).
            return new Result("error", concededSeats, turns, "The engine stopped the game after an internal error");
        }
        if (log.criticalError() != null) {
            return new Result("error", concededSeats, turns, "XMage ended the game after an internal error");
        }
        if (requested != null) {
            return new Result(requested, concededSeats, turns, null);
        }
        if (finished != null && finished.hasEnded()) {
            List<Integer> winners = new ArrayList<>();
            for (int seat = 0; seat < seatIds.size(); seat++) {
                if (finished.getPlayer(seatIds.get(seat)).hasWon()) {
                    winners.add(seat);
                }
            }
            // A team wins together (810.8a); otherwise there is at most one winner.
            Integer winner = winners.isEmpty() ? null : request.format().teams() ? winners.get(0)
                : winners.get(winners.size() - 1);
            return new Result("completed", winner, winners, finished.isADraw(), concededSeats, turns, null);
        }
        if (finished != null && finished.getTurnNum() > request.turnCap()) {
            return new Result("turn_limit", concededSeats, turns, null);
        }
        return new Result("error", concededSeats, turns, "Game stopped without a result");
    }

    /** Request thread: answers the seat's open prompt. */
    Reply submit(int seatIndex, SeatCommand command) {
        Seat seat = seats.get(seatIndex);
        Prompts.Answer answer;
        Reply reply;
        int promptFor;
        // The option answered: the command's own, or the first of its batch.
        String chosen = command.optionId();
        if (recorder != null) {
            // The answer builds on the newest checkpoint (v0.9.9), which is being written since the
            // prompt opened: the answer is taken once it is on disk, so that what the seat is told
            // was accepted can be played again whatever happens next.
            recorder.awaitDurable();
        }
        synchronized (this) {
            Reply earlier = replay(seat, command);
            if (earlier != null) {
                return earlier;
            }
            if (result != null) {
                return reject(seat, 409, "game_over", "The game has finished");
            }
            Prompts.Prompt prompt = seat.prompt;
            if (replaying || prompt == null || !prompt.view().id().equals(command.promptId())) {
                // While the journal is played again after a recovery (v0.9.9) no prompt is the seat's
                // to answer: it is shown none.
                return reject(seat, 409, "stale_prompt", "That prompt is no longer open");
            }
            if (command.expectedRevision() != seat.revision) {
                return reject(seat, 409, "stale_revision", "The game has moved on; fetch the view again");
            }
            if (!prompt.supported()) {
                return reject(seat, 409, "unsupported_prompt",
                    "This request is not supported yet; concede or close the game");
            }
            if (command.amounts() != null) {
                answer = prompt.amounts(command.amounts());
                if (answer == null) {
                    return reject(seat, 422, "invalid_amounts", prompt.view().amounts() == null
                        ? "This prompt does not take amounts" : "The amounts break the prompt's limits");
                }
            } else if (command.text() != null) {
                answer = prompt.name(command.text());
                if (answer == null) {
                    List<String> near = prompt.near(command.text());
                    return reject(seat, 422, "invalid_name", prompt.names() == null
                        ? "This prompt does not take a typed name"
                        : "No card by that name can be chosen here"
                            + (near.isEmpty() ? "." : ". Did you mean " + String.join(", ", near) + "?"));
                }
            } else if (command.batch() != null) {
                // Several attackers or blockers at once (v0.9.12): checked whole against the prompt,
                // then the first is this command's answer and the rest follow as the prompt opens
                // again (Automation).
                try {
                    chosen = automation.begin(seat.index, seat.promptFor, prompt, command.batch());
                } catch (Automation.Refused refused) {
                    return reject(seat, 422, "invalid_batch", refused.getMessage());
                }
                answer = prompt.answers().get(chosen);
            } else {
                answer = prompt.answers().get(command.optionId());
                if (answer == null) {
                    return reject(seat, 422, "invalid_option", "The prompt has no such option");
                }
            }
            if (command.batch() == null) {
                // The seat's own answer: to the question a batch left it, or the end of the batch.
                automation.answered(seat.index, prompt.view(), command.optionId());
            }
            if (answer instanceof Prompts.YieldAnswer yield) {
                // Only a priority prompt offers one, and only in a game that is running.
                automation.yield(seat.index, prompt, yield.offer(), game.getTurnNum());
            }
            String answered = chosen;
            if (prompt.view().kind().equals("declare_attackers")) {
                // XMage's defender choice that may follow does not say which attacker it is for.
                PromptView.Option option = prompt.view().options().stream()
                    .filter(candidate -> candidate.id().equals(answered)).findFirst().orElse(null);
                seat.lastAttacker = option == null ? null
                    : option.action().equals("all_attack") ? "all attackers" : option.label();
            }
            promptFor = seat.promptFor;
            seat.prompt = null;
            seat.revision++;
            seat.status = "waiting";
            touch();
            reply = accepted(seat, command);
            if (recorder != null) {
                // On disk before XMage hears of it, and before the seat is told (v0.9.9).
                JsonObject record = journalled("answer", seat, command, reply);
                record.addProperty("for", promptFor);
                record.addProperty("print", prompt.print());
                // What was asked, for a person reading the journal and for the log should a game
                // taken up again ask something else; the print alone decides.
                record.addProperty("kind", prompt.view().kind());
                record.addProperty("options", prompt.view().options().size());
                if (JOURNAL_CHOICES) {
                    JsonArray choices = new JsonArray();
                    prompt.codes().forEach(choices::add);
                    record.add("choices", choices);
                }
                if (command.amounts() != null) {
                    JsonArray amounts = new JsonArray();
                    command.amounts().forEach(amounts::add);
                    record.add("amounts", amounts);
                } else if (command.text() != null) {
                    record.addProperty("text", command.text());
                } else {
                    record.addProperty("code", prompt.code(chosen));
                }
                if (prompt.view().kind().equals("declare_attackers") && seat.lastAttacker != null) {
                    record.addProperty("attacker", seat.lastAttacker);
                }
                recorder.journal(record);
            }
            notifyAll();
        }
        // Outside the lock: XMage hands the answer to the waiting game thread. A prompt made for a
        // player whose turn this seat controls is that player's to receive (723.5).
        Player answering = answering(promptFor);
        if (answering != null) {
            answer.apply(answering);
        }
        return reply;
    }

    /**
     * The object XMage waits on for the answer of the player in a seat: a human seat's current player,
     * or a bot, which hands it to the stand-in its controller made for it.
     */
    private Player answering(int seatIndex) {
        Seat seat = seats.get(seatIndex);
        if (seat != null) {
            return current(seat);
        }
        Game current = game;
        return current == null ? null : current.getPlayer(seatIds.get(seatIndex));
    }

    /**
     * Request thread: changes the seat's priority controls. It needs no prompt, so a seat can
     * cancel a pass while XMage is passing for it. The reply carries the controls as they now are;
     * the seat's next view shows them too.
     */
    Reply setPriority(int seatIndex, SeatCommand command) {
        Seat seat = seats.get(seatIndex);
        synchronized (this) {
            Reply earlier = replay(seat, command);
            if (earlier != null) {
                return earlier;
            }
            if (result != null) {
                return reject(seat, 409, "game_over", "The game has finished");
            }
        }
        HumanPlayer human = current(seat);
        Priority.apply(human, game, command.priority());
        if (command.priority().cancelPasses()) {
            automation.cancel(seatIndex);
        }
        // Before the game has started there is no turn, and nothing yielded to.
        Game running = game;
        List<String> yields = running == null ? List.of() : automation.yielding(seatIndex, running.getTurnNum());
        synchronized (this) {
            Reply reply = accepted(seat, command);
            reply.body().put("priority", Priority.controls(human, yields));
            if (recorder != null) {
                // After it is applied (v0.9.9): a checkpoint taken in between has the controls, and
                // the journal then sets them again, to the same.
                JsonObject record = journalled("priority", seat, command, reply);
                record.add("settings", EngineServer.JSON.toJsonTree(command.priority()));
                recorder.journal(record);
            }
            touch();
            return reply;
        }
    }

    /** Caller holds the lock. A journal record of a seat's command and the reply it was given (v0.9.9). */
    private static JsonObject journalled(String type, Seat seat, SeatCommand command, Reply reply) {
        JsonObject record = new JsonObject();
        record.addProperty("type", type);
        record.addProperty("seat", seat.index);
        record.addProperty("action", command.actionId());
        record.addProperty("fp", command.fingerprint());
        record.add("reply", EngineServer.JSON.toJsonTree(reply.body()));
        return record;
    }

    /** Request thread: the seat concedes. In a game of three or more the others play on. */
    Reply concede(int seatIndex, SeatCommand command) {
        Seat seat = seats.get(seatIndex);
        Reply reply;
        boolean promptOpen;
        Runnable handover;
        synchronized (this) {
            Reply earlier = replay(seat, command);
            if (earlier != null) {
                return earlier;
            }
            if (result != null) {
                return reject(seat, 409, "game_over", "The game has finished");
            }
            HumanPlayer human = current(seat);
            if (seat.concedeRequested || human.hasLost() || human.hasLeft()) {
                return reject(seat, 409, "eliminated", "This seat is already out of the game");
            }
            handover = handOver(seat);
            promptOpen = markConcession(seat);
            conceded.add(seat.index);
            reply = accepted(seat, command);
            if (recorder != null) {
                recorder.journal(journalled("concede", seat, command, reply));
            }
        }
        applyConcession(seat.id, promptOpen);
        if (handover != null) {
            // Not on the request thread: if the concession ended the game, nobody listens any more.
            Thread.ofVirtual().name("human-game-handover").start(handover);
        }
        return reply;
    }

    /**
     * Caller holds the lock. A request the seat answers for a player whose turn it controls is that
     * player's once the seat leaves the game (800.4a): a human seat gets the same prompt as its own;
     * a bot's stand-in gets the answer that does the least, returned to apply once the concession is
     * on its way. Null if there is nothing to apply.
     */
    private Runnable handOver(Seat seat) {
        Prompts.Prompt prompt = seat.prompt;
        if (prompt == null || seat.promptFor == seat.index) {
            return null;
        }
        Seat owner = seats.get(seat.promptFor);
        if (owner != null) {
            if (!owner.concedeRequested && endRequest == null) {
                owner.prompt = new Prompts.Prompt(prompt.view().madeFor(null), prompt.answers(), prompt.names());
                owner.promptFor = owner.index;
                owner.revision++;
                owner.status = prompt.supported() ? "your_prompt" : "unsupported_prompt";
                touch();
                notifyAll();
            }
            return null;
        }
        Prompts.Answer answer = prompt.fallback();
        int botSeat = seat.promptFor;
        return answer == null ? null : () -> {
            Player bot = answering(botSeat);
            if (bot != null) {
                answer.apply(bot);
            }
        };
    }

    /**
     * Ends the game: every seat concedes, and the result records {@code reason} instead of a winner.
     */
    Map<String, Object> close(String reason) {
        List<UUID> conceding = new ArrayList<>();
        List<Boolean> promptsOpen = new ArrayList<>();
        synchronized (this) {
            if (result != null) {
                return closeBody();
            }
            if (endRequest == null) {
                endRequest = reason;
            }
            // Bots first: a human's concession wakes XMage, which then applies every queued one.
            for (int index = 0; index < seatIds.size(); index++) {
                if (seats.get(index) == null) {
                    conceding.add(seatIds.get(index));
                    promptsOpen.add(awaited(index));
                }
            }
            // Whose answers XMage waits for is read before any prompt closes: a seat controlling
            // another's turn may hold that player's prompt.
            List<Seat> leaving = humans.stream().filter(seat -> !seat.concedeRequested).toList();
            for (Seat seat : leaving) {
                conceding.add(seat.id);
                promptsOpen.add(awaited(seat.index));
            }
            leaving.forEach(this::markConcession);
        }
        Game current = game;
        for (int i = 0; i < conceding.size(); i++) {
            // A game that has ended meanwhile (conceding one of two bots ends it) needs no more
            // concessions, and XMage refuses them from this thread. Its thread records the result.
            if (current == null || over(current)) {
                break;
            }
            Player player = current.getPlayer(conceding.get(i));
            if (player != null && !player.hasLeft()) {
                applyConcession(conceding.get(i), promptsOpen.get(i));
            }
        }
        if (!BotMatchRunner.join(thread, CLOSE_GRACE_MILLIS)) {
            // The game thread did not reach the concessions (for instance, a long AI search): end the
            // game and keep interrupting until the thread exits.
            Game stopping = game;
            Thread.ofVirtual().name("human-game-stopper").start(() -> {
                if (stopping != null) {
                    stopping.end();
                }
                BotMatchRunner.stop(thread);
            });
        }
        synchronized (this) {
            return closeBody();
        }
    }

    private Map<String, Object> closeBody() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", result == null ? "closing" : "finished");
        return body;
    }

    /**
     * Caller holds the lock. Closes the seat's open prompt, and any prompt the seat controlling its
     * turn holds for it; returns whether XMage was waiting for this seat's answer.
     */
    private boolean markConcession(Seat seat) {
        boolean promptOpen = awaited(seat.index);
        for (Seat holder : humans) {
            if (holder != seat && holder.prompt != null && holder.promptFor == seat.index) {
                holder.prompt = null;
                holder.status = "waiting";
                holder.revision++;
            }
        }
        seat.concedeRequested = true;
        seat.prompt = null;
        seat.status = "waiting";
        seat.revision++;
        touch();
        notifyAll();
        return promptOpen;
    }

    /**
     * Caller holds the lock. Whether XMage waits for the answer of the player in this seat: a prompt
     * for it is open, on its own seat or (v0.5.1) on the seat controlling its turn.
     */
    private boolean awaited(int seatIndex) {
        return humans.stream().anyMatch(holder -> holder.prompt != null && holder.promptFor == seatIndex);
    }

    private void applyConcession(UUID playerId, boolean promptOpen) {
        Game current = game;
        // XMage's server records a concession from its request threads too. Before the game has
        // started, with no prompt waiting, the next prompt applies it on the game thread instead.
        if (current != null && (promptOpen || current.getStartTime() != null)) {
            if (!awaitPriority(current)) {
                return;
            }
            current.setConcedingPlayer(playerId);
            Player player = current.getPlayer(playerId);
            if (promptOpen && player != null) {
                // Wakes the waiting choice even when XMage has no priority player yet (mulligans).
                player.signalPlayerConcede(true);
            } else if (endsGame(current, playerId)) {
                // XMage applies another player's concession at the next answer of the player who
                // holds priority or a choice. When the concession ends the game (two players at a
                // human table, v0.4.0; since v0.9.3 the last team at Two-Headed Giant or King's
                // Table, or a King out), the game would wait for a winner to act, so the waiting
                // player is woken: XMage applies the concession, the game ends, and otherwise it
                // goes on waiting for the same answer.
                Player waiting = waitingPlayer(current);
                if (waiting != null && !waiting.getId().equals(playerId)) {
                    synchronized (this) {
                        // XMage will run on with that player's prompt still open: an inspection
                        // must not read while it does (v0.8.6). Under the lock, so one being built
                        // finishes first.
                        listening = null;
                    }
                    waiting.signalPlayerConcede(true);
                }
            }
        }
    }

    /**
     * Whether the game ends once this concession and earlier ones apply: at most one player stays,
     * or in a team format (v0.9.3) one team, or at King's Table a King is out (its team loses). At
     * Two-Headed Giant one player's concession takes their teammate with them (810.8b).
     */
    private boolean endsGame(Game current, UUID conceding) {
        Set<UUID> leaving = new HashSet<>();
        leaving.add(conceding);
        synchronized (this) {
            for (Seat seat : humans) {
                if (seat.concedeRequested) {
                    leaving.add(seat.id);
                }
            }
        }
        GameFormat format = request.format();
        if (format == GameFormat.TWO_HEADED_GIANT) {
            // A player's concession takes their whole team out of the game (810.8b).
            for (int index = 0; index < seatIds.size(); index++) {
                if (leaving.contains(seatIds.get(index))) {
                    leaving.add(seatIds.get(index ^ 1));
                }
            }
        }
        List<Integer> standing = new ArrayList<>();
        for (int index = 0; index < seatIds.size(); index++) {
            UUID id = seatIds.get(index);
            Player player = current.getPlayer(id);
            if (player != null && !player.hasLost() && !player.hasLeft() && !leaving.contains(id)) {
                standing.add(index);
            }
        }
        if (standing.size() <= 1 || !format.teams()) {
            return standing.size() <= 1;
        }
        if (format.kingsTable()) {
            for (int index = 0; index < seatIds.size(); index++) {
                if (KingsTableRules.king(index) && !standing.contains(index)) {
                    return true;
                }
            }
        }
        return standing.stream().map(format::teamOf).distinct().count() <= 1;
    }

    /** The player XMage waits for: who holds priority, or else who makes a choice. */
    private static Player waitingPlayer(Game current) {
        UUID id = current.getState().getPriorityPlayerId();
        if (id == null) {
            id = current.getState().getChoosingPlayerId();
        }
        return id == null ? null : current.getPlayer(id);
    }

    private static boolean over(Game game) {
        return game.hasEnded() || game.getState().isGameOver();
    }

    /**
     * Waits up to a second, while the game runs, for a player to hold priority or a choice. XMage
     * then queues a concession from any thread and applies it on its game thread. With nobody
     * holding either (between steps) it would check the game's end on the caller's thread, which it
     * refuses ("Non-game thread can't concede"). Returns whether the game still runs.
     */
    private static boolean awaitPriority(Game game) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1);
        try {
            while (!over(game) && game.getState().getPriorityPlayerId() == null
                    && game.getState().getChoosingPlayerId() == null && System.nanoTime() < deadline) {
                Thread.sleep(5);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return !over(game);
    }

    /** The game's current object for a human seat (see {@link Seat}). */
    private HumanPlayer current(Seat seat) {
        Game current = game;
        Player player = current == null ? null : current.getPlayer(seat.id);
        return player instanceof HumanPlayer human ? human : seat.player;
    }

    /** Request thread: the seat's latest snapshot newer than {@code since}, waiting up to {@code waitMillis}. */
    Snapshot snapshot(int seatIndex, long since, long waitMillis, int logFrom) throws InterruptedException {
        Seat seat = seats.get(seatIndex);
        long revisionNow;
        String statusNow;
        PromptView promptNow;
        SeatView viewNow;
        int logLimit;
        Result resultNow;
        synchronized (this) {
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(waitMillis);
            // While the journal is played again after a recovery (v0.9.9) the prompts that open are
            // the journal's to answer: a seat waits it out, and is shown none if it cannot wait.
            while ((seat.revision <= since || replaying) && result == null) {
                long remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
                if (remaining <= 0) {
                    break;
                }
                wait(remaining);
            }
            boolean answeredByJournal = replaying && result == null && seat.prompt != null;
            revisionNow = seat.revision;
            statusNow = answeredByJournal ? "waiting" : seat.status;
            promptNow = seat.prompt == null || answeredByJournal ? null : seat.prompt.view();
            viewNow = seat.view;
            logLimit = seat.logEntries;
            resultNow = result;
        }
        // The log as it was when the view was built: XMage writes "casts X" before any view shows X.
        LogPage page = logPage(logLimit, logFrom);
        return new Snapshot(id, revisionNow, statusNow, seatIndex, settings.forSeat(seatIndex), promptNow, viewNow,
            resultNow, page.count(), page.start(), page.lines());
    }

    /**
     * Request thread: what a spectator is shown, the public view of {@code spectatorDelaySeconds}
     * ago, newer than {@code since}, waiting up to {@code waitMillis}. The log and the result are
     * delayed with it.
     */
    Snapshot spectatorSnapshot(long since, long waitMillis, int logFrom) throws InterruptedException {
        Watched shown;
        synchronized (this) {
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(waitMillis);
            while (true) {
                long now = System.nanoTime();
                shown = matured(now);
                long remaining = TimeUnit.NANOSECONDS.toMillis(deadline - now);
                if ((shown != null && shown.revision() > since) || remaining <= 0) {
                    break;
                }
                // Sleep until the next view comes of age, or a new one is published.
                long delay = TimeUnit.SECONDS.toNanos(settings.spectatorDelaySeconds());
                long nextMaturity = Long.MAX_VALUE;
                for (Watched entry : watched) {
                    long age = now - entry.publishedNanos();
                    if (age < delay) {
                        nextMaturity = Math.min(nextMaturity, TimeUnit.NANOSECONDS.toMillis(delay - age) + 1);
                    }
                }
                wait(Math.max(1, Math.min(remaining, nextMaturity)));
            }
        }
        if (shown == null) {
            return new Snapshot(id, 0, "starting", null, settings.forSeat(-1), null, null, null, 0, 0, List.of());
        }
        LogPage page = logPage(shown.logEntries(), logFrom);
        return new Snapshot(id, shown.revision(), shown.result() == null ? "spectating" : "finished", null,
            settings.forSeat(-1), null, shown.view(), shown.result(), page.count(), page.start(), page.lines());
    }

    private record LogPage(int count, int start, List<LogLine> lines) {}

    /** The public log up to {@code rawLimit} entries, paged from {@code logFrom} (the last page if negative). */
    private LogPage logPage(int rawLimit, int logFrom) {
        List<MatchLog.Entry> entries = log.entries();
        List<LogLine> lines = new ArrayList<>();
        int count = 0;
        for (MatchLog.Entry entry : entries.subList(0, Math.min(rawLimit, entries.size()))) {
            // Engine errors stay in the engine's own log: their details are not seat-safe.
            if (entry.text().startsWith(ENGINE_ERROR_PREFIX)) {
                continue;
            }
            lines.add(new LogLine(count, entry.turn(), entry.activeSeat(), entry.step(),
                SeatViews.plain(entry.text())));
            count++;
        }
        int start = logFrom < 0 ? Math.max(0, count - DEFAULT_LOG_PAGE) : Math.min(logFrom, count);
        return new LogPage(count, start, List.copyOf(lines.subList(start, Math.min(count, start + MAX_LOG_PAGE))));
    }

    private Seat humanSeat(UUID playerId) {
        for (Seat seat : humans) {
            if (seat.id.equals(playerId)) {
                return seat;
            }
        }
        return null;
    }

    private Reply replay(Seat seat, SeatCommand command) {
        Recorded earlier = seat.actions.get(command.actionId());
        if (earlier == null) {
            return null;
        }
        if (!earlier.fingerprint().equals(command.fingerprint())) {
            return reject(seat, 409, "action_id_reused", "That action id was used for a different command");
        }
        return earlier.reply();
    }

    private Reply accepted(Seat seat, SeatCommand command) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", "accepted");
        body.put("action_id", command.actionId());
        body.put("revision", seat.revision);
        Reply reply = new Reply(200, body);
        seat.actions.put(command.actionId(), new Recorded(command.fingerprint(), reply));
        return reply;
    }

    private Reply reject(Seat seat, int httpStatus, String code, String message) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", code);
        body.put("message", message);
        body.put("revision", seat.revision);
        return new Reply(httpStatus, body);
    }

    /** Caller holds the lock. Something a seat or SysOp can see changed. */
    private void touch() {
        lastActivityNanos = System.nanoTime();
        version++;
    }

    /** Whether the game's bots are passive (v0.8.6, see {@link #setPassiveBots}). */
    boolean passiveBots() {
        return passiveBots.get();
    }

    /**
     * Request thread: makes every bot at the table passive, or normal again (v0.8.6), for SysOp's
     * tests. Each bot follows the switch at its next decision: a decision XMage's AI has already
     * started (a search) finishes as it would have. Only {@link FairBot}s follow it; a test's other
     * bot plays on. A change writes {@link #BOTS_PASSIVE} or {@link #BOTS_NORMAL} in the game's log;
     * setting the value the switch already has writes nothing. Returns the switch as it now is, or
     * null once the game has finished, when it changes nothing.
     */
    Boolean setPassiveBots(boolean passive) {
        synchronized (this) {
            if (result != null) {
                return null;
            }
            if (passiveBots.getAndSet(passive) != passive) {
                note(passive ? BOTS_PASSIVE : BOTS_NORMAL);
                if (recorder != null) {
                    JsonObject record = new JsonObject();
                    record.addProperty("type", "bots");
                    record.addProperty("passive", passive);
                    recorder.journal(record);
                }
            }
            return passive;
        }
    }

    /**
     * Caller holds the lock. Writes the engine's own line in the game's log (v0.8.6), at the turn
     * and step of the last line XMage wrote: it is written on a request thread, which does not read
     * XMage's state while the game thread may be changing it. A seat whose log already reached the
     * end is shown the line at once, at a new revision; a seat whose log stops short of XMage's last
     * lines (its next view is still to come) is shown it with that view, so its log still never runs
     * ahead of its board. Spectators are shown it with their next public view.
     */
    private void note(String text) {
        int before = log.size();
        log.note(text);
        int after = log.size();
        for (Seat seat : humans) {
            if (seat.logEntries >= before) {
                seat.logEntries = after;
                seat.revision++;
            }
        }
        touch();
        notifyAll();
    }

    /** Lets {@link #inspect} serve this game: service games only. */
    synchronized void allowInspection() {
        inspectable = true;
    }

    /**
     * Request thread: SysOp's inspection view, once XMage waits for a human seat's answer, waiting
     * up to {@code waitMillis} for that; null if it did not happen in time. A finished game returns
     * its final inspection. The view is built under the game's lock while the game thread is parked
     * in XMage's wait for the answer to an open prompt ({@link #settled}). Only an answer or the
     * engine wakes it, and both change what {@code settled} reads under the same lock before they
     * do, so XMage's state holds still while it is read.
     *
     * <p>Before v0.8.6 an open prompt was enough (bug E4). XMage publishes its request before it
     * waits: the game thread was still returning through the engine's listener and XMage's own code,
     * and an inspection could read XMage's state while that thread changed it.
     */
    Inspection inspect(long waitMillis) throws InterruptedException {
        synchronized (this) {
            if (!inspectable) {
                throw new IllegalStateException("Inspection is for service games only");
            }
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(waitMillis);
            while (result == null) {
                Game current = game;
                boolean settled = current != null && views != null && settled();
                if (settled && parked()) {
                    Inspection built = buildInspection(current, "live", null);
                    if (built != null) {
                        return built;
                    }
                }
                long remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
                if (remaining <= 0) {
                    return null;
                }
                // XMage said it waits but has not parked yet: nothing will notify when it does.
                wait(settled ? Math.min(remaining, PARK_POLL_MILLIS) : remaining);
            }
            return finalInspection;
        }
    }

    /**
     * Caller holds the lock. XMage's game thread is inside its wait for the answer to a human seat's
     * open prompt (v0.8.6: before, any open prompt), and nothing is ending the game. The seat may
     * hold the prompt for a player whose turn it controls, whose stand-in XMage waits on.
     */
    private boolean settled() {
        if (endRequest != null || listening == null) {
            return false;
        }
        int waitingFor = seatIds.indexOf(listening);
        return humans.stream().anyMatch(seat -> seat.prompt != null && !seat.concedeRequested
            && seat.promptFor == waitingFor);
    }

    /**
     * Whether the game thread is parked (v0.8.6). XMage reports its wait as it goes into it
     * ({@link #waiting}) and then runs a few lines of its own (it resets the answer it will take
     * and notes what it waits for) before it parks in {@code Object.wait}; only then is it blocked.
     * Inside that method nothing else parks the thread, and an answer that would wake it first closes
     * the prompt under this lock.
     */
    private boolean parked() {
        return thread.getState() == Thread.State.WAITING;
    }

    /**
     * Game thread (v0.8.6): XMage goes into its wait for {@code player}'s answer, or comes out of
     * it. An inspection waiting for the game to settle is woken to look.
     */
    private void waiting(Player player, boolean waiting) {
        synchronized (this) {
            if (waiting) {
                listening = player.getId();
                notifyAll();
            } else if (player.getId().equals(listening)) {
                listening = null;
            }
        }
    }

    /**
     * Every player's hand and library, field by field, with a builder of its own (the game thread's
     * keeps caches). Null if XMage's state changed under it.
     */
    private Inspection buildInspection(Game current, String status, Result outcome) {
        try {
            var builder = new SeatViews(current, seatIds, refs);
            SeatView publicView = builder.buildPublic();
            List<Concealed> players = new ArrayList<>();
            for (int seat = 0; seat < seatIds.size(); seat++) {
                Player player = current.getPlayer(seatIds.get(seat));
                List<SeatView.CardInfo> hand = new ArrayList<>();
                List<SeatView.CardInfo> library = new ArrayList<>();
                if (player != null) {
                    player.getHand().getCards(current).forEach(card -> hand.add(builder.card(card, true)));
                    // XMage's library iterates from the top.
                    player.getLibrary().getCards(current).forEach(card -> library.add(builder.card(card, true)));
                }
                players.add(new Concealed(seat, player == null ? null : player.getName(), List.copyOf(hand),
                    List.copyOf(library)));
            }
            long at;
            synchronized (this) {
                at = version;
            }
            return new Inspection(id, at, status, settings, publicView, List.copyOf(players), outcome);
        } catch (RuntimeException e) {
            System.err.println("Inspection of game " + id + " failed: " + e);
            return null;
        }
    }

    /**
     * For tests (v0.9.9): the game is gone as its process would be. Its recording stops here, with
     * no result, exactly as it stands on disk; then the game's thread is ended and its seats see an
     * error, which nothing records. The recording is what a recovery finds.
     */
    void interrupt() {
        if (recorder != null) {
            recorder.close();
        }
        synchronized (this) {
            interrupted = true;
            if (endRequest == null) {
                endRequest = "interrupted";
            }
        }
        Game stopping = game;
        if (stopping != null) {
            stopping.end();
        }
        BotMatchRunner.stop(thread);
    }

    /** The game's recorder (v0.9.9); null for a game that keeps no recording. */
    Recorder recorder() {
        return recorder;
    }

    /** The game's result as its seats and its recording have it; null while it has none. */
    synchronized JsonObject resultJson() {
        return result == null ? null : EngineServer.JSON.toJsonTree(result).getAsJsonObject();
    }

    /** Whether the journal is still being played again after a recovery (v0.9.9). */
    synchronized boolean replaying() {
        return replaying;
    }

    /** How many of the journal's records were played again after a recovery (v0.9.9). */
    synchronized int replayed() {
        return replayed;
    }

    /**
     * How many of the journal's records were left unplayed after a recovery (v0.9.9): the game asked
     * something else than they answered, and went on from there.
     */
    synchronized int replayDropped() {
        return replayDropped;
    }

    // For tests: XMage's state may be read only while a prompt is open (the game thread is waiting).

    /** Whether XMage's game thread is parked in its wait for a human seat's answer (v0.8.6). */
    synchronized boolean settledForInspection() {
        return settled() && parked();
    }

    Game game() {
        return game;
    }

    ObjectRefs refs() {
        return refs;
    }

    List<UUID> seatIds() {
        return seatIds;
    }

    synchronized Prompts.Prompt openPrompt(int seatIndex) {
        Seat seat = seats.get(seatIndex);
        return seat == null ? null : seat.prompt;
    }

    /** The seat with an open prompt, waiting up to {@code waitMillis}; -1 if none, -2 once finished. */
    synchronized int awaitPromptSeat(long waitMillis) throws InterruptedException {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(waitMillis);
        while (result == null) {
            for (Seat seat : humans) {
                if (seat.prompt != null && !replaying) {
                    return seat.index;
                }
            }
            long remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
            if (remaining <= 0) {
                return -1;
            }
            wait(remaining);
        }
        return -2;
    }
}
