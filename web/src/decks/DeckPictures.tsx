import { CardImage, StatusBadge } from "../catalog/CardViews";
import type { CardSummary } from "../catalog/catalog";
import { LockIcon } from "./ProblemList";
import { entryKey, type DeckEntry, type Location } from "./decks";
import styles from "./decks.module.css";

/**
 * A group of a deck's cards as their pictures (v0.6.2, the owner's request: the deck editor's
 * default view). Each entry is its edition's picture with its copies counted on it; a click on the
 * picture opens the card as a click on its name in the list does, and the copies change below it.
 * A card held back by the library keeps its lock, and one the game cannot play its badge.
 */
export function DeckPictures({
  label,
  location,
  entries,
  cards,
  highlight,
  edition,
  lock,
  onUpdate,
  onOpen,
}: {
  label: string;
  location: Location;
  /** The group's entries, in the order shown. */
  entries: DeckEntry[];
  cards: Record<string, CardSummary>;
  highlight: Set<string>;
  /** The edition an entry names, in words. */
  edition: (entry: DeckEntry, card: CardSummary) => string | null;
  /** Why the library holds an entry back, in a few words; null when it does not. */
  lock: (entry: DeckEntry, card: CardSummary) => string | null;
  onUpdate: (entry: DeckEntry, patch: Partial<DeckEntry>) => void;
  onOpen: (card: CardSummary, entry: DeckEntry) => void;
}) {
  const single = location === "commander" || location === "companion";
  return (
    <ul className={styles.pictures} aria-label={label}>
      {entries.map((entry) => {
        const card = cards[entry.card_id];
        const name = card?.name ?? "card";
        const from = card ? edition(entry, card) : null;
        const locked = card ? lock(entry, card) : null;
        return (
          <li
            key={entryKey(entry)}
            id={`entry-${entry.card_id}`}
            className={styles.picture}
            data-highlight={highlight.has(entry.card_id)}
            data-playable={card?.playable ?? false}
            data-locked={locked ? true : undefined}
          >
            <button
              type="button"
              className={styles.pictureButton}
              aria-label={`${card?.name ?? "Loading…"}${from ? ` · ${from}` : ""}, ${entry.quantity} ${entry.quantity === 1 ? "copy" : "copies"}`}
              onClick={() => card && onOpen(card, entry)}
            >
              {card ? (
                <CardImage card={card} printingId={entry.printing_id} />
              ) : (
                <span className={styles.pictureLoading}>Loading…</span>
              )}
              {entry.quantity > 1 && (
                <span className={styles.pictureCount} aria-hidden="true">
                  ×{entry.quantity}
                </span>
              )}
            </button>
            {card && (
              <span className={styles.pictureName} title={card.name}>
                {card.name}
              </span>
            )}
            <div className={styles.pictureFoot}>
              <div className={styles.quantity}>
                <button
                  type="button"
                  aria-label={`One fewer ${name}`}
                  onClick={() =>
                    onUpdate(entry, { quantity: entry.quantity - 1 })
                  }
                >
                  −
                </button>
                <span aria-label={`${entry.quantity} copies`}>
                  {entry.quantity}
                </span>
                <button
                  type="button"
                  aria-label={`One more ${name}`}
                  disabled={single}
                  onClick={() =>
                    onUpdate(entry, { quantity: entry.quantity + 1 })
                  }
                >
                  +
                </button>
              </div>
              <button
                type="button"
                className={styles.remove}
                aria-label={`Remove ${card?.name ?? "the card"}`}
                onClick={() => onUpdate(entry, { quantity: 0 })}
              >
                ×
              </button>
            </div>
            {card && !card.playable && <StatusBadge card={card} />}
            {locked && (
              <span className={styles.lockNote}>
                <LockIcon />
                {locked}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
