package com.commanderduels;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Random;
import java.util.Set;
import java.util.UUID;
import mage.cards.Card;
import mage.cards.Cards;
import mage.constants.CommanderCardType;
import mage.constants.Zone;
import mage.game.Game;
import mage.players.Library;
import mage.players.Player;

/**
 * Replaces the concealed state of a bot's simulation copy with a plausible sample drawn from what the
 * bot's seat may know (AI02). XMage's AI searches a full copy of the game, in which every other
 * player's hand and library hold the real cards in the real order and the bot's own library is in
 * its real order: the search would see opponents' hands and its own next draws.
 *
 * <p>For every other player, the cards in their hand and library are pooled and dealt again: a hand
 * and a library of the same sizes, in random order. Cards whose identity the seat may see under
 * {@link Visibility} (revealed to everyone, looked at by the bot, or the player's commander) stay
 * where they are known to be: a known card in a hand stays in that hand, and a known card in a
 * library stays in the library, at a random position. The bot's own hand stays as it is and its
 * library is shuffled. A library whose top card is revealed by an effect ({@link Player#isTopCardRevealed})
 * keeps that card on top. Before shuffling, each pool is put in card-name order, so a sample depends
 * only on the pool's contents and the random source, never on the real concealed order.
 *
 * <p>Only the copy changes: the real game is never touched. The pool is the other player's real
 * remaining cards (their deck minus the cards in public zones), so the sample still assumes the bot
 * knows each opponent's deck list; see docs/engine/fair-bots.md.
 */
final class Determinizer {
    private static final Comparator<Card> BY_NAME = Comparator.comparing(Card::getName);

    private Determinizer() {}

    /** Re-deals every player's concealed zones in {@code sim} as the seat of {@code viewerId} sees them. */
    static void redeal(Game sim, UUID viewerId, Random random) {
        // Seating order, so a seeded source gives the same samples on every run.
        for (UUID playerId : new ArrayList<>(sim.getState().getPlayers().keySet())) {
            Player player = sim.getPlayer(playerId);
            if (player == null) {
                continue;
            }
            if (playerId.equals(viewerId)) {
                shuffleOwnLibrary(sim, player, random);
            } else {
                redealOther(sim, player, viewerId, random);
            }
        }
    }

    /** The bot knows its own hand and its library's contents, not the library's order. */
    private static void shuffleOwnLibrary(Game sim, Player player, Random random) {
        List<Card> library = owned(sim, player, player.getLibrary().getCardList());
        if (library == null || library.size() < 2) {
            return;
        }
        Card top = player.isTopCardRevealed() ? library.remove(0) : null;
        shuffle(library, random);
        if (top != null) {
            library.add(0, top);
        }
        putInLibrary(sim, player, library);
    }

    private static void redealOther(Game sim, Player player, UUID viewerId, Random random) {
        List<Card> hand = owned(sim, player, new ArrayList<>(player.getHand()));
        List<Card> library = owned(sim, player, player.getLibrary().getCardList());
        if (hand == null || library == null || hand.size() + library.size() < 2) {
            return;
        }
        Set<UUID> commanders = new HashSet<>(sim.getCommandersIds(player, CommanderCardType.COMMANDER_OR_OATHBREAKER,
            false));
        List<Card> knownInHand = new ArrayList<>();
        List<Card> unknown = new ArrayList<>();
        for (Card card : hand) {
            (known(sim, card, viewerId, commanders) ? knownInHand : unknown).add(card);
        }
        Card top = player.isTopCardRevealed() && !library.isEmpty() ? library.remove(0) : null;
        List<Card> knownInLibrary = new ArrayList<>();
        for (Card card : library) {
            (known(sim, card, viewerId, commanders) ? knownInLibrary : unknown).add(card);
        }

        shuffle(unknown, random);
        int dealt = hand.size() - knownInHand.size();
        List<Card> newHand = new ArrayList<>(knownInHand);
        newHand.addAll(unknown.subList(0, dealt));
        List<Card> newLibrary = new ArrayList<>(unknown.subList(dealt, unknown.size()));
        if (!knownInLibrary.isEmpty()) {
            // A known card's identity is public, its position in the library is not.
            newLibrary.addAll(knownInLibrary);
            shuffle(newLibrary, random);
        }
        if (top != null) {
            newLibrary.add(0, top);
        }
        Cards handZone = player.getHand();
        handZone.clear();
        for (Card card : newHand) {
            handZone.add(card);
            // Through the card, so split and double-faced cards' halves follow it.
            card.setZone(Zone.HAND, sim);
        }
        putInLibrary(sim, player, newLibrary);
    }

    private static boolean known(Game sim, Card card, UUID viewerId, Set<UUID> commanders) {
        return commanders.contains(card.getId()) || Visibility.identityVisible(sim, card.getId(), viewerId);
    }

    /** Name order first, so the result depends only on the cards and the random source. */
    private static void shuffle(List<Card> cards, Random random) {
        cards.sort(BY_NAME);
        Collections.shuffle(cards, random);
    }

    /**
     * The cards behind {@code ids}, or null if one is missing or belongs to someone else: such a zone
     * is left as it is rather than risk moving a card to another player's zone.
     */
    private static List<Card> owned(Game sim, Player player, List<UUID> ids) {
        List<Card> cards = new ArrayList<>(ids.size());
        for (UUID id : ids) {
            Card card = sim.getCard(id);
            if (card == null || !card.isOwnedBy(player.getId())) {
                return null;
            }
            cards.add(card);
        }
        return cards;
    }

    /** Makes {@code library} (top first) the player's library; putOnBottom records each card's zone. */
    private static void putInLibrary(Game sim, Player player, List<Card> library) {
        Library libraryZone = player.getLibrary();
        libraryZone.clear();
        for (Card card : library) {
            libraryZone.putOnBottom(card, sim);
        }
    }
}
