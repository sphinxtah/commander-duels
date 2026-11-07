import type { components } from "../generated/api";

// Leng's card shop (v0.4.0): what the page shows of the API's products, and how it filters,
// sorts and groups them. Prices are tokens only; the API never sends a player a dollar price.

export type ShopView = components["schemas"]["ShopView"];
export type Product = components["schemas"]["ProductInfo"];
export type ProductRef = components["schemas"]["ProductRef"];
export type EraInfo = components["schemas"]["EraInfo"];
export type InventoryItem = components["schemas"]["InventoryItem"];
export type Opening = components["schemas"]["Opening"];
export type OpeningSummary = components["schemas"]["OpeningSummary"];
export type PulledCard = components["schemas"]["PulledCard"];
export type Purchase = components["schemas"]["Purchase"];
export type DeckOffer = components["schemas"]["DeckOffer"];
export type SaleInfo = components["schemas"]["SaleInfo"];
export type BoosterKind = Product["kind"];

export const kindLabels: Record<BoosterKind, string> = {
  booster: "Booster",
  draft: "Draft Booster",
  set: "Set Booster",
  collector: "Collector Booster",
  play: "Play Booster",
  jumpstart: "Jumpstart",
  theme: "Theme Booster",
  six: "Six-card Booster",
  starter: "Starter Deck",
  tournament: "Tournament Pack",
  special: "Special",
  lands: "Basic Land Pack",
};

export type Sort = "newest" | "oldest" | "cheapest" | "dearest";
export const sortLabels: Record<Sort, string> = {
  newest: "Newest first",
  oldest: "Oldest first",
  cheapest: "Price: low to high",
  dearest: "Price: high to low",
};

export type Filters = {
  q: string;
  year: string;
  kind: "" | BoosterKind;
  sort: Sort;
};
export const noFilters: Filters = { q: "", year: "", kind: "", sort: "newest" };

/** 1,234 tokens. */
export function tokens(amount: number): string {
  return `${amount.toLocaleString("en-US")} ${amount === 1 ? "token" : "tokens"}`;
}

export function yearOf(product: Pick<Product, "released">): number | null {
  return product.released ? Number(product.released.slice(0, 4)) : null;
}

/** The years the products were released in, newest first. */
export function yearsOf(products: Product[]): number[] {
  const years = new Set<number>();
  for (const product of products) {
    const year = yearOf(product);
    if (year !== null) years.add(year);
  }
  return [...years].sort((a, b) => b - a);
}

/** The kinds of product on sale, in the labels' order. */
export function kindsOf(products: Product[]): BoosterKind[] {
  const present = new Set(products.map((product) => product.kind));
  return (Object.keys(kindLabels) as BoosterKind[]).filter((kind) =>
    present.has(kind),
  );
}

/** Whether a product matches the search: its set's name or code, or its own name. */
export function matches(product: Product, q: string): boolean {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text =
    `${product.set_name} ${product.set_code} ${product.name}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

function released(product: Product): string {
  return product.released ?? "9999-12-31";
}

/** What a basic land pack holds (v0.6.4), for the shelf's line under its name. */
export function landsLine(product: Pick<Product, "booster">): string {
  return product.booster === "basic-lands"
    ? "40 of each basic land, from every edition since Alpha"
    : "40 lands, from every edition since Alpha";
}

/** What buying the product costs now: this week's sale price, or its own (v0.4.3). */
export function priceToPay(
  product: Pick<Product, "price" | "sale_price">,
): number {
  return product.sale_price ?? product.price;
}

function compare(a: Product, b: Product, sort: Sort): number {
  const byDate = released(a).localeCompare(released(b));
  const byName = a.name.localeCompare(b.name);
  switch (sort) {
    case "oldest":
      return byDate || byName;
    case "cheapest":
      return priceToPay(a) - priceToPay(b) || -byDate || byName;
    case "dearest":
      return priceToPay(b) - priceToPay(a) || -byDate || byName;
    default:
      return -byDate || byName;
  }
}

/** The products the filters let through, sorted. */
export function filtered(products: Product[], filters: Filters): Product[] {
  return products
    .filter(
      (product) =>
        matches(product, filters.q) &&
        (!filters.year || String(yearOf(product)) === filters.year) &&
        (!filters.kind || product.kind === filters.kind),
    )
    .sort((a, b) => compare(a, b, filters.sort));
}

/** The products grouped by era, the eras in the API's order (newest first) or, sorted oldest
 * first, the reverse. Sorted by price, they stay one list: grouping would hide the order. */
export function byEra(
  products: Product[],
  eras: EraInfo[],
  sort: Sort,
): { era: EraInfo | null; products: Product[] }[] {
  if (sort === "cheapest" || sort === "dearest")
    return products.length ? [{ era: null, products }] : [];
  const ordered = sort === "oldest" ? [...eras].reverse() : eras;
  return ordered
    .map((era) => ({
      era,
      products: products.filter((product) => product.era === era.id),
    }))
    .filter((group) => group.products.length > 0);
}

export const rarityLabels: Record<string, string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  mythic: "Mythic rare",
  special: "Special",
  bonus: "Bonus",
};

/** How a card is announced when it turns over. */
export function describeCard(card: PulledCard): string {
  const parts = [rarityLabels[card.rarity] ?? card.rarity, card.name];
  if (card.finish === "foil") parts.push("foil");
  if (card.finish === "etched") parts.push("etched foil");
  if (card.new) parts.push("new to your library");
  return parts.join(", ");
}

/** The rarity a card glows in, if any. */
export function glowOf(card: PulledCard): "rare" | "mythic" | null {
  if (card.rarity === "mythic") return "mythic";
  if (card.rarity === "rare" || card.rarity === "special") return "rare";
  return null;
}

/** A client key for one purchase: a retry of the same request reuses it, so it buys once. */
export function purchaseKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** One edition's share of a land in a basic land pack (v0.9.0). */
export interface EditionCount {
  set_code: string;
  set_name: string;
  released_at: string | null;
  count: number;
  foils: number;
}

/** A land's count in a basic land pack, by edition, newest first (v0.9.0). */
export interface LandCount {
  name: string;
  count: number;
  foils: number;
  editions: EditionCount[];
}

const LAND_ORDER = ["Plains", "Island", "Swamp", "Mountain", "Forest"];
/** How many of a land pack's oldest pulls the summary calls out. */
export const OLDEST_SHOWN = 5;

/**
 * A basic land pack's cards counted by land and edition (v0.9.0, the owner's view made for big
 * packs): the lands in WUBRG order, each edition newest first; and the oldest pulls, the
 * rarest by the packs' scale (each edition's chance is its rank by release), oldest first.
 */
export function landTally(cards: PulledCard[]): {
  lands: LandCount[];
  oldest: PulledCard[];
} {
  const lands = new Map<string, LandCount>();
  for (const card of cards) {
    const land = lands.get(card.name) ?? {
      name: card.name,
      count: 0,
      foils: 0,
      editions: [],
    };
    lands.set(card.name, land);
    const foil = card.finish !== "nonfoil" ? 1 : 0;
    land.count += 1;
    land.foils += foil;
    let edition = land.editions.find(
      (found) => found.set_code === card.set_code,
    );
    if (!edition) {
      edition = {
        set_code: card.set_code,
        set_name: card.set_name ?? card.set_code,
        released_at: card.released_at ?? null,
        count: 0,
        foils: 0,
      };
      land.editions.push(edition);
    }
    edition.count += 1;
    edition.foils += foil;
  }
  const released = (value: string | null | undefined) => value ?? "0000";
  for (const land of lands.values())
    land.editions.sort(
      (a, b) =>
        released(b.released_at).localeCompare(released(a.released_at)) ||
        a.set_name.localeCompare(b.set_name),
    );
  const rank = (name: string) => {
    const index = LAND_ORDER.indexOf(name);
    return index < 0 ? LAND_ORDER.length : index;
  };
  const oldest = cards
    .filter((card) => card.released_at)
    .sort(
      (a, b) =>
        released(a.released_at).localeCompare(released(b.released_at)) ||
        a.position - b.position,
    )
    .slice(0, OLDEST_SHOWN);
  return {
    lands: [...lands.values()].sort(
      (a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name),
    ),
    oldest,
  };
}
