import { useEffect, useRef, useState } from "react";
import { client, describe } from "../api";
import game from "../game/game.module.css";
import type { components } from "../generated/api";
import { OpeningWindow } from "../shop/OpeningWindow";
import { PackOpening } from "../shop/PackOpening";
import styles from "./starterDecks.module.css";

// A starter deck bought at the table (v1.0.0, the owner's request; docs/tables.md): what the
// Play wizard, the form that opens a table and a table's own page share. Leng's offers for the
// table's format, each at his price (the week's sale price where it is on sale); the purchase,
// keyed so that a retry buys once; and the reveal of the cards, which can be skipped.

export type StarterOffers = components["schemas"]["StarterOffers"];
export type StarterOffer = components["schemas"]["StarterOffer"];
export type StarterBought = components["schemas"]["StarterBought"];
export type StarterFormat = StarterOffer["format"];
type Opening = components["schemas"]["Opening"];

/** The workflow's name behind its gate (api/rollout.py). */
export const STARTER_TABLES = "starter_tables";

export const tokens = (amount: number) =>
  `${amount.toLocaleString("en-US")} tokens`;

/** Whether a format has starter decks to buy at the table: Legacy and Commander. */
export function starterFormat(format: string): format is StarterFormat {
  return format === "legacy" || format === "commander";
}

/** A key for one purchase: a retry of the same request buys once. */
export function purchaseKey(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Leng's offers for the format, asked for while `wanted`; undefined until they arrive, and
 * again when the format changes. */
export function useStarterOffers(
  format: string,
  wanted: boolean,
): StarterOffers | undefined {
  const [found, setFound] = useState<StarterOffers>();
  useEffect(() => {
    setFound(undefined);
    if (!wanted || !starterFormat(format)) return;
    let active = true;
    void client
      .GET("/api/v1/starter-decks", { params: { query: { format } } })
      .then(({ data }) => {
        if (active && data) setFound(data);
      });
    return () => {
      active = false;
    };
  }, [format, wanted]);
  return found;
}

/** Buys the offer: the purchase, or what went wrong, in words. */
export async function buyStarter(
  offer: StarterOffer,
  key: string,
): Promise<StarterBought | string> {
  const answer = await client
    .POST("/api/v1/starter-decks/purchases", {
      body: { format: offer.format, offer: offer.id, key },
    })
    .catch(() => undefined);
  return answer?.data ?? describe(answer?.error);
}

/** The offers as a choice: the account's tokens, what it lacks for the cheapest, and each deck
 * with its price. One the account cannot afford is greyed, with the reason. */
export function StarterOfferFields({
  offers,
  format,
  chosen,
  onChoose,
  name,
}: {
  offers: StarterOffers | undefined;
  format: string;
  chosen: string;
  onChoose: (id: string) => void;
  /** Keeps two forms' radio groups apart. */
  name: string;
}) {
  if (!offers) return <p role="status">Asking Leng what he has…</p>;
  if (offers.offers.length === 0)
    return (
      <p className={styles.note}>
        Leng has no {format === "legacy" ? "Legacy" : "Commander"} starter deck
        on his shelf now.
      </p>
    );
  return (
    <>
      <p className={styles.note} data-balance>
        You have {tokens(offers.balance)}.
        {offers.short > 0 &&
          ` You need ${tokens(offers.short)} more to buy the cheapest deck on offer, so you cannot sit down yet.`}
      </p>
      <fieldset>
        <legend>Leng&apos;s starter decks, at his price</legend>
        {offers.offers.map((found) => (
          <label key={found.id} className={game.choice}>
            <input
              type="radio"
              name={name}
              checked={chosen === found.id}
              disabled={!found.affordable}
              onChange={() => onChoose(found.id)}
            />
            <span>
              <strong>
                {found.title} · {tokens(found.price)}
              </strong>
              <small>
                {found.detail}
                {found.on_sale &&
                  ` · this week's sale (${tokens(found.list_price)} otherwise)`}
                {found.owned && " · you own one: this buys another"}
                {!found.affordable && " · more than you have"}
              </small>
            </span>
          </label>
        ))}
      </fieldset>
    </>
  );
}

/** A Commander starter just bought, as the opening the reveal shows: the deck as its product. */
function boughtOpening(offer: StarterOffer, deal: StarterBought): Opening {
  return {
    id: `starter-${deal.id}`,
    pack: `starter-${deal.id}`,
    product: {
      id: offer.id,
      set_code: "",
      set_name: offer.detail,
      name: deal.title,
      kind: "starter",
      released: null,
      booster: "starter-deck",
      era: "play",
      art: null,
      symbol: null,
    },
    collation_revision: 0,
    mtgjson_version: "",
    opened_at: new Date().toISOString(),
    cards: deal.cards ?? [],
    deck: null,
  };
}

/** What the reveal shows of a purchase: a Legacy product's opening, asked for, or a Commander
 * starter's cards; undefined where there is nothing to show (a retry, or no answer). */
export async function revealOf(
  offer: StarterOffer,
  deal: StarterBought,
): Promise<Opening | undefined> {
  if (deal.opening_id) {
    const found = await client
      .GET("/api/v1/shop/openings/{opening_id}", {
        params: { path: { opening_id: deal.opening_id } },
      })
      .catch(() => undefined);
    return found?.data;
  }
  return (deal.cards ?? []).length > 0 ? boughtOpening(offer, deal) : undefined;
}

/**
 * The cards of a starter deck just bought, revealed as a pack is, in a window over the page. It
 * can be skipped (the owner's choice): the deck is bought either way, and at a table the seat is
 * ready already. `onDone` runs when the reveal ends, is skipped or is closed.
 */
export function StarterReveal({
  opening,
  title,
  doneLabel,
  onDone,
}: {
  opening: Opening;
  title: string;
  doneLabel: string;
  onDone: () => void;
}) {
  // The window closes once, however it was asked to.
  const done = useRef(false);
  const finish = () => {
    if (done.current) return;
    done.current = true;
    onDone();
  };
  return (
    <OpeningWindow label={`${title}: your deck`} onClose={finish}>
      <button type="button" className={styles.skip} onClick={finish}>
        Skip the reveal
      </button>
      <PackOpening
        key={opening.id}
        opening={opening}
        noun="deck"
        tutorial={false}
        doneLabel={doneLabel}
        onDone={finish}
      />
    </OpeningWindow>
  );
}
