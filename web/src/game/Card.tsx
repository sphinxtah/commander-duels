import { useEffect, useRef, useState } from "react";
import type { Located } from "./model";
import { manaSymbols, manaWords } from "./model";
import type { CardView, PermanentView } from "./types";
import styles from "./game.module.css";

// Card faces: the printed image from our own server's cache (Scryfall's, fetched once), drawn
// over a text frame built from the engine's view. The frame is always underneath, so a missing
// or slow image never hides the rules text or blocks a choice (UI03). Images are never cropped,
// covered or altered; the current state sits in a strip below the card.

const missing = new Set<string>();

export function cardImageUrl(name: string, size: "normal" | "large"): string {
  return `/api/v1/card-images?name=${encodeURIComponent(name)}&size=${size}`;
}

export function ManaCost({ cost }: { cost: string | null }) {
  const symbols = manaSymbols(cost);
  if (symbols.length === 0) return null;
  return (
    <span className={styles.mana} aria-label={manaWords(cost)} role="img">
      {symbols.map((symbol, index) => (
        <span
          key={index}
          data-symbol={symbol.replace("/", "")}
          aria-hidden="true"
        >
          {symbol.replace("/P", "ᴾ").replace("/", "")}
        </span>
      ))}
    </span>
  );
}

function TextFrame({ card }: { card: CardView }) {
  return (
    <div className={styles.frame} aria-hidden="true">
      <div className={styles.frameName}>
        <span>{card.name}</span>
        <ManaCost cost={card.mana_cost} />
      </div>
      <div className={styles.frameType}>{card.type_line}</div>
      <div className={styles.frameRules}>
        {card.rules.map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </div>
      {card.power !== null && (
        <div className={styles.framePt}>
          {card.power}/{card.toughness}
        </div>
      )}
    </div>
  );
}

export function CardFace({
  card,
  size = "normal",
}: {
  card: CardView;
  size?: "normal" | "large";
}) {
  if (card.hidden || !card.name)
    return (
      <div className={styles.cardBack} aria-hidden="true">
        <img src="/brand/mark.webp" alt="" />
      </div>
    );
  // A new name is a new image: remount rather than reset, so a cached image that loads at once
  // is never marked loading again afterwards.
  return (
    <Face
      key={`${card.name}/${size}`}
      card={card}
      name={card.name}
      size={size}
    />
  );
}

function Face({
  card,
  name,
  size,
}: {
  card: CardView;
  name: string;
  size: "normal" | "large";
}) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">(() =>
    missing.has(name) ? "failed" : "loading",
  );
  return (
    <div className={styles.face} data-image={state}>
      <TextFrame card={card} />
      {state !== "failed" && (
        <img
          src={cardImageUrl(name, size)}
          alt=""
          decoding="async"
          draggable={false}
          ref={(image) => {
            // An image already in the browser's cache may be complete before React listens.
            if (
              image?.complete &&
              image.naturalWidth > 0 &&
              state === "loading"
            )
              setState("loaded");
          }}
          onLoad={() => setState("loaded")}
          onError={() => {
            missing.add(name);
            setState("failed");
          }}
        />
      )}
    </div>
  );
}

/** The permanent's current state in words, for the strip and for screen readers. */
export function permanentState(permanent: PermanentView | undefined): string[] {
  if (!permanent) return [];
  const parts: string[] = [];
  if (permanent.tapped) parts.push("Tapped");
  if (permanent.attacking) parts.push("Attacking");
  if (permanent.blocking) parts.push("Blocking");
  if (permanent.summoning_sick) parts.push("Summoning sick");
  if (permanent.damage > 0) parts.push(`${permanent.damage} damage`);
  for (const [counter, count] of Object.entries(permanent.counters))
    parts.push(`${count} ${counter.replace(/_/g, " ")}`);
  return parts;
}

export function cardLabel(card: CardView, located?: Located): string {
  if (card.hidden || !card.name) return "A face-down card";
  const parts = [card.name];
  if (card.type_line) parts.push(card.type_line);
  if (card.power !== null) parts.push(`${card.power}/${card.toughness}`);
  parts.push(...permanentState(located?.permanent));
  return parts.join(", ");
}

interface ImageInfo {
  artist: string | null;
  status: string;
}

/** Card zoom (UI04): the large image beside every current characteristic and the credits. */
export function CardZoom({
  card,
  located,
  onClose,
}: {
  card: CardView | null;
  located?: Located;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<ImageInfo | null>(null);
  useEffect(() => {
    if (card) dialog.current?.showModal();
    else dialog.current?.close();
  }, [card]);
  useEffect(() => {
    setInfo(null);
    if (!card?.name || card.hidden) return;
    const controller = new AbortController();
    fetch(`/api/v1/card-images/info?name=${encodeURIComponent(card.name)}`, {
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: ImageInfo | null) => setInfo(body))
      .catch(() => undefined);
    return () => controller.abort();
  }, [card]);
  const state = permanentState(located?.permanent);
  return (
    <dialog
      ref={dialog}
      className={styles.zoom}
      onClose={onClose}
      aria-labelledby="zoom-title"
    >
      {card && (
        <>
          <button
            className={styles.zoomClose}
            aria-label="Close card details"
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
          <div className={styles.zoomCard}>
            <CardFace card={card} size="large" />
          </div>
          <div className={styles.zoomText}>
            <h2 id="zoom-title">
              {card.hidden ? "A face-down card" : card.name}{" "}
              <ManaCost cost={card.mana_cost} />
            </h2>
            {!card.hidden && (
              <>
                <p className={styles.zoomType}>{card.type_line}</p>
                {card.rules.map((line, index) => (
                  <p key={index}>{line}</p>
                ))}
                {card.power !== null && (
                  <p className={styles.zoomPt}>
                    Power and toughness now: {card.power}/{card.toughness}
                  </p>
                )}
              </>
            )}
            {state.length > 0 && (
              <ul className={styles.zoomState}>
                {state.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
            {info?.status === "found" && (
              <p className={styles.credit}>
                {info.artist ? `Illustrated by ${info.artist}. ` : ""}Card image
                from Scryfall. Magic: The Gathering © Wizards of the Coast.
              </p>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
