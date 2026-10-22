import { useEffect, useState } from "react";
import { client, describe } from "../api";
import { CardTile } from "./CardViews";
import { GodlikeCards } from "./CustomCards";
import type { AllianceCards, CardSummary, CustomCard } from "./catalog";
import styles from "./catalog.module.css";

/** The allied Planeswalker's cards (v0.4.2), asked for once per visit to the Cards page. */
export function useAllianceCards(): {
  cards: AllianceCards | undefined;
  error: string;
} {
  const [cards, setCards] = useState<AllianceCards>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/me/alliance/cards")
      .then(({ data, error: refused }) => {
        if (!active) return;
        if (data) setCards(data);
        else setError(describe(refused));
      })
      .catch(() => {
        if (active) setError(describe(undefined));
      });
    return () => {
      active = false;
    };
  }, []);
  return { cards, error };
}

/** The alliance tab's name: the allied Planeswalker's, or the alliance's with none. */
export function allianceTabName(cards: AllianceCards | undefined): string {
  return cards?.name ? `${cards.name}'s cards` : "Alliance cards";
}

/**
 * The Cards page's alliance tab (v0.4.2): only the cards of the Planeswalker the account is
 * allied with, for every account, SysOp's too. They follow the alliance: another alliance, and
 * the tab shows that Planeswalker's. The Godlike tier's Planeswalker's are its custom cards, which
 * the server lists only while the account is allied with it.
 */
export function AllianceCardsView({
  cards,
  error,
  custom,
  onOpen,
}: {
  cards: AllianceCards | undefined;
  error: string;
  /** The allied Planeswalker's custom cards (GET /custom-cards). */
  custom: CustomCard[];
  onOpen: (card: CardSummary) => void;
}) {
  if (error)
    return (
      <p role="alert" className={styles.refusal}>
        {error}
      </p>
    );
  if (!cards) return <p role="status">Opening your alliance's cards…</p>;
  if (!cards.alliance)
    return (
      <section
        className={styles.library}
        aria-labelledby="alliance-cards-title"
      >
        <h2 id="alliance-cards-title">Alliance cards</h2>
        <p className={styles.lead}>
          You are in no alliance yet. Ally with a Planeswalker on{" "}
          <a href="#profile">your profile</a>, and their cards show here: a
          playset of each joins your library while the alliance lasts.
        </p>
      </section>
    );
  if (cards.custom)
    return custom.length ? (
      <GodlikeCards cards={custom} title={allianceTabName(cards)} />
    ) : (
      <section
        className={styles.library}
        aria-labelledby="alliance-cards-title"
      >
        <h2 id="alliance-cards-title">{allianceTabName(cards)}</h2>
        <p className={styles.lead}>No cards of theirs are here yet.</p>
      </section>
    );
  return (
    <section className={styles.library} aria-labelledby="alliance-cards-title">
      <h2 id="alliance-cards-title">{allianceTabName(cards)}</h2>
      <p className={styles.lead}>
        Your alliance with {cards.name} puts a playset (4) of each of their
        Planeswalker cards in your library while it lasts. Change it on{" "}
        <a href="#profile">your profile</a>.
      </p>
      <p role="status" className={styles.resultLine}>
        {`${cards.cards.length.toLocaleString()} ${cards.cards.length === 1 ? "card" : "cards"}`}
      </p>
      <ul className={styles.grid} aria-label={allianceTabName(cards)}>
        {cards.cards.map((card) => (
          <CardTile key={card.id} card={card} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}
