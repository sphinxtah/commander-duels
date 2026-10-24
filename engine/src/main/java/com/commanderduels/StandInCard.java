package com.commanderduels;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import mage.MageInt;
import mage.ObjectColor;
import mage.abilities.common.SimpleStaticAbility;
import mage.abilities.effects.common.InfoEffect;
import mage.cards.CardImpl;
import mage.cards.CardSetInfo;
import mage.constants.CardType;
import mage.constants.Rarity;
import mage.constants.SubType;
import mage.constants.SuperType;
import mage.constants.Zone;

/**
 * A card the engine has no implementation of, made from its description (v0.6.2): its name, printed
 * mana cost, card types, subtypes and supertypes, power and toughness, loyalty and defense, and
 * colours. It has no abilities but one rule saying so, so its rules text is inert: a creature attacks and blocks, a land
 * is played and does nothing more, a spell is cast and resolves with no effect. Casual games play
 * such cards so a player may use every card they own, as the owner decided; the API describes them
 * in the deck list ({@link DeckLists}). Games copy cards, so the copy constructor carries everything
 * (the description lives in {@link CardImpl}'s own fields); views name the card by its name, which
 * the browser's image cache looks up in the catalog.
 */
public final class StandInCard extends CardImpl {
    private static final long serialVersionUID = 1L;
    /** The set code views would show for it: no XMage set has it. */
    static final String SET_CODE = "CDSI";
    /** The one rule a stand-in shows, in place of its rules text. */
    static final String RULE = "Stand-in: the game has no rules for this card yet, so its rules text has no effect.";

    /** What the API says of a stand-in. Null power and toughness: not a creature's. */
    record Description(String name, String manaCost, List<String> types, List<String> subtypes,
                       List<String> supertypes, List<String> colors, String power, String toughness,
                       String loyalty, String defense) {
        Description {
            types = List.copyOf(types);
            subtypes = List.copyOf(subtypes);
            supertypes = List.copyOf(supertypes);
            colors = List.copyOf(colors);
        }
    }

    StandInCard(UUID ownerId, Description description) {
        super(ownerId, new CardSetInfo(description.name(), "0", SET_CODE, Rarity.COMMON), cardTypes(description),
            cost(description));
        for (String name : description.supertypes()) {
            SuperType supertype = superType(name);
            if (supertype != null) {
                this.supertype.add(supertype);
            }
        }
        for (String name : description.subtypes()) {
            SubType subtype = subType(name);
            if (subtype != null && !this.subtype.contains(subtype)) {
                this.subtype.add(subtype);
            }
        }
        // The printed colours, not the cost's: a colour indicator, or devoid's colourless.
        ObjectColor colour = new ObjectColor();
        for (String letter : description.colors()) {
            colour.addColor(new ObjectColor(letter));
        }
        this.color.setColor(colour);
        if (isCreature()) {
            this.power = new MageInt(number(description.power()));
            this.toughness = new MageInt(number(description.toughness()));
        }
        if (description.loyalty() != null) {
            setStartingLoyalty(number(description.loyalty()));
        }
        if (description.defense() != null) {
            setStartingDefense(number(description.defense()));
        }
        // Its one rule, which every view shows in place of its rules text; it does nothing.
        addAbility(new SimpleStaticAbility(Zone.ALL, new InfoEffect(RULE)));
    }

    private StandInCard(final StandInCard card) {
        super(card);
    }

    /** Makes the card, or (an unreadable cost) the same card with no cost. */
    static StandInCard of(Description description) {
        try {
            return new StandInCard(null, description);
        } catch (RuntimeException e) {
            return new StandInCard(null, new Description(description.name(), "", description.types(),
                description.subtypes(), description.supertypes(), description.colors(), description.power(),
                description.toughness(), description.loyalty(), description.defense()));
        }
    }

    @Override
    public StandInCard copy() {
        return new StandInCard(this);
    }

    private static CardType[] cardTypes(Description description) {
        List<CardType> found = new ArrayList<>();
        for (String name : description.types()) {
            CardType type = cardType(name);
            if (type != null && !found.contains(type)) {
                found.add(type);
            }
        }
        return found.toArray(CardType[]::new);
    }

    private static String cost(Description description) {
        String cost = description.manaCost();
        return cost == null ? "" : cost.strip();
    }

    private static CardType cardType(String name) {
        String wanted = name.strip();
        for (CardType type : CardType.values()) {
            if (type.toString().equalsIgnoreCase(wanted) || type.name().equalsIgnoreCase(wanted)) {
                return type;
            }
        }
        // Scryfall's "Tribal" is XMage's Kindred.
        return "tribal".equalsIgnoreCase(wanted) ? CardType.KINDRED : null;
    }

    /** A subtype XMage knows, or null (a type newer than XMage's list). */
    private static SubType subType(String name) {
        try {
            return SubType.byDescription(name.strip());
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static SuperType superType(String name) {
        String wanted = name.strip().toUpperCase(Locale.ROOT);
        for (SuperType type : SuperType.values()) {
            if (type.name().equals(wanted)) {
                return type;
            }
        }
        return null;
    }

    /** A printed number: its leading digits ("3", "1+*" is 1, "*" and "X" are 0). */
    static int number(String printed) {
        if (printed == null) {
            return 0;
        }
        String value = printed.strip();
        int sign = 1;
        int index = 0;
        if (value.startsWith("-")) {
            sign = -1;
            index = 1;
        } else if (value.startsWith("+")) {
            index = 1;
        }
        int number = 0;
        boolean any = false;
        while (index < value.length() && Character.isDigit(value.charAt(index)) && number < 1000) {
            number = number * 10 + (value.charAt(index) - '0');
            index++;
            any = true;
        }
        return any ? sign * number : 0;
    }
}
