package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import mage.constants.RangeOfInfluence;
import mage.game.Game;
import mage.game.match.Match;
import mage.players.Player;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * A round of responses (v0.9.14, the owner's report of 2026-11-14: late in a four-seat Commander
 * game three bots took a minute between them to answer one spell). A bot has its whole budget for
 * its own turn with nothing on the stack; any other decision has its share of one round, divided
 * among the table's bots. A bot alone against one player keeps its whole budget, and so does each
 * of two bots in a game of two.
 */
class ResponseRoundTest {
    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    /** A player who keeps their hand and passes every priority. */
    private static final Tables.Policy PASSING = (seat, prompt, view) -> {
        List<PromptView.Option> options = prompt.options();
        for (String action : List.of("keep", "pass")) {
            for (PromptView.Option option : options) {
                if (option.action().equals(action)) {
                    return option.id();
                }
            }
        }
        return options.stream().filter(option -> !option.action().equals("cancel")).findFirst()
            .orElse(options.get(0)).id();
    };

    /** What each bot would think at this moment, by whether it is that bot's own turn. */
    private static void read(Game game, Map<String, Long> seen) {
        for (Player player : game.getPlayers().values()) {
            if (player instanceof FairBot bot) {
                boolean own = bot.getId().equals(game.getActivePlayerId()) && game.getStack().isEmpty();
                seen.merge((own ? "own turn " : "response ") + bot.thinkMillis(game), 1L, Long::sum);
            }
        }
    }

    @Test
    void threeBotsShareARoundAndABotAloneKeepsItsBudget() throws Exception {
        long whole = FairBot.Budget.forSkill(4).thinkMillis();
        assertEquals(12_000, whole);

        // One player and three bots at a Commander table, the table's default skill.
        List<HumanGameRequest.Seat> seats = new ArrayList<>();
        seats.add(Tables.human("commander-mono-blue-flyers"));
        for (String deck : List.of("commander-mono-green-stompers", "commander-mono-red-raiders",
            "commander-mono-white-soldiers")) {
            seats.add(Tables.bot(deck));
        }
        Map<String, Long> table = new ConcurrentHashMap<>();
        var four = new TwoHeadedGiantAuditTest.Scenario(new HumanGameRequest(9142L, GameFormat.COMMANDER, seats, 4, 2, 900))
            .probe((Game game, List<UUID> seatIds, int seat, SeatView view) -> read(game, table));
        HumanGame commander = Tables.start(four.gameRequest, four);
        Tables.play(commander, PASSING, 2, new Tables.Coverage());
        four.settle();
        System.out.println("Three bots at a table: " + table);
        assertTrue(four.failures.isEmpty(), "leaks, wrong views or XMage errors: " + four.failures);
        // A response is a third of a six-second round; a bot's own turn has the whole budget.
        assertTrue(table.containsKey("response 2000"), table.toString());
        assertFalse(table.keySet().stream().anyMatch(key -> key.startsWith("response ")
            && !key.equals("response 2000")), table.toString());
        assertFalse(table.keySet().stream().anyMatch(key -> key.startsWith("own turn ")
            && !key.equals("own turn " + whole)), table.toString());

        // One bot against one player: every decision has the whole budget, as before.
        Map<String, Long> duel = new ConcurrentHashMap<>();
        var two = new TwoHeadedGiantAuditTest.Scenario(new HumanGameRequest(9143L, GameFormat.LEGACY, List.of(
            Tables.human("legacy-mono-blue-skies"), Tables.bot("legacy-mono-red-burn")), 4, 2, 900))
            .probe((Game game, List<UUID> seatIds, int seat, SeatView view) -> read(game, duel));
        HumanGame legacy = Tables.start(two.gameRequest, two);
        Tables.play(legacy, PASSING, 2, new Tables.Coverage());
        two.settle();
        System.out.println("One bot in a duel: " + duel);
        assertFalse(duel.isEmpty());
        assertTrue(duel.keySet().stream().allMatch(key -> key.endsWith(" " + whole)), duel.toString());
    }

    @Test
    void twoBotsInAGameOfTwoKeepTheirBudgets() throws Exception {
        // The campaign's duels are measured bot against bot: they are played as a player's are.
        Game game = LegacyDuel.newGame(10);
        Match match = LegacyDuel.newMatch("response round test");
        var first = new FairBot("Bot 1", RangeOfInfluence.ONE, 6, FairBot.seedFor(7L, 0));
        var second = new FairBot("Bot 2", RangeOfInfluence.ONE, 3, FairBot.seedFor(7L, 1));
        LegacyDuel.seat(game, match, first, LegacyDuel.loadDeck(SeatChecks.DECKS, "legacy-mono-red-burn"));
        LegacyDuel.seat(game, match, second, LegacyDuel.loadDeck(SeatChecks.DECKS, "legacy-mono-blue-skies"));
        assertEquals(18_000, first.thinkMillis(game));
        assertEquals(3_000, second.thinkMillis(game));
    }
}
