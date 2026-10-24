import styles from "./foilGlow.module.css";

// The foil glow (v0.6.0): the class a card picture takes when its copy is known to be foil or
// etched, everywhere outside games (the library, card details and the enlarged picture, the
// auction house, opening packs). The game table never uses it: decks ignore the finish.

export type CardFinish = "nonfoil" | "foil" | "etched";

/** The glow's class for a finish; undefined for nonfoil or an unknown finish. */
export function foilGlow(
  finish: string | null | undefined,
): string | undefined {
  if (finish === "foil") return styles.glow;
  if (finish === "etched") return `${styles.glow} ${styles.etched}`;
  return undefined;
}

/** The finish a library edition glows in: foil if it holds a foil copy, else etched if it holds
 * an etched one; nonfoil otherwise. */
export function heldFinish(
  finishes: Partial<Record<CardFinish, number>> | null | undefined,
): CardFinish {
  if (finishes?.foil) return "foil";
  if (finishes?.etched) return "etched";
  return "nonfoil";
}
