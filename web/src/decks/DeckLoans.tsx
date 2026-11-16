import { useEffect, useRef, useState } from "react";
import { client, describe } from "../api";
import { formatLabels } from "../catalog/catalog";
import { useFriendList } from "../tables/InviteFriends";
import { locationNames, type DeckSummary, type Location } from "./decks";
import {
  givenWords,
  untilWords,
  type LentDeck,
  type Loan,
  type LoanBook,
} from "./loans";
import styles from "./decks.module.css";

// Friend deck lending on the Decks page (v1.0.0): "Lend" on a deck, which says what lending
// means before anything is sent; the loan on the deck's row, with "Take it back"; and "Decks
// lent to you", where a friend's deck is looked at, accepted, declined and given back.

/** What lending means, said before the offer is sent. */
function Means({ days }: { days: number }) {
  return (
    <ul className={styles.restoreMeans}>
      <li>
        Your friend sees the whole list, and once they accept plays it for{" "}
        {days} days.
      </li>
      <li>They play it only at a private table where you sit too.</li>
      <li>
        <strong>While they have it, you cannot play this deck yourself</strong>,
        as with a real deck handed over. An offer they have not answered keeps
        nothing from you.
      </li>
      <li>
        Take it back whenever you like; a game already started plays on with it.
      </li>
      <li>
        It is lent as it stands now. Your later changes are not lent, and
        nothing changes hands: the cards stay in your library.
      </li>
    </ul>
  );
}

/** Lends a deck: a friend chosen, and what that means. */
export function LendDialog({
  deck,
  book,
  onClose,
  onLent,
}: {
  deck: DeckSummary;
  book: LoanBook;
  onClose: () => void;
  /** The friend the deck was offered to. */
  onLent: (handle: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { friends, error } = useFriendList();
  const [friend, setFriend] = useState("");
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal?.();
  }, []);
  const chosen = friends?.find((found) => found.id === friend);
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="lend-title"
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!chosen) return;
          void book.offer(deck.id, chosen.id).then((offered) => {
            if (!offered) return;
            onLent(chosen.handle);
            dialog.current?.close();
          });
        }}
      >
        <h2 id="lend-title">Lend {deck.title} to a friend</h2>
        <Means days={book.loans?.days ?? 7} />
        {error ? (
          <p role="alert" className={styles.refusal}>
            {error}
          </p>
        ) : friends === null ? (
          <p role="status">Finding your friends…</p>
        ) : friends.length === 0 ? (
          <p className={styles.hint}>
            A deck is lent to a friend, and you have none yet. Find players
            under <a href="#friends">Friends</a>.
          </p>
        ) : (
          <fieldset className={styles.formats}>
            <legend>Lend it to</legend>
            {friends.map((found) => (
              <label key={found.id}>
                <input
                  type="radio"
                  name="lend-friend"
                  checked={friend === found.id}
                  onChange={() => setFriend(found.id)}
                />
                <span>
                  <strong>{found.handle}</strong>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {book.error && (
          <p role="alert" className={styles.refusal}>
            {book.error}
          </p>
        )}
        <div className={styles.actions}>
          <button
            type="submit"
            className={styles.primary}
            disabled={!chosen || book.busy}
          >
            {chosen ? `Offer it to ${chosen.handle}` : "Offer it"}
          </button>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => dialog.current?.close()}
          >
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** A deck's open loan on its row, with the way to end it. A row's button is named by what it
 * says, then the deck: its name begins with the words on it. */
export function LoanLine({ loan, book }: { loan: Loan; book: LoanBook }) {
  const words =
    loan.state === "accepted" ? "Take it back" : "Withdraw the offer";
  return (
    <span className={styles.loanLine} data-state={loan.state}>
      <span>{givenWords(loan)}</span>
      <button
        type="button"
        className={styles.secondary}
        disabled={book.busy}
        aria-label={`${words}: ${loan.deck.title}`}
        onClick={() => book.end(loan.id)}
      >
        {words}
      </button>
    </span>
  );
}

/** The decks friends offered or lent to the account. */
export function BorrowedDecks({ book }: { book: LoanBook }) {
  const [looking, setLooking] = useState<Loan | null>(null);
  const taken = book.loans?.taken ?? [];
  if (taken.length === 0) return null;
  return (
    <>
      <section className={styles.starters} aria-labelledby="borrowed-title">
        <h2 id="borrowed-title">Decks lent to you</h2>
        <p className={styles.hint}>
          A friend&apos;s deck to play without owning its cards, for{" "}
          {book.loans?.days ?? 7} days once you accept. It is played only at a
          private table where that friend sits too: choose it as your deck
          there. Nothing changes hands, and you cannot change or copy it.
        </p>
        {book.error && (
          <p role="alert" className={styles.refusal}>
            {book.error}
          </p>
        )}
        <ul>
          {taken.map((loan) => (
            <li key={loan.id}>
              <div>
                <strong className={styles.deckTitle}>{loan.deck.title}</strong>
                <span className={styles.deckMeta}>
                  {formatLabels[loan.deck.format]} · {loan.deck.card_count}{" "}
                  cards
                  {loan.deck.commanders.length > 0 &&
                    ` · ${loan.deck.commanders.join(" & ")}`}{" "}
                  · from {loan.lender.handle}
                </span>
                <span className={styles.loanLine} data-state={loan.state}>
                  {loan.state === "accepted"
                    ? `Yours to play until ${untilWords(loan.until)}.`
                    : `${loan.lender.handle} offers it to you. Look at it, then accept or decline.`}
                </span>
              </div>
              <div className={styles.rowActions}>
                <button
                  type="button"
                  className={styles.secondary}
                  aria-label={`Look at it: ${loan.deck.title}`}
                  onClick={() => setLooking(loan)}
                >
                  Look at it
                </button>
                {loan.state === "offered" ? (
                  <>
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={book.busy}
                      aria-label={`Accept: ${loan.deck.title}`}
                      onClick={() => book.accept(loan.id)}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={book.busy}
                      aria-label={`Decline: ${loan.deck.title}`}
                      onClick={() => book.decline(loan.id)}
                    >
                      Decline
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={book.busy}
                    aria-label={`Give it back: ${loan.deck.title}`}
                    onClick={() => book.end(loan.id)}
                  >
                    Give it back
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
      {/* Beside the section, not in it: its rows' frames are not the list's. */}
      {looking && (
        <LentDeckDialog loan={looking} onClose={() => setLooking(null)} />
      )}
    </>
  );
}

/** A lent deck's list, for its borrower: the version the loan is of. */
function LentDeckDialog({
  loan,
  onClose,
}: {
  loan: Loan;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [deck, setDeck] = useState<LentDeck>();
  const [error, setError] = useState("");
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal?.();
    let active = true;
    void client
      .GET("/api/v1/loans/{loan_id}/deck", {
        params: { path: { loan_id: loan.id } },
      })
      .catch(() => ({ data: undefined, error: undefined }))
      .then(({ data, error: failure }) => {
        if (!active) return;
        if (data) setDeck(data);
        else setError(describe(failure));
      });
    return () => {
      active = false;
    };
  }, [loan.id]);
  const places = deck
    ? [...new Set(deck.entries.map((entry) => entry.location))]
    : [];
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="lent-deck-title"
      onClose={onClose}
    >
      <h2 id="lent-deck-title">
        {loan.deck.title}, from {loan.lender.handle}
      </h2>
      <p className={styles.hint}>
        Version {loan.deck.version}, as it was lent: this is the deck you play,
        whatever its owner changes afterwards.
      </p>
      {error && (
        <p role="alert" className={styles.refusal}>
          {error}
        </p>
      )}
      {!deck && !error && <p role="status">Opening the list…</p>}
      {places.map((place) => (
        <section key={place} aria-label={locationNames[place as Location]}>
          <h3 className={styles.lentPlace}>
            {locationNames[place as Location] ?? place}
          </h3>
          <ul className={styles.lentList}>
            {deck!.entries
              .filter((entry) => entry.location === place)
              .map((entry) => (
                <li key={`${entry.card_id}-${entry.printing_id ?? ""}`}>
                  {entry.quantity} ×{" "}
                  {deck!.cards[entry.card_id]?.name ?? "A card"}
                </li>
              ))}
          </ul>
        </section>
      ))}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.secondary}
          autoFocus
          onClick={() => dialog.current?.close()}
        >
          Close
        </button>
      </div>
    </dialog>
  );
}
