import type {
  CustomCard,
  Planeswalker,
  Progress,
  StarterDeck,
  TierInfo,
} from "../api";
import type { AllianceCards } from "../catalog/catalog";
import { card as cardSummary, customSummary } from "../decks/fixtures";

// Test data for the Planeswalker Alliance (v0.3.1). The roster's names are the public roster's;
// the starter decks and custom cards are made-up stand-ins, never the owner's own.

export const tiers: TierInfo[] = [
  { id: "bronze", name: "Bronze", wins: 0 },
  { id: "silver", name: "Silver", wins: 10 },
  { id: "gold", name: "Gold", wins: 100 },
  { id: "platinum", name: "Platinum", wins: 1000 },
  { id: "mythic", name: "Mythic", wins: 10000 },
  { id: "godlike", name: "Godlike", wins: 100000 },
];

/** An account's progress: 3 wins at Bronze, in no alliance, unless told otherwise. */
export function progress(fields: Partial<Progress> = {}): Progress {
  const wins = fields.wins ?? 3;
  const index = tiers.filter((tier) => wins >= tier.wins).length - 1;
  return {
    wins,
    counted_wins: wins,
    set_wins: 0,
    tier: tiers[index]!,
    next_tier: tiers[index + 1] ?? null,
    alliance: null,
    alliance_since: null,
    tiers,
    ...fields,
  };
}

export function planeswalker(
  id: string,
  name: string,
  tier: TierInfo,
  open: boolean,
  fields: Partial<Planeswalker> = {},
): Planeswalker {
  return {
    id,
    name,
    tier: tier.id,
    wins: tier.wins,
    open,
    portrait: true,
    description: `${name}, painted for the tests.`,
    first_card: null,
    cards: 2,
    playable_cards: 2,
    custom: false,
    ...fields,
  };
}

/** A Bronze account's roster: two open at Bronze, the rest locked. */
export const roster: Planeswalker[] = [
  planeswalker("abian", "Abian", tiers[0]!, true, {
    cards: 0,
    playable_cards: 0,
  }),
  planeswalker("rowan", "Rowan", tiers[0]!, true),
  planeswalker("kaya", "Kaya", tiers[1]!, false, { playable_cards: 1 }),
  planeswalker("jace", "Jace", tiers[4]!, false),
  planeswalker("the-sphinx", "The Sphinx", tiers[5]!, false, {
    cards: 0,
    playable_cards: 0,
    custom: true,
  }),
];

export function starterDeck(
  name: string,
  title: string,
  fields: Partial<StarterDeck> = {},
): StarterDeck {
  return {
    name,
    title,
    format: "commander",
    card_count: 100,
    commanders: [`${title} Leader`],
    playable: false,
    colors: "WU",
    color_names: "White / Blue",
    guild: "Azorius",
    description: `${title} plays a stand-in game.`,
    how_to_play: `Play ${title} with care.`,
    teaches: "Stand-in lessons.",
    commander_card_id: `card-${name}`,
    commander_printing_id: `printing-${name}`,
    chosen: false,
    ...fields,
  };
}

export const starterDecks: StarterDeck[] = [
  starterDeck("starter_one", "Stand-in Skies"),
  starterDeck("starter_two", "Stand-in Graves", {
    colors: "UB",
    color_names: "Blue / Black",
    guild: "Dimir",
  }),
  starterDeck("starter_three", "Stand-in Embers", {
    colors: "BR",
    color_names: "Black / Red",
    guild: "Rakdos",
    commander_printing_id: null,
  }),
];

/** A made-up custom card: never one of the owner's. */
export function customCard(name: string, fields: Partial<CustomCard> = {}) {
  const id = `custom-${name.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  const card: CustomCard = {
    id,
    name,
    planeswalker: "the-sphinx",
    mana_cost: "{1}{U}",
    type_line: "Artifact — Stand-in",
    oracle_text: "A stand-in for the tests.",
    flavor_text: null,
    power: null,
    toughness: null,
    loyalty: null,
    rarity: "mythic",
    set_code: "tst",
    collector_number: "1",
    artist: null,
    image_url: `/api/v1/custom-cards/${id}/image?v=1`,
    playable: false,
    loaded: false,
    in_library: false,
    card: customSummary(name, {
      status: "not_implemented",
      status_reason: "not_loaded",
      playable: false,
    }),
    ...fields,
  };
  return card;
}

/** A Planeswalker's own cards, as GET /planeswalkers/{id}/cards answers (v0.6.2): Rowan and
 * Kaya have two stand-ins each, Abian none, and The Sphinx's are custom, so none are listed. */
export function planeswalkerCards(id: string): AllianceCards {
  const found = roster.find((item) => item.id === id);
  const names: Record<string, string[]> = {
    rowan: ["Rowan, Stand-in Duelist", "Rowan, Stand-in Scion"],
    kaya: ["Kaya, Stand-in Ghost", "Kaya, Stand-in Spirit"],
  };
  return {
    alliance: id,
    name: found?.name ?? id,
    custom: found?.custom ?? false,
    cards: (names[id] ?? []).map((name, index) =>
      cardSummary(name, {
        type_line: "Legendary Planeswalker — Stand-in",
        image: { printing_id: `printing-${id}-${index}`, faces: 0 },
        owned: 0,
      }),
    ),
  };
}
