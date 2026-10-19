package com.commanderduels;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import mage.cards.Card;
import mage.cards.decks.Deck;
import mage.cards.decks.DeckCardLists;
import mage.cards.decks.DeckValidator;
import mage.cards.decks.DeckValidatorError;
import mage.cards.decks.importer.DeckImporter;
import mage.constants.MultiplayerAttackOption;
import mage.constants.PhaseStep;
import mage.constants.RangeOfInfluence;
import mage.deck.Legacy;
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
 * Setup shared by bot matches and human games: the fixture decks, a Legacy-rules Two Player Duel and
 * the never-started match that XMage's AI needs for its search (it copies each player's match
 * record and fails without one).
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
        var options = new GameOptions();
        options.stopOnTurn = turnCap + 1;
        options.stopAtStep = PhaseStep.UNTAP;
        options.rollbackTurnsAllowed = false;
        game.setGameOptions(options);
        return game;
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
        Path file = deckDirectory.resolve(name + ".txt");
        if (!Files.isRegularFile(file)) {
            throw new GameException("Deck file not found: " + file);
        }
        var errors = new StringBuilder();
        DeckCardLists lists = DeckImporter.importDeckFromFile(file.toString(), errors, false);
        if (!errors.isEmpty()) {
            throw new GameException("Deck " + name + " did not import: " + errors.toString().trim());
        }
        Deck deck = Deck.load(lists, false, false);
        DeckValidator validator = new Legacy();
        if (!validator.validate(deck)) {
            throw new GameException("Deck " + name + " is not Legacy-legal: " + validator.getErrorsListSorted()
                .stream().map(DeckValidatorError::getMessage).collect(Collectors.joining("; ")));
        }
        return deck;
    }
}
