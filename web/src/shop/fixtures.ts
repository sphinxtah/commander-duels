import type { Me } from "../api";
import type { components } from "../generated/api";
import type {
  DeckOffer,
  EraInfo,
  Opening,
  OpeningSummary,
  Product,
  PulledCard,
  ShopView,
} from "./shop";

// Made-up shop data for the tests.

export const eras: EraInfo[] = [
  { id: "play", name: "Play Boosters", since: "2024-02-09" },
  { id: "collector", name: "Set and Collector Boosters", since: "2020-09-25" },
  { id: "frame15", name: "The M15 frame", since: "2014-07-18" },
  { id: "mythic", name: "Mythic rares", since: "2008-10-03" },
  { id: "modern", name: "The modern frame", since: "2003-07-28" },
  { id: "oldborder", name: "The old border", since: "1997-01-01" },
  { id: "first", name: "The first years", since: "1993-01-01" },
];

export function product(fields: Partial<Product> = {}): Product {
  return {
    id: "product-znr-draft",
    set_code: "ZNR",
    set_name: "Zendikar Rising",
    name: "Zendikar Rising Draft Booster",
    kind: "draft",
    released: "2020-09-25",
    booster: "draft",
    era: "collector",
    price: 380,
    price_basis: "market",
    pack_size: 15,
    ...fields,
  };
}

export const products: Product[] = [
  product({
    id: "product-fra-play",
    set_code: "FRA",
    set_name: "Reality Fracture",
    name: "Reality Fracture Play Booster",
    kind: "play",
    booster: "play",
    released: "2026-10-02",
    era: "play",
    price: 500,
    pack_size: 14,
  }),
  product(),
  product({
    id: "product-3ed",
    set_code: "3ED",
    set_name: "Revised Edition",
    name: "Revised Edition Booster Pack",
    kind: "booster",
    booster: "default",
    released: "1994-04-11",
    era: "first",
    price: 150_000,
  }),
];

export const shopView: ShopView = {
  balance: 1_000,
  products,
  eras,
  inventory: [
    {
      product: {
        id: "product-znr-draft",
        set_code: "ZNR",
        set_name: "Zendikar Rising",
        name: "Zendikar Rising Draft Booster",
        kind: "draft",
        released: "2020-09-25",
      },
      count: 2,
      next_pack: "pack-1",
      openable: true,
    },
  ],
  data: {
    mtgjson_version: "5.3.0+20261021",
    prices_as_of: "2026-10-21",
    checked_at: "2026-10-21T11:00:00Z",
  },
  decks: [],
  free_decks: false,
};

/** A starter deck on Leng's shelf (v0.4.2). */
export function deckOffer(
  id: string,
  fields: Partial<DeckOffer> = {},
): DeckOffer {
  return {
    id,
    title: `Stand-in ${id}`,
    commander: `${id} Leader`,
    colors: "WU",
    color_names: "White / Blue",
    guild: "Azorius",
    description: `Stand-in ${id} plays a stand-in game.`,
    commander_card_id: `card-${id}`,
    commander_printing_id: `printing-${id}`,
    price: 40_000,
    owned: false,
    ...fields,
  };
}

export function card(
  position: number,
  fields: Partial<PulledCard> = {},
): PulledCard {
  return {
    position,
    card_id: `card-${position}`,
    printing_id: `printing-${position}`,
    name: `Common Card ${position}`,
    mana_cost: "{1}{G}",
    type_line: "Creature — Elf",
    rarity: "common",
    set_code: "ZNR",
    collector_number: String(100 + position),
    finish: "nonfoil",
    sheet: "common",
    new: false,
    faces: 0,
    ...fields,
  };
}

export const opening: Opening = {
  id: "opening-1",
  pack: "pack-1",
  product: shopView.inventory[0].product,
  collation_revision: 1,
  mtgjson_version: "5.3.0+20261021",
  opened_at: "2026-10-21T12:00:00Z",
  cards: [
    card(0, { new: true }),
    card(1),
    card(2, { name: "Uncommon Card", rarity: "uncommon", sheet: "uncommon" }),
    card(3, {
      name: "Rare Card",
      rarity: "rare",
      sheet: "rareMythic",
      new: true,
    }),
    card(4, {
      name: "Mythic Card",
      rarity: "mythic",
      sheet: "rareMythic",
      new: true,
    }),
    card(5, { name: "Foil Card", finish: "foil", sheet: "foil" }),
  ],
};

export const history: OpeningSummary[] = [
  {
    id: "opening-0",
    product: shopView.inventory[0].product,
    opened_at: "2026-10-20T12:00:00Z",
    cards: 15,
    new_cards: 9,
    foils: 1,
    best: "mythic",
  },
];

export const player: Me = {
  id: "00000000-0000-4000-8000-000000000002",
  kind: "player",
  status: "active",
  onboarding: "complete",
  handle: "ada",
  display_name: "Ada",
  email: "ada@example.com",
  avatar: "sigil",
  locale: "en",
  alliance: null,
  csrf_token: "token",
  permissions: ["decks.edit", "games.play", "profile.edit"],
  roles: ["player"],
  preferences: { large_text: false, reduced_motion: false },
  session: {
    id: "session-2",
    kind: "google",
    authenticated_at: "2026-10-21T10:00:00Z",
    idle_expires_at: "2026-10-22T10:00:00Z",
    absolute_expires_at: "2026-10-30T10:00:00Z",
  },
};

type AdminProduct = components["schemas"]["AdminProduct"];

export function adminProduct(fields: Partial<AdminProduct> = {}): AdminProduct {
  return {
    ...product(),
    usd: 4.97,
    usd_method: "pack",
    usd_source: "https://www.tcgplayer.com/product/1",
    curve_price: 380,
    price_override: null,
    price_reason: null,
    on_sale: true,
    sale_reason: null,
    selling: true,
    origin: "price_list",
    data_status: "ready",
    unresolved_count: 0,
    unresolved: [],
    collation_revision: 1,
    mtgjson_version: "5.3.0+20261021",
    checked_at: "2026-10-21T11:00:00Z",
    changed_at: null,
    ...fields,
  };
}
