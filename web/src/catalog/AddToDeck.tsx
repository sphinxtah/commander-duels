import { useEffect, useRef, useState, type FormEvent } from "react";
import { client, describe } from "../api";
import type { components } from "../generated/api";
import shell from "../App.module.css";
import styles from "./catalog.module.css";

/**
 * "Add to deck" from My library (v0.8.8, the owner's request of 2026-10-24): copies of one edition
 * put into one of the player's decks, chosen in a pop-up. The deck's draft is read, the copies
 * added to its entry for that card and edition in the place chosen (or a new entry), and the
 * draft saved with the version it was read at; a draft changed meanwhile (another tab) is read
 * again once and the copies added to it. The deck's own checks say whether it is still playable.
 */
export type AddRequest = {
  cardId: string;
  printingId: string;
  name: string;
  /** Copies the library holds of this edition: the most worth adding. */
  copies: number | null;
  /** The card can lead a Commander deck. */
  commander: boolean;
};

type DeckChoice = {
  id: string;
  title: string;
  format: string;
  card_count: number;
};
type Place = "main" | "sideboard" | "commander" | "maybeboard";
const formatNames: Record<string, string> = {
  commander: "Commander",
  legacy: "Legacy",
};
const placeNames: Record<Place, string> = {
  main: "Main deck",
  sideboard: "Sideboard",
  commander: "Command zone",
  maybeboard: "Maybeboard",
};

function placesFor(format: string, commander: boolean): Place[] {
  if (format === "commander")
    return commander
      ? ["main", "commander", "maybeboard"]
      : ["main", "maybeboard"];
  return ["main", "sideboard", "maybeboard"];
}

type Entry = components["schemas"]["DeckEntry"];

/** Adds the copies to the draft's entries: to the entry of the same card, edition and place. */
export function withCopies(
  entries: Entry[],
  add: { cardId: string; printingId: string; quantity: number; place: Place },
): Entry[] {
  const found = entries.findIndex(
    (entry) =>
      entry.card_id === add.cardId &&
      (entry.printing_id ?? null) === add.printingId &&
      (entry.location ?? "main") === add.place,
  );
  if (found >= 0)
    return entries.map((entry, index) =>
      index === found
        ? { ...entry, quantity: entry.quantity + add.quantity }
        : entry,
    );
  return [
    ...entries,
    {
      card_id: add.cardId,
      printing_id: add.printingId,
      quantity: add.quantity,
      location: add.place,
    },
  ];
}

export function AddToDeck({
  request,
  onClose,
  onAdded,
}: {
  request: AddRequest | null;
  onClose: () => void;
  onAdded: (words: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [decks, setDecks] = useState<DeckChoice[]>();
  const [deck, setDeck] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [place, setPlace] = useState<Place>("main");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (request && !dialog.current?.open) dialog.current?.showModal?.();
    if (!request && dialog.current?.open) dialog.current.close();
  }, [request]);
  useEffect(() => {
    if (!request) return;
    let active = true;
    setError("");
    setQuantity("1");
    setPlace("main");
    setDecks(undefined);
    void client
      .GET("/api/v1/decks")
      .then(({ data, error: failure }) => {
        if (!active) return;
        if (!data) return setError(describe(failure));
        const usable = data
          .filter((found) => !found.archived && !found.deleted_at)
          .filter((found) => found.format in formatNames)
          .map((found) => ({
            id: found.id,
            title: found.title,
            format: found.format,
            card_count: found.card_count,
          }));
        setDecks(usable);
        setDeck((current) =>
          usable.some((found) => found.id === current)
            ? current
            : (usable[0]?.id ?? ""),
        );
      })
      .catch(() => {
        if (active) setError(describe(undefined));
      });
    return () => {
      active = false;
    };
  }, [request]);
  const chosen = decks?.find((found) => found.id === deck);
  const places = chosen
    ? placesFor(chosen.format, request?.commander ?? false)
    : [];
  const shownPlace = places.includes(place) ? place : "main";

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!request || !chosen || busy) return;
    const count = Number(quantity);
    if (!Number.isInteger(count) || count < 1 || count > 99)
      return setError("Add 1 to 99 copies at a time.");
    setBusy(true);
    setError("");
    try {
      // Read, add, save; once more if another tab saved the draft in between.
      for (let attempt = 0; attempt < 2; attempt++) {
        const { data: found, error: unread } = await client.GET(
          "/api/v1/decks/{deck_id}",
          { params: { path: { deck_id: chosen.id } } },
        );
        if (!found) return setError(describe(unread));
        const entries = withCopies(found.draft.entries, {
          cardId: request.cardId,
          printingId: request.printingId,
          quantity: count,
          place: shownPlace,
        });
        const {
          data: saved,
          error: refused,
          response,
        } = await client.PUT("/api/v1/decks/{deck_id}/draft", {
          params: { path: { deck_id: chosen.id } },
          body: { version: found.draft.version, entries },
        });
        if (saved) {
          const cards = saved.entries
            .filter((entry) => entry.location !== "maybeboard")
            .reduce((sum, entry) => sum + entry.quantity, 0);
          const state = saved.validation.playable
            ? "It is ready to play."
            : "Open it in Decks to see what it still needs before it plays.";
          onAdded(
            `${count} × ${request.name} added to ${chosen.title} (${placeNames[shownPlace].toLowerCase()}), now ${cards} cards. ${state}`,
          );
          dialog.current?.close();
          return;
        }
        if (response.status !== 409 || attempt === 1)
          return setError(describe(refused));
      }
    } catch {
      setError(describe(undefined));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className={styles.addDialog}
      aria-labelledby="add-to-deck-title"
      onClose={onClose}
    >
      {request && (
        <form onSubmit={add}>
          <h2 id="add-to-deck-title">Add {request.name} to a deck</h2>
          {!decks && !error && <p role="status">Opening your decks…</p>}
          {decks && decks.length === 0 && (
            <p className={styles.note}>
              You have no decks yet: make one in <a href="#decks">Decks</a>.
            </p>
          )}
          {decks && decks.length > 0 && (
            <>
              <label className={styles.addField}>
                <span>Deck</span>
                <select
                  value={deck}
                  onChange={(event) => setDeck(event.target.value)}
                >
                  {decks.map((found) => (
                    <option key={found.id} value={found.id}>
                      {found.title} — {formatNames[found.format]},{" "}
                      {found.card_count} cards
                    </option>
                  ))}
                </select>
              </label>
              <div className={styles.addRow}>
                <label className={styles.addField}>
                  <span>Copies</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={99}
                    step={1}
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                    required
                  />
                </label>
                <label className={styles.addField}>
                  <span>Where</span>
                  <select
                    value={shownPlace}
                    onChange={(event) => setPlace(event.target.value as Place)}
                  >
                    {places.map((found) => (
                      <option key={found} value={found}>
                        {placeNames[found]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {request.copies !== null && (
                <p className={styles.note}>
                  Your library holds {request.copies}{" "}
                  {request.copies === 1 ? "copy" : "copies"} of this edition;
                  each deck may use all of them.
                </p>
              )}
            </>
          )}
          {error && (
            <p role="alert" className={styles.refusal}>
              {error}
            </p>
          )}
          <div className={styles.addActions}>
            {decks && decks.length > 0 && (
              <button
                type="submit"
                className={shell.primary}
                aria-disabled={busy}
              >
                Add to deck
              </button>
            )}
            <button
              type="button"
              className={styles.secondary}
              onClick={() => dialog.current?.close()}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
