import { useCallback, useEffect, useState } from "react";
import { client, describe } from "../api";
import type { components } from "../generated/api";
import type { CardSummary } from "./catalog";
import styles from "./catalog.module.css";

// The wishlist (v1.0.0, the deck workshop; the owner's decision 27: a view inside Cards, beside
// My library). The cards an account wants, each with how many, how many its library holds and
// the deck it is wanted for when one was named. A card is wished for from its details here or
// from a deck's missing cards (decks/MissingCards.tsx). A wish buys nothing and promises
// nothing: it is the account's own list.

export type Wishlist = components["schemas"]["Wishlist"];
export type Wish = components["schemas"]["Wish"];

/** The most copies of a card a wish asks for (api/workshop.py). */
const MOST = 250;

export interface Wishes {
  /** null until the list arrived. */
  wishlist: Wishlist | null;
  error: string;
  busy: boolean;
  /** Wishes for so many copies of a card, for a deck when one is named. */
  wish: (cardId: string, quantity: number, deckId?: string | null) => void;
  unwish: (cardId: string) => void;
}

export function useWishlist(): Wishes {
  const [wishlist, setWishlist] = useState<Wishlist | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/me/wishlist")
      .catch(() => ({ data: undefined }))
      .then(({ data }) => {
        if (active && data) setWishlist(data);
      });
    return () => {
      active = false;
    };
  }, []);
  const send = useCallback(
    async (
      request: Promise<{ data?: Wishlist; error?: unknown }>,
    ): Promise<void> => {
      setBusy(true);
      setError("");
      const { data, error: failure } = await request.catch(() => ({
        data: undefined,
        error: undefined,
      }));
      setBusy(false);
      if (data) setWishlist(data);
      else setError(describe(failure));
    },
    [],
  );
  const wish = useCallback(
    (cardId: string, quantity: number, deckId?: string | null) =>
      void send(
        client.PUT("/api/v1/me/wishlist/{card_id}", {
          params: { path: { card_id: cardId } },
          body: { quantity, ...(deckId ? { deck_id: deckId } : {}) },
        }),
      ),
    [send],
  );
  const unwish = useCallback(
    (cardId: string) =>
      void send(
        client.DELETE("/api/v1/me/wishlist/{card_id}", {
          params: { path: { card_id: cardId } },
        }),
      ),
    [send],
  );
  return { wishlist, error, busy, wish, unwish };
}

/** A card's own wish, if it has one. */
export function wishOf(wishes: Wishes, cardId: string): Wish | undefined {
  return wishes.wishlist?.wishes.find((wish) => wish.card.id === cardId);
}

/** In a card's details: put it on the wishlist, or take it off. */
export function WishButton({
  cardId,
  wishes,
}: {
  cardId: string;
  wishes: Wishes;
}) {
  if (!wishes.wishlist) return null;
  const mine = wishOf(wishes, cardId);
  return (
    <div className={styles.wishAction}>
      {mine && (
        <span role="status">
          On your wishlist: {mine.quantity}{" "}
          {mine.quantity === 1 ? "copy" : "copies"}.
        </span>
      )}
      <button
        type="button"
        className={styles.secondary}
        disabled={wishes.busy}
        onClick={() => (mine ? wishes.unwish(cardId) : wishes.wish(cardId, 1))}
      >
        {mine ? "Take it off your wishlist" : "Add to your wishlist"}
      </button>
      {wishes.error && (
        <span role="alert" className={styles.refusal}>
          {wishes.error}
        </span>
      )}
    </div>
  );
}

/** The decks' names, for the wishes that were made for one. */
function useDeckTitles(needed: boolean): Record<string, string> {
  const [titles, setTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!needed) return;
    let active = true;
    void client
      .GET("/api/v1/decks", { params: { query: { view: "active" } } })
      .catch(() => ({ data: undefined }))
      .then(({ data }) => {
        if (active && data)
          setTitles(
            Object.fromEntries(data.map((deck) => [deck.id, deck.title])),
          );
      });
    return () => {
      active = false;
    };
  }, [needed]);
  return titles;
}

/** The Wishlist view of the Cards page. */
export function WishlistView({
  wishes,
  onOpen,
}: {
  wishes: Wishes;
  onOpen: (card: CardSummary) => void;
}) {
  const list = wishes.wishlist?.wishes ?? [];
  const titles = useDeckTitles(list.some((wish) => wish.deck_id));
  if (!wishes.wishlist)
    return wishes.error ? (
      <p role="alert" className={styles.refusal}>
        {wishes.error}
      </p>
    ) : (
      <p role="status">Reading your wishlist…</p>
    );
  const copies = list.reduce((sum, wish) => sum + wish.quantity, 0);
  return (
    <section aria-labelledby="wishlist-title">
      <h2 id="wishlist-title" className={styles.wishTitle}>
        Your wishlist
      </h2>
      <p className={styles.wishLead}>
        The cards you want, with how many your library holds. A wish buys
        nothing: it is your own list, to keep track of what a deck still needs.
        Add a card from its details under All cards, or from a deck&apos;s
        Workshop, Missing cards.
      </p>
      {wishes.error && (
        <p role="alert" className={styles.refusal}>
          {wishes.error}
        </p>
      )}
      {list.length === 0 ? (
        <p className={styles.wishLead}>Nothing is on your wishlist yet.</p>
      ) : (
        <>
          <p role="status" className={styles.resultLine}>
            {list.length} {list.length === 1 ? "card" : "cards"}, {copies}{" "}
            {copies === 1 ? "copy" : "copies"} wanted
          </p>
          <div className={styles.libraryScroll}>
            <table className={styles.libraryTable} aria-label="Your wishlist">
              <thead>
                <tr>
                  <th scope="col">Card</th>
                  <th scope="col">Wanted</th>
                  <th scope="col">In your library</th>
                  <th scope="col">For</th>
                  <th scope="col">
                    <span className={styles.visuallyHidden}>Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((wish) => (
                  <tr key={wish.card.id}>
                    <th scope="row">
                      <button
                        type="button"
                        className={styles.cardLink}
                        onClick={() => onOpen(wish.card)}
                      >
                        {wish.card.name}
                      </button>
                    </th>
                    <td>
                      <input
                        type="number"
                        className={styles.wishCount}
                        aria-label={`Copies of ${wish.card.name} wanted`}
                        min={1}
                        max={MOST}
                        defaultValue={wish.quantity}
                        key={wish.quantity}
                        disabled={wishes.busy}
                        onBlur={(event) => {
                          const wanted = Math.min(
                            MOST,
                            Math.max(1, Math.round(Number(event.target.value))),
                          );
                          if (
                            Number.isFinite(wanted) &&
                            wanted !== wish.quantity
                          )
                            wishes.wish(wish.card.id, wanted, wish.deck_id);
                          else event.target.value = String(wish.quantity);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                    </td>
                    <td>
                      {wish.owned === null || wish.owned === undefined
                        ? "Any number"
                        : wish.owned || "None"}
                    </td>
                    <td>
                      {wish.deck_id ? (
                        <a
                          className={styles.cardLink}
                          href={`#deck/${wish.deck_id}/workshop`}
                        >
                          {titles[wish.deck_id] ?? "A deck"}
                        </a>
                      ) : (
                        "–"
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className={styles.secondary}
                        disabled={wishes.busy}
                        aria-label={`Take ${wish.card.name} off your wishlist`}
                        onClick={() => wishes.unwish(wish.card.id)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
