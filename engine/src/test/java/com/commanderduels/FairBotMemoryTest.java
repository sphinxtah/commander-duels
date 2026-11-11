package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BooleanSupplier;
import mage.abilities.Ability;
import mage.abilities.ActivatedAbility;
import mage.abilities.effects.SearchEffect;
import mage.cards.Card;
import mage.constants.RangeOfInfluence;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.match.Match;
import mage.game.permanent.Permanent;
import mage.game.permanent.PermanentCard;
import mage.game.stack.StackAbility;
import mage.player.ai.ComputerPlayerControllableProxy;
import mage.player.ai.SimulationNode2;
import mage.players.Player;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The memory of a bot's search (v0.9.8). At the campaign's court a search held hundreds of copies of
 * the game at once, and the engine's heap ran out: XMage's AI tries every card a search effect could
 * find, copying the game for each of them before it scores the first and keeping each one's line of
 * play until it has scored the last. The fair bot tries them one at a time, one card for each name,
 * and a running search ends when the heap fills. Needs ./db.
 */
class FairBotMemoryTest {
    private static final String FETCH = "Evolving Wilds";
    /** The bot's library under the fetch land: 59 basic lands of eleven names, in the names' order. */
    private static final List<String> NAMES = List.of("Forest", "Island", "Mountain", "Plains", "Snow-Covered Forest",
        "Snow-Covered Island", "Snow-Covered Mountain", "Snow-Covered Plains", "Snow-Covered Swamp", "Swamp", "Wastes");
    private static final List<DeckLists.Entry> LANDS = NAMES.stream()
        .map(name -> new DeckLists.Entry(name, name.equals("Forest") ? 9 : 5)).toList();

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    /** A fair bot that notes how many of a node's children are alive whenever one of them is searched. */
    private static final class Counting extends FairBot {
        private static final long serialVersionUID = 1L;
        int mostAlive;
        int searched;

        Counting(String name) {
            super(name, RangeOfInfluence.ONE, 6, 98L);
        }

        @Override
        protected int addActions(SimulationNode2 node, int depth, int alpha, int beta) {
            searched++;
            if (node.getParent() != null) {
                int alive = (int) node.getParent().getChildren().stream().filter(Objects::nonNull).count();
                mostAlive = Math.max(mostAlive, alive);
            }
            return super.addActions(node, depth, alpha, beta);
        }
    }

    /** XMage's own bot, with its search's steps opened to the test. */
    private static final class Xmage extends ComputerPlayerControllableProxy {
        private static final long serialVersionUID = 1L;

        Xmage(String name) {
            super(name, RangeOfInfluence.ONE, 6);
        }

        Game simulation(Game game) {
            return createSimulation(game);
        }

        void resolveStack(SimulationNode2 node, int depth, Game game) {
            resolve(node, depth, game);
        }
    }

    /**
     * A Legacy table before its first turn: the bot controls the fetch land, with only basic lands
     * in its library, and its fetch ability is on the stack of a copy made for a search.
     */
    private record Table(Game sim, UUID botId, int landsInLibrary) {}

    private static Table table(Player bot, java.util.function.Function<Game, Game> simulation) throws Exception {
        Game game = LegacyDuel.newGame(10);
        Match match = LegacyDuel.newMatch("fair bot memory test");
        var opponent = new ComputerPlayerControllableProxy("Opponent", RangeOfInfluence.ONE, 1);
        List<DeckLists.Entry> cards = new ArrayList<>(LANDS);
        cards.add(new DeckLists.Entry(FETCH, 1));
        LegacyDuel.seat(game, match, bot, DeckLists.load(new DeckLists.CustomDeck(cards, List.of())));
        LegacyDuel.seat(game, match, opponent,
            DeckLists.load(new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Island", 60)), List.of())));
        bot.updateRange(game);
        opponent.updateRange(game);
        Card fetch = bot.getLibrary().getCards(game).stream().filter(card -> card.getName().equals(FETCH))
            .findFirst().orElseThrow();
        bot.getLibrary().remove(fetch.getId(), game);
        Permanent land = new PermanentCard(fetch, bot.getId(), game);
        game.getBattlefield().addPermanent(land);
        game.getState().setZone(fetch.getId(), Zone.BATTLEFIELD);

        Game sim = simulation.apply(game);
        Ability search = sim.getPermanent(fetch.getId()).getAbilities(sim).stream()
            .filter(ability -> ability instanceof ActivatedAbility
                && ability.getEffects().stream().anyMatch(effect -> effect instanceof SearchEffect))
            .findFirst().orElseThrow();
        sim.getStack().push(sim, new StackAbility(search, bot.getId()));
        return new Table(sim, bot.getId(), sim.getPlayer(bot.getId()).getLibrary().size());
    }

    @Test
    void aSearchEffectsCardsAreTriedOneAtATime() throws Exception {
        // XMage: a copy of the game for every card in the library of every player in range (the
        // bot's 59 lands, and the opponent's 60 Islands, which the search could never find), all
        // made before one is scored. At the court's six seats with Commander decks that is hundreds.
        var xmage = new Xmage("XMage");
        Table before = table(xmage, xmage::simulation);
        assertEquals(59, before.landsInLibrary());
        var all = new SimulationNode2(null, before.sim(), 4, before.botId());
        xmage.resolveStack(all, 4, before.sim());
        assertEquals(59 + 60, all.getChildren().size(), "XMage copies the game for every card in range at once");

        // The fair bot: the first card's copy alone, and the others as the search comes to them.
        var bot = new Counting("Fair");
        Table table = table(bot, bot::createSimulation);
        assertEquals(59, table.landsInLibrary());
        var node = new SimulationNode2(null, table.sim(), 4, table.botId());
        bot.resolve(node, 4, table.sim());
        assertEquals(1, node.getChildren().size(), "one copy when the search effect is met");
        assertEquals(1, bot.stats().finds());
        assertEquals(1, bot.stats().found());

        // A depth that scores each found card where it stands: every line scores the same, so the
        // first stays the best and the others are let go as they are scored.
        bot.minimaxAB(node, 1, Integer.MIN_VALUE, Integer.MAX_VALUE);
        assertEquals(NAMES.size(), bot.stats().found(), "one card for each name in the bot's own library");
        assertEquals(NAMES.size(), bot.searched);
        assertTrue(bot.mostAlive <= 2, "the best line and the one being scored, never more: " + bot.mostAlive);
        assertEquals(1, node.getChildren().size(), "the best line is kept, as XMage keeps it");
        SimulationNode2 best = node.getChildren().get(0);
        assertEquals(1, best.getTargets().size());
        Set<String> names = new TreeSet<>();
        names.add(table.sim().getCard(best.getTargets().get(0)).getName());
        assertEquals(Set.of("Forest"), names, "the first name in order, when every card scores the same");
    }

    @Test
    void oneCardOfEachNameWhateverTheOrder() throws Exception {
        var bot = new Counting("Fair");
        Table table = table(bot, bot::createSimulation);
        Player player = table.sim().getPlayer(table.botId());
        Set<UUID> library = Set.copyOf(player.getLibrary().getCardList());
        List<UUID> chosen = List.copyOf(FairBot.oneOfEachName(library, table.sim()));
        assertEquals(NAMES, chosen.stream().map(id -> table.sim().getCard(id).getName()).toList());
        // The same cards from the same set every time: a seed repeats its game.
        assertEquals(chosen, List.copyOf(FairBot.oneOfEachName(new java.util.LinkedHashSet<>(
            library.stream().sorted(java.util.Comparator.reverseOrder()).toList()), table.sim())));

        // A search is of the searching player's own library: the opponent's cards are left out, though
        // XMage names them. If none of the named cards is the searching player's, all of them are tried.
        Player opponent = table.sim().getPlayers().values().stream()
            .filter(other -> !other.getId().equals(table.botId())).findFirst().orElseThrow();
        Set<UUID> theirs = Set.copyOf(opponent.getLibrary().getCardList());
        Set<UUID> both = new java.util.HashSet<>(library);
        both.addAll(theirs);
        assertEquals(chosen, List.copyOf(FairBot.findable(both, table.botId(), table.sim())));
        assertEquals(theirs.size(), FairBot.findable(theirs, table.botId(), table.sim()).size());
    }

    @Test
    void aSearchEndsWhenTheHeapFillsAndTheBotStillPlaysLegally() throws Exception {
        // Every look at the heap says it is full: a search still running at its first look (100 ms)
        // ends there, as at the end of its budget, and the bot plays its best action so far.
        HumanGameRequest request = HumanGameTest.legacy(981L, "legacy-mono-green-creatures", 8, 600);
        List<FairBot> bots = new CopyOnWriteArrayList<>();
        var check = new SeatChecks(request) {
            @Override
            public Player bot(int seat, String name, RangeOfInfluence range, int skill, long seed) {
                var bot = new FairBot(name, range, 6, FairBot.seedFor(seed, seat));
                bots.add(bot);
                return bot;
            }
        };
        BooleanSupplier real = FairBot.heapCheck;
        FairBot.heapCheck = () -> true;
        try {
            HumanGame game = Tables.start(request, check);
            var player = new ScriptedPlayer(981L);
            Tables.Played played = Tables.play(game, (seat, prompt, view) -> player.choose(prompt, view), 6,
                new Tables.Coverage());
            check.settle();
            assertTrue(check.failures.isEmpty(), "XMage errors or wrong views: " + check.failures);
            HumanGame.Result result = played.last().result();
            assertTrue(Set.of("completed", "turn_limit").contains(result.kind()), result.toString());
            assertNull(result.error());
            assertTrue(BotMatchRunner.join(game.thread(), 10_000), "game thread still running");
        } finally {
            FairBot.heapCheck = real;
        }
        assertEquals(1, bots.size());
        FairBot.Stats stats = bots.get(0).stats();
        System.out.println("A heap always full: " + stats);
        assertTrue(stats.heapStops() > 0, "no search was ended by the heap: " + stats);
        assertEquals(0, stats.timedOut(), "the heap ended them long before skill 6's 18 s");
        assertEquals(0, stats.abandoned(), "each stopped in time for its tree to be read");
        assertTrue(stats.longestMillis() <= FairBot.HEAP_CHECK_MILLIS + FairBot.STOP_GRACE_MILLIS + 1_000,
            "a decision took " + stats.longestMillis() + " ms");
    }

    @Test
    void theHeapIsReadAsAShareOfItsOldGeneration() {
        // On this JVM the heap is nowhere near full: the reading a search asks for says so.
        assertTrue(FairBot.heapPressure() >= 0 && FairBot.heapPressure() < 1);
        assertTrue(FairBot.HEAP_FULL > FairBot.HEAP_PRESSURE, "a running search is ended later than a new one is kept light");
        assertTrue(FairBot.HEAP_FULL_NOW > FairBot.HEAP_FULL, "the reading that counts garbage asks for more");
    }
}
