package com.commanderduels;

import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import mage.cards.decks.Deck;
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
 * consistent; request threads read the published snapshots. Games live in memory only: there is no
 * journal or recovery yet.
 *
 * <p>A service game can also be inspected ({@link #inspect}): every hand and library, in order,
 * for SysOp. That view is built only while XMage is waiting for a human seat's answer, when the
 * game thread is parked and XMage's state holds still.
 */
final class HumanGame {
    static final long CLOSE_GRACE_MILLIS = 5_000;
    private static final int MAX_MESSAGES = 10;
    private static final int DEFAULT_LOG_PAGE = 20;
    static final int MAX_LOG_PAGE = 200;
    private static final int MAX_RECORDED_ACTIONS = 512;
    private static final String ENGINE_ERROR_PREFIX = "ENGINE ERROR:";

    /** A seat at the table. A seat's snapshot names only its own deck. */
    record SeatSettings(int seat, String player, String deck) {}

    record Settings(String format, String rulesProfile, List<SeatSettings> seats, int skill, int turnCap,
                    int idleTimeoutSeconds, int spectatorDelaySeconds) {
        /** What one seat is told (other seats' decks are private); a spectator, seat -1, sees no deck. */
        Settings forSeat(int seat) {
            return new Settings(format, rulesProfile, seats.stream()
                .map(entry -> entry.seat() == seat ? entry : new SeatSettings(entry.seat(), entry.player(), null))
                .toList(), skill, turnCap, idleTimeoutSeconds, spectatorDelaySeconds);
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

        /** Every view (and prompt, if one opens) published to a human seat. */
        default void published(Game game, ObjectRefs refs, int seat, SeatView view, PromptView prompt) {}

        /** Every public view published for spectators, when it is published (before any delay). */
        default void spectated(Game game, ObjectRefs refs, SeatView view) {}

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
    private final ObjectRefs refs = new ObjectRefs();
    private final MatchLog log = new MatchLog();
    private final Thread thread;

    // Game thread only.
    private SeatViews views;

    private volatile Game game;

    // Guarded by this.
    private Result result;
    private boolean inspectable;
    private Inspection finalInspection;
    private long version;
    private String endRequest;
    private final List<Integer> conceded = new ArrayList<>();
    private long lastActivityNanos = System.nanoTime();
    // Spectators: public views, kept long enough to serve them spectatorDelaySeconds late.
    private final Deque<Watched> watched = new ArrayDeque<>();
    private SeatView spectatorView;
    private long spectatorRevision;

    HumanGame(String id, HumanGameRequest request, Path deckDirectory, Consumer<HumanGame> onFinished) {
        this(id, request, deckDirectory, onFinished, Hooks.NONE);
    }

    HumanGame(String id, HumanGameRequest request, Path deckDirectory, Consumer<HumanGame> onFinished,
              Hooks hooks) {
        this.id = id;
        this.hooks = hooks;
        this.request = request;
        GameFormat format = request.format();
        List<SeatSettings> seatSettings = new ArrayList<>();
        List<Player> seated = new ArrayList<>();
        List<Seat> bySeat = new ArrayList<>();
        for (int index = 0; index < request.seats().size(); index++) {
            HumanGameRequest.Seat seat = request.seats().get(index);
            seatSettings.add(new SeatSettings(index, seat.player(), seat.deck()));
            if (seat.human()) {
                var human = new HumanPlayer(name(seat, index), format.range(), 0);
                // XMage's server sets each human's preferences on connect; these are its defaults (stop in
                // both main phases, at declare attackers and blockers, and whenever something new is on
                // the stack).
                human.setUserData(UserData.getDefaultUserDataView());
                seated.add(human);
                bySeat.add(new Seat(index, human));
            } else {
                seated.add(hooks.bot(index, name(seat, index), format.range(), request.skill(), request.seed()));
                bySeat.add(null);
            }
        }
        this.settings = new Settings(format.id(), format.rulesProfile(seated.size()), List.copyOf(seatSettings),
            request.skill(), request.turnCap(), request.idleTimeoutSeconds(), request.spectatorDelaySeconds());
        this.players = List.copyOf(seated);
        // Stream.toList tolerates indexOf(null): XMage has no active player before the first turn.
        this.seatIds = seated.stream().map(Player::getId).toList();
        this.seats = Collections.unmodifiableList(bySeat);
        this.humans = bySeat.stream().filter(seat -> seat != null).toList();
        this.deckDirectory = deckDirectory;
        this.onFinished = onFinished;
        this.thread = new Thread(this::run, ThreadUtils.THREAD_PREFIX_GAME + " human_game " + id);
        this.thread.setDaemon(true);
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

    private void play() throws Exception {
        // XMage's only seed control: one process-wide generator for shuffles, coin flips and AI ties.
        RandomUtil.setSeed(request.seed());
        GameFormat format = request.format();
        List<Deck> decks = new ArrayList<>();
        for (HumanGameRequest.Seat seat : request.seats()) {
            decks.add(seat.custom() != null ? DeckLists.load(seat.custom()) : format.loadDeck(deckDirectory, seat.deck()));
        }
        Game created = format.newGame(players.size(), request.turnCap());
        Match match = format.newMatch("Commander Duels development game", players.size());
        // XMage's player list inserts each player it is given at the front, so turns pass in the
        // opposite order to the one players were added in. Adding seat 0 and then the others in
        // reverse makes the turn order follow the seat numbers: 0, 1, 2, 3.
        for (int index : additionOrder(players.size())) {
            LegacyDuel.seat(created, match, players.get(index), decks.get(index));
        }
        format.seatTeams(created, seatIds);
        views = new SeatViews(created, seatIds, refs);
        log.attach(created, seatIds);
        created.addTableEventListener(event -> {
            if (event.getEventType() == TableEvent.EventType.UPDATE) {
                refresh();
            }
        });
        created.addPlayerQueryEventListener(this::onQuery);
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
            } else {
                created.start(seatIds.get(RandomUtil.nextInt(seatIds.size())));
            }
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

    /** Game thread: XMage is about to wait for a human seat's answer. */
    private void onQuery(PlayerQueryEvent event) {
        Seat seat = humanSeat(event.getPlayerId());
        if (seat == null) {
            return;
        }
        if (event.getQueryType() == PlayerQueryEvent.QueryType.PERSONAL_MESSAGE) {
            String text = SeatViews.plain(event.getMessage());
            if (!text.isEmpty()) {
                seat.messages.addLast(text);
                while (seat.messages.size() > MAX_MESSAGES) {
                    seat.messages.removeFirst();
                }
            }
            refresh();
            return;
        }
        String attacker;
        boolean leaving;
        synchronized (this) {
            attacker = seat.lastAttacker;
            leaving = seat.concedeRequested || endRequest != null;
        }
        HumanPlayer human = current(seat);
        Prompts.Prompt next = Prompts.build(event, game, human, views, UUID.randomUUID().toString(), attacker);
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
        hooks.published(game, refs, seat.index, seatView, leaving ? null : next.view());
        boolean concede;
        boolean closing;
        synchronized (this) {
            concede = seat.concedeRequested;
            closing = endRequest != null;
            // A seat that has conceded, or any seat of a game being closed, is not asked: the
            // concession below makes XMage drop this request, and the seat leaves the game.
            boolean ask = !concede && !closing;
            seat.revision++;
            seat.prompt = ask ? next : null;
            seat.view = seatView;
            seat.logEntries = logged;
            seat.status = !ask ? "waiting" : next.supported() ? "your_prompt" : "unsupported_prompt";
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
            game.setConcedingPlayer(seat.id);
            human.signalPlayerConcede(true);
            // XMage has removed the seat: its view now says it is out.
            publish(seat);
        }
    }

    /** Game thread: the state changed without a request to a human seat. */
    private void refresh() {
        if (views == null) {
            return;
        }
        for (Seat seat : humans) {
            publish(seat);
        }
        publishSpectators();
        Game current = game;
        if (current != null && current.getStartTime() != null && !current.hasEnded()
                && humans.stream().map(this::current).allMatch(human -> human.hasLost() || human.hasLeft())
                && current.getPlayers().values().stream().filter(p -> !p.hasLost() && !p.hasLeft()).count() > 1) {
            // Every human seat is out and two or more bots play on: there is nobody left to play for.
            // With one player left XMage ends the game itself, and a close would race it.
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
        synchronized (this) {
            Reply earlier = replay(seat, command);
            if (earlier != null) {
                return earlier;
            }
            if (result != null) {
                return reject(seat, 409, "game_over", "The game has finished");
            }
            Prompts.Prompt prompt = seat.prompt;
            if (prompt == null || !prompt.view().id().equals(command.promptId())) {
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
            } else {
                answer = prompt.answers().get(command.optionId());
                if (answer == null) {
                    return reject(seat, 422, "invalid_option", "The prompt has no such option");
                }
            }
            if (prompt.view().kind().equals("declare_attackers")) {
                // XMage's defender choice that may follow does not say which attacker it is for.
                PromptView.Option option = prompt.view().options().stream()
                    .filter(candidate -> candidate.id().equals(command.optionId())).findFirst().orElse(null);
                seat.lastAttacker = option == null ? null
                    : option.action().equals("all_attack") ? "all attackers" : option.label();
            }
            seat.prompt = null;
            seat.revision++;
            seat.status = "waiting";
            touch();
            reply = accepted(seat, command);
            notifyAll();
        }
        // Outside the lock: XMage hands the answer to the waiting game thread.
        answer.apply(current(seat));
        return reply;
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
        synchronized (this) {
            Reply reply = accepted(seat, command);
            reply.body().put("priority", Priority.controls(human));
            touch();
            return reply;
        }
    }

    /** Request thread: the seat concedes. In a game of three or more the others play on. */
    Reply concede(int seatIndex, SeatCommand command) {
        Seat seat = seats.get(seatIndex);
        Reply reply;
        boolean promptOpen;
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
            promptOpen = markConcession(seat);
            conceded.add(seat.index);
            reply = accepted(seat, command);
        }
        applyConcession(seat.id, promptOpen);
        return reply;
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
                    promptsOpen.add(false);
                }
            }
            for (Seat seat : humans) {
                if (!seat.concedeRequested) {
                    conceding.add(seat.id);
                    promptsOpen.add(markConcession(seat));
                }
            }
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

    /** Caller holds the lock. Closes any open prompt; returns whether one was open. */
    private boolean markConcession(Seat seat) {
        boolean promptOpen = seat.prompt != null;
        seat.concedeRequested = true;
        seat.prompt = null;
        seat.status = "waiting";
        seat.revision++;
        touch();
        notifyAll();
        return promptOpen;
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
            } else if (lastStanding(current, playerId)) {
                // XMage applies another player's concession at the next answer of the player who
                // holds priority or a choice. When the concession leaves that player alone (two
                // players at a human table, v0.4.0), the game would wait for the winner to act, so
                // the waiting player is woken: XMage applies the concession, the game ends, and
                // otherwise it goes on waiting for the same answer.
                Player waiting = waitingPlayer(current);
                if (waiting != null && !waiting.getId().equals(playerId)) {
                    waiting.signalPlayerConcede(true);
                }
            }
        }
    }

    /** Whether at most one player stays in the game once this concession and earlier ones apply. */
    private boolean lastStanding(Game current, UUID conceding) {
        List<UUID> leaving = new ArrayList<>();
        synchronized (this) {
            for (Seat seat : humans) {
                if (seat.concedeRequested) {
                    leaving.add(seat.id);
                }
            }
        }
        long standing = current.getPlayers().values().stream()
            .filter(player -> !player.hasLost() && !player.hasLeft())
            .filter(player -> !player.getId().equals(conceding) && !leaving.contains(player.getId()))
            .count();
        return standing <= 1;
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
            while (seat.revision <= since && result == null) {
                long remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
                if (remaining <= 0) {
                    break;
                }
                wait(remaining);
            }
            revisionNow = seat.revision;
            statusNow = seat.status;
            promptNow = seat.prompt == null ? null : seat.prompt.view();
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

    /** Lets {@link #inspect} serve this game: service games only. */
    synchronized void allowInspection() {
        inspectable = true;
    }

    /**
     * Request thread: SysOp's inspection view, once XMage waits for a human seat's answer, waiting
     * up to {@code waitMillis} for that; null if it did not happen in time. A finished game returns
     * its final inspection. The view is built under the game's lock while a prompt is open: the game
     * thread is parked in XMage's wait for that answer, and an answer cannot close the prompt until
     * the lock is free, so XMage's state holds still while it is read.
     */
    Inspection inspect(long waitMillis) throws InterruptedException {
        synchronized (this) {
            if (!inspectable) {
                throw new IllegalStateException("Inspection is for service games only");
            }
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(waitMillis);
            while (result == null) {
                Game current = game;
                if (current != null && views != null && settled()) {
                    Inspection built = buildInspection(current, "live", null);
                    if (built != null) {
                        return built;
                    }
                }
                long remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
                if (remaining <= 0) {
                    return null;
                }
                wait(remaining);
            }
            return finalInspection;
        }
    }

    /** Caller holds the lock. A human seat's prompt is open and nothing is ending the game. */
    private boolean settled() {
        return endRequest == null && humans.stream().anyMatch(seat -> seat.prompt != null && !seat.concedeRequested);
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

    // For tests: XMage's state may be read only while a prompt is open (the game thread is waiting).

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
                if (seat.prompt != null) {
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
