package com.commanderduels;

import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import mage.cards.Card;
import mage.cards.decks.Deck;
import mage.constants.MultiplayerAttackOption;
import mage.constants.PhaseStep;
import mage.constants.RangeOfInfluence;
import mage.game.Game;
import mage.game.GameException;
import mage.game.GameOptions;
import mage.game.TwoPlayerDuel;
import mage.game.TwoPlayerMatch;
import mage.game.match.Match;
import mage.game.match.MatchOptions;
import mage.game.mulligan.MulliganType;
import mage.players.Player;

/**
 * Setup shared by bot matches and development games: the Legacy fixture decks, a Legacy-rules Two
 * Player Duel, seating a player with a deck, and the never-started match that XMage's AI needs for
 * its search (it copies each player's match record and fails without one).
 */
final class LegacyDuel {
    static final List<String> DECKS = List.of("legacy-mono-red-burn", "legacy-mono-green-creatures");
    private static final int LEGACY_MIN_DECK = 60;
    private static final int START_LIFE = 20;
    private static final int START_HAND = 7;

    private LegacyDuel() {}

    /** A London-mulligan duel that stops at the untap step after {@code turnCap} turns. */
    static Game newGame(int turnCap) {
        Game game = new TwoPlayerDuel(MultiplayerAttackOption.LEFT, RangeOfInfluence.ONE,
            MulliganType.LONDON.getMulligan(0), LEGACY_MIN_DECK, START_LIFE, START_HAND);
        game.setGameOptions(options(turnCap));
        return game;
    }

    /** Stop at the untap step after {@code turnCap} turns; no rollbacks. */
    static GameOptions options(int turnCap) {
        var options = new GameOptions();
        options.stopOnTurn = turnCap + 1;
        options.stopAtStep = PhaseStep.UNTAP;
        options.rollbackTurnsAllowed = false;
        return options;
    }

    static Match newMatch(String name) {
        var matchOptions = new MatchOptions(name, "Two Player Duel", false);
        matchOptions.setDeckType("Constructed - Legacy");
        matchOptions.setWinsNeeded(1);
        return new TwoPlayerMatch(matchOptions);
    }

    /** Adds a player and deck to the game and the match, with the library in deck-list order. */
    static void seat(Game game, Match match, Player player, Deck deck) {
        game.loadCards(deck.getCards(), player.getId());
        game.loadCards(deck.getSideboard(), player.getId());
        game.addPlayer(player, deck);
        match.addPlayer(player, deck);
        // addPlayer fills the library from Deck.getMaindeckCards(), a HashSet of identity-hashed
        // cards, so the order before the opening shuffle differs on every run. Restore deck-list
        // order so the seeded shuffle deals the same hands.
        Set<Card> maindeck = deck.getCards().stream().filter(card -> !card.isExtraDeckCard())
            .collect(Collectors.toCollection(LinkedHashSet::new));
        player.getLibrary().clear();
        player.getLibrary().addAll(maindeck, game);
    }

    /** Loads a fixture deck and checks it with XMage's Legacy validator. */
    static Deck loadDeck(Path deckDirectory, String name) throws GameException {
        return GameFormat.LEGACY.loadDeck(deckDirectory, name);
    }
}
