import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useMotionLevel } from "../app/motion";
import { readTableSettings } from "../app/tableSettings";
import { CardDetails } from "../catalog/CardViews";
import { printingImage } from "../catalog/catalog";
import { useImageRetry } from "../game/RetryingImage";
import { getSoundEngine } from "../game/sound/engine";
import type { Cue } from "../game/sound/recipes";
import shell from "../App.module.css";
import { LengBackdrop } from "./Leng";
import { PackArt } from "./PackArt";
import {
  describeCard,
  glowOf,
  kindLabels,
  rarityLabels,
  type Opening,
  type PulledCard,
} from "./shop";
import styles from "./shop.module.css";

// Opening a pack in the Magic Duels style (v0.4.0): the pack tears open, its cards are dealt face
// down and turn over one at a time (a click, or Space), rares and mythic rares glow in their
// rarity's color and foils shimmer, each with its generated sound; "Reveal all" turns the rest.
// A summary follows, with new cards marked and each card's details a click away. The server drew
// the pack before any of this: the show only reveals it. With reduced motion every step is
// immediate and nothing moves. Since v0.4.3 the pack is the product's own picture (PackArt), whose
// top strip tears off, and Leng's counter shows dimly behind it all.

/** How long each step takes, in ms, when motion is allowed. */
export const TIMING = { tear: 650, deal: 70, settle: 300, revealAll: 140 };

type Stage = "sealed" | "tearing" | "dealing" | "revealing" | "summary";

function play(cue: Cue, delayMs = 0) {
  getSoundEngine().play(cue, { delayMs });
}

/** The sounds of a card turning over: the flick, then its rarity's bell and a foil's sparkle. */
function flipSounds(card: PulledCard, delayMs = 0) {
  play("cardFlip", delayMs);
  const glow = glowOf(card);
  if (glow === "mythic") play("mythicReveal", delayMs + 90);
  else if (glow === "rare") play("rareReveal", delayMs + 90);
  if (card.finish !== "nonfoil") play("foilShimmer", delayMs + 160);
}

export function CardFace({ card }: { card: PulledCard }) {
  const src = printingImage(
    card.printing_id,
    "normal",
    card.faces > 0 ? 0 : undefined,
  );
  // A pack's new cards all load at once: one the server cannot send yet is tried again (v0.4.4).
  const image = useImageRetry(src);
  return (
    <span
      className={styles.face}
      data-loaded={image.state === "loaded" || undefined}
    >
      <span className={styles.frame} aria-hidden="true">
        <strong>{card.name}</strong>
        {card.mana_cost && <small>{card.mana_cost}</small>}
        <span>{card.type_line}</span>
        <small>{rarityLabels[card.rarity] ?? card.rarity}</small>
      </span>
      {image.state !== "failed" && (
        <img
          key={image.attempt}
          src={src}
          alt=""
          decoding="async"
          ref={image.ref}
          onLoad={image.onLoad}
          onError={image.onError}
        />
      )}
      {card.finish !== "nonfoil" && (
        <span className={styles.shimmer} aria-hidden="true" />
      )}
    </span>
  );
}

export function PackOpening({
  opening,
  onDone,
  onAnother,
  remaining = 0,
  startOpen = false,
}: {
  opening: Opening;
  onDone: () => void;
  /** Opens the next pack of the same product, when there is one. */
  onAnother?: () => void;
  /** Packs of this product still unopened. */
  remaining?: number;
  /** A pack opened before (from the history) goes straight to its summary. */
  startOpen?: boolean;
}) {
  const reduced = useMotionLevel("normal") === "none";
  const cards = opening.cards;
  const [stage, setStage] = useState<Stage>(startOpen ? "summary" : "sealed");
  const [dealt, setDealt] = useState(startOpen ? cards.length : 0);
  const [shown, setShown] = useState<Set<number>>(
    () => new Set(startOpen ? cards.map((card) => card.position) : []),
  );
  const [announced, setAnnounced] = useState("");
  const [details, setDetails] = useState<PulledCard | null>(null);
  const timers = useRef<number[]>([]);
  const board = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  const later = useCallback(
    (ms: number, run: () => void) => {
      if (reduced || ms <= 0) return run();
      timers.current.push(window.setTimeout(run, ms));
    },
    [reduced],
  );
  useEffect(
    () => () => {
      for (const id of timers.current) window.clearTimeout(id);
      timers.current = [];
    },
    [],
  );
  useEffect(() => {
    const settings = readTableSettings();
    const engine = getSoundEngine();
    engine.setVolume(settings.effectsVolume);
    engine.setMuted(settings.muted);
  }, []);
  useEffect(() => {
    if (details) dialog.current?.showModal?.();
  }, [details]);

  // The deal: the cards land face down one after another, then the board takes the keyboard.
  useEffect(() => {
    if (stage !== "dealing") return;
    if (reduced) {
      setDealt(cards.length);
      setStage("revealing");
      return;
    }
    const ids = cards.map((_, index) =>
      window.setTimeout(() => {
        setDealt(index + 1);
        if (index % 3 === 0) play("cardDeal");
      }, index * TIMING.deal),
    );
    ids.push(
      window.setTimeout(
        () => setStage("revealing"),
        cards.length * TIMING.deal + TIMING.settle,
      ),
    );
    return () => ids.forEach((id) => window.clearTimeout(id));
  }, [stage, cards, reduced]);
  useEffect(() => {
    if (stage === "revealing") board.current?.focus();
    if (stage === "summary") heading.current?.focus();
  }, [stage]);
  // Once every card is up, the summary follows after a moment to look at them.
  useEffect(() => {
    if (stage !== "revealing" || shown.size < cards.length) return;
    if (reduced) return setStage("summary");
    const id = window.setTimeout(() => setStage("summary"), 900);
    return () => window.clearTimeout(id);
  }, [stage, shown, cards.length, reduced]);

  function tear() {
    // The press itself may start audio, as browsers require.
    getSoundEngine().unlock();
    play("packTear");
    setStage("tearing");
    later(TIMING.tear, () => setStage("dealing"));
  }

  function flip(card: PulledCard) {
    if (shown.has(card.position)) return;
    setShown((before) => new Set(before).add(card.position));
    setAnnounced(describeCard(card));
    flipSounds(card);
  }

  function flipNext() {
    const next = cards.find((card) => !shown.has(card.position));
    if (next) flip(next);
  }

  function revealAll() {
    const hidden = cards.filter((card) => !shown.has(card.position));
    if (reduced) {
      setShown(new Set(cards.map((card) => card.position)));
      const best =
        hidden.find((card) => glowOf(card) === "mythic") ??
        hidden.find((card) => glowOf(card) === "rare") ??
        hidden[0];
      if (best) flipSounds(best);
      setAnnounced(`All ${cards.length} cards revealed.`);
      return;
    }
    hidden.forEach((card, index) =>
      later(index * TIMING.revealAll, () => {
        setShown((before) => new Set(before).add(card.position));
        flipSounds(card);
      }),
    );
    setAnnounced(`All ${cards.length} cards revealed.`);
  }

  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== " " && event.key !== "Spacebar") return;
    // A focused button answers Space itself.
    const target = event.target as HTMLElement;
    if (target.closest("button, input, select, textarea, a")) return;
    event.preventDefault();
    flipNext();
  }

  const newCards = cards.filter((card) => card.new).length;
  const foils = cards.filter((card) => card.finish !== "nonfoil").length;
  const title = opening.product.name;

  if (stage === "summary")
    return (
      <section
        className={styles.opening}
        aria-labelledby="opening-summary-title"
        data-stage="summary"
      >
        <LengBackdrop />
        <span className={shell.eyebrow}>PACK OPENED</span>
        <h2 id="opening-summary-title" ref={heading} tabIndex={-1}>
          {title}
        </h2>
        <p className={styles.note}>
          {cards.length} cards · {newCards} new to your library
          {foils ? ` · ${foils} foil${foils === 1 ? "" : "s"}` : ""}. Every card
          is now in your library for good.
        </p>
        <ul className={styles.summary} aria-label="Cards in the pack">
          {cards.map((card) => (
            <li
              key={card.position}
              className={styles.summaryCard}
              data-glow={glowOf(card) ?? undefined}
              data-finish={card.finish}
            >
              <CardFace card={card} />
              <div className={styles.summaryText}>
                <strong>{card.name}</strong>
                <span>
                  {rarityLabels[card.rarity] ?? card.rarity}
                  {card.finish === "foil" && " · Foil"}
                  {card.finish === "etched" && " · Etched foil"}
                </span>
                {card.new && <span className={styles.newMark}>New</span>}
                <button
                  type="button"
                  className={styles.linkButton}
                  aria-label={`Details of ${card.name}`}
                  onClick={() => setDetails(card)}
                >
                  Details
                </button>
              </div>
            </li>
          ))}
        </ul>
        <div className={styles.actions}>
          {onAnother && remaining > 0 && (
            <button type="button" className={shell.primary} onClick={onAnother}>
              Open another {kindLabels[opening.product.kind] ?? "pack"} (
              {remaining} left)
            </button>
          )}
          <button type="button" className={styles.secondary} onClick={onDone}>
            Back to the shop
          </button>
        </div>
        <dialog
          ref={dialog}
          className={styles.dialog}
          aria-label={
            details ? `${details.name}, card details` : "Card details"
          }
          onClose={() => setDetails(null)}
        >
          <button
            type="button"
            className={styles.close}
            aria-label="Close the card's details"
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
          {details && (
            <CardDetails
              cardId={details.card_id}
              chosenPrinting={details.printing_id}
            />
          )}
        </dialog>
      </section>
    );

  const left = cards.length - shown.size;
  return (
    <section
      className={styles.opening}
      aria-labelledby="opening-title"
      data-stage={stage}
    >
      <LengBackdrop />
      <span className={shell.eyebrow}>OPENING A PACK</span>
      <h2 id="opening-title">{title}</h2>
      {stage === "sealed" || stage === "tearing" ? (
        <div className={styles.packStage}>
          <button
            type="button"
            className={styles.pack}
            data-torn={stage === "tearing" || undefined}
            onClick={stage === "sealed" ? tear : undefined}
            aria-label={`Tear open the ${title}`}
          >
            {/* The same picture twice: the strip that tears off, and the rest of the pack. */}
            <span className={styles.packTop} aria-hidden="true">
              <PackArt product={opening.product} size="large" height={20} />
            </span>
            <span className={styles.packBody} aria-hidden="true">
              <PackArt product={opening.product} size="large" height={20} />
            </span>
          </button>
          <p className={styles.note}>
            {stage === "sealed"
              ? "Click the pack to tear it open."
              : "Tearing it open…"}
          </p>
        </div>
      ) : (
        <>
          <p className={styles.note}>
            {stage === "dealing"
              ? "Dealing the cards…"
              : left
                ? `Click a card, or press Space, to turn it over. ${left} to go.`
                : "Every card is revealed."}
          </p>
          <div
            ref={board}
            className={styles.board}
            tabIndex={-1}
            onKeyDown={onKey}
            role="group"
            aria-label="The pack's cards"
          >
            <ol className={styles.cards}>
              {cards.slice(0, dealt).map((card, index) => {
                const up = shown.has(card.position);
                return (
                  <li key={card.position} className={styles.slot}>
                    <button
                      type="button"
                      className={styles.card}
                      data-up={up || undefined}
                      data-glow={up ? (glowOf(card) ?? undefined) : undefined}
                      data-finish={up ? card.finish : undefined}
                      aria-label={
                        up
                          ? describeCard(card)
                          : `Card ${index + 1} of ${cards.length}, face down. Turn it over`
                      }
                      aria-disabled={up || stage !== "revealing"}
                      onClick={() => stage === "revealing" && flip(card)}
                    >
                      <span className={styles.inner}>
                        <span className={styles.back} aria-hidden="true" />
                        {up && <CardFace card={card} />}
                      </span>
                    </button>
                    {up && card.new && (
                      <span className={styles.newMark} aria-hidden="true">
                        New
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
          <div className={styles.actions}>
            {stage === "revealing" && left > 0 && (
              <button
                type="button"
                className={shell.primary}
                onClick={revealAll}
              >
                Reveal all
              </button>
            )}
            {stage === "revealing" && left === 0 && (
              <button
                type="button"
                className={shell.primary}
                onClick={() => setStage("summary")}
              >
                See the summary
              </button>
            )}
          </div>
        </>
      )}
      <p className={styles.hidden} role="status" aria-live="polite">
        {announced}
      </p>
    </section>
  );
}
