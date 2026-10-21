import { useEffect, useState } from "react";
import { client } from "../api";
import { ManaCost } from "../game/Card";
import type { CustomCard } from "./catalog";
import styles from "./catalog.module.css";

/**
 * The Godlike tier's custom cards (v0.3.1), for an account at that tier; none otherwise. Below it
 * the API answers as for a route that does not exist, and the page then shows nothing of them at
 * all: no tab, no hint that there is anything to reach. Nothing about them is in the page's own
 * code; it learns of them only from this answer.
 */
export function useCustomCards(): CustomCard[] {
  const [cards, setCards] = useState<CustomCard[]>([]);
  useEffect(() => {
    let active = true;
    // A failed request shows none, as below the tier.
    void client
      .GET("/api/v1/custom-cards")
      .then(({ data }) => {
        if (active && data) setCards(data);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return cards;
}

/** Whether the running game engine has loaded a custom card (v0.4.0): only then can a deck
 * holding it start a game. */
export function engineWords(card: CustomCard): string {
  if (card.loaded) return "Playable";
  return card.loaded === false
    ? "Not loaded by this engine"
    : "The game engine could not be asked";
}

/** The custom cards with their images, each saying whether the running game engine has loaded
 * it: a deck holding one it has not loaded cannot start a game. */
export function GodlikeCards({ cards }: { cards: CustomCard[] }) {
  return (
    <section className={styles.custom} aria-labelledby="godlike-title">
      <h2 id="godlike-title">Godlike cards</h2>
      <p className={styles.lead}>
        Custom cards that only the Godlike tier opens. Put them in your decks
        from the deck builder; a game plays them wherever the game engine has
        loaded them, and everyone at that table sees them.
      </p>
      <ul className={styles.customList}>
        {cards.map((card) => (
          <li key={card.id}>
            {/* The text beside the image says all it shows, so the image is not announced. */}
            <div className={styles.cardImage}>
              <img
                src={card.image_url}
                alt=""
                loading="lazy"
                decoding="async"
              />
            </div>
            <div className={styles.customText}>
              <h3 className={styles.detailName}>
                {card.name} <ManaCost cost={card.mana_cost} />
              </h3>
              <p className={styles.detailType}>{card.type_line}</p>
              <div className={styles.oracle}>
                {card.oracle_text.split("\n").map((line, index) => (
                  <p key={index}>{line}</p>
                ))}
                {card.flavor_text && (
                  <p className={styles.flavor}>{card.flavor_text}</p>
                )}
                {card.power !== null && (
                  <p className={styles.pt}>
                    {card.power}/{card.toughness}
                  </p>
                )}
                {card.loyalty && (
                  <p className={styles.pt}>Loyalty {card.loyalty}</p>
                )}
              </div>
              <p className={styles.customState}>
                <span
                  className={styles.status}
                  data-playable={card.playable ? "true" : "false"}
                >
                  {engineWords(card)}
                </span>{" "}
                {card.in_library
                  ? "In your library."
                  : "Not in your library: an alliance with their Planeswalker adds them."}
              </p>
              {card.artist && (
                <p className={styles.credit}>Illustrated by {card.artist}.</p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
