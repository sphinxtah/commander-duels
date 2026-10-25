package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Declaring blockers (v0.6.3, the owner's report): a creature offered as a blocker can block one of
 * the attackers. XMage lists every creature able to block something, then asks which attacker; for
 * a creature that can block none (Varragoth, Bloodsky Sire against a flier), that question offered
 * nothing and Done asked for blockers again, forever. Needs ./db (the card database).
 */
class BlockersTest {

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    @Test
    void onlyCreaturesThatCanBlockAnAttackerAreOffered() throws Exception {
        // Seat 0's Air Elemental (flying) attacks in turn 3. Seat 1's Giant Spider (reach) can block
        // it and is offered; its Grizzly Bears cannot and is not. The Spider blocks it: the choice of
        // the attacker is made for it, the only one it can block.
        var request = new HumanGameRequest(6301L, GameFormat.LEGACY,
            List.of(Tables.human(LegacyDuel.DECKS.get(0)), Tables.human(LegacyDuel.DECKS.get(1))), 1, 4, 900, 0, 0);
        var scenario = new TwoHeadedGiantAuditTest.Scenario(request)
            .battlefield(0, "Air Elemental")
            .battlefield(1, "Grizzly Bears", "Giant Spider");
        Set<String> offered = ConcurrentHashMap.newKeySet();
        Set<String> blocking = ConcurrentHashMap.newKeySet();
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        HumanGame game = Tables.start(request, scenario);
        Tables.play(game, (seat, prompt, view) -> {
            if (view.turn() == 3 && seat == 0 && prompt.kind().equals("declare_attackers")) {
                var elemental = prompt.options().stream()
                    .filter(option -> option.action().equals("toggle_attacker")
                        && "Air Elemental".equals(option.label()))
                    .findFirst();
                return elemental.isPresent() && !elemental.get().selected()
                    ? elemental.get().id() : first(prompt, "done");
            }
            if (view.turn() == 3 && seat == 1 && prompt.kind().equals("declare_blockers")) {
                for (PromptView.Option option : prompt.options()) {
                    if (option.action().equals("toggle_blocker")) {
                        offered.add(option.label());
                        if (option.selected()) {
                            blocking.add(option.label());
                        }
                    }
                }
                var spider = prompt.options().stream()
                    .filter(option -> option.action().equals("toggle_blocker")
                        && "Giant Spider".equals(option.label()) && !option.selected())
                    .findFirst();
                return spider.isPresent() ? spider.get().id() : first(prompt, "done");
            }
            return pass.choose(seat, prompt, view);
        }, 4, new Tables.Coverage());
        scenario.settle();
        assertTrue(scenario.failures.isEmpty(), "leaks or wrong views: " + scenario.failures);

        assertEquals(Set.of("Giant Spider"), offered, "only the Spider can block the flier");
        assertEquals(Set.of("Giant Spider"), blocking, "the Spider blocked the Elemental");
    }

    private static String first(PromptView prompt, String action) {
        return ScriptedPlayer.byAction(prompt.options(), action).get(0).id();
    }
}
