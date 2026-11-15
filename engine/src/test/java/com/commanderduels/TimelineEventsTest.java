package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Predicate;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * What the timeline explains (v1.0.0, events version 2), from games played through the prompts:
 * what a spell cost and what raised its cost, why a creature left the battlefield (lethal damage, a
 * destroying spell, a toughness of 0, a sacrifice, the legend rule), a spell that left the stack
 * because its only target was gone, and a mana ability's resolution told apart from the stack's.
 * Needs ./db (the card database).
 */
class TimelineEventsTest {
    private static final String BEARS = "Grizzly Bears";
    private static final String BOLT = "Lightning Bolt";
    private static final String ISAMARU = "Isamaru, Hound of Konda";
    private static final String SEER = "Viscera Seer";
    private static final String PYROMANCER = "Prodigal Pyromancer";
    private static final String RUNECLAW = "Runeclaw Bear";

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    private static HumanGameRequest duel(long seed, int turns) {
        var human = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Swamp", 40)), List.of());
        var bot = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Plains", 40)), List.of());
        return new HumanGameRequest(seed, GameFormat.LEGACY, List.of(
            new HumanGameRequest.Seat(HumanGameRequest.HUMAN, HumanGameRequest.CUSTOM_DECK, human),
            new HumanGameRequest.Seat(HumanGameRequest.BOT, HumanGameRequest.CUSTOM_DECK, bot)), 1, turns, 900);
    }

    private static String option(List<PromptView.Option> options, String action, String label) {
        return options.stream().filter(option -> option.action().equals(action)
            && (label == null || label.equals(option.label()))).findFirst().map(PromptView.Option::id).orElse(null);
    }

    /** What every prompt but the priority is answered with: a named choice first, then any that is not cancel. */
    // (No attacks and no blocks: the games are about what is cast.)
    private static String otherwise(PromptView prompt, String choose) {
        List<PromptView.Option> options = prompt.options();
        switch (prompt.kind()) {
            case "pay_mana": {
                String pay = option(options, "tap_source", null);
                pay = pay != null ? pay : option(options, "use_pool", null);
                return pay != null ? pay : options.get(0).id();
            }
            case "mulligan":
                return option(options, "keep", null);
            case "declare_attackers":
            case "declare_blockers":
                // Nobody attacks or blocks: an attacker picked is a toggle, and would be asked again.
                return option(options, "done", null);
            default: {
                String named = choose == null ? null : options.stream()
                    .filter(o -> o.action().equals("choose") && choose.equals(o.label()) && !o.selected())
                    .findFirst().map(PromptView.Option::id).orElse(null);
                if (named != null) {
                    return named;
                }
                // What is chosen stays chosen: a second press would take it back.
                String done = option(options, "done", null);
                if (done != null && options.stream().anyMatch(PromptView.Option::selected)) {
                    return done;
                }
                return options.stream().filter(o -> !o.action().equals("cancel") && !o.selected())
                    .findFirst().orElse(options.get(0)).id();
            }
        }
    }

    private static List<JsonObject> played(TwoHeadedGiantAuditTest.Scenario scenario, Tables.Policy policy)
            throws Exception {
        HumanGame game = Tables.start(scenario.gameRequest, scenario);
        Tables.play(game, policy, 4, new Tables.Coverage());
        scenario.settle();
        assertTrue(scenario.failures.isEmpty(), "leaks, wrong views or XMage errors: " + scenario.failures);
        List<JsonObject> events = game.events().since(0, Integer.MAX_VALUE);
        events.forEach(event -> assertEquals(2, event.get("v").getAsInt(), event.toString()));
        return events;
    }

    private static List<JsonObject> where(List<JsonObject> events, Predicate<JsonObject> test) {
        return events.stream().filter(test).toList();
    }

    private static boolean is(JsonObject event, String type, String key, String name) {
        return type.equals(event.get("type").getAsString()) && event.has(key) && event.get(key).isJsonObject()
            && event.getAsJsonObject(key).has("name") && !event.getAsJsonObject(key).get("name").isJsonNull()
            && name.equals(event.getAsJsonObject(key).get("name").getAsString());
    }

    private static boolean left(JsonObject event, String name) {
        return is(event, "zone_change", "object", name) && "battlefield".equals(event.get("from").getAsString());
    }

    @Test
    void aCastSaysWhatItCostAndADeathSaysWhy() throws Exception {
        var scenario = new TwoHeadedGiantAuditTest.Scenario(duel(10021L, 3))
            .battlefield(1, "Sphere of Resistance", BEARS, BEARS, BEARS)
            .battlefield(0, "Mountain", "Mountain", "Mountain", "Swamp", "Swamp", "Swamp", "Swamp", "Swamp", "Swamp")
            .hand(0, BOLT, "Doom Blade", "Disfigure");
        Tables.Policy policy = (seat, prompt, view) -> {
            if (!prompt.kind().equals("priority")) {
                return otherwise(prompt, BEARS);
            }
            if (view.stack().isEmpty()) {
                for (String spell : List.of(BOLT, "Doom Blade", "Disfigure")) {
                    String cast = option(prompt.options(), "cast", spell);
                    if (cast != null) {
                        return cast;
                    }
                }
            }
            return option(prompt.options(), "pass", null);
        };
        List<JsonObject> events = played(scenario, policy);

        JsonObject bolt = where(events, event -> is(event, "cast", "object", BOLT)).get(0);
        assertEquals("{R}", bolt.getAsJsonObject("object").get("mana_cost").getAsString(), bolt.toString());
        JsonObject cost = bolt.getAsJsonObject("cost");
        assertEquals("{1}{R}", cost.get("paid").getAsString(), bolt.toString());
        assertEquals(1, cost.getAsJsonArray("changes").size(), bolt.toString());
        JsonObject change = cost.getAsJsonArray("changes").get(0).getAsJsonObject();
        assertEquals("more", change.get("how").getAsString());
        assertEquals("Sphere of Resistance", change.getAsJsonObject("by").get("name").getAsString());
        assertEquals("all", change.getAsJsonObject("by").get("seen_by").getAsString());

        List<String> whys = new ArrayList<>();
        for (JsonObject death : where(events, event -> left(event, BEARS))) {
            assertEquals("graveyard", death.get("to").getAsString());
            whys.add(death.has("why") ? death.get("why").getAsString() : "none");
            if ("destroyed".equals(whys.get(whys.size() - 1))) {
                assertEquals("Doom Blade", death.getAsJsonObject("cause").get("name").getAsString(), death.toString());
            } else {
                assertFalse(death.has("cause"), "a death by the rules has no source: " + death);
            }
        }
        assertEquals(Set.of("lethal_damage", "destroyed", "toughness"), Set.copyOf(whys), "the three Bears: " + whys);
        assertEquals(3, whys.size());

        // The stack's resolutions are told apart from a land tapped for mana.
        assertTrue(where(events, event -> is(event, "resolve", "object", BOLT)).stream()
            .noneMatch(event -> event.has("immediate")), "Lightning Bolt resolved from the stack");
        List<JsonObject> mana = where(events, event -> is(event, "resolve", "object", "Mountain"));
        assertFalse(mana.isEmpty(), "a Mountain was tapped for mana");
        assertTrue(mana.stream().allMatch(event -> event.get("immediate").getAsBoolean()), mana.toString());
        assertTrue(where(events, event -> "fizzled".equals(event.get("type").getAsString())).isEmpty(),
            "every spell resolved");
    }

    @Test
    void aSpellWhoseTargetIsGoneFizzlesAndASacrificeAndTheLegendRuleAreNamed() throws Exception {
        var scenario = new TwoHeadedGiantAuditTest.Scenario(duel(10022L, 4))
            .battlefield(0, "Mountain", "Mountain", "Plains", "Plains", ISAMARU, SEER, BEARS, PYROMANCER, RUNECLAW)
            .hand(0, BOLT, ISAMARU);
        Set<String> done = ConcurrentHashMap.newKeySet();
        Tables.Policy policy = (seat, prompt, view) -> {
            if (!prompt.kind().equals("priority")) {
                // The Bears are aimed at and sacrificed first, the Runeclaw Bear after them.
                return otherwise(prompt, done.contains("pinged") ? RUNECLAW : BEARS);
            }
            List<PromptView.Option> options = prompt.options();
            if (view.stack().isEmpty()) {
                String bolt = option(options, "cast", BOLT);
                if (bolt != null) {
                    return bolt;
                }
                // Once the Bolt is gone, the second Isamaru, in its player's own main phase.
                String hound = done.contains("sacrificed") ? option(options, "cast", ISAMARU) : null;
                if (hound != null) {
                    return hound;
                }
                // And the Pyromancer's ability, aimed at the Runeclaw Bear, once it can be tapped.
                String ping = done.contains("sacrificed") && !done.contains("pinged")
                    ? option(options, "activate", PYROMANCER) : null;
                if (ping != null) {
                    done.add("pinged");
                    return ping;
                }
            } else if (done.add("sacrificed") || (done.contains("pinged") && done.add("sacrificed again"))) {
                // In response to the Bolt aimed at the Bears, and to the ability aimed at the Runeclaw
                // Bear: the Seer sacrifices the target.
                String seer = option(options, "activate", SEER);
                assertNotNull(seer, "Viscera Seer's ability was not offered: " + options);
                return seer;
            }
            return option(options, "pass", null);
        };
        List<JsonObject> events = played(scenario, policy);

        JsonObject sacrificed = where(events, event -> left(event, BEARS)).get(0);
        assertEquals("sacrificed", sacrificed.get("why").getAsString(), sacrificed.toString());

        List<JsonObject> fizzled = where(events, event -> "fizzled".equals(event.get("type").getAsString()));
        assertEquals(2, fizzled.size(), "the Bolt and the Pyromancer's ability: " + fizzled);
        JsonObject ping = fizzled.get(1);
        assertEquals(PYROMANCER, ping.getAsJsonObject("object").get("name").getAsString());
        assertEquals("ability", ping.get("of").getAsString());
        assertEquals("targets", ping.get("why").getAsString());
        assertEquals("sacrificed", where(events, event -> left(event, RUNECLAW)).get(0).get("why").getAsString());
        JsonObject bolt = fizzled.get(0);
        assertEquals(BOLT, bolt.getAsJsonObject("object").get("name").getAsString());
        assertEquals("spell", bolt.get("of").getAsString());
        assertEquals("targets", bolt.get("why").getAsString());
        assertEquals(0, bolt.get("player").getAsInt());
        assertTrue(where(events, event -> is(event, "resolve", "object", BOLT)).isEmpty(),
            "a fizzled spell does not resolve");
        assertNull(where(events, event -> is(event, "resolve", "object", SEER)).stream()
            .filter(event -> event.has("immediate")).findFirst().orElse(null),
            "the Seer's ability resolved from the stack");

        List<JsonObject> hounds = where(events, event -> left(event, ISAMARU));
        assertEquals(1, hounds.size(), "one Isamaru left: " + hounds);
        assertEquals("legend_rule", hounds.get(0).get("why").getAsString(), hounds.toString());
    }
}
