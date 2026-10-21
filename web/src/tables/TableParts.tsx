import { Portrait } from "../alliance/Portrait";
import type { OwnDeck } from "./tables";
import styles from "./tables.module.css";

/** A player's face at a table: their alliance's portrait, or their handle's first letter. */
export function Face({
  handle,
  portrait,
  size = 28,
}: {
  handle: string | null;
  portrait: string | null;
  size?: number;
}) {
  if (portrait)
    return <Portrait id={portrait} size={size} thumbnail decorative />;
  return (
    <span
      className={styles.sigil}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {(handle ?? "?").charAt(0).toUpperCase()}
    </span>
  );
}

/** The deck choices of one format: playable decks, and the others greyed with the reason. */
export function DeckChoices({ decks }: { decks: OwnDeck[] }) {
  return (
    <>
      {decks.map((deck) => (
        <option key={deck.id} value={deck.id} disabled={!deck.playable}>
          {deck.title}
          {deck.playable
            ? ""
            : deck.collection_locked
              ? " (needs cards you don't own)"
              : " (not playable yet)"}
        </option>
      ))}
    </>
  );
}
