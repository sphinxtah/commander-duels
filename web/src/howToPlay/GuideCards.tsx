import { useId, useLayoutEffect, useRef, useState } from "react";
import { CARDS, type CardKey, type CardPart, type Callout } from "./guide";
import { RichText } from "./RichText";
import styles from "./HowToPlay.module.css";

/**
 * The guide's example cards: the printed image from the API's Scryfall cache, which serves these
 * names to anyone (GET /api/v1/how-to-play/card-images, the guide's cards only), drawn over a text
 * frame from content/how-to-play-cards.json, so a missing image never hides the card's words.
 */
export function guideImageUrl(
  name: string,
  size: "normal" | "large" = "normal",
) {
  return `/api/v1/how-to-play/card-images?name=${encodeURIComponent(name)}&size=${size}`;
}

export function GuideCard({
  card,
  className,
}: {
  card: CardKey;
  className?: string;
}) {
  const face = CARDS[card];
  const [image, setImage] = useState<"loading" | "loaded" | "failed">(
    "loading",
  );
  const words = [
    face.name,
    face.cost ? `costs ${face.cost}` : null,
    face.type,
    ...face.rules,
    face.pt,
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <div
      className={[styles.card, className].filter(Boolean).join(" ")}
      data-image={image}
      role="img"
      aria-label={words}
    >
      <div className={styles.frame} aria-hidden="true">
        <div className={styles.frameName}>
          <span>{face.name}</span>
          {face.cost && (
            <span>
              <RichText text={face.cost} rules={false} />
            </span>
          )}
        </div>
        <div className={styles.frameType}>{face.type}</div>
        <div className={styles.frameRules}>
          {face.rules.map((line) => (
            <p key={line}>
              <RichText text={line} rules={false} />
            </p>
          ))}
        </div>
        {face.pt && <div className={styles.framePt}>{face.pt}</div>}
      </div>
      {image !== "failed" && (
        <img
          src={guideImageUrl(face.name)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setImage("loaded")}
          onError={() => setImage("failed")}
        />
      )}
    </div>
  );
}

/** Where each part's pin goes on a modern card frame, in percent of the card's width and height:
 * on the part, beside its words rather than over them. */
export const PART_AT: Record<CardPart, { x: number; y: number }> = {
  name: { x: 47, y: 7.6 },
  cost: { x: 72, y: 7.6 },
  art: { x: 50, y: 33 },
  type: { x: 52, y: 59.3 },
  set: { x: 80, y: 59.3 },
  text: { x: 91, y: 73 },
  pt: { x: 74, y: 93.6 },
  artist: { x: 47, y: 96.4 },
};

/**
 * A card with arrows from its parts to their names (v0.8.6): a numbered pin on each part, and on a
 * wide screen an arrow from each pin across to its label beside the card, drawn from where the
 * labels actually are (measured, and again whenever the layout changes). On a phone the labels
 * follow the card as a numbered list, and the pins alone say which is which.
 */
export function Anatomy({
  card,
  callouts,
  caption,
}: {
  card: CardKey;
  callouts: Callout[];
  caption: string;
}) {
  const id = useId();
  const marker = `head-${id.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const box = useRef<HTMLDivElement>(null);
  const cardBox = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [arrows, setArrows] = useState<{ d: string; key: string }[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // The labels in the order of the parts down the card.
  const ordered = [...callouts].sort(
    (a, b) =>
      PART_AT[a.part].y - PART_AT[b.part].y ||
      PART_AT[a.part].x - PART_AT[b.part].x,
  );

  useLayoutEffect(() => {
    const measure = () => {
      const outer = box.current?.getBoundingClientRect();
      const face = cardBox.current?.getBoundingClientRect();
      const items = list.current ? [...list.current.children] : [];
      if (!outer || !face || items.length === 0) return;
      setSize({ width: outer.width, height: outer.height });
      const first = items[0]!.getBoundingClientRect();
      // Side by side only: the labels start to the right of the card.
      if (first.left < face.right) {
        setArrows([]);
        return;
      }
      setArrows(
        ordered.map((callout, index) => {
          const at = PART_AT[callout.part];
          const x1 = face.left - outer.left + (face.width * at.x) / 100;
          const y1 = face.top - outer.top + (face.height * at.y) / 100;
          const item = items[index]!.getBoundingClientRect();
          const x2 = item.left - outer.left - 6;
          const y2 = item.top - outer.top + 12;
          const bend = (face.right - outer.left + x2) / 2;
          return {
            key: callout.part,
            d: `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${bend.toFixed(1)} ${y1.toFixed(1)}, ${bend.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`,
          };
        }),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined" || !box.current) return;
    const watcher = new ResizeObserver(measure);
    watcher.observe(box.current);
    return () => watcher.disconnect();
    // The callouts are the guide's constants: measuring once per mount and per resize is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card]);

  return (
    <figure className={styles.anatomy} aria-labelledby={`${id}-caption`}>
      <div className={styles.anatomyBody} ref={box}>
        <div className={styles.anatomyCard} ref={cardBox}>
          <GuideCard card={card} />
          {ordered.map((callout, index) => {
            const at = PART_AT[callout.part];
            return (
              <span
                key={callout.part}
                className={styles.pin}
                style={{ left: `${at.x}%`, top: `${at.y}%` }}
                aria-hidden="true"
              >
                {index + 1}
              </span>
            );
          })}
        </div>
        <ol className={styles.callouts} ref={list}>
          {ordered.map((callout, index) => (
            <li key={callout.part} data-n={index + 1}>
              <strong>{callout.label}</strong> <RichText text={callout.text} />
            </li>
          ))}
        </ol>
        {arrows.length > 0 && (
          <svg
            className={styles.arrows}
            width={size.width}
            height={size.height}
            viewBox={`0 0 ${size.width} ${size.height}`}
            aria-hidden="true"
          >
            <defs>
              <marker
                id={marker}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" className={styles.arrowHead} />
              </marker>
            </defs>
            {arrows.map((arrow) => (
              <path
                key={arrow.key}
                d={arrow.d}
                className={styles.arrow}
                markerStart={`url(#${marker})`}
              />
            ))}
          </svg>
        )}
      </div>
      <figcaption id={`${id}-caption`}>
        <RichText text={caption} />
      </figcaption>
    </figure>
  );
}

export function CardRow({
  cards,
  caption,
}: {
  cards: { card: CardKey; note: string }[];
  caption?: string;
}) {
  return (
    <figure className={styles.cardRow}>
      <ul>
        {cards.map(({ card, note }) => (
          <li key={card}>
            <GuideCard card={card} />
            <p>
              <RichText text={note} />
            </p>
          </li>
        ))}
      </ul>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}
