import { useEffect, useRef, useState, type CSSProperties } from "react";
import { client, describe } from "../api";
import { portraitUrl } from "../game/table/portrait";
import { PackOpening } from "../shop/PackOpening";
import type { Opening } from "../shop/shop";
import type { components } from "../generated/api";
import styles from "./cutscene.module.css";

// Opening a warden's deck (v0.9.5, the owner's request): after a warden's first defeat, the deck
// they played tears open like a 100-card deck from Leng's shop, card by card, commons first and
// the commander last, the High Priest last of all for The Sphinx. The server gave the cards with
// the win; this only shows them, and may show them again.

export type WardenOpeningSummary =
  components["schemas"]["WardenOpeningSummary"];
export type WardenOpeningView = components["schemas"]["WardenOpeningView"];

export async function loadOpenings(): Promise<WardenOpeningSummary[]> {
  const { data } = await client.GET("/api/v1/campaign/openings");
  return data ?? [];
}

/** The opening as the shop's pack opening shows it: the warden's deck as its product. */
export function asOpening(view: WardenOpeningView): Opening {
  return {
    id: view.id,
    pack: view.id,
    product: {
      id: view.id,
      set_code: "",
      set_name: view.opponent_name,
      name: view.deck_title,
      kind: "starter",
      released: null,
      booster: "warden",
      era: "play",
      art: null,
      symbol: null,
    },
    collation_revision: 0,
    mtgjson_version: "",
    opened_at: view.opened_at ?? view.created_at,
    cards: view.pulled,
  };
}

/** The warden's deck box: their portrait over a fanned deck, as the spoils card draws it. */
export function DeckBox({ opponent }: { opponent: string }) {
  return (
    <span className={styles.deckBox} data-opening>
      {[0, 1, 2].map((card) => (
        <span
          key={card}
          className={styles.deckCard}
          style={{ "--card": card } as CSSProperties}
        />
      ))}
      <img
        className={styles.deckPortrait}
        src={portraitUrl(opponent, 256)}
        alt=""
        width={128}
        height={128}
      />
    </span>
  );
}

export function WardenOpening({
  id,
  onDone,
}: {
  id: string;
  onDone: () => void;
}) {
  const [view, setView] = useState<WardenOpeningView>();
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/campaign/openings/{opening_id}", {
        params: { path: { opening_id: id } },
      })
      .then(({ data, error: refused }) => {
        if (!active) return;
        if (!data) return setError(describe(refused));
        setView(data);
        // Opened from the first look: the deck no longer waits on the map.
        if (!data.opened_at)
          void client.POST("/api/v1/campaign/openings/{opening_id}/open", {
            params: { path: { opening_id: id } },
          });
      })
      .catch(() => active && setError(describe(undefined)));
    return () => {
      active = false;
    };
  }, [id]);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    }
    return () => {
      if (element?.open && typeof element.close === "function") element.close();
    };
  }, []);

  const commander = view?.pulled.find((card) => card.commander);
  return (
    <dialog
      ref={dialog}
      className={styles.openingDialog}
      aria-label={view ? `Open ${view.deck_title}` : "A warden's deck"}
      onCancel={(event) => {
        event.preventDefault();
        onDone();
      }}
    >
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={onDone}>
            Close
          </button>
        </p>
      )}
      {!view && !error && <p>Unsealing the deck…</p>}
      {view && (
        <PackOpening
          opening={asOpening(view)}
          onDone={onDone}
          startOpen={false}
          tutorial={false}
          doneLabel="Back to the campaign"
          noun="deck"
          art={<DeckBox opponent={view.opponent} />}
          summaryLine={`${view.pulled.length} cards, every one yours${
            commander ? `, led by ${commander.name}` : ""
          }. The deck waits among your decks.`}
        />
      )}
    </dialog>
  );
}
