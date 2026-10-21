import type { Planeswalker, TierId } from "../api";

// The Planeswalker Alliance (v0.3.1). Six tiers by wins, each opening more Planeswalkers to ally
// with; the alliance's portrait is the player's picture, and its Planeswalker cards join the
// player's library while it lasts.

/** The tiers in order, as the API names them (api/roster.py). */
export const tierOrder: TierId[] = [
  "bronze",
  "silver",
  "gold",
  "platinum",
  "mythic",
  "godlike",
];
export const tierNames: Record<TierId, string> = {
  bronze: "Bronze",
  silver: "Silver",
  gold: "Gold",
  platinum: "Platinum",
  mythic: "Mythic",
  godlike: "Godlike",
};

/** The portraits' web sizes, written by the portrait script into public/portraits. */
export const portraitSizes = [128, 256, 512] as const;
export type PortraitSize = (typeof portraitSizes)[number];

export function portraitUrl(id: string, size: PortraitSize): string {
  return `/portraits/${encodeURIComponent(id)}-${size}.webp`;
}

/** "1 win", "1,000 wins". */
export function wins(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "win" : "wins"}`;
}

/** What an alliance with the Planeswalker brings that a game can be played with. */
export function playableWords(planeswalker: Planeswalker): string {
  const count = planeswalker.playable_cards;
  if (count === 0) return "No cards playable here yet";
  return `${count} ${count === 1 ? "card" : "cards"} playable here`;
}

/** The roster, grouped by tier in tier order; within a tier, the API's order. */
export function byTier(
  roster: Planeswalker[],
): { tier: TierId; planeswalkers: Planeswalker[] }[] {
  return tierOrder
    .map((tier) => ({
      tier,
      planeswalkers: roster.filter((found) => found.tier === tier),
    }))
    .filter((group) => group.planeswalkers.length > 0);
}
