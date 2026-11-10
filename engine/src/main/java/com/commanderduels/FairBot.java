package com.commanderduels;

import java.lang.management.ManagementFactory;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryType;
import java.lang.management.MemoryUsage;
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
import java.util.Map;
import mage.MageObject;
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
import mage.constants.Zone;
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
 * and think time for the skill (AI01) and, since v0.7.1, from the habits of a weaker player
 * ({@link Profile}), never from concealed cards.
 *
 * <ul>
 *   <li>XMage's skill changes little that a player feels: its search is four actions deep at every
 *       skill up to 4 and its attacks, blocks, targets and choices are the same heuristics at every
 *       skill, so the owner found level 1 playing like level 6 (v0.6.5, v0.7.1). A low skill now
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
 *   <li>Since v0.8.6 a game may make its bots passive ({@link #followPassive}), for SysOp's tests of
 *       campaign and card mechanics: the bot keeps its opening hand, passes every priority, attacks
 *       and blocks with nothing and says no to every optional choice. What the rules still make it
 *       do (its draw, the discard to hand size, a mandatory trigger's targets) is XMage's AI as
 *       before.</li>
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
    /**
     * A search whose root copy took this long, or that starts while the heap's old generation is
     * this full after its last collection, looks only {@link #LIGHT_DEPTH} plies ahead (v0.9.3).
     * XMage copies the whole game, watchers' lists of every spell cast included, into each node: in
     * a combo turn of the campaign finale one copy took seconds, the search could not stop between
     * nodes, and the engine's heap ran out.
     */
    static final long HEAVY_COPY_MILLIS = 200;
    static final double HEAP_PRESSURE = 0.70;
    static final int LIGHT_DEPTH = 2;
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
         * skill thinks one second per level (v0.7.1), which also spares the server. */
        static Budget forSkill(int skill) {
            int level = Math.max(1, skill);
            return new Budget(TimeUnit.SECONDS.toMillis(level < 4 ? level : 3L * level));
        }
    }

    /**
     * The habits of a weaker player, as shares in percent of the decisions they touch (v0.7.1). Each
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
        // The weaker player's habits (v0.7.1).
        private final AtomicLong slips = new AtomicLong();
        private final AtomicLong naivePlays = new AtomicLong();
        private final AtomicLong heldBack = new AtomicLong();
        private final AtomicLong recklessAttacks = new AtomicLong();
        private final AtomicLong unblocked = new AtomicLong();
        private final AtomicLong continued = new AtomicLong();
        // A passive bot's decisions (v0.8.6).
        private final AtomicLong passive = new AtomicLong();
        // A King's Table General's pressed attacks (v0.9.0).
        private final AtomicLong pressed = new AtomicLong();
        // Searches kept shallow for a heavy game or a full heap (v0.9.3).
        private final AtomicLong light = new AtomicLong();
        // Pacts not cast because their upkeep cost could not be paid (v0.9.3).
        private final AtomicLong pacts = new AtomicLong();

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

        /** Priorities a weaker player let pass unsearched (v0.7.1). */
        long slips() {
            return slips.get();
        }

        /** Main-phase plays made without the search (v0.7.1). */
        long naivePlays() {
            return naivePlays.get();
        }

        /** Attackers held back, creatures sent in anyway, and attacks left unblocked (v0.7.1). */
        long heldBack() {
            return heldBack.get();
        }

        long recklessAttacks() {
            return recklessAttacks.get();
        }

        long unblocked() {
            return unblocked.get();
        }

        /**
         * Decisions a passive bot made without XMage's AI (v0.8.6): priorities passed, attacks and
         * blocks declared empty, opening hands kept and optional choices declined.
         */
        long passive() {
            return passive.get();
        }

        /** Creatures a King's Table General sent at an opposing General beside it (v0.9.0). */
        long pressed() {
            return pressed.get();
        }

        /** Searches that looked only {@link #LIGHT_DEPTH} plies ahead (v0.9.3). */
        long light() {
            return light.get();
        }

        /** Plans dropped because they cast a Pact the bot could not pay for (v0.9.3). */
        long pacts() {
            return pacts.get();
        }

        @Override
        public String toString() {
            return searches() + " searches, " + completed() + " completed, " + timedOut() + " cut off by the budget, "
                + abandoned() + " abandoned, " + unstarted() + " unstarted, " + failed() + " failed; longest "
                + longestMillis() + " ms, longest wait " + longestWaitMillis() + " ms; habits: " + slips()
                + " slips, " + naivePlays() + " naive plays, " + heldBack() + " held back, " + recklessAttacks()
                + " reckless attacks, " + unblocked() + " unblocked; " + passive() + " passive decisions; "
                + pressed() + " pressed attacks; " + light() + " light searches, " + pacts() + " unpayable Pacts held";
        }

        /** Decisions that continued a planned chain of actions instead of searching again. */
        long continued() {
            return continued.get();
        }
    }

    private final Random random;
    private final transient Budget budget;
    /** The habits of this bot's skill (v0.7.1; before, v0.6.5 let a flat share of priorities pass). */
    private final transient Profile profile;
    private final transient Stats stats;
    /**
     * The game's switch for passive bots (v0.8.6), one object for every bot at the table, shared by
     * reference with every copy XMage makes and every stand-in this bot makes, so a change reaches
     * each of them at its next decision. A bot no game has given one keeps its own, always off.
     */
    private transient AtomicBoolean passive = new AtomicBoolean();

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
        this.passive = bot.passive;
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
        this.passive = controller.passive;
    }

    /**
     * Follows the game's switch for passive bots (v0.8.6) instead of this bot's own. The game calls
     * it once, when it seats the bot and before XMage has copied it: copies and stand-ins take the
     * switch they find.
     */
    void followPassive(AtomicBoolean gameSwitch) {
        this.passive = gameSwitch;
    }

    /**
     * Whether this decision is a passive bot's (v0.8.6): the switch is on, the game is the real one
     * (a search's copies play on as XMage's AI would), and the bot decides for itself. XMage's
     * {@code isGameUnderControl} is false while another player controls this bot's turn (723.5),
     * when the decision is that player's to make, and true for a stand-in this bot makes to decide
     * for a player whose turn it controls: a passive bot passes for that player too.
     */
    private boolean passiveNow(Game game) {
        if (passive.get() && !game.isSimulation() && isGameUnderControl()) {
            stats.passive.incrementAndGet();
            return true;
        }
        return false;
    }

    /**
     * Whether this decision may show a weaker player's habits (v0.7.1): the bot is not sharp and
     * decides for itself. While another player controls this bot's turn (723.5) XMage's
     * {@code isGameUnderControl} is false and the decision is that player's: it is never slipped,
     * held back or left unblocked for them (v0.8.8).
     */
    private boolean habitsNow() {
        return !profile.sharp() && isGameUnderControl();
    }

    /**
     * A weaker player's priority (v0.7.1): some chances pass unsearched, most of all responses on
     * other players' turns, and in its own main phases it sometimes plays what comes to hand
     * instead of what the search would choose. Skill 6 is XMage's AI as it is.
     *
     * <p>A passive bot (v0.8.6) passes every priority without searching: it plays no land, casts
     * nothing and activates nothing. It still draws, and discards to its hand size in the cleanup
     * step: XMage does both without asking for priority.
     */
    @Override
    public boolean priority(Game game) {
        if (passiveNow(game)) {
            pass(game);
            return false;
        }
        if (habitsNow()) {
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

    /**
     * The Pacts (v0.9.3): free now, their cost due at the caster's next upkeep or the game is lost,
     * by the mana value of that cost. XMage's AI casts them without counting it: the campaign
     * finale's stand-in countered a Bonesplitter with Pact of Negation on turn one and lost on turn
     * two at 40 life.
     */
    static final Map<String, Integer> PACTS = Map.of("Pact of Negation", 5, "Pact of the Titan", 5,
        "Slaughter Pact", 3, "Summoner's Pact", 3, "Intervention Pact", 3);

    /** XMage's action, unless its plan casts a Pact whose upkeep cost this bot could not pay. */
    @Override
    protected void act(Game game) {
        if (actions != null && actions.stream().anyMatch(ability -> unpayablePact(ability, game))) {
            actions.clear();
            stats.pacts.incrementAndGet();
        }
        super.act(game);
    }

    /** A Pact cast whose upkeep cost is more than the mana sources this bot controls. */
    boolean unpayablePact(Ability ability, Game game) {
        if (!(ability instanceof SpellAbility)) {
            return false;
        }
        MageObject source = game.getObject(ability.getSourceId());
        Integer cost = source == null ? null : PACTS.get(source.getName());
        if (cost == null) {
            return false;
        }
        long sources = game.getBattlefield().getAllActivePermanents(playerId).stream()
            .filter(permanent -> !permanent.getAbilities().getActivatedManaAbilities(Zone.BATTLEFIELD).isEmpty())
            .count();
        return sources < cost;
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
     * A weaker player's attack (v0.7.1): XMage's choice of attackers, then some of them held back
     * and some of the creatures it kept home sent in anyway, so lethal attacks are missed and
     * creatures run into blocks. XMage checks the requirements and restrictions afterwards, as it
     * does for its own choices.
     *
     * <p>A passive bot (v0.8.6) declares no attackers. A creature that must attack if able still
     * does: XMage declares it before it asks (508.1d), as the rules require.
     *
     * <p>At King's Table (v0.9.0) a General then presses the attack ({@link #pressAsGeneral}).
     */
    @Override
    public void selectAttackers(Game game, UUID attackingPlayerId) {
        if (passiveNow(game)) {
            return;
        }
        super.selectAttackers(game, attackingPlayerId);
        if (game.getCombat() == null) {
            return;
        }
        if (habitsNow()) {
            weakerAttack(game);
        }
        pressAsGeneral(game);
    }

    /** The weaker player's habits in an attack (v0.7.1): some attackers held back, some sent in. */
    private void weakerAttack(Game game) {
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
            if (!attacking.contains(idle.getId()) && chance(profile.reckless())) {
                declareAttacker(idle.getId(), defenderId, game, false);
                if (game.getCombat().getAttackers().contains(idle.getId())) {
                    stats.recklessAttacks.incrementAndGet();
                }
            }
        }
    }

    /**
     * A King's Table General presses the attack (v0.9.0, the owner's choice after a game where
     * the bot Generals never fought and, with the house rule off, the Kings could never attack).
     * XMage's AI is cautious at a multiplayer table; a General's purpose is to fight the opposing
     * Generals beside it. So each creature XMage kept home that may attack an opposing General
     * (never a King: the King is for the house rule and a fallen General) attacks the one with the
     * least life, unless that player has an untapped creature that could block it, kill it and
     * live: then it would be badly outmatched, and stays home. Kings and other formats' bots play
     * as before.
     */
    private void pressAsGeneral(Game game) {
        KingsTable table = GameFormat.kingsTableOf(game);
        if (table == null || table.isKing(playerId) || !isGameUnderControl()) {
            return;
        }
        int team = table.teamOf(playerId);
        List<UUID> generals = game.getCombat().getDefenders().stream()
            .filter(defenderId -> game.getPlayer(defenderId) != null && !table.isKing(defenderId))
            .filter(defenderId -> table.teamOf(defenderId) >= 0 && table.teamOf(defenderId) != team)
            .sorted(Comparator.comparingInt((UUID defenderId) -> game.getPlayer(defenderId).getLife()))
            .toList();
        if (generals.isEmpty()) {
            return;
        }
        Set<UUID> attacking = new HashSet<>(game.getCombat().getAttackers());
        for (UUID defenderId : generals) {
            for (Permanent idle : getAvailableAttackers(defenderId, game)) {
                if (attacking.contains(idle.getId()) || !idle.canAttack(defenderId, game)
                    || outmatched(game, idle, defenderId)) {
                    continue;
                }
                declareAttacker(idle.getId(), defenderId, game, false);
                if (game.getCombat().getAttackers().contains(idle.getId())) {
                    attacking.add(idle.getId());
                    stats.pressed.incrementAndGet();
                }
            }
        }
    }

    /** Whether the defending player has an untapped creature that could block the attacker, kill it
     * and survive. */
    static boolean outmatched(Game game, Permanent attacker, UUID defendingPlayerId) {
        int power = Math.max(0, attacker.getPower().getValue());
        int toughness = attacker.getToughness().getValue();
        for (Permanent blocker : game.getBattlefield().getAllActivePermanents(defendingPlayerId)) {
            if (!blocker.isCreature(game) || blocker.isTapped() || !blocker.canBlock(attacker.getId(), game)) {
                continue;
            }
            if (blocker.getPower().getValue() >= toughness && blocker.getToughness().getValue() > power) {
                return true;
            }
        }
        return false;
    }

    /**
     * The player the attack already goes at, else the first opponent still in the game; in a game
     * with its own attack rules (King's Table, v0.8.7), the first the combat lets this player attack.
     */
    private UUID defenderFor(Game game) {
        for (CombatGroup group : game.getCombat().getGroups()) {
            if (!group.getAttackers().isEmpty() && game.getPlayer(group.getDefenderId()) != null) {
                return group.getDefenderId();
            }
        }
        Set<UUID> defenders = game.getCombat().getDefenders();
        for (UUID opponentId : game.getOpponents(playerId, true)) {
            if (!game.attacksOnlyNamedPlayers() || defenders.contains(opponentId)) {
                return opponentId;
            }
        }
        if (game.attacksOnlyNamedPlayers()) {
            for (UUID defenderId : defenders) {
                if (game.getPlayer(defenderId) != null) {
                    return defenderId;
                }
            }
        }
        return null;
    }

    /**
     * A weaker player's blocks (v0.7.1): sometimes none at all, unless the attack as declared would
     * take all of this player's life, when even an amateur blocks.
     *
     * <p>A passive bot (v0.8.6) blocks with nothing, even a lethal attack. A creature that must
     * block still does: XMage adds a computer player's required blocks after it chooses (509.1c).
     */
    @Override
    public void selectBlockers(Ability source, Game game, UUID defendingPlayerId) {
        if (passiveNow(game)) {
            return;
        }
        if (habitsNow() && chance(profile.noBlock()) && incomingPower(game) < getLife()) {
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

    /** A passive bot (v0.8.6) keeps its opening hand. */
    @Override
    public boolean chooseMulligan(Game game) {
        if (passiveNow(game)) {
            return false;
        }
        return super.chooseMulligan(game);
    }

    /**
     * A passive bot (v0.8.6) answers every yes-or-no question with no, as the engine answers for a
     * player nobody is left to decide for ({@link Prompts.Prompt#fallback}): it uses no optional
     * ability and pays no optional cost. XMage's AI says yes to nearly everything. One question is
     * answered yes: its commander goes back to the command zone (903.9), as any player would choose,
     * so a campaign test meets the commander again as the duel would.
     */
    @Override
    public boolean chooseUse(Outcome outcome, String message, Ability source, Game game) {
        if (passiveNow(game)) {
            return toCommandZone(message);
        }
        return super.chooseUse(outcome, message, source, game);
    }

    @Override
    public boolean chooseUse(Outcome outcome, String message, String secondMessage, String trueText,
                             String falseText, Ability source, Game game) {
        if (passiveNow(game)) {
            return toCommandZone(message);
        }
        return super.chooseUse(outcome, message, secondMessage, trueText, falseText, source, game);
    }

    /** XMage's question for a commander leaving the battlefield or the stack (its
     * CommanderReplacementEffect): "Move <commander> to command zone instead of your <zone>?". */
    static boolean toCommandZone(String message) {
        return message != null && message.contains(" to command zone instead of ");
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
        long copying = System.nanoTime();
        Game sim = super.createSimulation(game);
        lastCopyMillis = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - copying);
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

    /** How long the last search's root copy took, in milliseconds (v0.9.3). */
    private volatile long lastCopyMillis;

    /**
     * The heap's fullness after its last collection (v0.9.3): the old generation's (or every heap
     * pool's) collection usage against its maximum, 0 when the JVM reports none.
     */
    static double heapPressure() {
        long used = 0;
        long max = 0;
        for (MemoryPoolMXBean pool : ManagementFactory.getMemoryPoolMXBeans()) {
            if (pool.getType() != MemoryType.HEAP || !pool.isCollectionUsageThresholdSupported()) {
                continue;
            }
            MemoryUsage usage = pool.getCollectionUsage();
            if (usage == null || usage.getMax() <= 0) {
                continue;
            }
            used += usage.getUsed();
            max += usage.getMax();
        }
        return max <= 0 ? 0 : (double) used / max;
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
        int depth = maxDepth;
        if (lastCopyMillis > HEAVY_COPY_MILLIS || heapPressure() > HEAP_PRESSURE) {
            depth = Math.min(depth, LIGHT_DEPTH);
            stats.light.incrementAndGet();
        }
        int searchDepth = depth;
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
                return addActions(searched, searchDepth, Integer.MIN_VALUE, Integer.MAX_VALUE);
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
     * The spells that name a card to fetch it from their caster's own library (v0.9.3). XMage asks
     * every card-name choice with {@code Outcome.Detriment} and its AI answers at random from every
     * card name there is, so Demonic Consultation exiled the bot's whole library and lost it the
     * game at its next draw (the campaign finale's turn-two losses at 40 life).
     */
    static final Set<String> NAMES_OWN_LIBRARY = Set.of("Demonic Consultation", "Spoils of the Vault");

    /** The cards a bot names first for those spells: the finale's win with an empty library. */
    private static final List<String> PREFERRED_NAMES = List.of("Thassa's Oracle", "Laboratory Maniac",
        "Jace, Wielder of Mysteries");

    @Override
    public boolean choose(Outcome outcome, Choice choice, Game game) {
        String named = isGameUnderControl() ? ownLibraryName(choice, game) : null;
        if (named != null) {
            choice.setChoice(named);
            return true;
        }
        return super.choose(outcome, choice, game);
    }

    /**
     * A card name for a spell of this bot's that fetches the named card from its own library: one
     * the library holds (the bot knows its own deck list, never its order), the preferred names
     * first, then its costliest nonland card. Null for any other choice.
     */
    String ownLibraryName(Choice choice, Game game) {
        if (choice == null || choice.getChoices() == null || choice.getChoices().size() < 100
            || game.getStack().isEmpty()) {
            return null;
        }
        var resolving = game.getStack().getFirstOrNull();
        if (resolving == null || !playerId.equals(resolving.getControllerId())
            || !NAMES_OWN_LIBRARY.contains(resolving.getName())) {
            return null;
        }
        List<Card> library = new ArrayList<>(getLibrary().getCards(game));
        if (library.isEmpty()) {
            return null;
        }
        for (String name : PREFERRED_NAMES) {
            if (library.stream().anyMatch(card -> card.getName().equals(name)) && choice.getChoices().contains(name)) {
                return name;
            }
        }
        return library.stream()
            .filter(card -> !card.isLand(game) && choice.getChoices().contains(card.getName()))
            .max(Comparator.comparingInt(Card::getManaValue).thenComparing(Card::getName, Comparator.reverseOrder()))
            .or(() -> library.stream().filter(card -> choice.getChoices().contains(card.getName()))
                .min(Comparator.comparing(Card::getName)))
            .map(Card::getName)
            .orElse(null);
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
