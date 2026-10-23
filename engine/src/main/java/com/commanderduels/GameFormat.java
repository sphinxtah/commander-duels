package com.commanderduels;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.stream.Collectors;
import mage.cards.decks.Deck;
import mage.cards.decks.DeckCardLists;
import mage.cards.decks.DeckValidator;
import mage.cards.decks.DeckValidatorError;
import mage.cards.decks.importer.DeckImporter;
import mage.constants.MultiplayerAttackOption;
import mage.constants.RangeOfInfluence;
import mage.deck.Commander;
import mage.deck.Legacy;
import mage.game.CommanderDuel;
import mage.game.CommanderDuelMatch;
import mage.game.CommanderFreeForAll;
import mage.game.CommanderFreeForAllMatch;
import mage.game.Game;
import mage.game.GameException;
import mage.game.match.Match;
import mage.game.match.MatchOptions;
import mage.game.mulligan.MulliganType;

/**
 * The formats a development game can be played in, each with its fixture decks and XMage game type.
 *
 * <p>Legacy is a Two Player Duel. Commander seats two, three or four players at 40 life with the
 * London mulligan. Two seats use XMage's {@link CommanderDuel}, labelled as the scope's two-seat
 * Commander profile rather than the separate Duel Commander format (FMT02); three and four use
 * {@link CommanderFreeForAll}, where a player may attack any opponent. Mulligan and first-draw rules
 * follow the table, as the Comprehensive Rules do: a two-player game is not multiplayer, so the
 * starting player skips the first draw and no mulligan is free (rules 103.8a and 103.5c); with three
 * or four players nobody skips the first draw and each player's first mulligan is free.
 *
 * <p>Two-Headed Giant (since v0.5.0, early) seats four players in turn order, seats 0 and 1 against
 * seats 2 and 3, with Legacy-legal decks: see {@link TwoHeadedGiant}. Each deck is checked here on
 * its own; the team's deck rule (no card in both teammates' decks) is the API's, which builds the
 * teams. Its fixtures are paired red and white against green and blue (v0.5.1): the most even of
 * the three pairings in bot-versus-bot games (docs/engine/two-headed-giant.md).
 */
enum GameFormat {
    LEGACY("legacy", "Legacy", 2, 2, LegacyDuel.DECKS, Legacy::new),
    COMMANDER("commander", "Commander", 2, 4, List.of("commander-mono-white-soldiers", "commander-mono-blue-flyers",
        "commander-mono-red-raiders", "commander-mono-green-stompers"), Commander::new),
    TWO_HEADED_GIANT("two_headed_giant", "Two-Headed Giant", 4, 4, List.of("legacy-mono-red-burn",
        "legacy-mono-white-weenie", "legacy-mono-green-creatures", "legacy-mono-blue-skies"), Legacy::new);

    static final int COMMANDER_START_LIFE = 40;
    private static final int START_HAND = 7;

    private final String id;
    private final String displayName;
    private final int minSeats;
    private final int maxSeats;
    private final List<String> decks;
    private final Supplier<DeckValidator> validator;

    GameFormat(String id, String displayName, int minSeats, int maxSeats, List<String> decks,
               Supplier<DeckValidator> validator) {
        this.id = id;
        this.displayName = displayName;
        this.minSeats = minSeats;
        this.maxSeats = maxSeats;
        this.decks = decks;
        this.validator = validator;
    }

    String id() {
        return id;
    }

    int minSeats() {
        return minSeats;
    }

    int maxSeats() {
        return maxSeats;
    }

    /** The fixture decks, by file name in the deck folder. */
    List<String> decks() {
        return decks;
    }

    static GameFormat of(String id) {
        for (GameFormat format : values()) {
            if (format.id.equals(id)) {
                return format;
            }
        }
        return null;
    }

    static List<String> ids() {
        return List.of(values()).stream().map(GameFormat::id).toList();
    }

    /** What the settings call the rules this table plays under. */
    String rulesProfile(int seats) {
        if (this == LEGACY) {
            return "legacy_two_player_duel";
        }
        if (this == TWO_HEADED_GIANT) {
            return "two_headed_giant_legacy";
        }
        return seats == 2 ? "commander_two_seat" : "commander_free_for_all";
    }

    /**
     * XMage's range of influence: everyone at a Commander table, as XMage's own Commander tables
     * use, and at a Two-Headed Giant table.
     */
    RangeOfInfluence range() {
        return this == LEGACY ? RangeOfInfluence.ONE : RangeOfInfluence.ALL;
    }

    /** Whether seats play in teams: seats 0 and 1 against seats 2 and 3. */
    boolean teams() {
        return this == TWO_HEADED_GIANT;
    }

    /** The team of a seat, or null outside team formats. */
    Integer teamOf(int seat) {
        return teams() ? seat / 2 : null;
    }

    /** Names the teams in a team game, once its players are seated; nothing in other formats. */
    void seatTeams(Game game, List<UUID> seatIds) {
        if (game instanceof TwoHeadedGiant giant) {
            giant.setTeams(List.of(seatIds.subList(0, 2), seatIds.subList(2, 4)));
        }
    }

    /** A new game that stops at the untap step after {@code turnCap} turns. */
    Game newGame(int seats, int turnCap) {
        if (this == LEGACY) {
            return LegacyDuel.newGame(turnCap);
        }
        Game game;
        if (this == TWO_HEADED_GIANT) {
            // 103.5c: a multiplayer game, so each player's first mulligan is free.
            game = new TwoHeadedGiant(MulliganType.LONDON.getMulligan(1), START_HAND);
        } else if (seats == 2) {
            game = new CommanderDuel(MultiplayerAttackOption.LEFT, RangeOfInfluence.ALL,
                MulliganType.LONDON.getMulligan(0), COMMANDER_START_LIFE, START_HAND);
        } else {
            var freeForAll = new CommanderFreeForAll(MultiplayerAttackOption.MULTIPLE, RangeOfInfluence.ALL,
                MulliganType.LONDON.getMulligan(1), COMMANDER_START_LIFE, START_HAND);
            freeForAll.setNumPlayers(seats);
            game = freeForAll;
        }
        game.setGameOptions(LegacyDuel.options(turnCap));
        return game;
    }

    /** The never-started match XMage's AI needs for its search. */
    Match newMatch(String name, int seats) {
        if (this == LEGACY) {
            return LegacyDuel.newMatch(name);
        }
        if (this == TWO_HEADED_GIANT) {
            var options = new MatchOptions(name, "Two-Headed Giant", false);
            options.setDeckType("Constructed - Legacy");
            options.setWinsNeeded(1);
            return new TwoHeadedGiant.Match(options);
        }
        var options = new MatchOptions(name, seats == 2 ? "Commander Two Player Duel" : "Commander Free For All",
            false);
        options.setDeckType("Variant Magic - Commander");
        options.setWinsNeeded(1);
        return seats == 2 ? new CommanderDuelMatch(options) : new CommanderFreeForAllMatch(options);
    }

    /** Loads a fixture deck and checks it with this format's XMage validator. */
    Deck loadDeck(Path deckDirectory, String name) throws GameException {
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
        DeckValidator check = validator.get();
        if (!check.validate(deck)) {
            throw new GameException("Deck " + name + " is not " + displayName + "-legal: "
                + check.getErrorsListSorted().stream().map(DeckValidatorError::getMessage)
                    .collect(Collectors.joining("; ")));
        }
        return deck;
    }
}
