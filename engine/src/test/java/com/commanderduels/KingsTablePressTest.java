package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import mage.game.combat.CombatGroup;
import mage.game.permanent.Permanent;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * King's Table (v0.9.0): a bot General presses the attack on the opposing General beside it unless
 * that player could block, kill the attacker and live (the owner's choice after a game where the
 * bot Generals never fought). Seats 0 to 5 are team A's Left General, King and Right General, then
 * team B's Right General, King and Left General; seat 1, team A's King, is a scripted human who
 * passes, the others bots, and seat 1 starts: turn 2 is seat 2's, turn 6 seat 0's. The cards are
 * put onto the battlefield in turn 1's main phase. Needs ./db.
 */
class KingsTablePressTest {

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    @Test
    void aBotGeneralAttacksTheGeneralBesideItUnlessOutmatched() throws Exception {
        var rules = new KingsTableRules(false, KingsTableRules.ALL_20, false);
        List<String> decks = GameFormat.KINGS_TABLE_LEGACY.decks();
        List<HumanGameRequest.Seat> seats = new ArrayList<>();
        for (int seat = 0; seat < 6; seat++) {
            String deck = decks.get(seat % decks.size());
            seats.add(seat == 1 ? Tables.human(deck) : Tables.bot(deck));
        }
        var request = new HumanGameRequest(9101L, GameFormat.KINGS_TABLE_LEGACY, seats, 1, 7, 900, 0, 1, null, rules);
        Map<Integer, FairBot> bots = new ConcurrentHashMap<>();
        Map<String, String> attacks = new ConcurrentHashMap<>();
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request)
            // Seat 0's Bears face seat 5's Wall of Torches (4/1): it would trade, so the Bears go in.
            .battlefield(0, "Grizzly Bears")
            .battlefield(5, "Wall of Torches")
            // Seat 3's Serra Angel faces seat 2's Bears, which could not kill it: XMage's AI keeps
            // it home (seen in the run), and the press sends it at seat 2 in turn 3.
            .battlefield(2, "Grizzly Bears")
            .battlefield(3, "Serra Angel")
            .bots((seat, name, range, skill, seed) -> {
                FairBot bot = new FairBot(name, range, skill, FairBot.seedFor(seed, seat));
                bots.put(seat, bot);
                return bot;
            })
            .probe((game, ids, seat, view) -> {
                if (game.getCombat() == null) {
                    return;
                }
                for (CombatGroup group : game.getCombat().getGroups()) {
                    for (var attackerId : group.getAttackers()) {
                        Permanent attacker = game.getPermanent(attackerId);
                        if (attacker != null) {
                            attacks.putIfAbsent(view.turn() + ":" + attacker.getName() + ":"
                                + ids.indexOf(attacker.getControllerId()), String.valueOf(ids.indexOf(group.getDefenderId())));
                        }
                    }
                }
            });
        HumanGame game = Tables.start(scenario.gameRequest, scenario);
        Tables.play(game, TwoHeadedGiantAuditTest.passing(false), 6, new Tables.Coverage());
        scenario.settle();
        assertTrue(scenario.failures.isEmpty(), "leaks or wrong views: " + scenario.failures);
        System.out.println("Attacks " + new java.util.TreeMap<>(attacks) + "; pressed " + bots.entrySet().stream()
            .map(entry -> entry.getKey() + "=" + entry.getValue().stats().pressed()).toList());

        assertEquals("2", attacks.get("3:Serra Angel:3"), "seat 3's Angel attacked seat 2: " + attacks);
        assertTrue(bots.get(3).stats().pressed() >= 1, "the press sent the Angel");
        assertEquals("5", attacks.get("6:Grizzly Bears:0"), "seat 0's Bears attacked seat 5: " + attacks);
        assertEquals(0, bots.get(4).stats().pressed(), "a King never presses");
    }

    @Test
    void outmatchedWeighsTheDefendersUntappedBlockers() throws Exception {
        // The same check as a unit: Serra Angel outmatches Grizzly Bears, Wall of Torches does not.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(new HumanGameRequest(9102L, GameFormat.LEGACY,
            List.of(Tables.human(LegacyDuel.DECKS.get(0)), Tables.human(LegacyDuel.DECKS.get(1))), 1, 2, 900, 0, 0))
            .battlefield(0, "Grizzly Bears")
            .battlefield(1, "Serra Angel", "Wall of Torches");
        Map<String, Boolean> seen = new ConcurrentHashMap<>();
        scenario.probe((game, ids, seat, view) -> {
            if (seen.containsKey("done")) {
                return;
            }
            Permanent bears = game.getBattlefield().getAllActivePermanents(ids.get(0)).stream()
                .filter(permanent -> permanent.getName().equals("Grizzly Bears")).findFirst().orElse(null);
            if (bears == null) {
                return;
            }
            seen.put("done", true);
            seen.put("with the Angel", FairBot.outmatched(game, bears, ids.get(1)));
            for (Permanent permanent : game.getBattlefield().getAllActivePermanents(ids.get(1))) {
                if (permanent.getName().equals("Serra Angel")) {
                    permanent.tap(null, game);
                }
            }
            seen.put("the Angel tapped", FairBot.outmatched(game, bears, ids.get(1)));
        });
        HumanGame game = Tables.start(scenario.gameRequest, scenario);
        Tables.play(game, TwoHeadedGiantAuditTest.passing(false), 4, new Tables.Coverage());
        scenario.settle();
        assertEquals(true, seen.get("with the Angel"), seen.toString());
        assertEquals(false, seen.get("the Angel tapped"), seen.toString());
    }
}
