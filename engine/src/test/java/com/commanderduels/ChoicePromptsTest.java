package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import mage.cards.Card;
import mage.cards.repository.CardInfo;
import mage.cards.repository.CardRepository;
import mage.game.Game;
import mage.players.Player;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Choices longer than a short list, which v0.3.1 left unsupported and which stopped a game at
 * Three Tree City: a Legacy game whose human seat plays Three Tree City (choose one of about 300
 * creature types, choose_choice) and then Pithing Needle (name any card, choose_name). The name is
 * typed: first a wrong one, refused with names that start like it, then the right one in lower case.
 * Every view of the human seat is checked as in the other scripted games.
 */
class ChoicePromptsTest {
    /** Cards the deck does not hold, put on top of the human seat's library before the game starts. */
    private static final List<String> ADDED = List.of("Three Tree City", "Pithing Needle");

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
            Player player = game.getPlayer(ids.get(0));
            Set<Card> added = new LinkedHashSet<>();
            for (String name : ADDED) {
                CardInfo info = CardRepository.instance.findCard(name);
                assertNotNull(info, name + " is not in the card database");
                added.add(info.createCard());
            }
            game.loadCards(added, player.getId());
            // The added cards, then the deck's Mountains, so the seat has lands for Pithing Needle.
            List<Card> rest = new ArrayList<>(player.getLibrary().getCards(game));
            LinkedHashSet<Card> ordered = new LinkedHashSet<>(added);
            rest.stream().filter(card -> card.getName().equals("Mountain")).forEach(ordered::add);
            ordered.addAll(rest);
            player.getLibrary().clear();
            player.getLibrary().addAll(ordered, game);
        }
    }

    /** Plays the two cards, names a creature type and a card, and passes everything else. */
    static final class Plan implements Tables.Policy {
        final Map<String, PromptView> seen = new ConcurrentHashMap<>();
        final List<String> refusals = new CopyOnWriteArrayList<>();
        volatile HumanGame game;
        volatile boolean typedWrong;

        @Override
        public String choose(int seat, PromptView prompt, SeatView view) {
            List<PromptView.Option> options = prompt.options();
            seen.putIfAbsent(prompt.kind(), prompt);
            switch (prompt.kind()) {
                case "priority": {
                    boolean myMain = view.activeSeat() != null && view.activeSeat() == seat
                        && "precombat_main".equals(view.step());
                    if (myMain) {
                        for (String action : List.of("play_land", "cast")) {
                            for (PromptView.Option option : ScriptedPlayer.byAction(options, action)) {
                                if (ADDED.contains(option.label())) {
                                    return option.id();
                                }
                            }
                        }
                        var land = ScriptedPlayer.byAction(options, "play_land");
                        if (!land.isEmpty() && !seen.containsKey("choose_name")) {
                            return land.get(0).id();
                        }
                    }
                    return ScriptedPlayer.byAction(options, "pass").get(0).id();
                }
                case "choose_target":
                    if (prompt.message().contains("starting player")) {
                        return options.stream().filter(option -> Integer.valueOf(0).equals(option.seat()))
                            .findFirst().orElse(options.get(0)).id();
                    }
                    return ScriptedPlayer.byAction(options, "choose").get(0).id();
                case "choose_choice":
                    return options.stream().filter(option -> "Goblin".equals(option.label())).findFirst()
                        .orElseThrow(() -> new AssertionError("no Goblin among " + options.size() + " types"))
                        .id();
                case "choose_name":
                    if (!typedWrong) {
                        typedWrong = true;
                        try {
                            HumanGame.Snapshot snapshot = game.snapshot(seat, -1, 0, 0);
                            HumanGame.Reply reply = game.submit(seat,
                                Tables.text(game, snapshot.revision(), prompt.id(), "black lot"));
                            Tables.assertRejected(422, "invalid_name", reply);
                            refusals.add(String.valueOf(reply.body().get("message")));
                        } catch (JsonRequest.Invalid | InterruptedException e) {
                            throw new AssertionError(e);
                        }
                    }
                    return Tables.TEXT + "  black lotus ";
                case "mulligan":
                    return ScriptedPlayer.byAction(options, "keep").get(0).id();
                case "pay_mana": {
                    var sources = ScriptedPlayer.byAction(options, "tap_source");
                    return sources.isEmpty() ? ScriptedPlayer.byAction(options, "cancel").get(0).id()
                        : sources.get(0).id();
                }
                case "declare_attackers":
                case "declare_blockers":
                    return ScriptedPlayer.byAction(options, "done").get(0).id();
                case "yes_no":
                    return ScriptedPlayer.byAction(options, "no").get(0).id();
                default:
                    // Once the needle has a name, the test has seen what it came for.
                    return seen.containsKey("choose_name") ? null
                        : options.stream().filter(option -> !option.action().equals("cancel")).findFirst()
                            .orElse(options.get(0)).id();
            }
        }
    }

    @Test
    void longChoicesAreListedOrTyped() throws Exception {
        var request = HumanGameRequest.of(7007L, GameFormat.LEGACY, 1, 8, 900,
            Tables.human("legacy-mono-red-burn"), Tables.bot("legacy-mono-green-creatures"));
        var check = new Arranged(request);
        var coverage = new Tables.Coverage();
        var plan = new Plan();
        HumanGame game = Tables.start(request, check);
        plan.game = game;
        Tables.play(game, plan, 4, coverage);
        coverage.summary().forEach(System.out::println);

        check.settle();
        assertTrue(check.failures.isEmpty(), "leaks or wrong views: " + check.failures);
        assertTrue(coverage.unsupported.isEmpty(), "unsupported: " + coverage.unsupported);

        PromptView types = plan.seen.get("choose_choice");
        assertNotNull(types, "Three Tree City asked for no creature type: " + coverage.kinds);
        long listed = types.options().stream().filter(option -> option.action().equals("choose")).count();
        assertTrue(listed > Prompts.MAX_NAME_SUGGESTIONS * 10 && listed <= Prompts.MAX_CHOICE_OPTIONS,
            "creature types listed: " + listed);

        PromptView naming = plan.seen.get("choose_name");
        assertNotNull(naming, "Pithing Needle asked for no name: " + coverage.kinds);
        assertTrue(naming.options().size() <= Prompts.MAX_NAME_SUGGESTIONS + 1, naming.options().toString());
        assertTrue(naming.options().stream().anyMatch(option -> "Three Tree City".equals(option.label())),
            "a card on the battlefield is suggested: " + naming.options());
        assertEquals(1, coverage.kinds.getOrDefault("choose_name (typed)", 0), coverage.kinds.toString());
        assertEquals(1, plan.refusals.size());
        assertTrue(plan.refusals.get(0).contains("Black Lotus"), plan.refusals.get(0));
    }
}
