package com.commanderduels;

import java.lang.management.ManagementFactory;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import java.util.stream.Collectors;
import mage.cards.Card;
import mage.cards.decks.Deck;
import mage.cards.decks.DeckCardLists;
import mage.cards.decks.DeckValidator;
import mage.cards.decks.DeckValidatorError;
import mage.cards.decks.importer.DeckImporter;
import mage.constants.MultiplayerAttackOption;
import mage.constants.PhaseStep;
import mage.constants.RangeOfInfluence;
import mage.deck.Legacy;
import mage.game.Game;
import mage.game.GameException;
import mage.game.GameOptions;
import mage.game.TwoPlayerDuel;
import mage.game.TwoPlayerMatch;
import mage.game.match.Match;
import mage.game.match.MatchOptions;
import mage.game.mulligan.MulliganType;
import mage.player.ai.ComputerPlayerControllableProxy;
import mage.players.Player;
import mage.util.RandomUtil;
import mage.util.ThreadUtils;

/**
 * Plays one Legacy-rules Two Player Duel between two XMage "Computer - mad" players, driving the
 * game objects directly as XMage's own test framework does (no server, users or sessions). Like the
 * test framework, it registers the players with a match that is never started: the AI's search
 * copies each player's match record and fails without one.
 *
 * <p>The game runs on its own platform thread, named with XMage's GAME prefix because engine code
 * asserts it runs on a game thread. The caller's thread enforces the wall-clock budget. XMage stops
 * a game when its thread is interrupted, but its AI catches InterruptedException while waiting on a
 * search and clears the flag, so the stop path keeps interrupting until the thread exits.
 */
public final class BotMatchRunner {
    public static final List<String> DECKS = List.of("legacy-mono-red-burn", "legacy-mono-green-creatures");
    static final String[] SEAT_NAMES = {"Bot A", "Bot B"};
    static final long STOP_GRACE_MILLIS = 15_000;
    private static final int LEGACY_MIN_DECK = 60;
    private static final int START_LIFE = 20;
    private static final int START_HAND = 7;

    /** The result plus the game thread, which may still be alive if it ignored the stop request. */
    public record Outcome(BotMatchResult result, Thread gameThread) {}

    private record Report(boolean ended, boolean draw, Integer winnerSeat, int turns, Integer startingSeat,
                          List<BotMatchResult.Seat> seats) {}

    private final Path deckDirectory;
    private final XmagePin pin;
    private final Consumer<Game> beforeStart;

    public BotMatchRunner(Path deckDirectory, XmagePin pin) {
        this(deckDirectory, pin, game -> {});
    }

    /** {@code beforeStart} runs on the game thread just before the game starts (tests only). */
    BotMatchRunner(Path deckDirectory, XmagePin pin, Consumer<Game> beforeStart) {
        this.deckDirectory = deckDirectory;
        this.pin = pin;
        this.beforeStart = beforeStart;
    }

    public Outcome run(BotMatchRequest request) {
        var log = new MatchLog();
        var report = new AtomicReference<Report>();
        var failure = new AtomicReference<Throwable>();
        String name = ThreadUtils.THREAD_PREFIX_GAME + " bot_match " + UUID.randomUUID();
        Thread thread = new Thread(() -> {
            try {
                report.set(play(request, log));
            } catch (Throwable t) {
                failure.set(t);
            }
        }, name);
        thread.setDaemon(true);

        long started = System.nanoTime();
        thread.start();
        boolean timedOut = !join(thread, TimeUnit.SECONDS.toMillis(request.timeBudgetSeconds()));
        long durationMs = (System.nanoTime() - started) / 1_000_000;
        if (timedOut) {
            stop(thread);
        }

        Report finished = report.get();
        Throwable error = failure.get();
        String kind;
        if (timedOut) {
            kind = "timeout";
        } else if (error != null) {
            kind = "error";
        } else if (log.criticalError() != null) {
            kind = "error";
            error = new IllegalStateException(log.criticalError());
        } else if (finished != null && finished.ended()) {
            kind = "completed";
        } else if (finished != null && finished.turns() > request.turnCap()) {
            kind = "turn_limit";
        } else {
            kind = "error";
            error = new IllegalStateException("Game stopped without a result");
        }
        // After a timeout the game state belongs to a thread that may still be running; report only
        // what the log observed.
        boolean usable = !timedOut && finished != null;
        int turns = usable ? Math.min(finished.turns(), request.turnCap()) : log.lastTurn();
        List<BotMatchResult.Seat> seats = usable ? finished.seats() : unknownSeats();
        boolean completed = kind.equals("completed");

        var result = new BotMatchResult(
            kind,
            completed ? finished.winnerSeat() : null,
            completed && finished.draw(),
            turns,
            durationMs,
            request.seed(),
            new BotMatchResult.Settings(request.skill(), request.turnCap(), request.timeBudgetSeconds()),
            pin.commit(),
            usable ? finished.startingSeat() : null,
            seats,
            kind.equals("error") ? describe(error) : null,
            log.engineErrors(),
            thread.isAlive() ? "game_thread_still_running" : "complete",
            log.summary(),
            request.includeLog() ? log.entries() : null,
            diagnostics());
        return new Outcome(result, thread);
    }

    private Report play(BotMatchRequest request, MatchLog log) throws GameException {
        // XMage draws every random number (shuffles, coin flips, AI tie-breaks) from one
        // process-wide generator; seeding it is the only seed control XMage offers.
        RandomUtil.setSeed(request.seed());
        List<Deck> decks = new ArrayList<>();
        for (String deck : DECKS) {
            decks.add(loadLegacyDeck(deck));
        }

        Game game = new TwoPlayerDuel(MultiplayerAttackOption.LEFT, RangeOfInfluence.ONE,
            MulliganType.LONDON.getMulligan(0), LEGACY_MIN_DECK, START_LIFE, START_HAND);
        var options = new GameOptions();
        options.stopOnTurn = request.turnCap() + 1; // stop at the untap step after the last allowed turn
        options.stopAtStep = PhaseStep.UNTAP;
        options.rollbackTurnsAllowed = false;
        game.setGameOptions(options);

        var matchOptions = new MatchOptions("Commander Duels bot match", "Two Player Duel", false);
        matchOptions.setDeckType("Constructed - Legacy");
        matchOptions.setWinsNeeded(1);
        Match match = new TwoPlayerMatch(matchOptions);

        List<Player> players = new ArrayList<>();
        for (int seat = 0; seat < DECKS.size(); seat++) {
            Player player = new ComputerPlayerControllableProxy(SEAT_NAMES[seat], RangeOfInfluence.ONE,
                request.skill());
            Deck deck = decks.get(seat);
            game.loadCards(deck.getCards(), player.getId());
            game.loadCards(deck.getSideboard(), player.getId());
            game.addPlayer(player, deck);
            match.addPlayer(player, deck);
            // addPlayer fills the library from Deck.getMaindeckCards(), a HashSet of identity-hashed
            // cards, so the order before the opening shuffle differs on every run. Restore deck-list
            // order so the seeded shuffle deals the same hands.
            Set<Card> maindeck = deck.getCards().stream().filter(card -> !card.isExtraDeckCard())
                .collect(Collectors.toCollection(LinkedHashSet::new));
            player.getLibrary().clear();
            player.getLibrary().addAll(maindeck, game);
            players.add(player);
        }
        List<UUID> seatIds = players.stream().map(Player::getId).toList();
        log.attach(game, seatIds);
        beforeStart.accept(game);

        game.start(seatIds.get(RandomUtil.nextInt(seatIds.size())));

        Integer winner = null;
        List<BotMatchResult.Seat> seats = new ArrayList<>();
        for (int seat = 0; seat < players.size(); seat++) {
            Player player = game.getPlayer(seatIds.get(seat));
            if (player.hasWon()) {
                winner = seat;
            }
            seats.add(new BotMatchResult.Seat(seat, SEAT_NAMES[seat], DECKS.get(seat), player.getLife(),
                player.hasWon()));
        }
        int startingSeat = seatIds.indexOf(game.getStartingPlayerId());
        return new Report(game.hasEnded(), game.isADraw(), winner, game.getTurnNum(),
            startingSeat < 0 ? null : startingSeat, seats);
    }

    /** Loads a fixture deck and checks it with XMage's Legacy validator. */
    Deck loadLegacyDeck(String name) throws GameException {
        Path file = deckDirectory.resolve(name + ".txt");
        if (!Files.isRegularFile(file)) {
            throw new GameException("Deck file not found: " + file);
        }
        var errors = new StringBuilder();
        DeckCardLists lists = DeckImporter.importDeckFromFile(file.toString(), errors, false);
        if (!errors.isEmpty()) {
            throw new GameException("Deck " + name + " did not import: " + errors.toString().trim());
        }
        Deck deck = Deck.load(lists, false, false);
        DeckValidator validator = new Legacy();
        if (!validator.validate(deck)) {
            throw new GameException("Deck " + name + " is not Legacy-legal: " + validator.getErrorsListSorted()
                .stream().map(DeckValidatorError::getMessage).collect(Collectors.joining("; ")));
        }
        return deck;
    }

    private static List<BotMatchResult.Seat> unknownSeats() {
        List<BotMatchResult.Seat> seats = new ArrayList<>();
        for (int seat = 0; seat < DECKS.size(); seat++) {
            seats.add(new BotMatchResult.Seat(seat, SEAT_NAMES[seat], DECKS.get(seat), null, null));
        }
        return seats;
    }

    private static boolean join(Thread thread, long millis) {
        try {
            return thread.join(Duration.ofMillis(millis));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return !thread.isAlive();
        }
    }

    /** Interrupts repeatedly: XMage's AI swallows single interrupts while it waits on a search. */
    static void stop(Thread thread) {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(STOP_GRACE_MILLIS);
        while (thread.isAlive() && System.nanoTime() < deadline) {
            thread.interrupt();
            join(thread, 50);
        }
    }

    private static String describe(Throwable error) {
        Throwable root = error;
        while (root.getCause() != null && root.getCause() != root) {
            root = root.getCause();
        }
        String message = root.getMessage() == null ? "" : ": " + root.getMessage();
        String text = root.getClass().getSimpleName() + message;
        return text.length() > 500 ? text.substring(0, 500) : text;
    }

    static int gameThreadCount() {
        return (int) Thread.getAllStackTraces().keySet().stream()
            .filter(Thread::isAlive)
            .filter(t -> t.getName().startsWith(ThreadUtils.THREAD_PREFIX_GAME + " "))
            .count();
    }

    private static BotMatchResult.Diagnostics diagnostics() {
        System.gc(); // makes the per-match heap figure comparable across runs
        Runtime runtime = Runtime.getRuntime();
        long mb = 1024 * 1024;
        return new BotMatchResult.Diagnostics(
            (runtime.totalMemory() - runtime.freeMemory()) / mb,
            runtime.totalMemory() / mb,
            runtime.maxMemory() / mb,
            ManagementFactory.getThreadMXBean().getThreadCount(),
            gameThreadCount());
    }
}
