import { useEffect, useState, type ReactNode } from "react";
import { client } from "../api";
import { ManaCost } from "../game/Card";
import {
  colorWords,
  formatLabels,
  legalityLabels,
  printingImage,
  statusLabel,
  type CardDetail,
  type CardSummary,
  type PrintingSummary,
} from "./catalog";
import styles from "./catalog.module.css";

/** The card's printed image over its text: a missing or slow image never hides the text. */
export function CardImage({
  card,
  printingId,
  face,
  size = "normal",
}: {
  card: CardSummary;
  printingId?: string | null;
  face?: number;
  size?: "normal" | "large";
}) {
  const chosen = printingId ?? card.image?.printing_id;
  const faces = card.image?.faces ?? 0;
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [chosen, face, size]);
  const src =
    chosen && !failed
      ? printingImage(chosen, size, faces > 0 ? (face ?? 0) : undefined)
      : null;
  return (
    <div className={styles.cardImage}>
      <TextFrame card={card} face={face} />
      {src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

function TextFrame({ card, face }: { card: CardSummary; face?: number }) {
  const shown =
    face !== undefined && card.faces[face] ? card.faces[face] : null;
  const name = shown?.name ?? card.name;
  const cost = shown ? shown.mana_cost : card.mana_cost;
  const type = shown?.type_line ?? card.type_line;
  const text = shown?.oracle_text ?? card.oracle_text;
  const power = shown ? shown.power : card.power;
  const toughness = shown ? shown.toughness : card.toughness;
  return (
    <div className={styles.frame} aria-hidden="true">
      <div className={styles.frameName}>
        <span>{name}</span>
        <ManaCost cost={cost ?? null} />
      </div>
      <div className={styles.frameType}>{type}</div>
      <div className={styles.frameText}>
        {text.split("\n").map((line, index) => (
          <p key={index}>{line}</p>
        ))}
      </div>
      {power !== null && power !== undefined && (
        <div className={styles.framePt}>
          {power}/{toughness}
        </div>
      )}
    </div>
  );
}

/** A small badge for a card's playability, with its reason in words for screen readers. */
export function StatusBadge({ card }: { card: CardSummary }) {
  return (
    <span
      className={styles.status}
      data-playable={card.playable}
      title={card.status_detail ?? undefined}
    >
      {card.playable ? "Playable" : "Not playable"}
      <span className={styles.visuallyHidden}>
        {card.playable ? "" : `: ${statusLabel(card)}`}
      </span>
    </span>
  );
}

/** A card in a grid of results: its image, name, cost and status. */
export function CardTile({
  card,
  onOpen,
  children,
}: {
  card: CardSummary;
  onOpen: (card: CardSummary) => void;
  children?: ReactNode;
}) {
  return (
    <li className={styles.tile} data-playable={card.playable}>
      <button
        type="button"
        className={styles.tileButton}
        onClick={() => onOpen(card)}
        aria-label={`${card.name}, ${card.type_line}, ${statusLabel(card)}`}
      >
        <CardImage card={card} />
      </button>
      <div className={styles.tileFoot}>
        <span className={styles.tileName}>{card.name}</span>
        <StatusBadge card={card} />
      </div>
      {children}
    </li>
  );
}

/** Everything about a card: its text, status, legality, printings, rulings and tags. */
export function CardDetails({
  cardId,
  chosenPrinting,
  onChoosePrinting,
  actions,
}: {
  cardId: string;
  chosenPrinting?: string | null;
  onChoosePrinting?: (printingId: string | null) => void;
  actions?: ReactNode;
}) {
  const [card, setCard] = useState<CardDetail>();
  const [face, setFace] = useState(0);
  const [preview, setPreview] = useState<string | null>(chosenPrinting ?? null);
  const [allPrintings, setAllPrintings] = useState<PrintingSummary[]>();
  useEffect(() => {
    let active = true;
    setCard(undefined);
    setAllPrintings(undefined);
    void client
      .GET("/api/v1/cards/{card_id}", { params: { path: { card_id: cardId } } })
      .then(({ data }) => active && data && setCard(data));
    return () => {
      active = false;
    };
  }, [cardId]);
  useEffect(() => setPreview(chosenPrinting ?? null), [chosenPrinting]);
  if (!card) return <p role="status">Loading the card…</p>;
  const printings = allPrintings ?? card.printings;
  const imageFaces = card.image?.faces ?? 0;
  return (
    <div className={styles.detail}>
      <div className={styles.detailImage}>
        <CardImage
          card={card}
          printingId={preview}
          face={imageFaces > 0 ? face : undefined}
          size="large"
        />
        {imageFaces > 1 && (
          <button
            type="button"
            className={styles.secondary}
            onClick={() => setFace((value) => (value + 1) % imageFaces)}
          >
            Turn over
          </button>
        )}
      </div>
      <div className={styles.detailText}>
        <h2 className={styles.detailName}>
          {card.name} <ManaCost cost={card.mana_cost} />
        </h2>
        <p className={styles.detailType}>{card.type_line}</p>
        {(card.faces.length ? card.faces : [card]).map((part, index) => (
          <div key={index} className={styles.oracle}>
            {card.faces.length > 0 && (
              <h3>
                {part.name} <ManaCost cost={part.mana_cost ?? null} />
              </h3>
            )}
            {card.faces.length > 0 && (
              <p className={styles.detailType}>{part.type_line}</p>
            )}
            {(part.oracle_text ?? "").split("\n").map((line, line_index) => (
              <p key={line_index}>{line}</p>
            ))}
            {part.power !== null && part.power !== undefined && (
              <p className={styles.pt}>
                {part.power}/{part.toughness}
              </p>
            )}
            {"loyalty" in part && part.loyalty && (
              <p className={styles.pt}>Loyalty {part.loyalty}</p>
            )}
          </div>
        ))}
        <dl className={styles.facts}>
          <div>
            <dt>Status</dt>
            <dd>
              <StatusBadge card={card} />{" "}
              {!card.playable && (
                <span>{card.status_detail ?? statusLabel(card)}</span>
              )}
              {card.text_differs && (
                <span className={styles.warning}>
                  The game engine's wording of this card may differ from today's
                  Oracle text. It plays as the engine has it.
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt>Color identity</dt>
            <dd>{colorWords(card.color_identity)}</dd>
          </div>
          <div>
            <dt>Legality</dt>
            <dd className={styles.legalities}>
              {Object.entries(card.legalities).map(([format, legality]) => (
                <span key={format} data-legality={legality}>
                  {formatLabels[format] ?? format}:{" "}
                  {legalityLabels[legality] ?? legality}
                </span>
              ))}
            </dd>
          </div>
          {card.commander && (
            <div>
              <dt>Commander</dt>
              <dd>
                Can be your commander
                {card.partner ? ` (${partnerWords(card.partner)})` : ""}
              </dd>
            </div>
          )}
          {card.copy_limit !== null && (
            <div>
              <dt>Copies</dt>
              <dd>
                {card.copy_limit === 0
                  ? "A deck may hold any number."
                  : `A deck may hold up to ${card.copy_limit}.`}
              </dd>
            </div>
          )}
        </dl>
        {actions}
        <section aria-labelledby={`printings-${card.id}`}>
          <h3 id={`printings-${card.id}`}>
            Printings <small>({card.printing_count})</small>
          </h3>
          <ul className={styles.printings}>
            {onChoosePrinting && (
              <li>
                <button
                  type="button"
                  aria-pressed={!chosenPrinting}
                  onClick={() => onChoosePrinting(null)}
                >
                  Any printing (the default)
                </button>
              </li>
            )}
            {printings.map((printing) => (
              <li key={printing.id}>
                <button
                  type="button"
                  aria-pressed={chosenPrinting === printing.id}
                  onMouseEnter={() => setPreview(printing.id)}
                  onFocus={() => setPreview(printing.id)}
                  onClick={() =>
                    onChoosePrinting
                      ? onChoosePrinting(printing.id)
                      : setPreview(printing.id)
                  }
                >
                  <strong>{printing.set_name}</strong>{" "}
                  {printing.set_code.toUpperCase()} #{printing.collector_number}{" "}
                  · {printing.rarity}
                  {printing.released_at
                    ? ` · ${printing.released_at.slice(0, 4)}`
                    : ""}
                  {printing.lang !== "en" ? ` · ${printing.lang}` : ""}
                  {printing.promo ? " · promo" : ""}
                </button>
              </li>
            ))}
          </ul>
          {printings.length < card.printing_count && (
            <button
              type="button"
              className={styles.secondary}
              onClick={() =>
                void client
                  .GET("/api/v1/cards/{card_id}/printings", {
                    params: {
                      path: { card_id: card.id },
                      query: { limit: 500 },
                    },
                  })
                  .then(({ data }) => data && setAllPrintings(data))
              }
            >
              Show all {card.printing_count} printings
            </button>
          )}
        </section>
        {card.rulings.length > 0 && (
          <details className={styles.rulings}>
            <summary>Rulings ({card.rulings.length})</summary>
            <ul>
              {card.rulings.map((ruling, index) => (
                <li key={index}>
                  <time dateTime={ruling.published_at}>
                    {ruling.published_at}
                  </time>{" "}
                  {ruling.comment}
                </li>
              ))}
            </ul>
          </details>
        )}
        {card.tags.length > 0 && (
          <p className={styles.tags}>
            <span>Tagged:</span> {card.tags.slice(0, 12).join(", ")}
            {card.tags.length > 12 ? "…" : ""}
          </p>
        )}
        <p className={styles.credit}>
          Card data and images from Scryfall; tags from Scryfall Tagger.
        </p>
      </div>
    </div>
  );
}

export function partnerWords(partner: string): string {
  if (partner === "partner") return "partner";
  if (partner.startsWith("partner_with:"))
    return `partner with ${titled(partner.slice(13))}`;
  if (partner.startsWith("partner_group:"))
    return `partner: ${titled(partner.slice(14))}`;
  return (
    {
      choose_background: "choose a Background",
      background: "a Background",
      doctors_companion: "Doctor's companion",
      time_lord_doctor: "a Time Lord Doctor",
    }[partner] ?? partner
  );
}

function titled(text: string): string {
  return text.replace(/\b\w/g, (letter) => letter.toUpperCase());
}
