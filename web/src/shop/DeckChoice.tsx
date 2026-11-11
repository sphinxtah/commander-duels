import { useState, type CSSProperties } from "react";
import shell from "../App.module.css";
import { printingImage } from "../catalog/catalog";
import { RetryingImage } from "../game/RetryingImage";
import type { DeckOffer } from "./shop";
import styles from "./shop.module.css";

// A pack that is a deck (v0.9.8, the owner's request): once its cards are revealed, the summary
// asks whether to keep them together as a deck or as individual cards. They are in the library
// either way. A Starter Deck or a Tournament Pack is saved as a Legacy deck; one of Leng's ten
// starter decks is built into a Commander deck.

export type SavedDeck = { id: string; title: string };

export type DeckChoice = {
  /** The format of the deck the cards may be kept as. */
  format: "legacy" | "commander";
  /** The deck already made from them. */
  saved: SavedDeck | null;
  /** Makes the deck: answers with it, or with what went wrong. */
  save: () => Promise<SavedDeck | string>;
  /** How the deck can still be made later, said once the cards are kept loose. */
  later: string;
};

const formats = { legacy: "Legacy", commander: "Commander" };

export function DeckChoicePanel({ choice }: { choice: DeckChoice }) {
  const [saved, setSaved] = useState(choice.saved);
  const [loose, setLoose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const format = formats[choice.format];
  const commander = choice.format === "commander";
  const make = commander
    ? "Build it into a Commander deck"
    : `Save as a ${format} deck`;

  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const made = await choice.save();
      if (typeof made === "string") setError(made);
      else setSaved(made);
    } catch {
      setError("That did not go through. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.deckChoice} aria-labelledby="deck-choice-title">
      <h3 id="deck-choice-title">
        {saved
          ? `Kept together as a ${format} deck`
          : loose
            ? "Kept as individual cards"
            : "Keep this deck together?"}
      </h3>
      {saved ? (
        <p role="status">
          {commander ? "Built" : "Saved"} as “{saved.title}”, among your decks.{" "}
          <a href={`#deck/${saved.id}`}>Open the deck</a>
        </p>
      ) : loose ? (
        <p role="status">
          The cards are in your library, and no deck was made. {choice.later}
        </p>
      ) : (
        <p>
          Its cards are in your library either way.{" "}
          {commander
            ? "Build them into a Commander deck to play it as it came"
            : `Save them as a ${format} deck to play it as it came`}
          , or keep them as individual cards for decks of your own.
        </p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {!saved && (
        <div className={styles.actions}>
          <button
            type="button"
            className={loose ? styles.secondary : shell.primary}
            disabled={busy}
            onClick={() => void save()}
          >
            {busy ? "Making the deck…" : loose ? `${make} after all` : make}
          </button>
          {!loose && (
            <button
              type="button"
              className={styles.secondary}
              disabled={busy}
              onClick={() => setLoose(true)}
            >
              Keep as individual cards
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** A starter deck's box (v0.9.8): its commander's card over a fanned deck, torn open as a pack. */
export function StarterBox({ deck }: { deck: DeckOffer }) {
  const frame = <span className={styles.deckBoxName}>{deck.commander}</span>;
  return (
    <span className={styles.deckBox}>
      {[0, 1, 2].map((card) => (
        <span
          key={card}
          className={styles.deckBoxCard}
          style={{ "--card": card } as CSSProperties}
        />
      ))}
      <span className={styles.deckBoxFace}>
        {deck.commander_printing_id ? (
          <RetryingImage
            src={printingImage(deck.commander_printing_id)}
            width={244}
            height={340}
            fallback={frame}
          />
        ) : (
          frame
        )}
      </span>
    </span>
  );
}
