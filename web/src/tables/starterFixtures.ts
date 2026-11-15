import type {
  StarterBought,
  StarterOffer,
  StarterOffers,
} from "./starterDecks";

// What Leng offers and sells at a starter-deck table (v1.0.0), for the tests of the pages that
// show it: the Play wizard, the form that opens a table and a table's own page.

export function offer(fields: Partial<StarterOffer> = {}): StarterOffer {
  return {
    id: "starter_red",
    format: "commander",
    title: "Red Test",
    detail: "Kenrith, the Returned King · Five colours",
    price: 500,
    list_price: 500,
    on_sale: false,
    affordable: true,
    owned: false,
    commander_printing_id: null,
    product: null,
    ...fields,
  };
}

export function offersOf(fields: Partial<StarterOffers> = {}): StarterOffers {
  return {
    format: "commander",
    balance: 600,
    short: 0,
    offers: [
      offer(),
      offer({
        id: "starter_blue",
        title: "Blue Test",
        detail: "Thrasios, Triton Hero · Green and blue",
        price: 250,
        list_price: 250,
        owned: true,
      }),
      offer({
        id: "starter_karlach",
        title: "Karlach Test",
        price: 1500,
        list_price: 1500,
        affordable: false,
      }),
    ],
    ...fields,
  };
}

export function boughtDeck(fields: Partial<StarterBought> = {}): StarterBought {
  return {
    id: "00000000-0000-4000-8000-00000000b001",
    format: "commander",
    offer: "starter_red",
    title: "Red Test",
    deck_id: "00000000-0000-4000-8000-00000000d001",
    tokens: 500,
    sale: false,
    balance: 100,
    opening_id: null,
    cards: [],
    repeated: false,
    ...fields,
  };
}
