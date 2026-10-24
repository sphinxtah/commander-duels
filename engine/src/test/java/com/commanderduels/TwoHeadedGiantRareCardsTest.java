package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import mage.abilities.Ability;
import mage.abilities.common.SimpleStaticAbility;
import mage.abilities.effects.common.InfoEffect;
import mage.cards.Cards;
import mage.cards.CardsImpl;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.events.GameEvent;
import mage.game.permanent.Permanent;
import mage.players.Player;
import mage.watchers.Watcher;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The rare cards the v0.5.1 Two-Headed Giant audit left wrong, fixed one by one in v0.6.2 (patch 0009):
 * a scripted game of four human seats for each (seats 0 and 1 against seats 2 and 3, seat 0 starting),
 * built as {@link TwoHeadedGiantAuditTest}'s are, the cards put onto the battlefield in turn 1's main
 * phase. Turn 1 is team A's, held by seat 0; turn 2 team B's, held by seat 2. Each test says what the
 * card did before the fix. A Legacy duel checks that the cards whose code path outside team games
 * changed play as before. Needs ./db (the card database).
 */
class TwoHeadedGiantRareCardsTest {
    private static final List<String> DECKS = GameFormat.TWO_HEADED_GIANT.decks();

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    private static HumanGameRequest fourHumans(long seed, int turnCap) {
        List<HumanGameRequest.Seat> seats = new ArrayList<>();
        for (String deck : DECKS) {
            seats.add(Tables.human(deck));
        }
        return new HumanGameRequest(seed, GameFormat.TWO_HEADED_GIANT, seats, 1, turnCap, 900, 0, 0);
    }

    private static HumanGameRequest legacyDuel(long seed, int turnCap) {
        return new HumanGameRequest(seed, GameFormat.LEGACY,
            List.of(Tables.human(LegacyDuel.DECKS.get(0)), Tables.human(LegacyDuel.DECKS.get(1))), 1, turnCap, 900, 0, 0);
    }

    private static List<String> play(TwoHeadedGiantAuditTest.Scenario scenario, Tables.Policy policy) throws Exception {
        HumanGame game = Tables.start(scenario.gameRequest, scenario);
        Tables.play(game, policy, 4, new Tables.Coverage());
        scenario.settle();
        assertTrue(scenario.failures.isEmpty(), "leaks or wrong views: " + scenario.failures);
        List<String> lines = new ArrayList<>();
        while (true) {
            HumanGame.Snapshot page = game.snapshot(0, -1, 0, lines.size());
            page.log().forEach(line -> lines.add(line.text()));
            if (page.log().size() < HumanGame.MAX_LOG_PAGE) {
                return lines;
            }
        }
    }

    private static int at(Map<String, Integer> values, int turn, int seat) {
        Integer value = values.get(turn + ":" + seat);
        assertNotNull(value, "no view of seat " + seat + " in turn " + turn + "'s main phase: " + values);
        return value;
    }

    private static Permanent permanent(Game game, String name, UUID controllerId) {
        return game.getBattlefield().getAllActivePermanents(controllerId).stream()
            .filter(permanent -> permanent.getName().equals(name)).findFirst()
            .orElseThrow(() -> new AssertionError("no " + name));
    }

    private static PromptView.Option option(PromptView prompt, String action, String label) {
        return prompt.options().stream()
            .filter(option -> option.action().equals(action) && label.equals(option.label())).findFirst()
            .orElse(null);
    }

    /** The first option of the action whose label names the card. */
    private static PromptView.Option naming(PromptView prompt, String action, String name) {
        return prompt.options().stream()
            .filter(option -> option.action().equals(action) && option.label() != null && option.label().contains(name))
            .findFirst().orElse(null);
    }

    private static String firstOf(PromptView prompt, String action) {
        return ScriptedPlayer.byAction(prompt.options(), action).get(0).id();
    }

    /** The option for the given seat (a player choice, a defender), or the first. */
    private static String seat(PromptView prompt, int seat) {
        return prompt.options().stream().filter(option -> Integer.valueOf(seat).equals(option.seat())).findFirst()
            .orElse(prompt.options().get(0)).id();
    }

    /** The choose_choice option with the given label (a player's name, a card type), or the first. */
    private static String choice(PromptView prompt, String label) {
        PromptView.Option chosen = option(prompt, "choose", label);
        return chosen != null ? chosen.id() : prompt.options().get(0).id();
    }

    /** The name the engine gives the player in the given seat. */
    private static String name(int seat) {
        return "Human " + (seat + 1);
    }

    /**
     * Casts the named card once, at the first priority the seat gets in the given turn's precombat
     * main phase with an empty stack, paying with the first sources; otherwise the other policy.
     */
    private static Tables.Policy casting(int caster, int turn, String card, Tables.Policy otherwise) {
        AtomicBoolean cast = new AtomicBoolean();
        return (seat, prompt, view) -> {
            if (seat == caster && view.turn() == turn && prompt.kind().equals("priority")
                && "precombat_main".equals(view.step()) && view.stack().isEmpty()) {
                PromptView.Option spell = option(prompt, "cast", card);
                if (spell != null && cast.compareAndSet(false, true)) {
                    return spell.id();
                }
            }
            if (seat == caster && prompt.kind().equals("pay_mana")) {
                return firstOf(prompt, "tap_source");
            }
            return otherwise.choose(seat, prompt, view);
        };
    }

    /**
     * In the given turn, each listed seat attacks with every creature it can (the others declare none),
     * at the defender seat given for it; otherwise {@link TwoHeadedGiantAuditTest#passing}, no attack.
     */
    private static Tables.Policy attacks(int turn, Map<Integer, Integer> defenders) {
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        return (seat, prompt, view) -> {
            if (view.turn() == turn && prompt.kind().equals("declare_attackers")) {
                if (defenders.containsKey(seat)) {
                    var fresh = prompt.options().stream()
                        .filter(option -> option.action().equals("toggle_attacker") && !option.selected()).findFirst();
                    if (fresh.isPresent()) {
                        return fresh.get().id();
                    }
                }
                return firstOf(prompt, "done");
            }
            if (view.turn() == turn && prompt.kind().equals("choose_defender") && defenders.containsKey(seat)) {
                return seat(prompt, defenders.get(seat));
            }
            return pass.choose(seat, prompt, view);
        };
    }

    /** By "turn:name:controller seat": the seat each attacking creature attacked, during that turn's combat. */
    private static Map<String, Integer> attackers(TwoHeadedGiantAuditTest.Scenario scenario) {
        Map<String, Integer> attacked = new ConcurrentHashMap<>();
        scenario.probe((game, ids, seat, view) -> {
            for (UUID attackerId : game.getCombat().getAttackers()) {
                Permanent attacker = game.getPermanent(attackerId);
                UUID defenderId = game.getCombat().getDefendingPlayerId(attackerId, game);
                if (attacker != null && defenderId != null) {
                    attacked.put(view.turn() + ":" + attacker.getName() + ":" + ids.indexOf(attacker.getControllerId()),
                        ids.indexOf(defenderId));
                }
            }
        });
        return attacked;
    }

    /** By "turn:name:controller seat": whether the permanent was tapped at the turn's first precombat main view. */
    private static Map<String, Boolean> tapped(TwoHeadedGiantAuditTest.Scenario scenario) {
        Map<String, Boolean> tapped = new ConcurrentHashMap<>();
        scenario.probe((game, ids, seat, view) -> {
            if ("precombat_main".equals(view.step())) {
                for (SeatView.PermanentInfo permanent : view.battlefield()) {
                    tapped.putIfAbsent(view.turn() + ":" + permanent.card().name() + ":" + permanent.controllerSeat(),
                        permanent.tapped());
                }
            }
        });
        return tapped;
    }

    /** By "turn:seat": the value at the turn's first precombat main view. */
    private static Map<String, Integer> inMainPhase(TwoHeadedGiantAuditTest.Scenario scenario,
                                                    java.util.function.BiFunction<Game, UUID, Integer> value) {
        Map<String, Integer> values = new ConcurrentHashMap<>();
        scenario.probe((game, ids, seat, view) -> {
            if ("precombat_main".equals(view.step())) {
                for (int index = 0; index < ids.size(); index++) {
                    values.putIfAbsent(view.turn() + ":" + index, value.apply(game, ids.get(index)));
                }
            }
        });
        return values;
    }

    private static int exiledOwnedBy(Game game, UUID playerId) {
        return game.getExile().getCardsOwned(game, playerId).size();
    }

    /** The card's game watcher (package-private in Mage.Sets), from the game's state. */
    private static Watcher watcher(Game game, String className) {
        try {
            @SuppressWarnings("unchecked")
            Class<? extends Watcher> type = (Class<? extends Watcher>) Class.forName(className);
            Watcher watcher = game.getState().getWatcher(type);
            assertNotNull(watcher, className + " is in the game");
            return watcher;
        } catch (ClassNotFoundException e) {
            throw new AssertionError(e);
        }
    }

    /** Calls the watcher's package-private checkPlayer(UUID, UUID). */
    private static boolean checkPlayer(Watcher watcher, UUID first, UUID second) {
        try {
            Method method = watcher.getClass().getDeclaredMethod("checkPlayer", UUID.class, UUID.class);
            method.setAccessible(true);
            return (Boolean) method.invoke(watcher, first, second);
        } catch (ReflectiveOperationException e) {
            throw new AssertionError(e);
        }
    }

    // Urabrask's draw replacement

    @Test
    void urabraskReplacesEachOpponentsOwnNextDraw() throws Exception {
        // "At the beginning of each opponent's upkeep, the next time they would draw a card this turn,
        // instead they exile the top card of their library." Urabrask on seat 0 triggers for seat 2 and
        // seat 3 in team B's upkeep (805.4d, v0.5.1); since v0.6.2 each replacement replaces that
        // player's own draw: each of seats 2 and 3 exiles one card from their own library and draws
        // none. Before, both replaced the first draw of either, from the library of seat 2, who holds
        // the turn: seat 2 exiled two cards and seat 3 drew.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(fourHumans(6201L, 2))
            .battlefield(0, "Urabrask, Heretic Praetor");
        Map<String, Integer> hand = inMainPhase(scenario, (game, playerId) -> game.getPlayer(playerId).getHand().size());
        Map<String, Integer> exiled = inMainPhase(scenario, TwoHeadedGiantRareCardsTest::exiledOwnedBy);
        play(scenario, TwoHeadedGiantAuditTest.passing(false));
        System.out.println("Libraries " + new java.util.TreeMap<>(scenario.library) + "; hands "
            + new java.util.TreeMap<>(hand) + "; exiled " + new java.util.TreeMap<>(exiled));

        assertEquals(52, at(scenario.library, 2, 2), "seat 2 exiled one card");
        assertEquals(52, at(scenario.library, 2, 3), "seat 3 exiled one card");
        assertEquals(7, at(hand, 2, 2), "seat 2 drew no card");
        assertEquals(7, at(hand, 2, 3), "seat 3 drew no card");
        assertEquals(1, at(exiled, 2, 2));
        assertEquals(1, at(exiled, 2, 3));
    }

    // Brine Elemental's skip

    /** Fires "turned face up" for the seat's Brine Elemental, put onto the battlefield face up. */
    private static void turnFaceUp(Game game, UUID controllerId) {
        Permanent brine = permanent(game, "Brine Elemental", controllerId);
        game.fireEvent(GameEvent.getEvent(GameEvent.EventType.TURNED_FACE_UP, brine.getId(), null, controllerId));
    }

    @Test
    void brineElementalMakesTheOpposingTeamSkipOneUntapStep() throws Exception {
        // 805.8: "each opponent skips their next untap step" makes team B skip one untap step, not one
        // for each of its players. Team B's lands, tapped in turn 1, stay tapped in turn 2 and untap in
        // turn 4. Before, a skip for each player made the team skip its untap steps in turns 2 and 4.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(fourHumans(6202L, 4))
            .battlefield(0, "Brine Elemental")
            .battlefield(2, "Plains")
            .battlefield(3, "Island")
            .setup((game, ids, seat, view) -> {
                permanent(game, "Plains", ids.get(2)).tap(null, game);
                permanent(game, "Island", ids.get(3)).tap(null, game);
                turnFaceUp(game, ids.get(0));
            });
        Map<String, Boolean> tapped = tapped(scenario);
        play(scenario, TwoHeadedGiantAuditTest.passing(false));
        System.out.println("Tapped " + new java.util.TreeMap<>(tapped));

        assertEquals(true, tapped.get("2:Plains:2"), "team B skipped its untap step in turn 2: " + tapped);
        assertEquals(true, tapped.get("2:Island:3"), "team B skipped its untap step in turn 2: " + tapped);
        assertEquals(false, tapped.get("4:Plains:2"), "team B untapped in turn 4: " + tapped);
        assertEquals(false, tapped.get("4:Island:3"), "team B untapped in turn 4: " + tapped);
    }

    // The attacking player (805.10c)

    @Test
    void invasionPlansLetsItsControllerChooseTheAttackingPlayer() throws Exception {
        // "The attacking player chooses how each creature blocks": 805.10c makes the attacking player
        // one specific player of the attacking team, whom the ability's controller chooses. Seat 2
        // (Invasion Plans) chooses seat 1, who declares team B's blocks. Before, seat 0, who holds the
        // turn, always did.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(fourHumans(6203L, 2))
            .battlefield(1, "Grizzly Bears")
            .battlefield(2, "Invasion Plans", "Llanowar Elves");
        Map<String, Integer> prompts = new ConcurrentHashMap<>();
        Tables.Policy attack = attacks(1, Map.of(1, 2));
        play(scenario, (seat, prompt, view) -> {
            if (view.turn() == 1 && (prompt.kind().equals("declare_blockers") || prompt.kind().equals("choose_choice"))) {
                prompts.merge(prompt.kind() + ":" + seat, 1, Integer::sum);
            }
            if (prompt.kind().equals("choose_choice") && seat == 2) {
                return choice(prompt, name(1));
            }
            if (prompt.kind().equals("declare_blockers")) {
                var fresh = prompt.options().stream()
                    .filter(option -> option.action().equals("toggle_blocker") && !option.selected()).findFirst();
                return fresh.isPresent() ? fresh.get().id() : firstOf(prompt, "done");
            }
            return attack.choose(seat, prompt, view);
        });
        System.out.println("Prompts in turn 1: " + prompts);

        assertNotNull(prompts.get("choose_choice:2"), "seat 2 chose the attacking player: " + prompts);
        assertNotNull(prompts.get("declare_blockers:1"), "seat 1 declared team B's blocks: " + prompts);
        assertNull(prompts.get("declare_blockers:0"), "seat 0 declared none: " + prompts);
        assertNull(prompts.get("declare_blockers:2"), "team B declared none: " + prompts);
        assertNull(prompts.get("declare_blockers:3"), "team B declared none: " + prompts);
    }

    @Test
    void masterWarcraftChoosesAmongTheAttackingTeamsCreatures() throws Exception {
        // "You choose which creatures attack this turn": seat 2 casts Master Warcraft in team A's turn 1
        // and chooses seat 1's Llanowar Elves, which attacks; seat 0's Grizzly Bears does not. Before,
        // only the creatures of seat 0, who holds the turn, could be chosen, and every other creature
        // could not attack.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(fourHumans(6204L, 2))
            .battlefield(0, "Grizzly Bears")
            .battlefield(1, "Llanowar Elves")
            .battlefield(2, "Mountain", "Mountain", "Mountain", "Mountain")
            .hand(2, "Master Warcraft");
        Map<String, Integer> attacked = attackers(scenario);
        Set<String> offered = ConcurrentHashMap.newKeySet();
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        Tables.Policy policy = casting(2, 1, "Master Warcraft", (seat, prompt, view) -> {
            if (seat == 2 && prompt.kind().equals("choose_target") && view.turn() == 1) {
                prompt.options().forEach(option -> offered.add(String.valueOf(option.label())));
                PromptView.Option elves = naming(prompt, "choose", "Llanowar Elves");
                if (elves != null && !elves.selected()) {
                    return elves.id();
                }
                return firstOf(prompt, "done");
            }
            return pass.choose(seat, prompt, view);
        });
        List<String> log = play(scenario, policy);
        System.out.println("Offered " + offered + "; attackers " + attacked);

        assertTrue(log.stream().anyMatch(line -> line.contains("Llanowar Elves attacks this combat if able")),
            "seat 2 chose the Elves: " + offered);
        assertTrue(offered.stream().anyMatch(label -> label.contains("Grizzly Bears")),
            "the holder's creature was offered: " + offered);
        assertNotNull(attacked.get("1:Llanowar Elves:1"), "seat 1's Elves attacked: " + attacked);
        assertNull(attacked.get("1:Grizzly Bears:0"), "seat 0's Bears did not: " + attacked);
    }

    @Test
    void tenuousTruceEndsWhenTheEnchantedOpponentAttacksYou() throws Exception {
        // "When they attack you, sacrifice Tenuous Truce": seat 2 enchants seat 1 in turn 2; in team A's
        // turn 3 seat 1 attacks seat 2 alone, and the Truce is sacrificed. Before, the attack was read
        // as seat 0's, who holds the turn and did not attack.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(fourHumans(6205L, 4))
            .battlefield(1, "Grizzly Bears")
            .battlefield(2, "Plains", "Plains")
            .hand(2, "Tenuous Truce");
        Tables.Policy attack = attacks(3, Map.of(1, 2));
        play(scenario, casting(2, 2, "Tenuous Truce", (seat, prompt, view) -> {
            if (seat == 2 && prompt.kind().equals("choose_target")) {
                return seat(prompt, 1);
            }
            return attack.choose(seat, prompt, view);
        }));
        System.out.println("Permanents by turn: " + new java.util.TreeMap<>(scenario.count));

        assertEquals(1, scenario.count.get("3:Tenuous Truce:2"), "seat 2 enchanted seat 1: " + scenario.count);
        assertNull(scenario.count.get("4:Tenuous Truce:2"), "sacrificed in turn 3: " + scenario.count);
    }

    @Test
    void territorialHellkiteRemembersItsControllersLastCombat() throws Exception {
        // "Choose an opponent at random that it didn't attack during your last combat": Territorial
        // Hellkite on seat 1 attacks a different player of team B in each of team A's turns 1, 3 and 5.
        // Before, the last combat was remembered for seat 0, who holds the turn, so seat 1's Hellkite
        // chose at random from both every time.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(fourHumans(6206L, 5))
            .battlefield(1, "Territorial Hellkite");
        Map<String, Integer> attacked = attackers(scenario);
        play(scenario, TwoHeadedGiantAuditTest.passing(false));
        System.out.println("Attackers " + new java.util.TreeMap<>(attacked));

        Integer first = attacked.get("1:Territorial Hellkite:1");
        Integer second = attacked.get("3:Territorial Hellkite:1");
        Integer third = attacked.get("5:Territorial Hellkite:1");
        assertNotNull(first, "it attacked in turn 1: " + attacked);
        assertNotNull(second, "it attacked in turn 3: " + attacked);
        assertNotNull(third, "it attacked in turn 5: " + attacked);
        assertTrue(Set.of(2, 3).containsAll(List.of(first, second, third)), attacked.toString());
        assertFalse(first.equals(second), "not the player it attacked in turn 1: " + attacked);
        assertFalse(second.equals(third), "not the player it attacked in turn 3: " + attacked);
    }

    @Test
    void contestedGameBallGoesToTheAttackingPlayerItsControllerChooses() throws Exception {
        // "Whenever you're dealt combat damage, the attacking player gains control of Contested Game
        // Ball": 805.10c, its controller (seat 2, dealt damage by seat 1's Grizzly Bears) chooses one
        // player of the attacking team, seat 1, who gains control. Before, seat 0, who holds the turn,
        // always did.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(fourHumans(6207L, 2))
            .battlefield(1, "Grizzly Bears")
            .battlefield(2, "Contested Game Ball");
        Set<Integer> choosers = ConcurrentHashMap.newKeySet();
        Tables.Policy attack = attacks(1, Map.of(1, 2));
        play(scenario, (seat, prompt, view) -> {
            if (prompt.kind().equals("choose_choice")) {
                choosers.add(seat);
                return choice(prompt, name(1));
            }
            return attack.choose(seat, prompt, view);
        });
        System.out.println("Permanents by turn: " + new java.util.TreeMap<>(scenario.count) + "; choosers " + choosers);

        assertEquals(Set.of(2), choosers, "seat 2 chose the attacking player");
        assertEquals(1, scenario.count.get("2:Contested Game Ball:1"), "seat 1 controls the ball: " + scenario.count);
        assertEquals(30, at(scenario.life, 1, 2), "team B at 30 before the attack");
        assertEquals(28, at(scenario.life, 2, 2), "seat 1's Bears dealt seat 2 combat damage");
    }

    @Test
    void ellieGivesTheTokenToThePlayerWhoAttacks() throws Exception {
        // "Whenever a player attacks one of your opponents, that attacking player creates a tapped 1/1
        // Cordyceps Infected that's attacking that opponent": Ellie on seat 0, seat 1 attacks seat 3 and
        // seat 0 does not. Seat 1 creates the token, attacking seat 3. Before, seat 0, who holds the
        // turn, created it.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(fourHumans(6208L, 2))
            .battlefield(0, "Ellie, Brick Master")
            .battlefield(1, "Grizzly Bears");
        Map<String, Integer> attacked = attackers(scenario);
        play(scenario, attacks(1, Map.of(1, 3)));
        System.out.println("Attackers " + attacked);

        assertEquals(3, attacked.get("1:Grizzly Bears:1"), "seat 1 attacked seat 3: " + attacked);
        assertEquals(3, attacked.get("1:Cordyceps Infected:1"), "seat 1's token attacks seat 3: " + attacked);
        assertNull(attacked.get("1:Cordyceps Infected:0"), "seat 0 created none: " + attacked);
        assertNull(attacked.get("1:Ellie, Brick Master:0"), "Ellie did not attack: " + attacked);
    }

    @Test
    void emberwildeCaptainDamagesTheOpponentWhoAttacks() throws Exception {
        // "Whenever an opponent attacks you while you're the monarch, Emberwilde Captain deals damage to
        // that player equal to the number of cards in their hand": seat 2 is the monarch, and seat 1,
        // holding two cards, attacks it while seat 0 (seven cards) does not: two damage, team A at 28.
        // Before, seat 0, who holds the turn, took seven.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(fourHumans(6209L, 2))
            .battlefield(1, "Grizzly Bears")
            .battlefield(2, "Emberwilde Captain")
            .setup((game, ids, seat, view) -> {
                game.setMonarchId(null, ids.get(2));
                Player seat1 = game.getPlayer(ids.get(1));
                Cards set = new CardsImpl();
                seat1.getHand().getCards(game).stream().limit(5).forEach(set::add);
                seat1.moveCards(set, Zone.EXILED, null, game);
            });
        Map<String, Integer> hand = inMainPhase(scenario, (game, playerId) -> game.getPlayer(playerId).getHand().size());
        play(scenario, attacks(1, Map.of(1, 2)));
        System.out.println("Life " + new java.util.TreeMap<>(scenario.life) + "; hands " + new java.util.TreeMap<>(hand));

        assertEquals(28, at(scenario.life, 2, 0), "seat 1 took two, for its two cards");
        assertEquals(28, at(scenario.life, 2, 2), "seat 1's Bears dealt seat 2 two");
    }

    @Test
    void tahngarthJoinsTheOpponentWhoAttacks() throws Exception {
        // "Whenever an opponent attacks with one or more creatures, if Tahngarth is tapped, you may have
        // that opponent gain control of Tahngarth until end of combat; it attacks a player or
        // planeswalker that opponent is attacking": seat 1 attacks seat 3 and seat 0 does not, so seat 1
        // gains control of seat 2's Tahngarth, which attacks seat 3. Before, seat 0, who holds the turn,
        // gained control.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(fourHumans(6210L, 2))
            .battlefield(1, "Grizzly Bears")
            .battlefield(2, "Tahngarth, First Mate")
            .setup((game, ids, seat, view) -> permanent(game, "Tahngarth, First Mate", ids.get(2)).tap(null, game));
        Map<String, Integer> attacked = attackers(scenario);
        Tables.Policy attack = attacks(1, Map.of(1, 3));
        play(scenario, (seat, prompt, view) -> {
            if (prompt.kind().equals("yes_no") && seat == 2) {
                return firstOf(prompt, "yes");
            }
            if (prompt.kind().equals("choose_target") && seat == 2) {
                return seat(prompt, 3);
            }
            return attack.choose(seat, prompt, view);
        });
        System.out.println("Attackers " + attacked);

        assertEquals(3, attacked.get("1:Tahngarth, First Mate:1"), "seat 1's Tahngarth attacks seat 3: " + attacked);
        assertNull(attacked.get("1:Tahngarth, First Mate:0"), "not seat 0's: " + attacked);
    }

    @Test
    void warsTollMakesTheAttackingPlayersOwnCreaturesAttack() throws Exception {
        // "If a creature an opponent controls attacks, all creatures that opponent controls attack if
        // able": seat 1 attacks with one of its two Llanowar Elves, is told, and attacks with both;
        // seat 0's Grizzly Bears needn't attack. Before, the holder's creatures were checked: seat 1 was
        // told about seat 0's Bears and could not make the attack legal.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(fourHumans(6211L, 2))
            .battlefield(0, "Grizzly Bears")
            .battlefield(1, "Llanowar Elves", "Llanowar Elves")
            .battlefield(2, "War's Toll");
        Map<String, Integer> attacked = attackers(scenario);
        AtomicInteger elves = new AtomicInteger();
        scenario.probe((game, ids, seat, view) -> {
            if (view.turn() == 1) {
                int attacking = (int) game.getCombat().getAttackers().stream().map(game::getPermanent)
                    .filter(attacker -> attacker != null && attacker.getName().equals("Llanowar Elves")
                        && attacker.isControlledBy(ids.get(1))).count();
                elves.accumulateAndGet(attacking, Math::max);
            }
        });
        AtomicInteger seat1Declarations = new AtomicInteger();
        AtomicBoolean toggledOne = new AtomicBoolean();
        AtomicBoolean doneOnce = new AtomicBoolean();
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        play(scenario, (seat, prompt, view) -> {
            if (view.turn() == 1 && prompt.kind().equals("declare_attackers")) {
                if (seat != 1) {
                    return firstOf(prompt, "done");
                }
                seat1Declarations.incrementAndGet();
                var fresh = prompt.options().stream()
                    .filter(option -> option.action().equals("toggle_attacker") && !option.selected()).findFirst();
                if (toggledOne.compareAndSet(false, true) && fresh.isPresent()) {
                    return fresh.get().id(); // one of the two Elves
                }
                if (doneOnce.compareAndSet(false, true)) {
                    return firstOf(prompt, "done");
                }
                return fresh.isPresent() ? fresh.get().id() : firstOf(prompt, "done"); // asked again: both
            }
            if (view.turn() == 1 && prompt.kind().equals("choose_defender")) {
                return seat(prompt, 2);
            }
            return pass.choose(seat, prompt, view);
        });
        System.out.println("Attackers " + attacked + "; seat 1's Elves attacking " + elves
            + "; seat 1's declarations " + seat1Declarations);

        assertTrue(seat1Declarations.get() >= 3, "seat 1 was asked again: " + seat1Declarations);
        assertEquals(2, elves.get(), "both of seat 1's Elves attacked");
        assertNull(attacked.get("1:Grizzly Bears:0"), "seat 0's Bears did not attack: " + attacked);
    }

    // Watchers of who attacked whom, and of the turn

    /** Whether the seat's Grizzly Bears could attack seats 2 and 3, by "turn:seat", in each turn's main phase. */
    private static Map<String, Boolean> canAttack(TwoHeadedGiantAuditTest.Scenario scenario) {
        Map<String, Boolean> can = new ConcurrentHashMap<>();
        scenario.probe((game, ids, seat, view) -> {
            if (!"precombat_main".equals(view.step()) || view.turn() < 2) {
                return;
            }
            Permanent bears = permanent(game, "Grizzly Bears", ids.get(0));
            for (int defender = 2; defender < 4; defender++) {
                can.putIfAbsent(view.turn() + ":" + defender, bears.canAttack(ids.get(defender), game));
            }
        });
        return can;
    }

    @Test
    void arboriaCountsTheSpellsOfEachPlayerOfTheTeam() throws Exception {
        // "Creatures can't attack a player unless that player cast a spell or put a nontoken permanent
        // onto the battlefield during their last turn": seat 3 casts Think Twice in team B's turn 2, so
        // in team A's turn 3 seat 0's Grizzly Bears can attack seat 3 and not seat 2. Before, only the
        // spells of seat 2, who holds the turn, were counted.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(fourHumans(6212L, 3))
            .battlefield(0, "Arboria", "Grizzly Bears")
            .battlefield(3, "Island", "Island")
            .hand(3, "Think Twice");
        Map<String, Boolean> can = canAttack(scenario);
        List<String> log = play(scenario, casting(3, 2, "Think Twice", TwoHeadedGiantAuditTest.passing(false)));
        System.out.println("Bears can attack " + new java.util.TreeMap<>(can));

        assertTrue(log.stream().anyMatch(line -> line.contains("Think Twice")), "seat 3 cast Think Twice");
        assertEquals(true, can.get("3:3"), "seat 3 cast a spell in its last turn: " + can);
        assertEquals(false, can.get("3:2"), "seat 2 did nothing: " + can);
    }

    @Test
    void arboriaForgetsATeammatesPermanentsAfterTheirTeamsTurn() throws Exception {
        // The same, with nothing cast: seat 3's Islands entered in team A's turn 1 (moved from its hand,
        // so they enter as any permanent does; XMage's cheat above puts permanents onto the battlefield
        // without the event), not during seat 3's last turn (team B's turn 2), so seat 3 can't be
        // attacked in turn 3. Before, the record of permanents entering under seat 3's control was
        // cleared only at the end of seat 3's own turns, which a teammate's turn never is, so the
        // Islands still counted.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(fourHumans(6213L, 3))
            .battlefield(0, "Arboria", "Grizzly Bears")
            .hand(3, "Island", "Island")
            .setup((game, ids, seat, view) -> {
                Player seat3 = game.getPlayer(ids.get(3));
                Cards islands = new CardsImpl();
                seat3.getHand().getCards(game).stream().filter(card -> card.getName().equals("Island")).limit(2)
                    .forEach(islands::add);
                Ability source = new SimpleStaticAbility(Zone.BATTLEFIELD, new InfoEffect("Islands enter"));
                source.setControllerId(ids.get(3));
                seat3.moveCards(islands, Zone.BATTLEFIELD, source, game);
            });
        scenario.probe((game, ids, seat, view) -> {
            if (view.turn() == 2 && "precombat_main".equals(view.step())) {
                scenario.seen.putIfAbsent("islands", game.getBattlefield().getAllActivePermanents(ids.get(3)).size());
            }
        });
        Map<String, Boolean> can = canAttack(scenario);
        play(scenario, TwoHeadedGiantAuditTest.passing(false));
        System.out.println("Bears can attack " + new java.util.TreeMap<>(can));

        assertTrue((Integer) scenario.seen.get("islands") >= 2, "seat 3's Islands entered: " + scenario.seen);
        assertEquals(false, can.get("3:3"), "seat 3 did nothing in its last turn: " + can);
        assertEquals(false, can.get("3:2"), "seat 2 did nothing in its last turn: " + can);
    }

    @Test
    void marchesaForgetsCombatDamageAfterTheTeamsTurn() throws Exception {
        // Invasion of Fiora's Marchesa: "if you haven't been dealt combat damage since your last turn".
        // Seat 1 is dealt combat damage in team A's turn 1; the turn is seat 1's too, so after it ends
        // the damage no longer counts. Before, only seat 0's, who holds the turn, was forgotten.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(fourHumans(6214L, 2))
            .battlefield(2, "Grizzly Bears")
            .hand(1, "Invasion of Fiora");
        Map<String, Object> seen = new ConcurrentHashMap<>();
        scenario.setup((game, ids, seat, view) -> {
            Permanent bears = permanent(game, "Grizzly Bears", ids.get(2));
            Ability source = new SimpleStaticAbility(Zone.BATTLEFIELD, new InfoEffect("combat damage"));
            source.setSourceId(bears.getId());
            source.setControllerId(ids.get(2));
            game.getPlayer(ids.get(1)).damage(2, bears.getId(), source, game, true, true);
            seen.put("damaged in turn 1", players(game).contains(ids.get(1)));
        });
        scenario.probe((game, ids, seat, view) -> {
            if (view.turn() == 2 && "precombat_main".equals(view.step())) {
                seen.putIfAbsent("damaged in turn 2", players(game).contains(ids.get(1)));
            }
        });
        play(scenario, TwoHeadedGiantAuditTest.passing(false));
        System.out.println("Marchesa's watcher: " + seen);

        assertEquals(true, seen.get("damaged in turn 1"), "the combat damage counted: " + seen);
        assertEquals(false, seen.get("damaged in turn 2"), "forgotten after team A's turn: " + seen);
    }

    @SuppressWarnings("unchecked")
    private static Set<UUID> players(Game game) {
        Watcher watcher = watcher(game, "mage.cards.i.MarchesaResoluteMonarchWatcher");
        try {
            Field field = watcher.getClass().getDeclaredField("players");
            field.setAccessible(true);
            return (Set<UUID>) field.get(watcher);
        } catch (ReflectiveOperationException e) {
            throw new AssertionError(e);
        }
    }

    @Test
    void oKagachiAndWeatheredSentinelsRememberWhichPlayerAttacked() throws Exception {
        // "If that player attacked you during their last turn": in team B's turn 2 seat 3 attacks seat 0
        // and seat 2, who holds the turn, does not. Both cards' watchers remember seat 3 as the player
        // who attacked, and in team A's turn 3 O-Kagachi's combat damage to seat 3 exiles seat 3's
        // Grizzly Bears. Before, both remembered seat 2, and O-Kagachi's ability did not trigger.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(fourHumans(6215L, 4))
            .battlefield(0, "O-Kagachi, Vengeful Kami", "Weathered Sentinels")
            .battlefield(3, "Grizzly Bears");
        Map<String, Object> seen = new ConcurrentHashMap<>();
        scenario.probe((game, ids, seat, view) -> {
            if (view.turn() != 3 || !"precombat_main".equals(view.step()) || seen.containsKey("done")) {
                return;
            }
            seen.put("done", true);
            Watcher kami = watcher(game, "mage.cards.o.OKagachiVengefulKamiWatcher");
            Watcher sentinels = watcher(game, "mage.cards.w.WeatheredSentinelsLastTurnAttackersWatcher");
            // checkPlayer(you, them): whether they attacked you during their last turn
            seen.put("O-Kagachi: seat 3 attacked", checkPlayer(kami, ids.get(0), ids.get(3)));
            seen.put("O-Kagachi: seat 2 attacked", checkPlayer(kami, ids.get(0), ids.get(2)));
            seen.put("Sentinels: seat 3 attacked", checkPlayer(sentinels, ids.get(0), ids.get(3)));
            seen.put("Sentinels: seat 2 attacked", checkPlayer(sentinels, ids.get(0), ids.get(2)));
        });
        Tables.Policy teamB = attacks(2, Map.of(3, 0));
        Tables.Policy teamA = attacks(3, Map.of(0, 3));
        play(scenario, (seat, prompt, view) -> {
            if (prompt.kind().equals("choose_target") && seat == 0) {
                PromptView.Option bears = naming(prompt, "choose", "Grizzly Bears");
                return bears != null ? bears.id() : prompt.options().get(0).id();
            }
            return (view.turn() == 3 ? teamA : teamB).choose(seat, prompt, view);
        });
        System.out.println("Watchers " + seen + "; permanents " + new java.util.TreeMap<>(scenario.count));

        assertEquals(true, seen.get("O-Kagachi: seat 3 attacked"), seen.toString());
        assertEquals(false, seen.get("O-Kagachi: seat 2 attacked"), seen.toString());
        assertEquals(true, seen.get("Sentinels: seat 3 attacked"), seen.toString());
        assertEquals(false, seen.get("Sentinels: seat 2 attacked"), seen.toString());
        assertEquals(1, scenario.count.get("3:Grizzly Bears:3"), "seat 3's Bears in turn 3: " + scenario.count);
        assertNull(scenario.count.get("4:Grizzly Bears:3"), "exiled by O-Kagachi: " + scenario.count);
    }

    @Test
    void storageMatrixAsksEachPlayerOfTheTeam() throws Exception {
        // "Each player chooses artifact, creature, or land during their untap step. That player can
        // untap only permanents of the chosen type": in team B's untap step seat 2 chooses land and seat
        // 3 creature. Before, seat 2, who holds the turn, chose for itself only, and all of seat 3's
        // permanents untapped.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(fourHumans(6216L, 2))
            .battlefield(0, "Storage Matrix")
            .battlefield(2, "Plains", "Grizzly Bears")
            .battlefield(3, "Island", "Llanowar Elves")
            .setup((game, ids, seat, view) -> {
                for (String name : List.of("Plains", "Grizzly Bears")) {
                    permanent(game, name, ids.get(2)).tap(null, game);
                }
                for (String name : List.of("Island", "Llanowar Elves")) {
                    permanent(game, name, ids.get(3)).tap(null, game);
                }
            });
        Map<String, Boolean> tapped = tapped(scenario);
        Set<Integer> choosers = ConcurrentHashMap.newKeySet();
        Tables.Policy pass = TwoHeadedGiantAuditTest.passing(false);
        play(scenario, (seat, prompt, view) -> {
            if (prompt.kind().equals("choose_choice")) {
                choosers.add(seat);
                return choice(prompt, seat == 2 ? "Land" : "Creature");
            }
            return pass.choose(seat, prompt, view);
        });
        System.out.println("Tapped " + new java.util.TreeMap<>(tapped) + "; choosers " + choosers);

        assertEquals(Set.of(2, 3), choosers, "each player of team B chose");
        assertEquals(false, tapped.get("2:Plains:2"), tapped.toString());
        assertEquals(true, tapped.get("2:Grizzly Bears:2"), tapped.toString());
        assertEquals(true, tapped.get("2:Island:3"), tapped.toString());
        assertEquals(false, tapped.get("2:Llanowar Elves:3"), tapped.toString());
    }

    @Test
    void elkinLairPutsEachPlayersUnplayedCardIntoTheirGraveyard() throws Exception {
        // "At the beginning of each player's upkeep, that player exiles a card at random from their
        // hand ... At the beginning of the next end step, if the player hasn't played the card, they
        // put it into their graveyard." Each of seats 2 and 3 exiles a card in team B's upkeep, plays
        // neither, and each card goes to its owner's graveyard at team B's end step. Reviewed in v0.6.2:
        // the end step's part reads the holder, but puts every card the Lair still has exiled into its
        // owner's graveyard, so it plays right; this test confirms it.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(fourHumans(6217L, 3))
            .battlefield(0, "Elkin Lair");
        Map<String, Integer> graveyard = inMainPhase(scenario, (game, playerId) -> game.getPlayer(playerId).getGraveyard().size());
        Map<String, Integer> exiled = inMainPhase(scenario, TwoHeadedGiantRareCardsTest::exiledOwnedBy);
        play(scenario, TwoHeadedGiantAuditTest.passing(false));
        System.out.println("Graveyards " + new java.util.TreeMap<>(graveyard) + "; exiled " + new java.util.TreeMap<>(exiled));

        assertEquals(1, at(exiled, 2, 2), "seat 2 exiled a card in its upkeep");
        assertEquals(1, at(exiled, 2, 3), "seat 3 exiled a card in its upkeep");
        assertEquals(0, at(exiled, 3, 2));
        assertEquals(0, at(exiled, 3, 3));
        assertEquals(at(graveyard, 2, 2) + 1, at(graveyard, 3, 2), "seat 2's card in its graveyard");
        assertEquals(at(graveyard, 2, 3) + 1, at(graveyard, 3, 3), "seat 3's card in its graveyard");
    }

    // Outside team games

    @Test
    void aLegacyDuelPlaysTheFixedCardsAsBefore() throws Exception {
        // Between two players, where each change reduces to the card's own code: Urabrask replaces the
        // opponent's draw in their turn; Brine Elemental makes them skip their next untap step, and only
        // one; Storage Matrix asks the player whose untap step it is; Contested Game Ball goes to the
        // attacking player without a choice.
        var scenario = new TwoHeadedGiantAuditTest.Scenario(legacyDuel(6218L, 4))
            .battlefield(0, "Urabrask, Heretic Praetor", "Brine Elemental", "Storage Matrix", "Grizzly Bears")
            .battlefield(1, "Plains", "Llanowar Elves", "Contested Game Ball")
            .setup((game, ids, seat, view) -> {
                permanent(game, "Plains", ids.get(1)).tap(null, game);
                permanent(game, "Llanowar Elves", ids.get(1)).tap(null, game);
                turnFaceUp(game, ids.get(0));
            });
        Map<String, Boolean> tapped = tapped(scenario);
        Map<String, Integer> hand = inMainPhase(scenario, (game, playerId) -> game.getPlayer(playerId).getHand().size());
        Map<String, Integer> choices = new ConcurrentHashMap<>();
        Tables.Policy attack = TwoHeadedGiantAuditTest.attackingIn(3);
        play(scenario, (seat, prompt, view) -> {
            if (prompt.kind().equals("choose_choice")) {
                choices.merge(view.turn() + ":" + seat, 1, Integer::sum);
                return choice(prompt, "Land");
            }
            if (prompt.kind().equals("declare_attackers") && seat == 0 && view.turn() == 3) {
                PromptView.Option bears = option(prompt, "toggle_attacker", "Grizzly Bears");
                return bears != null && !bears.selected() ? bears.id() : firstOf(prompt, "done");
            }
            return attack.choose(seat, prompt, view);
        });
        System.out.println("Tapped " + new java.util.TreeMap<>(tapped) + "; hands " + new java.util.TreeMap<>(hand)
            + "; libraries " + new java.util.TreeMap<>(scenario.library) + "; choices " + choices
            + "; permanents " + new java.util.TreeMap<>(scenario.count));

        // Urabrask: seat 1 exiled its top card instead of drawing in its turn 2
        assertEquals(52, at(scenario.library, 2, 1));
        assertEquals(7, at(hand, 2, 1));
        // Brine Elemental: seat 1 skipped its untap step in turn 2 (no choice for Storage Matrix), then
        // in turn 4 chose land for Storage Matrix
        assertEquals(true, tapped.get("2:Plains:1"), tapped.toString());
        assertEquals(true, tapped.get("2:Llanowar Elves:1"), tapped.toString());
        assertNull(choices.get("2:1"), "no untap step in turn 2: " + choices);
        assertEquals(1, choices.get("3:0"), "seat 0 chose in its untap step: " + choices);
        assertEquals(1, choices.get("4:1"), "seat 1 chose in its untap step: " + choices);
        assertEquals(false, tapped.get("4:Plains:1"), tapped.toString());
        assertEquals(true, tapped.get("4:Llanowar Elves:1"), tapped.toString());
        // Contested Game Ball: seat 0's Bears dealt seat 1 combat damage in turn 3
        assertEquals(1, scenario.count.get("4:Contested Game Ball:0"), "seat 0 gained control: " + scenario.count);
    }
}
