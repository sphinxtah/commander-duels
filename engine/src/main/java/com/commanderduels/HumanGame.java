package com.commanderduels;

import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.stream.Stream;
import mage.cards.decks.Deck;
import mage.constants.RangeOfInfluence;
import mage.game.Game;
import mage.game.events.PlayerQueryEvent;
import mage.game.events.TableEvent;
import mage.game.match.Match;
import mage.player.ai.ComputerPlayerControllableProxy;
import mage.player.human.HumanPlayer;
import mage.players.Player;
import mage.players.net.UserData;
import mage.util.RandomUtil;
import mage.util.ThreadUtils;

/**
 * One development game: XMage's own {@link HumanPlayer} in seat 0 against a "Computer - mad" player
 * in seat 1, with fixture decks under Legacy rules.
 *
 * <p>XMage's human player blocks the game thread until it gets an answer. Each request it fires (a
 * {@link PlayerQueryEvent}) becomes a typed prompt with a new id, published together with the seat's
 * view at a new revision. An answer is accepted only for the open prompt at the current revision;
 * it then closes, and XMage's next request opens the next prompt. Views and prompts are built on the
 * game thread, the only place XMage's state is consistent; request threads read the published
 * snapshot. Games live in memory only: there is no journal or recovery yet.
 */
final class HumanGame {
    static final int HUMAN_SEAT = 0;
    static final String HUMAN_NAME = "Human";
    static final String BOT_NAME = "Bot";
    static final long CLOSE_GRACE_MILLIS = 5_000;
    private static final int MAX_MESSAGES = 10;
    private static final int DEFAULT_LOG_PAGE = 20;
    static final int MAX_LOG_PAGE = 200;
    private static final int MAX_RECORDED_ACTIONS = 512;
    private static final String ENGINE_ERROR_PREFIX = "ENGINE ERROR:";

    record Settings(String humanDeck, String botDeck, int skill, int turnCap, int idleTimeoutSeconds) {}

    /**
     * @param kind completed (a winner or a draw), turn_limit, closed, idle_timeout or error
     */
    record Result(String kind, Integer winnerSeat, boolean draw, boolean conceded, int turns, String error) {}

    record LogLine(int index, int turn, Integer activeSeat, String step, String text) {}

    /**
     * What the seat is shown. {@code status} is starting, your_prompt, unsupported_prompt, waiting
     * (the bot is acting or XMage is processing) or finished.
     */
    record Snapshot(String gameId, long revision, String status, int seat, Settings settings, PromptView prompt,
                    SeatView view, Result result, int logCount, int logFrom, List<LogLine> log) {}

    /** A response to a seat command: an HTTP status and its JSON body. */
    record Reply(int status, Map<String, Object> body) {}

    private record Recorded(String fingerprint, Reply reply) {}

    /** Test hooks, called on the game thread while XMage's state is consistent. */
    interface Hooks {
        Hooks NONE = new Hooks() {};

        default void beforeStart(Game game, List<UUID> seatIds) {}

        /** Every view (and prompt, if one opens) published to the seat. */
        default void published(Game game, ObjectRefs refs, SeatView view, PromptView prompt) {}
    }

    private final String id;
    private final HumanGameRequest request;
    private final Settings settings;
    private final Path deckDirectory;
    private final Consumer<HumanGame> onFinished;
    private final Hooks hooks;
    private final HumanPlayer human;
    private final Player bot;
    private final List<UUID> seatIds;
    private final ObjectRefs refs = new ObjectRefs();
    private final MatchLog log = new MatchLog();
    private final Thread thread;

    // Game thread only.
    private final Deque<String> messages = new ArrayDeque<>();
    private SeatViews views;

    private volatile Game game;
    private volatile boolean concedeRequested;

    // Guarded by this.
    private long revision;
    private String status = "starting";
    private Prompts.Prompt prompt;
    private SeatView view;
    private Result result;
    private String endRequest;
    private long lastActivityNanos = System.nanoTime();
    private final Map<String, Recorded> actions = new LinkedHashMap<>() {
        private static final long serialVersionUID = 1L;

        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Recorded> eldest) {
            return size() > MAX_RECORDED_ACTIONS;
        }
    };

    HumanGame(String id, HumanGameRequest request, Path deckDirectory, Consumer<HumanGame> onFinished) {
        this(id, request, deckDirectory, onFinished, Hooks.NONE);
    }

    HumanGame(String id, HumanGameRequest request, Path deckDirectory, Consumer<HumanGame> onFinished,
              Hooks hooks) {
        this.id = id;
        this.hooks = hooks;
        this.request = request;
        this.settings = new Settings(request.humanDeck(), request.botDeck(), request.skill(), request.turnCap(),
            request.idleTimeoutSeconds());
        this.deckDirectory = deckDirectory;
        this.onFinished = onFinished;
        this.human = new HumanPlayer(HUMAN_NAME, RangeOfInfluence.ONE, 0);
        // XMage's server sets each human's preferences on connect; these are its defaults (stop in both
        // main phases, at declare attackers and blockers, and whenever something new is on the stack).
        this.human.setUserData(UserData.getDefaultUserDataView());
        this.bot = new ComputerPlayerControllableProxy(BOT_NAME, RangeOfInfluence.ONE, request.skill());
        // Stream.toList tolerates indexOf(null): XMage has no active player before the first turn.
        this.seatIds = Stream.of(human.getId(), bot.getId()).toList();
        this.thread = new Thread(this::run, ThreadUtils.THREAD_PREFIX_GAME + " human_game " + id);
        this.thread.setDaemon(true);
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
        }
    }

    private void play() throws Exception {
        // XMage's only seed control: one process-wide generator for shuffles, coin flips and AI ties.
        RandomUtil.setSeed(request.seed());
        Deck humanDeck = LegacyDuel.loadDeck(deckDirectory, request.humanDeck());
        Deck botDeck = LegacyDuel.loadDeck(deckDirectory, request.botDeck());
        Game created = LegacyDuel.newGame(request.turnCap());
        Match match = LegacyDuel.newMatch("Commander Duels human game");
        LegacyDuel.seat(created, match, human, humanDeck);
        LegacyDuel.seat(created, match, bot, botDeck);
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
        if (!concedeRequested) {
            created.start(seatIds.get(RandomUtil.nextInt(seatIds.size())));
        }
    }

    /** Game thread: XMage is about to wait for the human seat's answer. */
    private void onQuery(PlayerQueryEvent event) {
        if (!human.getId().equals(event.getPlayerId())) {
            return;
        }
        if (event.getQueryType() == PlayerQueryEvent.QueryType.PERSONAL_MESSAGE) {
            String text = SeatViews.plain(event.getMessage());
            if (!text.isEmpty()) {
                messages.addLast(text);
                while (messages.size() > MAX_MESSAGES) {
                    messages.removeFirst();
                }
            }
            refresh();
            return;
        }
        Prompts.Prompt next = Prompts.build(event, game, human, views, UUID.randomUUID().toString());
        SeatView seatView = views.build(HUMAN_SEAT, List.copyOf(messages));
        hooks.published(game, refs, seatView, next.view());
        synchronized (this) {
            revision++;
            prompt = next;
            view = seatView;
            status = next.supported() ? "your_prompt" : "unsupported_prompt";
            touch();
            notifyAll();
        }
        if (concedeRequested) {
            // A concession that arrived before the game had started is applied here, on the game thread.
            game.setConcedingPlayer(human.getId());
        }
    }

    /** Game thread: the state changed without a request to the human seat. */
    private void refresh() {
        if (views == null) {
            return;
        }
        SeatView seatView = views.build(HUMAN_SEAT, List.copyOf(messages));
        hooks.published(game, refs, seatView, null);
        synchronized (this) {
            // While a prompt is open the game thread is waiting, so its view is still current.
            if (result != null || prompt != null) {
                return;
            }
            revision++;
            view = seatView;
            status = "waiting";
            touch();
            notifyAll();
        }
    }

    private void finish(Throwable failure) {
        Game finished = game;
        SeatView finalView = null;
        if (finished != null && views != null) {
            try {
                finalView = views.build(HUMAN_SEAT, List.copyOf(messages));
                hooks.published(finished, refs, finalView, null);
            } catch (RuntimeException e) {
                // keep the last published view
            }
        }
        Result outcome = outcome(finished, failure);
        synchronized (this) {
            revision++;
            result = outcome;
            prompt = null;
            if (finalView != null) {
                view = finalView;
            }
            status = "finished";
            touch();
            notifyAll();
        }
        views = null;
        game = null;
    }

    private Result outcome(Game finished, Throwable failure) {
        int turns = finished == null ? 0 : Math.min(finished.getTurnNum(), request.turnCap());
        String requested;
        synchronized (this) {
            requested = endRequest;
        }
        if (failure != null) {
            return new Result("error", null, false, false, turns, BotMatchRunner.describe(failure));
        }
        if (log.criticalError() != null) {
            return new Result("error", null, false, false, turns, "XMage ended the game after an internal error");
        }
        if (requested != null) {
            return new Result(requested, null, false, false, turns, null);
        }
        if (finished != null && finished.hasEnded()) {
            Integer winner = null;
            for (int seat = 0; seat < seatIds.size(); seat++) {
                if (finished.getPlayer(seatIds.get(seat)).hasWon()) {
                    winner = seat;
                }
            }
            return new Result("completed", winner, finished.isADraw(), concedeRequested, turns, null);
        }
        if (finished != null && finished.getTurnNum() > request.turnCap()) {
            return new Result("turn_limit", null, false, false, turns, null);
        }
        return new Result("error", null, false, false, turns, "Game stopped without a result");
    }

    /** Request thread: answers the open prompt. */
    Reply submit(SeatCommand command) {
        Prompts.Answer answer;
        Reply reply;
        synchronized (this) {
            Reply earlier = replay(command);
            if (earlier != null) {
                return earlier;
            }
            if (result != null) {
                return reject(409, "game_over", "The game has finished");
            }
            if (prompt == null || !prompt.view().id().equals(command.promptId())) {
                return reject(409, "stale_prompt", "That prompt is no longer open");
            }
            if (command.expectedRevision() != revision) {
                return reject(409, "stale_revision", "The game has moved on; fetch the view again");
            }
            if (!prompt.supported()) {
                return reject(409, "unsupported_prompt",
                    "This request is not supported yet; concede or close the game");
            }
            if (command.amounts() != null) {
                answer = prompt.amounts(command.amounts());
                if (answer == null) {
                    return reject(422, "invalid_amounts", prompt.view().amounts() == null
                        ? "This prompt does not take amounts" : "The amounts break the prompt's limits");
                }
            } else {
                answer = prompt.answers().get(command.optionId());
                if (answer == null) {
                    return reject(422, "invalid_option", "The prompt has no such option");
                }
            }
            prompt = null;
            revision++;
            status = "waiting";
            touch();
            reply = accepted(command);
            notifyAll();
        }
        // Outside the lock: XMage hands the answer to the waiting game thread.
        answer.apply(human);
        return reply;
    }

    /** Request thread: the human seat concedes the game. */
    Reply concede(SeatCommand command) {
        Reply reply;
        boolean promptOpen;
        synchronized (this) {
            Reply earlier = replay(command);
            if (earlier != null) {
                return earlier;
            }
            if (result != null) {
                return reject(409, "game_over", "The game has finished");
            }
            promptOpen = markConcession();
            reply = accepted(command);
        }
        applyConcession(promptOpen);
        return reply;
    }

    /** Ends the game: the seat concedes, and the result records {@code reason} instead of a winner. */
    Map<String, Object> close(String reason) {
        boolean promptOpen;
        synchronized (this) {
            if (result != null) {
                return closeBody();
            }
            if (endRequest == null) {
                endRequest = reason;
            }
            promptOpen = markConcession();
        }
        applyConcession(promptOpen);
        if (!BotMatchRunner.join(thread, CLOSE_GRACE_MILLIS)) {
            // The game thread did not reach the concession (for instance, a long AI search): end the
            // game and keep interrupting until the thread exits.
            Game current = game;
            Thread.ofVirtual().name("human-game-stopper").start(() -> {
                if (current != null) {
                    current.end();
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
        body.put("revision", revision);
        return body;
    }

    /** Caller holds the lock. Closes any open prompt; returns whether one was open. */
    private boolean markConcession() {
        boolean promptOpen = prompt != null;
        concedeRequested = true;
        prompt = null;
        status = "waiting";
        revision++;
        touch();
        notifyAll();
        return promptOpen;
    }

    private void applyConcession(boolean promptOpen) {
        Game current = game;
        // XMage's server records a concession from its request threads too. Before the game has
        // started, with no prompt waiting, the next prompt applies it on the game thread instead.
        if (current != null && (promptOpen || current.getStartTime() != null)) {
            current.setConcedingPlayer(human.getId());
            if (promptOpen) {
                // Wakes the waiting choice even when XMage has no priority player yet (mulligans).
                human.signalPlayerConcede(true);
            }
        }
    }

    /** Request thread: the latest snapshot newer than {@code since}, waiting up to {@code waitMillis}. */
    Snapshot snapshot(long since, long waitMillis, int logFrom) throws InterruptedException {
        long revisionNow;
        String statusNow;
        PromptView promptNow;
        SeatView viewNow;
        Result resultNow;
        synchronized (this) {
            long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(waitMillis);
            while (revision <= since && result == null) {
                long remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
                if (remaining <= 0) {
                    break;
                }
                wait(remaining);
            }
            revisionNow = revision;
            statusNow = status;
            promptNow = prompt == null ? null : prompt.view();
            viewNow = view;
            resultNow = result;
        }
        List<MatchLog.Entry> entries = log.entries();
        List<LogLine> lines = new ArrayList<>();
        int count = 0;
        int from = logFrom < 0 ? -1 : logFrom;
        for (MatchLog.Entry entry : entries) {
            // Engine errors stay in the engine's own log: their details are not seat-safe.
            if (entry.text().startsWith(ENGINE_ERROR_PREFIX)) {
                continue;
            }
            lines.add(new LogLine(count, entry.turn(), entry.activeSeat(), entry.step(),
                SeatViews.plain(entry.text())));
            count++;
        }
        int start = from < 0 ? Math.max(0, count - DEFAULT_LOG_PAGE) : Math.min(from, count);
        List<LogLine> page = List.copyOf(lines.subList(start, Math.min(count, start + MAX_LOG_PAGE)));
        return new Snapshot(id, revisionNow, statusNow, HUMAN_SEAT, settings, promptNow, viewNow, resultNow, count,
            start, page);
    }

    private Reply replay(SeatCommand command) {
        Recorded earlier = actions.get(command.actionId());
        if (earlier == null) {
            return null;
        }
        if (!earlier.fingerprint().equals(command.fingerprint())) {
            return reject(409, "action_id_reused", "That action id was used for a different command");
        }
        return earlier.reply();
    }

    private Reply accepted(SeatCommand command) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", "accepted");
        body.put("action_id", command.actionId());
        body.put("revision", revision);
        Reply reply = new Reply(200, body);
        actions.put(command.actionId(), new Recorded(command.fingerprint(), reply));
        return reply;
    }

    private Reply reject(int httpStatus, String code, String message) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", code);
        body.put("message", message);
        body.put("revision", revision);
        return new Reply(httpStatus, body);
    }

    private void touch() {
        lastActivityNanos = System.nanoTime();
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

    synchronized Prompts.Prompt openPrompt() {
        return prompt;
    }
}
