package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import mage.game.Game;
import mage.game.match.Match;
import mage.players.Player;
import mage.util.RandomUtil;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfSystemProperty;

/**
 * Measures the Two-Headed Giant bot decks' pairings (v0.5.1): four fair bots play whole games for
 * each way of pairing the four Legacy fixtures into two teams, and the wins are counted by team.
 * Not part of the suite: run with {@code -Dtest=TwoHeadedGiantPairingTest -Dcd.pairings=<games>}
 * (and optionally {@code -Dcd.pairingSkill=<skill>}, 4 by default, the practice and queue bots';
 * {@code -Dcd.pairingSeed=<first seed>}, 7000 by default; {@code -Dcd.pairingOnly=<indexes>}). The
 * games run four at a time, which shares XMage's random source, so a rerun is close but not identical.
 * The results are recorded in docs/engine/two-headed-giant.md.
 */
@EnabledIfSystemProperty(named = "cd.pairings", matches = "\\d+")
class TwoHeadedGiantPairingTest {
    private static final String RED = "legacy-mono-red-burn";
    private static final String GREEN = "legacy-mono-green-creatures";
    private static final String WHITE = "legacy-mono-white-weenie";
    private static final String BLUE = "legacy-mono-blue-skies";
    /** Each pairing: seats 0 and 1 (team A) against seats 2 and 3 (team B). */
    private static final List<List<String>> PAIRINGS = List.of(
        List.of(RED, GREEN, WHITE, BLUE), List.of(RED, WHITE, GREEN, BLUE), List.of(RED, BLUE, GREEN, WHITE));

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    /** One game's outcome: the winning team (0 for team A, 1 for team B, -1 for none) and its turns. */
    record Outcome(int team, int turns, String kind) {}

    @Test
    void measurePairings() throws Exception {
        int games = Integer.parseInt(System.getProperty("cd.pairings"));
        int skill = Integer.parseInt(System.getProperty("cd.pairingSkill", "4"));
        long firstSeed = Long.parseLong(System.getProperty("cd.pairingSeed", "7000"));
        // The pairings to play, by index in PAIRINGS ("0,1,2" by default)
        List<Integer> only = java.util.Arrays.stream(System.getProperty("cd.pairingOnly", "0,1,2").split(","))
            .map(Integer::parseInt).toList();
        ExecutorService pool = Executors.newFixedThreadPool(4, runnable -> {
            Thread thread = new Thread(runnable, mage.util.ThreadUtils.THREAD_PREFIX_GAME + " pairing");
            thread.setDaemon(true);
            return thread;
        });
        Map<String, String> summary = new TreeMap<>();
        for (int index : only) {
            List<String> decks = PAIRINGS.get(index);
            List<Future<Outcome>> futures = new ArrayList<>();
            for (int game = 0; game < games; game++) {
                long seed = firstSeed + game;
                futures.add(pool.submit(() -> play(decks, seed, skill)));
            }
            int[] wins = new int[2];
            int none = 0;
            List<Integer> turns = new ArrayList<>();
            for (Future<Outcome> future : futures) {
                Outcome outcome = future.get(10, TimeUnit.MINUTES);
                if (outcome.team() < 0) {
                    none++;
                } else {
                    wins[outcome.team()]++;
                }
                turns.add(outcome.turns());
            }
            Collections.sort(turns);
            String name = colour(decks.get(0)) + "+" + colour(decks.get(1)) + " vs " + colour(decks.get(2)) + "+"
                + colour(decks.get(3));
            summary.put(name, "team A " + wins[0] + ", team B " + wins[1] + ", neither " + none + " (of " + games
                + "); turns median " + turns.get(turns.size() / 2) + ", " + turns.get(0) + " to "
                + turns.get(turns.size() - 1));
            System.out.println("Pairing " + name + ": " + summary.get(name));
        }
        pool.shutdownNow();
        summary.forEach((name, result) -> System.out.println("PAIRING " + name + " | skill " + skill + " | " + result));
    }

    private static String colour(String deck) {
        return deck.replace("legacy-mono-", "").replaceAll("-.*", "");
    }

    private static Outcome play(List<String> decks, long seed, int skill) throws Exception {
        GameFormat format = GameFormat.TWO_HEADED_GIANT;
        Game game;
        List<UUID> ids;
        synchronized (TwoHeadedGiantPairingTest.class) {
            // XMage's random source is global: seed and set up one game at a time
            RandomUtil.setSeed(seed);
            game = format.newGame(TwoHeadedGiant.PLAYERS, 60);
            Match match = format.newMatch("Two-Headed Giant pairing", TwoHeadedGiant.PLAYERS);
            List<Player> players = new ArrayList<>();
            for (int seat = 0; seat < TwoHeadedGiant.PLAYERS; seat++) {
                players.add(new FairBot("Bot " + (seat + 1), format.range(), skill, FairBot.seedFor(seed, seat)));
            }
            for (int index : HumanGame.additionOrder(players.size())) {
                LegacyDuel.seat(game, match, players.get(index), format.loadDeck(SeatChecks.DECKS, decks.get(index)));
            }
            ids = players.stream().map(Player::getId).toList();
            format.seatTeams(game, ids);
        }
        // Each team starts half the games.
        game.start(ids.get(seed % 2 == 0 ? 0 : 2));
        int team = -1;
        for (int seat = 0; seat < ids.size(); seat++) {
            if (game.getPlayer(ids.get(seat)).hasWon()) {
                team = seat / 2;
            }
        }
        String kind = game.hasEnded() ? "completed" : "turn_limit";
        return new Outcome(team, Math.min(game.getTurnNum(), 60), kind);
    }
}
