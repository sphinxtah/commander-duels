package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import mage.cards.Card;
import mage.cards.CardsImpl;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.permanent.Permanent;
import mage.players.Player;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The owner's report (v0.9.8), played as he played it, through a human seat at the campaign's court:
 * King A controls Liliana's Contract and four Demons with different names, so at King A's upkeep the
 * Contract wins the game for him, which at a table with limited range makes his opponents in range
 * lose (801.16): both of the other King's Generals. The other King is out of range and plays on, with
 * a planeswalker beside him, as The Sphinx has his incarnation. In that same turn King A must be able
 * to attack him: the guard fell with the Generals. Before v0.9.8 the choice of a defender offered
 * nothing, since it kept to the range King A's turn began with. Needs ./db.
 */
class KingsTableAttackChoiceTest {
    private static final String COMMANDER = "Isamaru, Hound of Konda";
    private static final String CONTRACT = "Liliana's Contract";
    private static final List<String> DEMONS =
        List.of("Demon of Catastrophes", "Doom Whisperer", "Pestilence Demon", "Griselbrand");
    private static final String WALKER = "Chandra Nalaar";
    private static final int KING_A = 1;
    private static final int KING_B = 4;

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
        Tables.actAsClient();
    }

    @Test
    void aKingAttacksTheOtherKingInTheTurnHisGeneralsFall() throws Exception {
        List<DeckLists.Entry> mine = new ArrayList<>(List.of(new DeckLists.Entry("Swamp", 94),
            new DeckLists.Entry(CONTRACT, 1)));
        DEMONS.forEach(demon -> mine.add(new DeckLists.Entry(demon, 1)));
        var human = new DeckLists.CustomDeck(mine, List.of(COMMANDER));
        var general = new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Mountain", 99)), List.of(COMMANDER));
        var otherKing = new DeckLists.CustomDeck(
            List.of(new DeckLists.Entry("Mountain", 98), new DeckLists.Entry(WALKER, 1)), List.of(COMMANDER));
        List<HumanGameRequest.Seat> seats = new ArrayList<>();
        for (int seat = 0; seat < KingsTableRules.SEATS; seat++) {
            seats.add(seat == KING_A
                ? new HumanGameRequest.Seat(HumanGameRequest.HUMAN, HumanGameRequest.CUSTOM_DECK, human)
                : new HumanGameRequest.Seat(HumanGameRequest.BOT, HumanGameRequest.CUSTOM_DECK,
                    seat == KING_B ? otherKing : general));
        }
        // The court's settings: Commander decks, everyone at 40, the house rule with its guard. King A
        // takes the first turn, so the Contract's upkeep is the game's first.
        var rules = new KingsTableRules(true, KingsTableRules.ALL_40, true, true);
        var request = new HumanGameRequest(9801L, GameFormat.KINGS_TABLE_COMMANDER, seats, 1, 12, 900, 0, KING_A,
            null, rules);

        AtomicBoolean set = new AtomicBoolean(false);
        HumanGame.Hooks hooks = new HumanGame.Hooks() {
            @Override
            public void published(Game game, ObjectRefs refs, int seat, SeatView view, PromptView prompt) {
                // At the first prompt, the mulligan's: the board the owner had, and the other King's
                // planeswalker, put onto the battlefield as an effect would put them.
                if (seat != KING_A || prompt == null || !set.compareAndSet(false, true)) {
                    return;
                }
                List<UUID> ids = GameFormat.kingsTableOf(game).seats();
                List<String> board = new ArrayList<>(DEMONS);
                board.add(CONTRACT);
                put(game, game.getPlayer(ids.get(KING_A)), board);
                put(game, game.getPlayer(ids.get(KING_B)), List.of(WALKER));
            }
        };

        Set<Integer> offeredSeats = ConcurrentHashMap.newKeySet();
        Set<String> offeredObjects = ConcurrentHashMap.newKeySet();
        AtomicInteger choices = new AtomicInteger();
        AtomicBoolean toggled = new AtomicBoolean(false);
        AtomicBoolean declared = new AtomicBoolean(false);
        AtomicInteger otherKingsLife = new AtomicInteger(40);
        Set<Integer> lost = ConcurrentHashMap.newKeySet();
        AtomicInteger turnOfTheAttack = new AtomicInteger();
        AtomicBoolean attackable = new AtomicBoolean(false);

        HumanGame game = Tables.start(request, hooks);
        // The bots only pass, as in the owner's test of the court: nothing blocks or answers.
        game.setPassiveBots(true);
        Tables.Played played = Tables.play(game, (seat, prompt, view) -> {
            if (view != null) {
                for (SeatView.PlayerState other : view.opponents()) {
                    if (other.seat() == KING_B) {
                        otherKingsLife.accumulateAndGet(other.life(), Math::min);
                        if (Boolean.TRUE.equals(other.attackable())) {
                            attackable.set(true);
                        }
                    }
                    if (other.lost()) {
                        lost.add(other.seat());
                    }
                }
            }
            List<PromptView.Option> options = prompt.options();
            switch (prompt.kind()) {
                case "mulligan":
                    return ScriptedPlayer.byAction(options, "keep").get(0).id();
                case "declare_attackers": {
                    if (declared.get() && otherKingsLife.get() < 40) {
                        return null; // the attack landed: King A concedes, and the game is over
                    }
                    var attackers = ScriptedPlayer.byAction(options, "toggle_attacker");
                    if (!declared.get() && !attackers.isEmpty() && toggled.compareAndSet(false, true)) {
                        return attackers.get(0).id();
                    }
                    return ScriptedPlayer.byAction(options, "done").get(0).id();
                }
                case "choose_defender": {
                    choices.incrementAndGet();
                    turnOfTheAttack.set(view.turn());
                    for (PromptView.Option option : ScriptedPlayer.byAction(options, "choose")) {
                        if (option.seat() != null) {
                            offeredSeats.add(option.seat());
                        } else if (option.objectId() != null) {
                            offeredObjects.add(option.label());
                        }
                    }
                    var king = options.stream().filter(option -> Integer.valueOf(KING_B).equals(option.seat()))
                        .findFirst();
                    if (king.isEmpty()) {
                        return null; // nothing to choose: the bug. Concede, and let the assertions say so
                    }
                    declared.set(true);
                    return king.get().id();
                }
                default: {
                    if (declared.get() && otherKingsLife.get() < 40) {
                        return null;
                    }
                    var pass = ScriptedPlayer.byAction(options, "pass");
                    if (!pass.isEmpty()) {
                        return pass.get(0).id();
                    }
                    var done = ScriptedPlayer.byAction(options, "done");
                    return done.isEmpty() ? options.get(0).id() : done.get(0).id();
                }
            }
        }, 6, new Tables.Coverage());

        assertTrue(set.get(), "the board was never set");
        assertTrue(lost.containsAll(Set.of(3, 5)), "the Contract beat both Generals in range; lost: " + lost);
        assertTrue(attackable.get(), "the view marks the other King as one King A may attack");
        assertEquals(1, choices.get(), "one choice of a defender");
        assertEquals(1, turnOfTheAttack.get(), "in the turn the Generals fell");
        assertEquals(Set.of(KING_B), offeredSeats, "the other King is offered");
        assertEquals(Set.of(WALKER), offeredObjects, "and his planeswalker");
        assertTrue(otherKingsLife.get() <= 35, "the Demon hit the other King: " + otherKingsLife.get());
        assertEquals("completed", played.last().result().kind(), played.last().result().toString());
    }

    /** Puts the player's named cards onto the battlefield from their library or hand, ready to attack. */
    private static void put(Game game, Player player, List<String> names) {
        List<Card> found = new ArrayList<>();
        for (Card card : player.getLibrary().getCards(game)) {
            if (names.contains(card.getName())) {
                found.add(card);
            }
        }
        for (Card card : player.getHand().getCards(game)) {
            if (names.contains(card.getName())) {
                found.add(card);
            }
        }
        assertEquals(names.size(), found.size(), "the deck's cards: " + names);
        // XMage wants a source for what enters (a planeswalker's loyalty counters name it).
        player.moveCards(new CardsImpl(found), Zone.BATTLEFIELD, found.get(0).getSpellAbility(), game);
        for (Card card : found) {
            Permanent permanent = game.getPermanent(card.getId());
            assertTrue(permanent != null, card.getName() + " is on the battlefield");
            ((mage.game.permanent.PermanentImpl) permanent).removeSummoningSickness();
        }
    }
}
