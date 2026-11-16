import { useMemo, useState } from "react";
import type { DeckDetail } from "./decks";
import {
  bottom,
  deal,
  draw,
  HAND_SIZE,
  libraryOf,
  mulligan,
  sampleWords,
  type Sample,
} from "./sampleHand";
import styles from "./decks.module.css";

// The Workshop's sample hands (v1.0.0): a deck's opening hands, drawn here with no game. For
// any deck, a sandbox deck or not, from its draft as it stands.

export function SampleHand({
  deck,
  draft,
  random = Math.random,
}: {
  deck: DeckDetail;
  draft: DeckDetail["draft"];
  /** The shuffle's chance, a test's own. */
  random?: () => number;
}) {
  const library = useMemo(
    () => libraryOf(draft.entries, deck.cards),
    [draft.entries, deck.cards],
  );
  // The game's own rule: the first mulligan is free where three or more play.
  const [crowd, setCrowd] = useState(deck.format === "commander");
  const [sample, setSample] = useState<Sample>();
  const free = crowd ? 1 : 0;
  if (library.length < HAND_SIZE)
    return (
      <section aria-labelledby="sample-title">
        <h2 id="sample-title">Sample hands</h2>
        <p className={styles.hint}>
          The main deck holds {library.length}{" "}
          {library.length === 1 ? "card" : "cards"}: an opening hand is seven.
          Add cards in the editor first.
        </p>
      </section>
    );
  return (
    <section aria-labelledby="sample-title">
      <h2 id="sample-title">Sample hands</h2>
      <p className={styles.hint}>
        Opening hands from the {library.length} cards of the main deck as the
        draft stands, shuffled here: no game is started, and nothing is kept. A
        mulligan is the game's own: seven new cards, then one to the bottom for
        each mulligan taken.
      </p>
      {deck.format === "commander" && (
        <label className={styles.sandboxCheck}>
          <input
            type="checkbox"
            checked={crowd}
            onChange={(event) => setCrowd(event.target.checked)}
          />
          <span>Three or more players: the first mulligan is free</span>
        </label>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          onClick={() => setSample(deal(library, random))}
        >
          {sample ? "Draw a new hand" : "Draw a sample hand"}
        </button>
        {sample && (
          <>
            <button
              type="button"
              className={styles.secondary}
              disabled={sample.mulligans >= HAND_SIZE}
              onClick={() => setSample(mulligan(sample, library, free, random))}
            >
              Mulligan
            </button>
            <button
              type="button"
              className={styles.secondary}
              disabled={sample.owed > 0 || sample.library.length === 0}
              onClick={() => setSample(draw(sample))}
            >
              Draw a card
            </button>
          </>
        )}
      </div>
      {sample && (
        <>
          <p role="status" className={styles.sampleWords}>
            {sampleWords(sample)}
          </p>
          <ul className={styles.sampleHand} aria-label="The hand">
            {sample.hand.map((card) => (
              <li key={card.key}>
                <span>
                  <strong>{card.name}</strong>
                  <small>{card.typeLine}</small>
                </span>
                {sample.owed > 0 && (
                  <button
                    type="button"
                    className={styles.secondary}
                    aria-label={`To the bottom: ${card.name}`}
                    onClick={() => setSample(bottom(sample, card.key))}
                  >
                    To the bottom
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
