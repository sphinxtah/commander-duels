import { useEffect, useState, type RefObject } from "react";
import { client, describe } from "../api";
import { ManaCost } from "../game/Card";
import { formatLabels } from "../catalog/catalog";
import { ProblemList } from "./ProblemList";
import {
  locationNames,
  locationsFor,
  type SharedDeck as Shared,
} from "./decks";
import styles from "./decks.module.css";

/** A deck someone shared by link: its cards and validation, never its owner's notes (DECK11). */
export function SharedDeck({
  code,
  heading,
}: {
  code: string;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const [deck, setDeck] = useState<Shared>();
  const [missing, setMissing] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    void client
      .GET("/api/v1/shared-decks/{code}", { params: { path: { code } } })
      .then(({ data, response }) => {
        if (data) setDeck(data);
        else setMissing(response.status === 404 || response.status === 422);
      });
  }, [code]);
  async function copy() {
    const { data, error } = await client.POST(
      "/api/v1/shared-decks/{code}/copy",
      { params: { path: { code } } },
    );
    if (data) window.location.hash = `#deck/${data.id}`;
    else setMessage(describe(error));
  }
  if (missing)
    return (
      <>
        <h1 ref={heading} tabIndex={-1}>
          This link no longer opens a deck.
        </h1>
        <p className={styles.lead}>
          Its owner stopped sharing it, or deleted it.
        </p>
      </>
    );
  if (!deck) return <p role="status">Opening the shared deck…</p>;
  return (
    <>
      <span className={styles.eyebrow}>
        SHARED {formatLabels[deck.format].toUpperCase()} DECK · BY{" "}
        {deck.owner.toUpperCase()}
      </span>
      <h1 ref={heading} tabIndex={-1}>
        {deck.title}
      </h1>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primary}
          onClick={() => void copy()}
        >
          Copy it to your decks
        </button>
        <a
          className={styles.secondary}
          href={`/api/v1/shared-decks/${code}/export?kind=text`}
          download
        >
          Export as text
        </a>
      </div>
      {message && (
        <p role="alert" className={styles.refusal}>
          {message}
        </p>
      )}
      <ProblemList validation={deck.validation} cards={deck.cards} />
      <div className={styles.sections}>
        {locationsFor(deck.format).map((location) => {
          const here = deck.entries.filter(
            (entry) => entry.location === location,
          );
          if (here.length === 0) return null;
          return (
            <section
              key={location}
              className={styles.section}
              aria-label={locationNames[location]}
            >
              <h2>
                {locationNames[location]}{" "}
                <small>
                  {here.reduce((sum, entry) => sum + entry.quantity, 0)}
                </small>
              </h2>
              <ul className={styles.entries}>
                {here.map((entry) => {
                  const card = deck.cards[entry.card_id];
                  return (
                    <li key={`${entry.card_id}|${entry.printing_id ?? ""}`}>
                      <span className={styles.count}>{entry.quantity}</span>
                      <span className={styles.entryName}>
                        {card?.name ?? "A card"}
                      </span>
                      {card && <ManaCost cost={card.mana_cost} />}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </>
  );
}
