import { manaSymbols } from "../model";
import type { CardView } from "../types";
import type { ManaColour } from "./types";

// What makes a moment notable enough for a special effect (v0.7.0). The thresholds are shared by
// the events (which mark a cast as big), the sound (which rings a bigger bell for it) and the
// effects layer, so the three never disagree about what counts.

/** A spell whose mana value is at least this gets the arcane burst and the bell chord. */
export const BIG_SPELL_MANA_VALUE = 6;
/** A creature whose power is at least this shakes the ground as it enters. */
export const BIG_CREATURE_POWER = 5;
/** Life lost in one blow that counts as heavy: a shock ring, the deeper thud, and your own screen
 * edges flaring red. */
export const HEAVY_LOSS = 5;
/** Life gained at once that glitters. */
export const BIG_GAIN = 5;

/** The mana value of a cost such as "{3}{R}{R}": generic numbers count their number, every other
 * symbol one, X and the like nothing. A missing cost is 0. */
export function manaValue(cost: string | null): number {
  let total = 0;
  for (const symbol of manaSymbols(cost)) {
    if (/^\d+$/.test(symbol)) total += Number(symbol);
    else if (/^[WUBRGCS](\/[WUBRGCP])*$/.test(symbol)) total += 1;
    else if (/^\d+\/[WUBRG]$/.test(symbol))
      total += Number(symbol.split("/")[0]);
    // X, Y, Z, T, Q and anything else add nothing.
  }
  return total;
}

export function isBigSpell(card: CardView): boolean {
  return manaValue(card.mana_cost) >= BIG_SPELL_MANA_VALUE;
}

/** A printed power, or null for a "*" or a card without one. */
export function powerOf(card: CardView): number | null {
  const power = card.power === null ? NaN : Number(card.power);
  return Number.isFinite(power) ? power : null;
}

export function isBigCreature(card: CardView): boolean {
  const power = powerOf(card);
  return power !== null && power >= BIG_CREATURE_POWER;
}

/** The colours in a mana cost, in WUBRG order, each once: the hue of a spell's burst. */
export function manaColours(cost: string | null): ManaColour[] {
  const found = new Set<string>();
  for (const symbol of manaSymbols(cost))
    for (const part of symbol.split("/"))
      if (part.length === 1 && "WUBRG".includes(part)) found.add(part);
  return (["W", "U", "B", "R", "G"] as const).filter((c) => found.has(c));
}
