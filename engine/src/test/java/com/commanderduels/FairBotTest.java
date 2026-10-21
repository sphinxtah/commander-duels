package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import mage.cards.Card;
import mage.constants.RangeOfInfluence;
import mage.game.Game;
import mage.player.ai.ComputerPlayerControllableProxy;
import mage.players.Player;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The fair bot in real games: a position where knowing the next card of its own library changes
 * the bot's choice (AI02), and decisions that run out of budget (AI05). Needs ./db and ./decks.
 */
class FairBotTest {
    private static final String ORACLE = "Coiling Oracle";
    private static final String MERFOLK = "Coral Merfolk";
    private static final String BALOTH = "Enormous Baloth";
    /**
     * The top of the bot's library: its opening hand, the card it draws on turn 3, and then the
     * only other nonland card, the Baloth. Lands make up the rest.
     */
    private static final List<String> BOT_LIBRARY_TOP = List.of("Forest", "Island", ORACLE, MERFOLK,
        "Craw Wurm", "Craw Wurm", "Craw Wurm", "Craw Wurm", BALOTH);

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    /**
     * A human seat with only Plains, which plays nothing, against a bot whose library is arranged.
     * The bot starts and plays a land on turns 1 and 3. On turn 3, with Forest and Island, it can
     * cast one of two creatures. Coral Merfolk, a 2/1, is worth more to XMage's evaluation than
     * Coiling Oracle, a 1/1, unless the Oracle's trigger finds a land on top of the library and puts
     * it onto the battlefield. The real top card is the Baloth, but 51 of the 52 cards left in the
     * library are lands. A bot that sees its next card casts the Merfolk; a bot that knows only the
     * library's contents expects a land and casts the Oracle. Skill 6 searches deep enough to see the
     * trigger resolve after the land drop.
     */
    static HumanGameRequest request(long seed) {
        var human = new HumanGameRequest.Seat(HumanGameRequest.HUMAN, HumanGameRequest.CUSTOM_DECK,
            new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Plains", 60)), List.of()));
        var bot = new HumanGameRequest.Seat(HumanGameRequest.BOT, HumanGameRequest.CUSTOM_DECK,
            new DeckLists.CustomDeck(List.of(new DeckLists.Entry(ORACLE, 1), new DeckLists.Entry(MERFOLK, 1),
                new DeckLists.Entry("Craw Wurm", 4), new DeckLists.Entry(BALOTH, 1),
                new DeckLists.Entry("Forest", 27), new DeckLists.Entry("Island", 26)), List.of()));
        return new HumanGameRequest(seed, GameFormat.LEGACY, List.of(human, bot), 6, 3, 600);
    }

    /** Arranges the bot's library and records the permanents the bot controls. */
    static final class Fixture implements HumanGame.Hooks {
        private final boolean xmageBot;
        final Set<String> botPermanents = ConcurrentHashMap.newKeySet();
        volatile FairBot fairBot;
        private volatile UUID botId;

        Fixture(boolean xmageBot) {
            this.xmageBot = xmageBot;
        }

        @Override
        public Player bot(int seat, String name, RangeOfInfluence range, int skill, long seed) {
            if (xmageBot) {
                // XMage's own bot, which searches the real library: the baseline.
                return new ComputerPlayerControllableProxy(name, range, skill);
            }
            fairBot = (FairBot) HumanGame.Hooks.super.bot(seat, name, range, skill, seed);
            return fairBot;
        }

        @Override
        public void beforeStart(Game game, List<UUID> seatIds) {
            botId = seatIds.get(1);
            game.getOptions().skipInitShuffling = true;
            Player bot = game.getPlayer(botId);
            List<Card> rest = new ArrayList<>(bot.getLibrary().getCards(game));
            LinkedHashSet<Card> ordered = new LinkedHashSet<>();
            for (String name : BOT_LIBRARY_TOP) {
                Card card = rest.stream().filter(candidate -> candidate.getName().equals(name)).findFirst()
                    .orElseThrow(() -> new IllegalStateException(name + " is not in the deck"));
                rest.remove(card);
                ordered.add(card);
            }
            ordered.addAll(rest);
            bot.getLibrary().clear();
            bot.getLibrary().addAll(ordered, game);
        }

        @Override
        public void published(Game game, ObjectRefs refs, int seat, SeatView view, PromptView prompt) {
            UUID id = botId;
            if (id != null) {
                game.getBattlefield().getAllActivePermanents(id)
                    .forEach(permanent -> botPermanents.add(permanent.getName()));
            }
        }
    }

    /** The human seat keeps its hand, lets the bot start, plays nothing and discards what it must. */
    private static String passEverything(int seat, PromptView prompt, SeatView view) {
        List<PromptView.Option> options = prompt.options();
        switch (prompt.kind()) {
            case "priority":
                return ScriptedPlayer.byAction(options, "pass").get(0).id();
            case "mulligan":
                return ScriptedPlayer.byAction(options, "keep").get(0).id();
            case "declare_attackers":
            case "declare_blockers":
                return ScriptedPlayer.byAction(options, "done").get(0).id();
            case "choose_target": {
                Optional<PromptView.Option> botSeat = options.stream()
                    .filter(option -> Integer.valueOf(1).equals(option.seat())).findFirst();
                if (botSeat.isPresent() && view != null && view.turn() == 0) {
                    return botSeat.get().id(); // the bot starts
                }
                List<PromptView.Option> done = ScriptedPlayer.byAction(options, "done");
                if (!done.isEmpty() && options.stream().anyMatch(PromptView.Option::selected)) {
                    return done.get(0).id();
                }
                return options.stream().filter(option -> option.action().equals("choose") && !option.selected())
                    .findFirst().orElse(options.get(0)).id();
            }
            default:
                return options.stream().filter(option -> !option.action().equals("cancel")).findFirst()
                    .orElse(options.get(0)).id();
        }
    }

    private static Fixture play(Fixture fixture) throws Exception {
        var game = new HumanGame(UUID.randomUUID().toString(), request(61L), SeatChecks.DECKS, finished -> {}, fixture);
        game.start();
        Tables.Played played = Tables.play(game, FairBotTest::passEverything, 3, new Tables.Coverage());
        HumanGame.Result result = played.last().result();
        assertEquals("turn_limit", result.kind(), result.toString());
        assertTrue(BotMatchRunner.join(game.thread(), 10_000), "game thread still running");
        return fixture;
    }

    @Test
    void theBotDoesNotKnowWhatItDrawsNext() throws Exception {
        Fixture xmage = play(new Fixture(true));
        assertTrue(xmage.botPermanents.contains(MERFOLK) && !xmage.botPermanents.contains(ORACLE),
            "the fixture must tell the bots apart: XMage's bot sees the Baloth on top and casts the Merfolk, but it "
                + "controls " + xmage.botPermanents);

        Fixture fair = play(new Fixture(false));
        assertTrue(fair.botPermanents.contains(ORACLE) && !fair.botPermanents.contains(MERFOLK),
            "the fair bot expects a land from a library of lands and casts the Oracle, but it controls "
                + fair.botPermanents);
        assertNotNull(fair.fairBot);
        FairBot.Stats stats = fair.fairBot.stats();
        assertTrue(stats.samples() > 0 && stats.samples() == stats.searches(), "one sample per search");
        assertEquals(0, stats.timedOut(), "these small searches finish well within skill 6's 18 s");
        // After the land drop the bot continues its plan: the seat's fingerprint of the real game
        // matches the one the search recorded, although the copies hold other cards.
        assertTrue(stats.continued() > 0, "the bot never continued a planned chain");
        System.out.printf("Peeking fixture: XMage's bot %s, fair bot %s; fair bot %d searches, %d continued%n",
            xmage.botPermanents, fair.botPermanents, stats.searches(), stats.continued());
    }

    @Test
    void decisionsThatRunOutOfBudgetStillPlayLegally() throws Exception {
        // A 1 ms budget cuts almost every search short: the bot must still play only legal moves (XMage
        // reports no error), and every decision must return within the budget and the stop grace.
        HumanGameRequest request = HumanGameTest.legacy(301L, "legacy-mono-green-creatures", 8, 600);
        List<FairBot> bots = new CopyOnWriteArrayList<>();
        var check = new SeatChecks(request) {
            @Override
            public Player bot(int seat, String name, RangeOfInfluence range, int skill, long seed) {
                var bot = new FairBot(name, range, skill, FairBot.seedFor(seed, seat), new FairBot.Budget(1));
                bots.add(bot);
                return bot;
            }
        };
        HumanGame game = Tables.start(request, check);
        var player = new ScriptedPlayer(301L);
        Tables.Played played = Tables.play(game, (seat, prompt, view) -> player.choose(prompt, view), 4,
            new Tables.Coverage());
        check.settle();
        assertTrue(check.failures.isEmpty(), "XMage errors or wrong views: " + check.failures);
        HumanGame.Result result = played.last().result();
        assertTrue(Set.of("completed", "turn_limit").contains(result.kind()), result.toString());
        assertNull(result.error());
        assertTrue(BotMatchRunner.join(game.thread(), 10_000), "game thread still running");

        assertEquals(1, bots.size());
        FairBot.Stats stats = bots.get(0).stats();
        assertTrue(stats.searches() > 0, "the bot never searched");
        assertTrue(stats.timedOut() > 0, "a 1 ms budget cut no search short");
        assertTrue(stats.longestMillis() <= 1 + FairBot.STOP_GRACE_MILLIS + 1_000,
            "a decision took " + stats.longestMillis() + " ms");
        System.out.printf("1 ms budget: %d searches, %d completed, %d timed out, %d abandoned, longest %d ms%n",
            stats.searches(), stats.completed(), stats.timedOut(), stats.abandoned(), stats.longestMillis());
    }
}
