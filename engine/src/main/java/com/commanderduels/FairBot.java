package com.commanderduels;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedList;
import java.util.List;
import java.util.Random;
import java.util.Set;
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
import mage.abilities.Ability;
import mage.abilities.ActivatedAbility;
import mage.abilities.PlayLandAbility;
import mage.abilities.SpellAbility;
import mage.cards.Card;
import mage.choices.Choice;
import mage.constants.CardType;
import mage.constants.Outcome;
import mage.constants.PhaseStep;
import mage.constants.RangeOfInfluence;
import mage.game.Game;
import mage.game.combat.CombatGroup;
import mage.game.permanent.Permanent;
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
 * (AI02) and a bounded search for each decision (AI05). Difficulty comes from XMage's search depth
 * and think time for the skill (AI01) and, since v0.7.0, from the habits of a weaker player
 * ({@link Profile}), never from concealed cards.
 *
 * <ul>
 *   <li>XMage's skill changes little that a player feels: its search is four actions deep at every
 *       skill up to 4 and its attacks, blocks, targets and choices are the same heuristics at every
 *       skill, so the owner found level 1 playing like level 6 (v0.6.5, v0.7.0). A low skill now
 *       plays like an amateur: it lets chances pass, casts what comes to hand instead of what the
 *       search prefers, holds attackers back or sends them into bad blocks, and leaves attacks
 *       unblocked when no lethal blow is coming. Each habit's share falls steeply with the skill and
 *       is gone at 6; the shares are in {@link Profile#forSkill}.</li>
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

        /** XMage's own limit for a skill level, three seconds per level, from skill 4 up; a lower
         * skill thinks one second per level (v0.7.0), which also spares the server. */
        static Budget forSkill(int skill) {
            int level = Math.max(1, skill);
            return new Budget(TimeUnit.SECONDS.toMillis(level < 4 ? level : 3L * level));
        }
    }

    /**
     * The habits of a weaker player, as shares in percent of the decisions they touch (v0.7.0). Each
     * is a base share scaled by {@code ((6 - skill) / 5) ^ 1.5}: the whole share at skill 1, about
     * 72% of it at 2, 46% at 3, 25% at 4, 9% at 5 and none at 6, so the default table bot (skill 4)
     * stays a decent player and skill 6 is XMage's AI unchanged.
     *
     * @param passMain     own main phase with an empty stack: lets the chance pass (30 at skill 1)
     * @param passResponse any other priority, mostly responses: passes without searching (70)
     * @param naive        own main phase: plays a random land or castable spell instead of searching (50)
     * @param timid        each attacker the AI would send is held back (35)
     * @param reckless     each creature the AI would keep home attacks anyway (30)
     * @param noBlock      declares no blockers at all, unless the attack would be lethal (45)
     */
    record Profile(int skill, int passMain, int passResponse, int naive, int timid, int reckless, int noBlock) {
        static final int MAX_SKILL = 6;

        static Profile forSkill(int skill) {
            int level = Math.max(1, Math.min(MAX_SKILL, skill));
            double scale = Math.pow((MAX_SKILL - level) / 5.0, 1.5);
            return new Profile(level, share(30, scale), share(70, scale), share(50, scale),
                share(35, scale), share(30, scale), share(45, scale));
        }

        private static int share(int base, double scale) {
            return (int) Math.round(base * scale);
        }

        /** XMage's AI as it is: nothing lets a decision slip. */
        boolean sharp() {
            return passMain == 0 && passResponse == 0 && naive == 0 && timid == 0 && reckless == 0 && noBlock == 0;
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
        // The weaker player's habits (v0.7.0).
        private final AtomicLong slips = new AtomicLong();
        private final AtomicLong naivePlays = new AtomicLong();
        private final AtomicLong heldBack = new AtomicLong();
        private final AtomicLong recklessAttacks = new AtomicLong();
        private final AtomicLong unblocked = new AtomicLong();
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

        /** Priorities a weaker player let pass unsearched (v0.7.0). */
        long slips() {
            return slips.get();
        }

        /** Main-phase plays made without the search (v0.7.0). */
        long naivePlays() {
            return naivePlays.get();
        }

        /** Attackers held back, creatures sent in anyway, and attacks left unblocked (v0.7.0). */
        long heldBack() {
            return heldBack.get();
        }

        long recklessAttacks() {
            return recklessAttacks.get();
        }

        long unblocked() {
            return unblocked.get();
        }

        @Override
        public String toString() {
            return searches() + " searches, " + completed() + " completed, " + timedOut() + " cut off by the budget, "
                + abandoned() + " abandoned, " + unstarted() + " unstarted, " + failed() + " failed; longest "
                + longestMillis() + " ms, longest wait " + longestWaitMillis() + " ms; habits: " + slips()
                + " slips, " + naivePlays() + " naive plays, " + heldBack() + " held back, " + recklessAttacks()
                + " reckless attacks, " + unblocked() + " unblocked";
        }

        /** Decisions that continued a planned chain of actions instead of searching again. */
        long continued() {
            return continued.get();
        }
    }

    private final Random random;
    private final transient Budget budget;
    /** The habits of this bot's skill (v0.7.0; before, v0.6.5 let a flat share of priorities pass). */
    private final Profile profile;
    private final transient Stats stats;

    FairBot(String name, RangeOfInfluence range, int skill, long seed) {
        this(name, range, skill, seed, Budget.forSkill(skill));
    }

    FairBot(String name, RangeOfInfluence range, int skill, long seed, Budget budget) {
        this(name, range, skill, seed, budget, Profile.forSkill(skill));
    }

    FairBot(String name, RangeOfInfluence range, int skill, long seed, Budget budget, Profile profile) {
        super(name, range, skill);
        this.random = new Random(seed);
        this.budget = budget;
        this.profile = profile;
        this.stats = new Stats();
    }

    /** XMage copies players with every saved state; a copy shares the original's random source and statistics. */
    FairBot(FairBot bot) {
        super(bot);
        this.random = bot.random;
        this.budget = bot.budget;
        this.profile = bot.profile;
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
        this.profile = controller.profile;
        this.stats = controller.stats;
    }

    /**
     * A weaker player's priority (v0.7.0): some chances pass unsearched, most of all responses on
     * other players' turns, and in its own main phases it sometimes plays what comes to hand
     * instead of what the search would choose. Skill 6 is XMage's AI as it is.
     */
    @Override
    public boolean priority(Game game) {
        if (!profile.sharp()) {
            boolean ownMain = game.getActivePlayerId() != null && game.getActivePlayerId().equals(playerId)
                && game.getStack().isEmpty() && isMainPhase(game);
            if (chance(ownMain ? profile.passMain() : profile.passResponse())) {
                stats.slips.incrementAndGet();
                pass(game);
                return false;
            }
            if (ownMain && chance(profile.naive()) && playNaively(game)) {
                stats.naivePlays.incrementAndGet();
                return true;
            }
        }
        return super.priority(game);
    }

    private static boolean isMainPhase(Game game) {
        PhaseStep step = game.getTurnStepType();
        return step == PhaseStep.PRECOMBAT_MAIN || step == PhaseStep.POSTCOMBAT_MAIN;
    }

    /** True with the given chance in percent. */
    private boolean chance(int percent) {
        return percent > 0 && random.nextInt(100) < percent;
    }

    /**
     * Plays a land when one can be played (an amateur still makes land drops), otherwise one of
     * the spells it could cast, chosen at random, with XMage's usual targets and payment. False
     * when there is nothing of the kind to play: the search decides as usual.
     */
    private boolean playNaively(Game game) {
        List<ActivatedAbility> lands = new ArrayList<>();
        List<ActivatedAbility> spells = new ArrayList<>();
        for (ActivatedAbility ability : getPlayable(game, true)) {
            if (ability instanceof PlayLandAbility) {
                lands.add(ability);
            } else if (ability instanceof SpellAbility) {
                spells.add(ability);
            }
        }
        List<ActivatedAbility> pool = !lands.isEmpty() ? lands : spells;
        if (pool.isEmpty()) {
            return false;
        }
        ActivatedAbility pick = pool.get(random.nextInt(pool.size()));
        if (!activateAbility(pick, game)) {
            return false;
        }
        if (pick.isUsesStack()) {
            // As XMage's act(): the spell is on the stack, and priority passes with it there.
            pass(game);
        }
        return true;
    }

    /**
     * A weaker player's attack (v0.7.0): XMage's choice of attackers, then some of them held back
     * and some of the creatures it kept home sent in anyway, so lethal attacks are missed and
     * creatures run into blocks. XMage checks the requirements and restrictions afterwards, as it
     * does for its own choices.
     */
    @Override
    public void selectAttackers(Game game, UUID attackingPlayerId) {
        super.selectAttackers(game, attackingPlayerId);
        if (profile.sharp() || game.getCombat() == null) {
            return;
        }
        for (UUID attackerId : new ArrayList<>(game.getCombat().getAttackers())) {
            Permanent attacker = game.getPermanent(attackerId);
            if (attacker != null && attacker.isControlledBy(playerId) && chance(profile.timid())) {
                game.getCombat().removeAttacker(attackerId, game);
                stats.heldBack.incrementAndGet();
            }
        }
        if (profile.reckless() == 0) {
            return;
        }
        UUID defenderId = defenderFor(game);
        if (defenderId == null) {
            return;
        }
        Set<UUID> attacking = new HashSet<>(game.getCombat().getAttackers());
        for (Permanent idle : getAvailableAttackers(defenderId, game)) {
            if (!attacking.contains(idle.getId()) && chance(profile.reckless())
                && declareAttacker(idle.getId(), defenderId, game, false)) {
                stats.recklessAttacks.incrementAndGet();
            }
        }
    }

    /** The player the attack already goes at, else the first opponent still in the game. */
    private UUID defenderFor(Game game) {
        for (CombatGroup group : game.getCombat().getGroups()) {
            if (!group.getAttackers().isEmpty() && game.getPlayer(group.getDefenderId()) != null) {
                return group.getDefenderId();
            }
        }
        for (UUID opponentId : game.getOpponents(playerId, true)) {
            return opponentId;
        }
        return null;
    }

    /**
     * A weaker player's blocks (v0.7.0): sometimes none at all, unless the attack as declared would
     * take all of this player's life, when even an amateur blocks.
     */
    @Override
    public void selectBlockers(Ability source, Game game, UUID defendingPlayerId) {
        if (!profile.sharp() && chance(profile.noBlock()) && incomingPower(game) < getLife()) {
            stats.unblocked.incrementAndGet();
            return;
        }
        super.selectBlockers(source, game, defendingPlayerId);
    }

    /** The power of every attacking creature: at least what an unblocked attack would deal. */
    private int incomingPower(Game game) {
        int power = 0;
        for (UUID attackerId : game.getCombat().getAttackers()) {
            Permanent attacker = game.getPermanent(attackerId);
            if (attacker != null) {
                power += Math.max(0, attacker.getPower().getValue());
            }
        }
        return power;
    }

    Profile profile() {
        return profile;
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
