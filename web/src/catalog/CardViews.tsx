import { useEffect, useState, type ReactNode } from "react";
import { client } from "../api";
import { ManaCost } from "../game/Card";
import { useImageRetry } from "../game/RetryingImage";
import {
  colorWords,
  editionName,
  formatLabels,
  legalityLabels,
  ownedWords,
  printingImage,
  statusLabel,
  type CardDetail,
  type CardSummary,
  type PrintingSummary,
  type PrintingsShown,
} from "./catalog";
import styles from "./catalog.module.css";
import type { CardView } from "./cardView";

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
  // A Godlike card (v0.4.0) has its own image, from the custom card route.
  const src =
    card.custom_image ??
    (chosen
      ? printingImage(chosen, size, faces > 0 ? (face ?? 0) : undefined)
      : null);
  // A failure is tried again (v0.4.4): a page of new cards may find the server busy at first.
  const image = useImageRetry(src);
  // Once the image has drawn, the frame beneath it is hidden, so a printing of another shape
  // shows the card's background around it rather than fragments of the text.
  return (
    <div
      className={styles.cardImage}
      data-loaded={image.state === "loaded" || undefined}
    >
      <TextFrame card={card} face={face} />
      {src && image.state !== "failed" && (
        <img
          key={image.attempt}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          ref={image.ref}
          onLoad={image.onLoad}
          onError={image.onError}
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

/** A small badge for a Godlike card's playability (whether the running engine has loaded it),
 * or for a catalog card that cannot be played, with its reason in words for screen readers. Since
 * v0.4.5 the catalog shows only cards the game can play, so a catalog card has one only in a
 * version of a deck that games played. */
export function StatusBadge({ card }: { card: CardSummary }) {
  if (card.playable && !card.custom) return null;
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

/** A card's copies in the player's library, when the library limits it: nothing otherwise. */
export function OwnedNote({ card }: { card: CardSummary }) {
  const words = ownedWords(card);
  if (!words) return null;
  return (
    <span className={styles.owned} data-owned={(card.owned ?? 0) > 0}>
      {words}
    </span>
  );
}

/** A card in a grid of results: its image and name, and for a player who builds from a library,
 * the copies it holds; in the library (v0.5.0), the edition the copies are. */
export function CardTile({
  card,
  onOpen,
  edition,
  children,
}: {
  card: CardSummary;
  onOpen: (card: CardSummary) => void;
  /** The edition the tile shows, in words. */
  edition?: string;
  children?: ReactNode;
}) {
  const owned = ownedWords(card);
  return (
    <li className={styles.tile} data-playable={card.playable}>
      <button
        type="button"
        className={styles.tileButton}
        onClick={() => onOpen(card)}
        aria-label={`${card.name}${edition ? ` from ${edition}` : ""}, ${card.type_line}${card.playable ? "" : `, ${statusLabel(card)}`}${owned ? `, ${owned.toLowerCase()}` : ""}`}
      >
        <CardImage card={card} />
      </button>
      <div className={styles.tileFoot}>
        <span className={styles.tileName} title={card.name}>
          {card.name}
        </span>
        <StatusBadge card={card} />
      </div>
      {edition && (
        <span className={styles.tileEdition} title={edition}>
          {edition}
        </span>
      )}
      <OwnedNote card={card} />
      {children}
    </li>
  );
}

/** The Cards page's switch between the cards' pictures and a list of them (v0.5.0). */
export function ViewSwitch({
  view,
  onChange,
}: {
  view: CardView;
  onChange: (view: CardView) => void;
}) {
  return (
    <div className={styles.viewSwitch} role="group" aria-label="Show cards as">
      {(["pictures", "list"] as const).map((item) => (
        <button
          key={item}
          type="button"
          aria-pressed={view === item}
          onClick={() => onChange(item)}
        >
          {item === "pictures" ? "Pictures" : "List"}
        </button>
      ))}
    </div>
  );
}

/** Cards as a list (v0.5.0): name and cost, type, and for a player who builds from a library, the
 * copies it holds. */
export function CardTable({
  cards,
  label,
  onOpen,
}: {
  cards: CardSummary[];
  label: string;
  onOpen: (card: CardSummary) => void;
}) {
  const owned = cards.some((card) => ownedWords(card) !== null);
  return (
    <div className={styles.libraryScroll}>
      <table className={styles.libraryTable} aria-label={label}>
        <thead>
          <tr>
            <th scope="col">Card</th>
            <th scope="col">Type</th>
            {owned && <th scope="col">In your library</th>}
          </tr>
        </thead>
        <tbody>
          {cards.map((card) => (
            <tr key={card.id} data-playable={card.playable}>
              <th scope="row">
                <button
                  type="button"
                  className={styles.cardLink}
                  onClick={() => onOpen(card)}
                >
                  {card.name}
                </button>{" "}
                <ManaCost cost={card.mana_cost} />
              </th>
              <td>{card.type_line}</td>
              {owned && (
                <td>
                  {card.owned === null || card.owned === undefined
                    ? "Any number"
                    : card.owned || "None"}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Everything about a card: its text, status, legality, printings, rulings and tags. Since v0.5.0
 * `printings` says which printings it lists: every one (the catalog), the editions the player's
 * library holds (opened from the library, or a deck entry's choice), or only the chosen one (a
 * card pulled from a pack). The server decides which those are. */
export function CardDetails({
  cardId,
  chosenPrinting,
  onChoosePrinting,
  actions,
  printings: shownPrintings = "all",
}: {
  cardId: string;
  chosenPrinting?: string | null;
  onChoosePrinting?: (printingId: string | null) => void;
  actions?: ReactNode;
  printings?: PrintingsShown;
}) {
  const [card, setCard] = useState<CardDetail>();
  // A card the game cannot play is not in the game (v0.4.5): a version of a deck that games
  // played may still name one.
  const [gone, setGone] = useState(false);
  const [face, setFace] = useState(0);
  const [preview, setPreview] = useState<string | null>(chosenPrinting ?? null);
  const [allPrintings, setAllPrintings] = useState<PrintingSummary[]>();
  useEffect(() => {
    let active = true;
    setCard(undefined);
    setGone(false);
    setAllPrintings(undefined);
    // A deck entry's chosen printing is asked for by name, so the details list it (and its
    // artist) even when it is older than the printings the card lists first. Choosing another
    // printing later picks one from that list, so it needs no new request.
    const printing = chosenPrinting ?? undefined;
    const query = {
      ...(printing ? { printing } : {}),
      ...(shownPrintings !== "all" ? { printings: shownPrintings } : {}),
    };
    void client
      .GET("/api/v1/cards/{card_id}", {
        params: {
          path: { card_id: cardId },
          query: Object.keys(query).length ? query : undefined,
        },
      })
      .then(({ data, response }) => {
        if (!active) return;
        if (data) setCard(data);
        else setGone(response.status === 404);
      });
    return () => {
      active = false;
    };
  }, [cardId]);
  useEffect(() => setPreview(chosenPrinting ?? null), [chosenPrinting]);
  if (!card)
    return (
      <p role="status">
        {gone
          ? "This card is not in the game: the game engine cannot play it."
          : "Loading the card…"}
      </p>
    );
  // "Show all" loads the newest 500; the first list's printings stay too, so a chosen printing
  // older than those (asked for by name) is never dropped from the list.
  const loaded = new Set(allPrintings?.map((printing) => printing.id));
  const printings = allPrintings
    ? [
        ...allPrintings,
        ...card.printings.filter((printing) => !loaded.has(printing.id)),
      ]
    : card.printings;
  const imageFaces = card.image?.faces ?? 0;
  // The artist of the image on show: a previewed printing's, else the default image's.
  const shownArtist = preview
    ? (printings.find((item) => item.id === preview)?.artist ?? null)
    : (card.image?.artist ?? null);
  // The editions the player's library holds of it, when the library limits it (v0.5.0).
  const held = card.editions
    ? new Map(
        card.editions.map((edition) => [edition.printing_id, edition.copies]),
      )
    : null;
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
          {(!card.playable || card.text_differs) && (
            <div>
              <dt>Status</dt>
              <dd>
                <StatusBadge card={card} />{" "}
                {!card.playable && (
                  <span>{card.status_detail ?? statusLabel(card)}</span>
                )}
                {card.text_differs && (
                  <span className={styles.warning}>
                    The game engine's wording of this card may differ from
                    today's Oracle text. It plays as the engine has it.
                  </span>
                )}
              </dd>
            </div>
          )}
          {ownedWords(card) && (
            <div>
              <dt>Your library</dt>
              <dd>
                {ownedWords(card)}
                {card.editions && card.editions.length > 0 && (
                  <ul
                    className={styles.ownedEditions}
                    aria-label="Your editions"
                  >
                    {card.editions.map((edition) => (
                      <li key={edition.printing_id}>
                        {editionName(edition)}: {edition.copies}
                      </li>
                    ))}
                  </ul>
                )}
                <span className={styles.note}>
                  {(card.owned ?? 0) > 0
                    ? "A deck may hold the editions your library holds, as many copies of each as it does."
                    : "A deck may still hold it, but cannot start a game until your library does."}
                </span>
              </dd>
            </div>
          )}
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
            {shownPrintings === "chosen"
              ? "Edition"
              : shownPrintings === "owned" && held
                ? "Your editions"
                : "Printings"}{" "}
            <small>({card.printing_count})</small>
          </h3>
          {shownPrintings === "owned" && held && held.size === 0 && (
            <p className={styles.note}>
              Your library holds no edition of this card yet.
            </p>
          )}
          <ul className={styles.printings}>
            {/* A player's deck holds an edition of their own (v0.5.0); a basic land, or an
                account that builds from the whole catalog, may leave it to the default. */}
            {onChoosePrinting && !held && (
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
                  {held &&
                    shownPrintings !== "chosen" &&
                    (held.has(printing.id)
                      ? ` · ${held.get(printing.id)} in your library`
                      : " · not in your library")}
                </button>
              </li>
            ))}
          </ul>
          {!allPrintings && printings.length < card.printing_count && (
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
              {card.printing_count > 500
                ? "Show the newest 500 printings"
                : `Show all ${card.printing_count} printings`}
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
          {shownArtist ? `Illustrated by ${shownArtist}. ` : ""}Card data and
          images from Scryfall; tags from Scryfall Tagger. Magic: The Gathering
          © Wizards of the Coast.
        </p>
      </div>
    </div>
  );
}

/**
 * One of the Godlike tier's custom cards (v0.4.0), from the summary its deck or the custom card
 * list sent: its own image and text. The catalog knows nothing of it, so there are no printings,
 * rulings or tags to show. In the deck of an owner below the Godlike tier, the server sends only
 * a hidden "Godlike card", which says so.
 */
export function CustomCardDetails({
  card,
  actions,
}: {
  card: CardSummary;
  actions?: ReactNode;
}) {
  const shown = card.custom_image !== null && card.custom_image !== undefined;
  return (
    <div className={styles.detail}>
      <div className={styles.detailImage}>
        <CardImage card={card} size="large" />
      </div>
      <div className={styles.detailText}>
        <h2 className={styles.detailName}>
          {card.name} <ManaCost cost={card.mana_cost} />
        </h2>
        <p className={styles.detailType}>{card.type_line}</p>
        {shown && (
          <div className={styles.oracle}>
            {card.oracle_text.split("\n").map((line, index) => (
              <p key={index}>{line}</p>
            ))}
            {card.power !== null && (
              <p className={styles.pt}>
                {card.power}/{card.toughness}
              </p>
            )}
            {card.loyalty && (
              <p className={styles.pt}>Loyalty {card.loyalty}</p>
            )}
          </div>
        )}
        <dl className={styles.facts}>
          <div>
            <dt>Status</dt>
            <dd>
              <StatusBadge card={card} />{" "}
              {!card.playable && (
                <span>{card.status_detail ?? statusLabel(card)}</span>
              )}
            </dd>
          </div>
          {ownedWords(card) && (
            <div>
              <dt>Your library</dt>
              <dd>{ownedWords(card)}</dd>
            </div>
          )}
          {shown && (
            <>
              <div>
                <dt>Color identity</dt>
                <dd>{colorWords(card.color_identity)}</dd>
              </div>
              <div>
                <dt>Legality</dt>
                <dd>A Godlike card: legal in Legacy and Commander for you.</dd>
              </div>
              {card.commander && (
                <div>
                  <dt>Commander</dt>
                  <dd>Can be your commander</dd>
                </div>
              )}
            </>
          )}
        </dl>
        {actions}
        <p className={styles.credit}>
          A Godlike card: only accounts at the Godlike tier see it, and the
          players at a table where it is played.
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
