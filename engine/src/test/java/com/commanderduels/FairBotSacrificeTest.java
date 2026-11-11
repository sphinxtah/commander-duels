package com.commanderduels;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import mage.abilities.Ability;
import mage.abilities.common.PassAbility;
import mage.cards.Card;
import mage.constants.Zone;
import mage.game.Game;
import mage.game.match.Match;
import mage.game.permanent.Permanent;
import mage.game.permanent.PermanentCard;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Sacrifice outlets (v0.9.8). XMage's AI feeds its board to an ability paid for by sacrificing
 * another permanent: in the campaign's measured duels Daretti's commander, Slobad, Goblin Tinkerer,
 * sacrificed his artifacts one after another, each to make itself indestructible, and Liliana's,
 * Yawgmoth, Thran Physician, sacrificed Phyrexian Obliterator for a -1/-1 counter and a card. A
 * bot's search no longer considers such an ability; everything else a permanent can do stays among
 * its options. Needs ./db.
 */
class FairBotSacrificeTest {
    private static final List<String> OUTLETS = List.of("Slobad, Goblin Tinkerer", "Yawgmoth, Thran Physician",
        "Viscera Seer", "Carrion Feeder");
    /** Permanents that sacrifice themselves, pay mana by a sacrifice, or sacrifice nothing. */
    private static final List<String> OTHERS = List.of("Mind Stone", "Evolving Wilds", "Phyrexian Tower",
        "Soul-Guide Lantern", "Prodigal Sorcerer");

    @BeforeAll
    static void loadCards() {
        assertTrue(CardDatabase.load().printings() > 50_000);
    }

    private record Table(Game game, FairBot bot) {}

    /** A Legacy table before its first turn, the bot controlling one of each named card. */
    private static Table table(List<String> permanents, List<String> others) throws Exception {
        GameFormat format = GameFormat.LEGACY;
        Game game = format.newGame(2, 30, null);
        Match match = format.newMatch("sacrifice outlets test", 2);
        FairBot bot = new FairBot("Bot", format.range(0), 6, 7L);
        FairBot other = new FairBot("Other", format.range(1), 6, 8L);
        List<DeckLists.Entry> cards = new ArrayList<>();
        permanents.forEach(name -> cards.add(new DeckLists.Entry(name, 1)));
        others.forEach(name -> cards.add(new DeckLists.Entry(name, 1)));
        cards.add(new DeckLists.Entry("Swamp", 60 - cards.size()));
        LegacyDuel.seat(game, match, bot, DeckLists.load(new DeckLists.CustomDeck(cards, List.of())));
        LegacyDuel.seat(game, match, other,
            DeckLists.load(new DeckLists.CustomDeck(List.of(new DeckLists.Entry("Island", 60)), List.of())));
        bot.updateRange(game);
        other.updateRange(game);
        for (String name : permanents) {
            Card card = card(game, bot, name);
            bot.getLibrary().remove(card.getId(), game);
            Permanent permanent = new PermanentCard(card, bot.getId(), game);
            game.getBattlefield().addPermanent(permanent);
            game.getState().setZone(card.getId(), Zone.BATTLEFIELD);
        }
        return new Table(game, bot);
    }

    private static Card card(Game game, FairBot bot, String name) {
        return bot.getLibrary().getCards(game).stream().filter(card -> card.getName().equals(name))
            .findFirst().orElseThrow(() -> new AssertionError("no " + name));
    }

    /** Each permanent's activated abilities that are not mana abilities, by its name. */
    private static Map<String, List<Ability>> abilities(Table table) {
        Map<String, List<Ability>> found = new TreeMap<>();
        for (Permanent permanent : table.game().getBattlefield().getAllActivePermanents(table.bot().getId())) {
            List<Ability> own = new ArrayList<>();
            for (Ability ability : permanent.getAbilities(table.game())) {
                if (ability.isNonManaActivatedAbility()) {
                    own.add(ability);
                }
            }
            found.put(permanent.getName(), own);
        }
        return found;
    }

    @Test
    void anAbilityPaidForByAnotherPermanentsSacrificeIsAnOutlet() throws Exception {
        List<String> names = new ArrayList<>(OUTLETS);
        names.addAll(OTHERS);
        Table table = table(names, List.of("Diabolic Intent"));
        Map<String, List<Ability>> abilities = abilities(table);
        for (String name : OUTLETS) {
            assertEquals(1, abilities.get(name).stream().filter(FairBot::isSacrificeOutlet).count(), name);
        }
        // Yawgmoth's other ability, which discards a card to proliferate, is no outlet.
        assertEquals(2, abilities.get("Yawgmoth, Thran Physician").size());
        for (String name : OTHERS) {
            assertTrue(abilities.get(name).stream().noneMatch(FairBot::isSacrificeOutlet), name);
        }
        // Mind Stone, Evolving Wilds and the Lantern sacrifice themselves: an ability each.
        assertEquals(1, abilities.get("Mind Stone").size());
        assertEquals(1, abilities.get("Evolving Wilds").size());
        assertFalse(abilities.get("Soul-Guide Lantern").isEmpty());
        // Phyrexian Tower's sacrifice pays for mana: XMage spends mana abilities, it does not search them.
        Permanent tower = table.game().getBattlefield().getAllActivePermanents(table.bot().getId()).stream()
            .filter(permanent -> permanent.getName().equals("Phyrexian Tower")).findFirst().orElseThrow();
        assertTrue(tower.getAbilities(table.game()).stream().noneMatch(FairBot::isSacrificeOutlet));
        // A spell with a sacrifice among its costs is cast or not, as before.
        Card intent = card(table.game(), table.bot(), "Diabolic Intent");
        assertFalse(FairBot.isSacrificeOutlet(intent.getSpellAbility()));
    }

    @Test
    void aSearchLeavesTheOutletsOutOfItsOptions() throws Exception {
        List<String> names = new ArrayList<>(OUTLETS);
        names.addAll(OTHERS);
        Table table = table(names, List.of());
        List<Ability> options = new ArrayList<>();
        abilities(table).values().forEach(own -> own.forEach(ability -> options.add(ability.copy())));
        options.add(new PassAbility());
        int before = options.size();
        long outlets = options.stream().filter(FairBot::isSacrificeOutlet).count();
        assertEquals(OUTLETS.size(), outlets);

        table.bot().optimize(table.game(), options);

        assertTrue(options.stream().noneMatch(FairBot::isSacrificeOutlet), options.toString());
        assertEquals(before - outlets, options.size(), options.toString());
        assertEquals(outlets, table.bot().stats().outlets());
        // What is left is everything else: the Stone's card, the Wilds' land, the Sorcerer's ping, and passing.
        assertTrue(options.stream().anyMatch(ability -> ability instanceof PassAbility));
        for (String name : List.of("Mind Stone", "Evolving Wilds", "Prodigal Sorcerer")) {
            assertTrue(options.stream().anyMatch(ability -> {
                Permanent source = table.game().getPermanent(ability.getSourceId());
                return source != null && source.getName().equals(name);
            }), name);
        }
    }
}
