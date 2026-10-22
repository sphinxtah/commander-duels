import { useEffect, useRef, useState } from "react";
import { client, describe } from "../api";
import shell from "../App.module.css";
import { printingImage } from "../catalog/catalog";
import { tokens, type DeckOffer } from "./shop";
import styles from "./shop.module.css";

/**
 * Leng's starter decks (v0.4.2): the ten Commander starter decks. The first two are free, chosen
 * in the setup wizard, which this tab opens while they are still to choose; after them, each of
 * the others sells once, at the value of its cards in tokens. A deck bought becomes a deck of the
 * player's own, and every card in it joins the library for good.
 */
export function DeckShelf({
  decks,
  free,
  balance,
  onSetup,
  onBought,
}: {
  decks: DeckOffer[];
  /** The account's two free decks are still to choose. */
  free: boolean;
  balance: number;
  onSetup: () => void;
  onBought: (message: string) => Promise<void>;
}) {
  const [buying, setBuying] = useState<DeckOffer | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Commanders whose picture did not arrive show their name in a frame instead.
  const [missing, setMissing] = useState<Set<string>>(new Set());
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (buying) dialog.current?.showModal?.();
  }, [buying]);

  async function confirm() {
    if (!buying || busy) return;
    setBusy(true);
    setError("");
    try {
      const { data, error: refused } = await client.POST("/api/v1/shop/decks", {
        body: { deck: buying.id },
      });
      if (!data) return setError(describe(refused));
      const title = buying.title;
      dialog.current?.close();
      setBuying(null);
      await onBought(
        `You bought ${title} for ${tokens(data.tokens)}. It is in your decks, and its cards in your library.`,
      );
    } catch {
      setError(describe(undefined));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.section} aria-labelledby="decks-title">
      <h2 id="decks-title">Starter decks</h2>
      {free ? (
        <div className={styles.freeDecks}>
          <p>
            Your first two starter decks are free: choose any two of these ten,
            and your welcome tokens stay yours for packs. The others are sold
            here once you have chosen.
          </p>
          <button type="button" className={shell.primary} onClick={onSetup}>
            Claim your two free decks
          </button>
        </div>
      ) : (
        <p className={styles.note}>
          Ten 100-card Commander decks, ready to play. Each sells once, priced
          by the market value of its cards; it becomes a deck of your own, and
          its cards join your library for good.
        </p>
      )}
      <ul className={styles.decks} aria-label="Starter decks">
        {decks.map((deck) => {
          const short = deck.price !== null ? deck.price - balance : 0;
          return (
            <li key={deck.id} className={styles.deck} aria-label={deck.title}>
              <span className={styles.deckArt}>
                {deck.commander_printing_id && !missing.has(deck.id) ? (
                  <img
                    src={printingImage(deck.commander_printing_id)}
                    alt=""
                    width={244}
                    height={340}
                    loading="lazy"
                    decoding="async"
                    onError={() =>
                      setMissing((current) => new Set(current).add(deck.id))
                    }
                  />
                ) : (
                  <span className={styles.deckFrame} aria-hidden="true">
                    {deck.commander}
                  </span>
                )}
              </span>
              <div className={styles.deckText}>
                <strong>{deck.title}</strong>
                <span className={styles.deckColors}>
                  {deck.color_names} · {deck.guild}
                </span>
                <span className={styles.note}>Commander: {deck.commander}</span>
                <p>{deck.description}</p>
                <div className={styles.price}>
                  {deck.owned ? (
                    <b>In your decks</b>
                  ) : free ? (
                    <b>Free</b>
                  ) : deck.price === null ? (
                    <b>Not for sale yet</b>
                  ) : (
                    <>
                      <b>{tokens(deck.price)}</b>
                      <button
                        type="button"
                        className={styles.secondary}
                        aria-disabled={short > 0}
                        title={
                          short > 0
                            ? `You need ${tokens(short)} more.`
                            : undefined
                        }
                        aria-label={`Buy ${deck.title}`}
                        onClick={() => {
                          if (short > 0) return;
                          setError("");
                          setBuying(deck);
                        }}
                      >
                        Buy
                      </button>
                    </>
                  )}
                </div>
                {!deck.owned && !free && short > 0 && (
                  <p className={styles.note}>You need {tokens(short)} more.</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-labelledby="buy-deck-title"
        onClose={() => setBuying(null)}
      >
        {buying && buying.price !== null && (
          <>
            <h2 id="buy-deck-title">Buy {buying.title}?</h2>
            <p>
              It costs {tokens(buying.price)}. You have {tokens(balance)}, and
              will have {tokens(balance - buying.price)} left. It becomes a deck
              of your own, and its cards join your library for good.
            </p>
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            <div className={styles.actions}>
              <button
                type="button"
                className={shell.primary}
                disabled={busy}
                onClick={() => void confirm()}
              >
                {error ? "Try again" : `Buy for ${tokens(buying.price)}`}
              </button>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => dialog.current?.close()}
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </dialog>
    </section>
  );
}
