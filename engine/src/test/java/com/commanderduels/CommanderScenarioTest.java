package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import mage.cards.Card;
import mage.game.Game;
import mage.players.Player;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * A scripted four-human Commander game with arranged libraries, so that it reaches, every time, the
 * situations random games reach only sometimes (T07 and T08 at the engine level):
 * <ol>
 *   <li>Seat 1 casts its commander, Isamaru, from the command zone.</li>
 *   <li>Seat 2 kills it with Lightning Bolt; seat 1 moves it from the graveyard to the command zone.</li>
 *   <li>Seat 1 casts it again, paying {2} of commander tax.</li>
 *   <li>Seat 0 takes control of it with Control Magic and attacks seat 2, choosing the defender: the
 *       commander damage counts for Isamaru, whoever controls it.</li>
 *   <li>Seat 0 concedes while controlling the borrowed commander. XMage's cleanup ends the control
 *       effect, so Isamaru returns to seat 1, and the other three play on.</li>
 * </ol>
 * Every published view is checked for leaks and against XMage's state, as in the random games.
 */
class CommanderScenarioTest {
    private static final String ISAMARU = "Isamaru, Hound of Konda";
    private static final List<String> DECKS = List.of("commander-mono-blue-flyers",
        "commander-mono-white-soldiers", "commander-mono-red-raiders", "commander-mono-green-stompers");
    /** The top of each seat's library (its opening hand first), before the basic lands it draws. */
    private static final List<List<String>> TOPS = List.of(
        List.of("Island", "Island", "Island", "Island", "Island", "Control Magic", "Unsummon"),
        List.of("Plains", "Plains", "Plains", "Plains", "Plains", "Plains", "Plains"),
        List.of("Mountain", "Mountain", "Mountain", "Mountain", "Mountain", "Lightning Bolt", "Shock"),
        List.of("Forest", "Forest", "Forest", "Forest", "Forest", "Forest", "Forest"));

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    /** Arranges every library and turns off the opening shuffle, for this scenario only. */
    static final class Arranged extends SeatChecks {
        final Map<String, Object> seen = new ConcurrentHashMap<>();

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

        @Override
        public void published(Game game, ObjectRefs refs, int seat, SeatView view, PromptView prompt) {
            super.published(game, refs, seat, view, prompt);
            Player thief = game.getPlayer(seatIds.get(0));
            if (seat == 1) {
                view.you().commanders().stream().filter(commander -> commander.castCount() == 2).findFirst()
                    .ifPresent(commander -> seen.putIfAbsent("recast", commander));
                if (thief.hasLeft() || thief.hasLost()) {
                    // The last view after the thief left: XMage publishes some during its cleanup.
                    isamaru(view).ifPresent(permanent -> seen.put("returned", permanent));
                }
            }
            if (seat == 2) {
                isamaru(view).filter(permanent -> permanent.controllerSeat() == 0)
                    .ifPresent(permanent -> seen.putIfAbsent("stolen", permanent));
                view.opponents().stream().filter(opponent -> opponent.seat() == 1)
                    .flatMap(opponent -> opponent.commanders().stream())
                    .filter(commander -> !commander.damageDealt().isEmpty()).findFirst()
                    .ifPresent(commander -> seen.putIfAbsent("damage", commander));
                if (thief.hasLeft() || thief.hasLost()) {
                    view.opponents().stream().filter(opponent -> opponent.seat() == 0).findFirst()
                        .ifPresent(opponent -> seen.putIfAbsent("thief", opponent));
                }
            }
        }

        private static Optional<SeatView.PermanentInfo> isamaru(SeatView view) {
            return view.battlefield().stream().filter(permanent -> ISAMARU.equals(permanent.card().name()))
                .findFirst();
        }
    }

    /** Plays the plan above; every other choice passes, keeps, declines to block or takes the first option. */
    static final class Plan implements Tables.Policy {
        private boolean attacked;
        private boolean conceded;
        volatile HumanGame game;
        volatile String thiefStatus;

        @Override
        public String choose(int seat, PromptView prompt, SeatView view) {
            if (conceded && seat != 0) {
                try {
                    thiefStatus = game.snapshot(0, -1, 0, 0).status();
                } catch (InterruptedException e) {
                    throw new IllegalStateException(e);
                }
            }
            String choice = decide(seat, prompt, view);
            conceded |= choice == null;
            return choice;
        }

        private String decide(int seat, PromptView prompt, SeatView view) {
            List<PromptView.Option> options = prompt.options();
            boolean myMain = view.activeSeat() != null && view.activeSeat() == seat
                && "precombat_main".equals(view.step());
            switch (prompt.kind()) {
                case "priority": {
                    if (seat == 0 && attacked && view.turn() >= 17 && !"declare_attackers".equals(view.step())
                            && !"declare_blockers".equals(view.step())) {
                        return null; // concede, still controlling the borrowed commander
                    }
                    if (myMain) {
                        var land = byAction(options, "play_land");
                        if (!land.isEmpty()) {
                            return land.get(0).id();
                        }
                        boolean isamaruOut = view.battlefield().stream()
                            .anyMatch(permanent -> ISAMARU.equals(permanent.card().name()));
                        String spell = switch (seat) {
                            case 1 -> isamaruOut ? null : ISAMARU;
                            case 2 -> isamaruOut && view.turn() < 5 ? "Lightning Bolt" : null;
                            case 0 -> isamaruOut && view.battlefield().stream().anyMatch(permanent ->
                                ISAMARU.equals(permanent.card().name()) && permanent.controllerSeat() == 1)
                                ? "Control Magic" : null;
                            default -> null;
                        };
                        for (PromptView.Option option : byAction(options, "cast")) {
                            if (option.label() != null && option.label().equals(spell)) {
                                return option.id();
                            }
                        }
                    }
                    return byAction(options, "pass").get(0).id();
                }
                case "choose_target": {
                    boolean players = options.stream().allMatch(option -> option.seat() != null
                        || option.action().equals("done"));
                    if (players && view.turn() == 0) {
                        return options.stream().filter(option -> Integer.valueOf(0).equals(option.seat()))
                            .findFirst().orElseThrow().id(); // seat 0 starts
                    }
                    for (PromptView.Option option : options) {
                        if (ISAMARU.equals(option.label()) && !option.selected()) {
                            return option.id();
                        }
                    }
                    var done = byAction(options, "done");
                    if (options.stream().anyMatch(PromptView.Option::selected) && !done.isEmpty()) {
                        return done.get(0).id();
                    }
                    return options.get(0).id();
                }
                case "choose_defender":
                    return options.stream().filter(option -> Integer.valueOf(2).equals(option.seat())).findFirst()
                        .orElse(options.get(0)).id();
                case "declare_attackers": {
                    if (seat == 0 && view.turn() >= 17) {
                        for (PromptView.Option option : byAction(options, "toggle_attacker")) {
                            if (ISAMARU.equals(option.label()) && !option.selected()) {
                                attacked = true;
                                return option.id();
                            }
                        }
                    }
                    return byAction(options, "done").get(0).id();
                }
                case "mulligan":
                    return byAction(options, "keep").get(0).id();
                case "yes_no":
                    return byAction(options, "yes").get(0).id();
                case "pay_mana": {
                    var sources = byAction(options, "tap_source");
                    return sources.isEmpty() ? byAction(options, "cancel").get(0).id() : sources.get(0).id();
                }
                case "declare_blockers":
                    return byAction(options, "done").get(0).id();
                case "assign_amounts":
                    return byAction(options, "suggested").get(0).id();
                default:
                    return options.stream().filter(option -> !option.action().equals("cancel")).findFirst()
                        .orElse(options.get(0)).id();
            }
        }

        private static List<PromptView.Option> byAction(List<PromptView.Option> options, String action) {
            return ScriptedPlayer.byAction(options, action);
        }
    }

    @Test
    void aBorrowedCommanderReturnsWhenItsControllerIsEliminated() throws Exception {
        List<HumanGameRequest.Seat> seats = new ArrayList<>();
        for (String deck : DECKS) {
            seats.add(Tables.human(deck));
        }
        var request = new HumanGameRequest(4004L, GameFormat.COMMANDER, seats, 1, 20, 900);
        var check = new Arranged(request);
        var coverage = new Tables.Coverage();
        var plan = new Plan();
        HumanGame game = Tables.start(request, check);
        plan.game = game;
        Tables.Played played = Tables.play(game, plan, 4, coverage);
        coverage.summary().forEach(System.out::println);

        check.settle();
        assertTrue(check.failures.isEmpty(), "leaks or wrong views: " + check.failures);
        assertTrue(coverage.unsupported.isEmpty(), "unsupported: " + coverage.unsupported);
        assertTrue(coverage.kinds.containsKey("choose_defender"), "seat 0 chose whom to attack: " + coverage.kinds);

        SeatView.CommanderState recast = (SeatView.CommanderState) check.seen.get("recast");
        assertNotNull(recast, "Isamaru was never cast a second time: " + check.reached);
        assertEquals(4, recast.tax(), "two casts from the command zone make the next one cost {4} more");
        assertTrue(check.reached.contains("commander zone graveyard"), "Isamaru's owner saw it in the graveyard");

        SeatView.PermanentInfo stolen = (SeatView.PermanentInfo) check.seen.get("stolen");
        assertNotNull(stolen, "Control Magic never took Isamaru: " + check.reached);
        assertEquals(1, stolen.ownerSeat());
        SeatView.CommanderState damage = (SeatView.CommanderState) check.seen.get("damage");
        assertNotNull(damage, "Isamaru never dealt commander damage");
        assertEquals(List.of(new SeatView.CommanderDamage(2, 2)), damage.damageDealt(),
            "2 combat damage to seat 2, counted for Isamaru although seat 0 controlled it");
        assertTrue(check.reached.contains("commander damage while controlled by another player"));

        SeatView.PermanentInfo returned = (SeatView.PermanentInfo) check.seen.get("returned");
        assertNotNull(returned, "Isamaru left the battlefield with its thief");
        assertEquals(1, returned.controllerSeat(), "the control effect ended when seat 0 left the game");
        SeatView.PlayerState thief = (SeatView.PlayerState) check.seen.get("thief");
        assertTrue(thief.lost(), "the conceding seat is shown as eliminated");
        assertEquals(0, thief.handCount());

        HumanGame.Result result = played.last().result();
        assertEquals("turn_limit", result.kind(), "the other three played on: " + result);
        assertEquals(List.of(0), result.concededSeats());
        assertNull(result.error());
        assertEquals("eliminated", plan.thiefStatus, "the conceded seat can still watch the game");
        assertEquals(Set.of(0, 1, 2, 3), played.answeredBySeat().keySet());
    }
}
