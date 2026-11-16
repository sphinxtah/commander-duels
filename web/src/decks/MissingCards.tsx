import { useCallback, useEffect, useState } from "react";
import { client, describe } from "../api";
import type { DeckDetail, DeckEntry } from "./decks";
import type { Draft } from "./DeckWorkshop";
import {
  swapped,
  type Missing,
  type MissingCard,
  type Substitutions,
} from "./workshop";
import styles from "./decks.module.css";

// What a deck lacks (v1.0.0, the deck workshop): the cards its player's library does not hold
// enough of, each with a wish, where it might be had (the auctions open for it, the shop's packs
// that may hold it), and the cards the library does hold that could take its place, each with
// why. Choosing a substitute swaps it into the draft at once, with an undo (the owner's decision
// 29): only the draft changes, never a saved version or a game's record.

/** A swap just made, kept so that it can be taken back. */
type Swap = {
  words: string;
  /** The draft's entries as they were before it. */
  before: DeckEntry[];
};

export function MissingCards({
  deck,
  draft,
  onDraft,
  onStale,
}: {
  deck: DeckDetail;
  draft: Draft;
  /** The draft as the server saved it after a swap or its undo. */
  onDraft: (draft: Draft) => void;
  /** The deck changed somewhere else: the page reads it again. */
  onStale: () => void;
}) {
  const [missing, setMissing] = useState<Missing>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [swap, setSwap] = useState<Swap | null>(null);
  const [note, setNote] = useState("");
  // The card whose substitutes are open, and what the library offers for it.
  const [open, setOpen] = useState<string | null>(null);
  const [offered, setOffered] = useState<Substitutions | null>(null);

  const load = useCallback(async () => {
    const { data, error: failure } = await client
      .GET("/api/v1/decks/{deck_id}/missing", {
        params: { path: { deck_id: deck.id } },
      })
      .catch(() => ({ data: undefined, error: undefined }));
    if (data) {
      setMissing(data);
      setError("");
    } else setError(describe(failure));
  }, [deck.id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function wish(card: MissingCard, wanted: boolean) {
    setBusy(true);
    setError("");
    const path = { params: { path: { card_id: card.card.id } } };
    const { error: failure } = await (
      wanted
        ? client.PUT("/api/v1/me/wishlist/{card_id}", {
            ...path,
            body: { quantity: card.missing, deck_id: deck.id },
          })
        : client.DELETE("/api/v1/me/wishlist/{card_id}", path)
    ).catch(() => ({ error: undefined, data: undefined }));
    setBusy(false);
    if (failure) setError(describe(failure));
    await load();
  }

  async function substitutes(card: MissingCard) {
    if (open === card.card.id) return setOpen(null);
    setOpen(card.card.id);
    setOffered(null);
    const { data, error: failure } = await client
      .GET("/api/v1/decks/{deck_id}/substitutions", {
        params: {
          path: { deck_id: deck.id },
          query: { card_id: card.card.id },
        },
      })
      .catch(() => ({ data: undefined, error: undefined }));
    if (data) setOffered(data);
    else {
      setOpen(null);
      setError(describe(failure));
    }
  }

  /** Saves the draft with these entries; true when the server took it. */
  async function saveDraft(entries: DeckEntry[]): Promise<boolean> {
    setBusy(true);
    setError("");
    const {
      data,
      error: failure,
      response,
    } = await client
      .PUT("/api/v1/decks/{deck_id}/draft", {
        params: { path: { deck_id: deck.id } },
        body: { version: draft.version, entries },
      })
      .catch(() => ({
        data: undefined,
        error: undefined,
        response: undefined,
      }));
    setBusy(false);
    if (!data) {
      if (response?.status === 409) {
        setError(
          "This deck changed somewhere else since this page opened, so nothing was swapped. It has been read again: try once more.",
        );
        onStale();
      } else setError(describe(failure));
      return false;
    }
    onDraft({ version: data.version, entries: data.entries });
    return true;
  }

  async function swapIn(
    card: MissingCard,
    with_: Substitutions["substitutes"][number],
  ) {
    const copies = Math.min(card.missing, with_.spare);
    const result = swapped(draft.entries, card.card.id, with_.card.id, copies);
    if (result.swapped === 0) return;
    if (!(await saveDraft(result.entries))) return;
    setSwap({
      words: `Swapped ${result.swapped} × ${card.card.name} for ${with_.card.name} in the draft.`,
      before: draft.entries,
    });
    setNote("");
    setOpen(null);
    await load();
  }

  async function undo() {
    if (!swap) return;
    if (!(await saveDraft(swap.before))) return;
    setSwap(null);
    setNote("The swap is undone: the draft is as it was.");
    await load();
  }

  if (!missing)
    return error ? (
      <p role="alert" className={styles.refusal}>
        {error}
      </p>
    ) : (
      <p role="status">Looking through your library…</p>
    );

  return (
    <>
      {swap && (
        <p role="status" className={styles.swapNote}>
          {swap.words} No saved version changed.{" "}
          <button
            type="button"
            className={styles.secondary}
            disabled={busy}
            onClick={() => void undo()}
          >
            Undo the swap
          </button>
        </p>
      )}
      {note && (
        <p role="status" className={styles.message}>
          {note}
        </p>
      )}
      {error && (
        <p role="alert" className={styles.refusal}>
          {error}
        </p>
      )}
      {missing.complete ? (
        <p className={styles.hint}>
          Your library holds every card of this deck&apos;s draft. Nothing is
          missing.
        </p>
      ) : (
        <>
          <p className={styles.diffLine}>
            The draft lacks {missing.missing}{" "}
            {missing.missing === 1 ? "copy" : "copies"} across{" "}
            {missing.cards.length}{" "}
            {missing.cards.length === 1 ? "card" : "cards"}. Until your library
            holds them, or other cards take their place, the deck cannot start a
            game.
          </p>
          <ul className={styles.missingList} aria-label="Missing cards">
            {missing.cards.map((card) => (
              <li key={card.card.id}>
                <div className={styles.missingHead}>
                  <strong>{card.card.name}</strong>
                  <span className={styles.deckMeta}>
                    The deck plays {card.needed}, you own {card.owned}:{" "}
                    {card.missing} missing
                  </span>
                </div>
                <p className={styles.where}>
                  {card.wished > 0 ? `On your wishlist (${card.wished}). ` : ""}
                  {card.auctions > 0 ? (
                    <a href="#auctions/search">
                      {card.auctions} open{" "}
                      {card.auctions === 1 ? "auction" : "auctions"} at
                      Tivit&apos;s
                    </a>
                  ) : (
                    "No auction is open for it"
                  )}
                  {" · "}
                  {card.packs.length > 0 ? (
                    <>
                      May be in <a href="#shop">Leng&apos;s packs</a>:{" "}
                      {card.packs.map((pack) => pack.name).join(", ")}
                    </>
                  ) : (
                    "In none of Leng's packs"
                  )}
                </p>
                <div className={styles.rowActions}>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={busy}
                    aria-label={
                      card.wished > 0
                        ? `Take ${card.card.name} off your wishlist`
                        : `Wish for ${card.missing} × ${card.card.name}`
                    }
                    onClick={() => void wish(card, card.wished === 0)}
                  >
                    {card.wished > 0
                      ? "Take off the wishlist"
                      : `Wish for ${card.missing}`}
                  </button>
                  <button
                    type="button"
                    className={styles.secondary}
                    aria-expanded={open === card.card.id}
                    aria-label={`Substitutes you own for ${card.card.name}`}
                    onClick={() => void substitutes(card)}
                  >
                    Substitutes you own
                  </button>
                </div>
                {open === card.card.id && (
                  <SubstituteList
                    card={card}
                    offered={offered}
                    busy={busy}
                    onSwap={(with_) => void swapIn(card, with_)}
                  />
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className={styles.hint}>
        Your wishlist is under <a href="#cards">Cards</a>, Wishlist. The
        maybeboard is not played, and not counted here.
      </p>
    </>
  );
}

/** The cards the library holds that could take a missing card's place, each with why. */
function SubstituteList({
  card,
  offered,
  busy,
  onSwap,
}: {
  card: MissingCard;
  offered: Substitutions | null;
  busy: boolean;
  onSwap: (with_: Substitutions["substitutes"][number]) => void;
}) {
  if (!offered) return <p role="status">Looking for cards like it…</p>;
  if (offered.substitutes.length === 0)
    return (
      <p className={styles.hint} role="status">
        {offered.note ??
          "No card your library holds could take its place in this deck."}
      </p>
    );
  return (
    <div className={styles.substitutes}>
      <p className={styles.hint}>
        Cards you own that could take its place: the game plays each as written,
        it is legal in this deck, and you hold a copy the deck does not use. How
        alike is a rough measure of what the two share, not of how strong either
        is.
      </p>
      <ul aria-label={`Substitutes for ${card.card.name}`}>
        {offered.substitutes.map((with_) => {
          const copies = Math.min(card.missing, with_.spare);
          return (
            <li key={with_.card.id}>
              <div>
                <strong>{with_.card.name}</strong>
                <span className={styles.deckMeta}>
                  {with_.card.type_line} · {with_.spare} to spare · alike{" "}
                  {with_.score} of 100
                </span>
                <ul className={styles.reasons}>
                  {with_.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
              <button
                type="button"
                className={styles.primary}
                disabled={busy || copies === 0}
                aria-label={`Swap ${copies} × ${card.card.name} for ${with_.card.name} in the draft`}
                onClick={() => onSwap(with_)}
              >
                Swap in {copies}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
