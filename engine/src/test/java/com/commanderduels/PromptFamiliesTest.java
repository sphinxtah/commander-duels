package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import mage.cards.Card;
import mage.game.Game;
import mage.players.Player;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * A scripted four-human Commander game with arranged libraries that reaches each prompt family
 * added after the first v0.0.4 build, every time:
 * <ul>
 *   <li>{@code choose_mode}: Valorous Stance (seat 0) and Abrade (seat 2);</li>
 *   <li>{@code choose_amount}: X for Blaze (seat 2) and Mistcutter Hydra (seat 3), answered with a custom number;</li>
 *   <li>{@code order_triggers}: Attended Knight entering next to Soul Warden (seat 0);</li>
 *   <li>{@code choose_pile}: Fact or Fiction (seat 1), its five cards split by seat 0.</li>
 * </ul>
 * Every view for every seat and every spectator view is checked as in the other scripted games.
 */
class PromptFamiliesTest {
    private static final List<String> DECKS = List.of("commander-mono-white-soldiers", "commander-mono-blue-flyers",
        "commander-mono-red-raiders", "commander-mono-green-stompers");
    /** The top of each seat's library: its opening hand, then the basic lands it draws. */
    private static final List<List<String>> TOPS = List.of(
        List.of("Plains", "Plains", "Plains", "Plains", "Soul Warden", "Valorous Stance", "Attended Knight"),
        List.of("Island", "Island", "Island", "Island", "Island", "Fact or Fiction", "Counterspell"),
        List.of("Mountain", "Mountain", "Mountain", "Mountain", "Mountain", "Blaze", "Abrade"),
        List.of("Forest", "Forest", "Forest", "Forest", "Forest", "Mistcutter Hydra", "Giant Growth"));
    /**
     * What each seat casts, in order, and the turn it waits for: turns pass 0, 1, 2, 3, so seat s
     * has its n-th land on turn 4(n - 1) + s + 1. Blaze and Mistcutter Hydra need two lands for X = 1.
     */
    private static final List<List<Map.Entry<String, Integer>>> CASTS = List.of(
        List.of(Map.entry("Soul Warden", 1), Map.entry("Valorous Stance", 5), Map.entry("Attended Knight", 9)),
        List.of(Map.entry("Fact or Fiction", 14)),
        List.of(Map.entry("Blaze", 7), Map.entry("Abrade", 11)),
        List.of(Map.entry("Mistcutter Hydra", 8)));
    /** For a modal spell, the mode to choose; for a targeted one, the target (a card name, or a seat). */
    private static final Map<String, String> MODES = Map.of("Valorous Stance", "indestructible",
        "Abrade", "damage");
    private static final Map<String, String> TARGETS = Map.of("Valorous Stance", "Soul Warden",
        "Abrade", "Attended Knight", "Blaze", "seat 3", "Fact or Fiction", "seat 0");

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    static final class Arranged extends SeatChecks {
        Arranged(HumanGameRequest request) throws Exception {
            super(request);
        }

        @Override
        public void beforeStart(Game game, List<UUID> ids) {
            super.beforeStart(game, ids);
            game.getOptions().skipInitShuffling = true;
            for (int seat = 0; seat < ids.size(); seat++) {
                Player player = game.getPlayer(ids.get(seat));
                List<Card> rest = new ArrayList<>(player.getLibrary().getCards(game));
                LinkedHashSet<Card> ordered = new LinkedHashSet<>();
                for (String name : TOPS.get(seat)) {
                    Card card = rest.stream().filter(candidate -> candidate.getName().equals(name)).findFirst()
                        .orElseThrow(() -> new IllegalStateException(name + " is not in the deck"));
                    rest.remove(card);
                    ordered.add(card);
                }
                String basic = TOPS.get(seat).get(0);
                rest.stream().filter(card -> card.getName().equals(basic)).forEach(ordered::add);
                ordered.addAll(rest);
                player.getLibrary().clear();
                player.getLibrary().addAll(ordered, game);
            }
        }
    }

    /** Casts each seat's cards in order; passes, keeps and declines everything else. */
    static final class Plan implements Tables.Policy {
        final Map<Integer, Integer> nextCast = new ConcurrentHashMap<>();
        final Map<Integer, String> casting = new ConcurrentHashMap<>();
        final List<List<List<String>>> piles = new ArrayList<>();
        final Set<String> pileLabels = new HashSet<>();

        @Override
        public String choose(int seat, PromptView prompt, SeatView view) {
            List<PromptView.Option> options = prompt.options();
            String spell = casting.get(seat);
            switch (prompt.kind()) {
                case "priority": {
                    boolean myMain = view.activeSeat() != null && view.activeSeat() == seat
                        && "precombat_main".equals(view.step());
                    if (myMain) {
                        var land = ScriptedPlayer.byAction(options, "play_land");
                        if (!land.isEmpty()) {
                            return land.get(0).id();
                        }
                        int next = nextCast.getOrDefault(seat, 0);
                        if (next < CASTS.get(seat).size() && view.turn() >= CASTS.get(seat).get(next).getValue()) {
                            String name = CASTS.get(seat).get(next).getKey();
                            for (PromptView.Option option : ScriptedPlayer.byAction(options, "cast")) {
                                if (name.equals(option.label())) {
                                    nextCast.put(seat, next + 1);
                                    casting.put(seat, name);
                                    return option.id();
                                }
                            }
                        }
                    }
                    return ScriptedPlayer.byAction(options, "pass").get(0).id();
                }
                case "choose_mode": {
                    String wanted = spell == null ? "" : MODES.getOrDefault(spell, "");
                    for (PromptView.Option option : ScriptedPlayer.byAction(options, "choose_mode")) {
                        if (option.label() != null && option.label().toLowerCase().contains(wanted)) {
                            return option.id();
                        }
                    }
                    return ScriptedPlayer.byAction(options, "choose_mode").get(0).id();
                }
                case "choose_amount":
                    return Tables.AMOUNTS + Math.min(1, prompt.amounts().entries().get(0).max());
                case "order_triggers":
                    return ScriptedPlayer.byAction(options, "put_first").get(0).id();
                case "choose_pile":
                    piles.add(prompt.piles());
                    options.forEach(option -> pileLabels.add(option.label()));
                    return ScriptedPlayer.byAction(options, "choose_pile").get(0).id();
                case "choose_target": {
                    if (prompt.message().contains("starting player")) {
                        return seatOption(options, 0);
                    }
                    var done = ScriptedPlayer.byAction(options, "done");
                    if (options.stream().anyMatch(PromptView.Option::selected) && !done.isEmpty()) {
                        return done.get(0).id();
                    }
                    String target = spell == null ? null : TARGETS.get(spell);
                    if (target != null && target.startsWith("seat ")) {
                        String id = seatOption(options, Integer.parseInt(target.substring(5)));
                        if (id != null) {
                            return id;
                        }
                    }
                    for (PromptView.Option option : options) {
                        if (target != null && target.equals(option.label()) && !option.selected()) {
                            return option.id();
                        }
                    }
                    var choices = ScriptedPlayer.byAction(options, "choose");
                    return choices.isEmpty() ? options.get(0).id() : choices.get(0).id();
                }
                case "mulligan":
                    return ScriptedPlayer.byAction(options, "keep").get(0).id();
                case "yes_no":
                    return ScriptedPlayer.byAction(options, "yes").get(0).id();
                case "pay_mana": {
                    var sources = ScriptedPlayer.byAction(options, "tap_source");
                    return sources.isEmpty() ? ScriptedPlayer.byAction(options, "cancel").get(0).id()
                        : sources.get(0).id();
                }
                case "declare_attackers":
                case "declare_blockers":
                    return ScriptedPlayer.byAction(options, "done").get(0).id();
                case "assign_amounts":
                    return ScriptedPlayer.byAction(options, "suggested").get(0).id();
                default:
                    return options.stream().filter(option -> !option.action().equals("cancel")).findFirst()
                        .orElse(options.get(0)).id();
            }
        }

        private static String seatOption(List<PromptView.Option> options, int seat) {
            return options.stream().filter(option -> Integer.valueOf(seat).equals(option.seat())).findFirst()
                .map(PromptView.Option::id).orElse(null);
        }
    }

    @Test
    void everyNewPromptFamilyIsReachedAndAnswered() throws Exception {
        List<HumanGameRequest.Seat> seats = new ArrayList<>();
        for (String deck : DECKS) {
            seats.add(Tables.human(deck));
        }
        var request = new HumanGameRequest(5005L, GameFormat.COMMANDER, seats, 1, 16, 900);
        var check = new Arranged(request);
        var coverage = new Tables.Coverage();
        var plan = new Plan();
        HumanGame game = Tables.start(request, check);
        Tables.Played played = Tables.play(game, plan, 4, coverage);
        coverage.summary().forEach(System.out::println);

        check.settle();
        assertTrue(check.failures.isEmpty(), "leaks or wrong views: " + check.failures);
        assertTrue(coverage.unsupported.isEmpty(), "unsupported: " + coverage.unsupported);
        for (String kind : List.of("choose_mode", "choose_amount (custom)", "order_triggers", "choose_pile")) {
            assertTrue(coverage.kinds.containsKey(kind), kind + " was never reached: " + coverage.kinds);
        }
        assertEquals(List.of(0, 0, 0, 0), List.of(plan.nextCast.get(0) - 3, plan.nextCast.get(1) - 1,
            plan.nextCast.get(2) - 2, plan.nextCast.get(3) - 1), "every planned spell was cast: " + plan.nextCast);
        assertEquals(1, plan.piles.size(), "one pile choice");
        List<List<String>> piles = plan.piles.get(0);
        assertNotNull(piles);
        assertEquals(5, piles.get(0).size() + piles.get(1).size(), "the five revealed cards are in the piles");
        assertTrue(check.spectatorViewsChecked.get() > 0, "spectator views were checked");
        assertEquals("turn_limit", played.last().result().kind(), played.last().result().toString());
    }
}
