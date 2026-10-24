package com.commanderduels;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedList;
import java.util.List;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import mage.cards.Card;
import mage.choices.Choice;
import mage.constants.CardType;
import mage.constants.Outcome;
import mage.constants.RangeOfInfluence;
import mage.game.Game;
import mage.player.ai.ComputerPlayerControllableProxy;
import mage.player.ai.SimulationNode2;
import mage.player.ai.score.GameStateEvaluator2;
import mage.players.Player;
import mage.players.PlayerImpl;
import mage.util.ThreadUtils;
import mage.util.XmageThreadFactory;
import org.apache.log4j.Logger;

/**
 * The bot of Commander Duels: XMage's "Computer - mad" AI, playing with only its seat's information
 * (AI02) and a bounded search for each decision (AI05). Difficulty still comes from XMage's search
 * depth, node limit and think time for the skill (AI01), not from concealed cards.
 *
 * <ul>
 *   <li>Every search starts from a determinized copy ({@link Determinizer}): other players' hands
 *       and libraries are dealt again from their pooled cards, and the bot's own library is
 *       shuffled. The search's own copies derive from that one, so nothing in it sees the real
 *       concealed cards. The random source is seeded from the game's seed and the seat.</li>
 *   <li>XMage continues a planned chain of actions when the game still matches the search's
 *       expectation, comparing a fingerprint that includes every hand's cards. Determinized copies
 *       never match that, so this bot compares a fingerprint with other players' hands as counts and
 *       its own hand in full (what its seat can see) of the real game and of the planned node.</li>
 *   <li>Each search gets {@link Budget#thinkMillis()} on its own thread. When the budget runs out the
 *       search is cancelled, and the bot waits up to {@link #STOP_GRACE_MILLIS} for it to stop
 *       before reading its tree; it then plays the best action found so far, or passes if there is
 *       none. A search that does not stop in time is abandoned and the bot passes, so a decision
 *       never reads a tree that another thread is still writing.</li>
 *   <li>Every bot in the engine shares one pool of search threads, one per processor unless
 *       {@code CD_ENGINE_AI_THREADS} says otherwise (v0.4.1; XMage's own pool has five). The budget
 *       starts when the search does: time spent waiting for a free thread, when many games run at
 *       once, is not thinking time. A search still waiting after {@link #QUEUE_WAIT_MILLIS} never
 *       starts, and the bot passes.</li>
 *   <li>XMage's choice of a creature type walks the bot's library from the top, following its
 *       concealed order; this bot walks it in name order.</li>
 * </ul>
 *
 * See docs/engine/fair-bots.md for the audit of XMage's AI code behind these changes. Not final
 * since v0.6.1: a test scripts one bot's spell (TurnControlTest).
 */
class FairBot extends ComputerPlayerControllableProxy {
    private static final long serialVersionUID = 1L;
    private static final Logger LOG = Logger.getLogger(FairBot.class);
    /** How long a cancelled search may take to stop before the bot gives up on its result. */
    static final long STOP_GRACE_MILLIS = 2_000;
    /** How long a decision waits for a free search thread before the bot passes instead. */
    static final long QUEUE_WAIT_MILLIS = 60_000;
    /** XMage's own pool for its AI has five threads; a busy engine needs one per processor. */
    static final int SEARCH_THREADS = searchThreads(System.getenv("CD_ENGINE_AI_THREADS"),
        Runtime.getRuntime().availableProcessors());
    private static final ThreadPoolExecutor SEARCHES = searchPool();

    /** The wall-clock time one decision's search may take. */
    record Budget(long thinkMillis) {
        Budget {
            if (thinkMillis < 0) {
                throw new IllegalArgumentException("thinkMillis must not be negative");
            }
        }

        /** XMage's own limit for a skill level: three seconds per level. */
        static Budget forSkill(int skill) {
            return new Budget(TimeUnit.SECONDS.toMillis(3L * Math.max(1, skill)));
        }
    }

    /** What a bot's searches did, shared with its copies: for tests and diagnostics. */
    static final class Stats {
        private final AtomicLong samples = new AtomicLong();
        private final AtomicLong searches = new AtomicLong();
        private final AtomicLong completed = new AtomicLong();
        private final AtomicLong timedOut = new AtomicLong();
        private final AtomicLong failed = new AtomicLong();
        private final AtomicLong abandoned = new AtomicLong();
        private final AtomicLong longestMillis = new AtomicLong();
        private final AtomicLong longestWaitMillis = new AtomicLong();
        private final AtomicLong unstarted = new AtomicLong();
        private final AtomicLong continued = new AtomicLong();

        /** Determinized copies made: one per search. */
        long samples() {
            return samples.get();
        }

        long searches() {
            return searches.get();
        }

        long completed() {
            return completed.get();
        }

        /** Searches cut off by the budget. */
        long timedOut() {
            return timedOut.get();
        }

        /** Searches that ended with an error in XMage's simulation code. */
        long failed() {
            return failed.get();
        }

        /** Cut-off searches that did not stop within the grace period: the bot passed instead. */
        long abandoned() {
            return abandoned.get();
        }

        /** The longest a single search decision took, from start to a usable result. */
        long longestMillis() {
            return longestMillis.get();
        }

        /** The longest a search waited for a free search thread before it started. */
        long longestWaitMillis() {
            return longestWaitMillis.get();
        }

        /** Searches that found no free thread within {@link #QUEUE_WAIT_MILLIS}: the bot passed. */
        long unstarted() {
            return unstarted.get();
        }

        @Override
        public String toString() {
            return searches() + " searches, " + completed() + " completed, " + timedOut() + " cut off by the budget, "
                + abandoned() + " abandoned, " + unstarted() + " unstarted, " + failed() + " failed; longest "
                + longestMillis() + " ms, longest wait " + longestWaitMillis() + " ms";
        }

        /** Decisions that continued a planned chain of actions instead of searching again. */
        long continued() {
            return continued.get();
        }
    }

    private final Random random;
    private final transient Budget budget;
    private final transient Stats stats;

    FairBot(String name, RangeOfInfluence range, int skill, long seed) {
        this(name, range, skill, seed, Budget.forSkill(skill));
    }

    FairBot(String name, RangeOfInfluence range, int skill, long seed, Budget budget) {
        super(name, range, skill);
        this.random = new Random(seed);
        this.budget = budget;
        this.stats = new Stats();
    }

    /** XMage copies players with every saved state; a copy shares the original's random source and statistics. */
    FairBot(FairBot bot) {
        super(bot);
        this.random = bot.random;
        this.budget = bot.budget;
        this.stats = bot.stats;
        // XMage's own copy constructor leaves these at zero.
        this.maxThinkTimeSecs = bot.maxThinkTimeSecs;
        this.maxNodes = bot.maxNodes;
    }

    /**
     * A stand-in for a player whose turn this bot controls (723.5, v0.6.1, patch 0008): a fair bot
     * with that player's identity, zones and life, deciding each of their decisions as XMage's AI
     * decides for the player it plays, with this bot's skill, budget, search threads and random
     * source. Its searches redeal what that player may not see, as this bot's own do.
     */
    private FairBot(PlayerImpl playerUnderControl, FairBot controller) {
        super(playerUnderControl, controller);
        this.random = controller.random;
        this.budget = controller.budget;
        this.stats = controller.stats;
    }

    @Override
    public FairBot copy() {
        return new FairBot(this);
    }

    @Override
    protected ComputerPlayerControllableProxy makeStandIn(PlayerImpl playerUnderControl) {
        return new FairBot(playerUnderControl, this);
    }

    /** A bot's random stream: the game's seed mixed with the bot's seat, so bots at one table differ. */
    static long seedFor(long gameSeed, int seat) {
        return gameSeed * 0x9E3779B97F4A7C15L + seat + 1;
    }

    Budget budget() {
        return budget;
    }

    Stats stats() {
        return stats;
    }

    /** The search's root copy, with the concealed zones dealt again from what this seat may know. */
    @Override
    protected Game createSimulation(Game game) {
        Game sim = super.createSimulation(game);
        Determinizer.redeal(sim, getId(), random);
        stats.samples.incrementAndGet();
        return sim;
    }

    /**
     * XMage's chain continuation, comparing what this seat can see. XMage records a fingerprint of
     * every hand's cards in each node it expands ({@code simulatePriority}) and compares it with the
     * real game. Here a node XMage expanded (one with a recorded fingerprint) is compared through
     * its own game, which the search leaves as it was when expanded: it works on copies.
     * Fingerprinting only that one node keeps the cost off the search, where rendering every
     * permanent's rules text at each node would double XMage's own cost.
     */
    @Override
    protected boolean getNextAction(Game game) {
        if (root == null || root.getChildren().isEmpty()) {
            return false;
        }
        SimulationNode2 test = root;
        root = root.getChildren().get(0);
        while (!root.getChildren().isEmpty() && !root.getPlayerId().equals(playerId)) {
            test = root;
            root = root.getChildren().get(0);
        }
        if (root.getPlayerId().equals(playerId) && root.getAbilities() != null && test.getGameValue() != 0
                && seatFingerprint(game) == seatFingerprint(test.getGame())) {
            actions = new LinkedList<>(root.getAbilities());
            combat = root.getCombat();
            stats.continued.incrementAndGet();
            return true;
        }
        return false;
    }

    /** XMage's state fingerprint with hands as counts, plus this bot's own hand. */
    private int seatFingerprint(Game game) {
        Player self = game.getPlayer(playerId);
        return (game.getState().getValue(false) + "|hand:" + (self == null ? "" : self.getHand())).hashCode();
    }

    /**
     * Runs the search within the budget. XMage's version also cancels a search that runs out of
     * time, but then reads the tree while the cancelled search may still be writing it.
     */
    @Override
    protected Integer addActionsTimed() {
        SimulationNode2 searched = root;
        AtomicBoolean claimed = new AtomicBoolean();
        CountDownLatch began = new CountDownLatch(1);
        AtomicLong startedAt = new AtomicLong();
        CountDownLatch stopped = new CountDownLatch(1);
        FutureTask<Integer> search = new FutureTask<>(() -> {
            if (!claimed.compareAndSet(false, true)) {
                return null; // cancelled before it started
            }
            startedAt.set(System.nanoTime());
            began.countDown();
            try {
                return addActions(searched, maxDepth, Integer.MIN_VALUE, Integer.MAX_VALUE);
            } finally {
                stopped.countDown();
            }
        });
        long submitted = System.nanoTime();
        stats.searches.incrementAndGet();
        SEARCHES.execute(search);
        Integer score = null;
        boolean interrupted = false;
        try {
            // The budget is thinking time: it starts when a search thread takes the search.
            if (began.await(QUEUE_WAIT_MILLIS, TimeUnit.MILLISECONDS)) {
                score = search.get(budget.thinkMillis(), TimeUnit.MILLISECONDS);
                stats.completed.incrementAndGet();
            } else {
                stats.unstarted.incrementAndGet();
            }
        } catch (TimeoutException e) {
            stats.timedOut.incrementAndGet();
        } catch (InterruptedException e) {
            interrupted = true; // the game is being stopped
        } catch (ExecutionException e) {
            // XMage's own handling: log it and play the best action found before the error, if any.
            stats.failed.incrementAndGet();
            LOG.warn("AI search failed for " + getName() + ": " + e.getCause(), e.getCause());
        }
        if (!search.isDone()) {
            search.cancel(true);
            // The search checks for interruption at every node. Either it never started, or wait
            // for it to let go of the tree before the caller reads it.
            boolean idle = claimed.compareAndSet(false, true) || awaitStop(stopped);
            if (!idle) {
                stats.abandoned.incrementAndGet();
                LOG.warn("AI search for " + getName() + " did not stop within " + STOP_GRACE_MILLIS
                    + " ms of its budget; the bot passes");
                root = null;
            }
        }
        if (interrupted || Thread.currentThread().isInterrupted()) {
            // Pass, and keep the interrupt so XMage stops the game.
            root = null;
            Thread.currentThread().interrupt();
        }
        long started = startedAt.get();
        if (started != 0) {
            stats.longestWaitMillis.accumulateAndGet(TimeUnit.NANOSECONDS.toMillis(started - submitted), Math::max);
            stats.longestMillis.accumulateAndGet(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started), Math::max);
        }
        return score == null ? 0 : score;
    }

    private static boolean awaitStop(CountDownLatch stopped) {
        try {
            return stopped.await(STOP_GRACE_MILLIS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    /**
     * XMage's rule (the first creature type among the hand's cards, then the library's) with the
     * library in name order rather than its concealed order. Choosing against opponents reads only
     * public zones and stays XMage's.
     */
    @Override
    protected boolean chooseCreatureType(Outcome outcome, Choice choice, Game game) {
        if (outcome == Outcome.Detriment) {
            return super.chooseCreatureType(outcome, choice, game);
        }
        List<Card> cards = new ArrayList<>();
        for (UUID cardId : getHand()) {
            Card card = game.getCard(cardId);
            if (card != null) {
                cards.add(card);
            }
        }
        List<Card> library = new ArrayList<>(getLibrary().getCards(game));
        library.sort(Comparator.comparing(Card::getName));
        cards.addAll(library);
        for (Card card : cards) {
            if (card.getCardType(game).contains(CardType.CREATURE) && !card.getSubtype(game).isEmpty()) {
                String type = card.getSubtype(game).get(0).toString();
                if (choice.getChoices().contains(type)) {
                    choice.setChoice(type);
                    break;
                }
            }
        }
        return choice.isChosen();
    }

    /** XMage's debug log of the board, without other players' hand cards (it names them). */
    @Override
    protected void printBattlefieldScore(Game game, UUID shownId) {
        Player shown = game.getPlayer(shownId);
        if (!LOG.isInfoEnabled() || shown == null) {
            return;
        }
        String hand = shownId.equals(playerId)
            ? shown.getHand().getCards(game).stream().map(Card::getName).toList().toString()
            : shown.getHand().size() + " cards";
        LOG.info("[" + shown.getName() + "] life " + shown.getLife() + ", score "
            + GameStateEvaluator2.evaluate(shownId, game).getTotalScore() + ", hand " + hand);
    }

    /** The pool's size: {@code CD_ENGINE_AI_THREADS} when it is a number from 1 to 256, else one per processor. */
    static int searchThreads(String configured, int processors) {
        if (configured != null && !configured.isBlank()) {
            try {
                return Math.max(1, Math.min(256, Integer.parseInt(configured.strip())));
            } catch (NumberFormatException e) {
                LOG.warn("CD_ENGINE_AI_THREADS is not a number: " + configured);
            }
        }
        return Math.max(1, processors);
    }

    private static ThreadPoolExecutor searchPool() {
        // XMage treats threads named with its AI prefix as game threads, as its simulations need.
        var pool = new ThreadPoolExecutor(SEARCH_THREADS, SEARCH_THREADS, 60, TimeUnit.SECONDS,
            new LinkedBlockingQueue<>(), new XmageThreadFactory(ThreadUtils.THREAD_PREFIX_AI_SIMULATION_MAD + " fair"));
        pool.allowCoreThreadTimeOut(true);
        return pool;
    }
}
