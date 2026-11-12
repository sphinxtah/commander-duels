import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type SyntheticEvent,
  type WheelEvent,
} from "react";
import { useMotionLevel } from "../app/motion";
import { readTableSettings } from "../app/tableSettings";
import { CardDetails } from "../catalog/CardViews";
import { printingImage } from "../catalog/catalog";
import { foilGlow } from "../catalog/foilGlow";
import { useImageRetry } from "../game/RetryingImage";
import { getSoundEngine } from "../game/sound/engine";
import type { Cue } from "../game/sound/recipes";
import shell from "../App.module.css";
import { DeckChoicePanel, type DeckChoice } from "./DeckChoice";
import { LandTally } from "./LandTally";
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
import { signalTutorial } from "../tutorial/tutorial";

// Opening a pack card by card (v0.4.0): the pack tears open, its cards are dealt face
// down and turn over one at a time (a click, or Space), rares and mythic rares glow in their
// rarity's color and foils shimmer, each with its generated sound; "Reveal all" turns the rest.
// A summary follows, with new cards marked; clicking a card opens its details (v0.9.1). The server drew
// the pack before any of this: the show only reveals it. With reduced motion every step is
// immediate and nothing moves. Since v0.4.3 the pack is the product's own picture (PackArt), whose
// top strip tears off, and Leng's counter shows dimly behind it all. Since v0.9.8 a pack that is
// a deck asks in its summary whether to keep its cards together as one (DeckChoice).
// Since v0.9.9 it is laid out for a window that does not scroll (OpeningWindow): a head with the
// title, a body that alone scrolls (the pack, its cards, the summary) and a foot with the
// buttons, so in a large pack the cards scroll while everything else, Leng's counter behind them
// included, holds still.

/** How long each step takes, in ms, when motion is allowed. */
export const TIMING = { tear: 650, deal: 70, settle: 300, revealAll: 140 };

type Stage = "sealed" | "tearing" | "dealing" | "revealing" | "summary";

/** What one press of an arrow key scrolls the window's body by, and the least a page key does. */
const LINE = 40;

/**
 * Whether an event in the window came from outside its scrolling body: from the head, the foot
 * or the bare ground. The body scrolls itself, and a card's details, open over all of it, are
 * their own pop-up.
 */
function outsideBody(event: SyntheticEvent<HTMLElement>): boolean {
  const from = (event.target as Element | null)?.closest?.(
    "[data-opening-scroll], dialog",
  );
  return !(from && event.currentTarget.contains(from));
}

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

export function CardFace({
  card,
  glow = false,
}: {
  card: PulledCard;
  /** The foil glow (v0.6.0) on the face itself, where nothing around it turns. */
  glow?: boolean;
}) {
  // A warden deck's custom commander (v0.9.5) shows the custom card's own image.
  const src =
    "custom" in card && card.custom
      ? `/api/v1/custom-cards/${card.card_id}/image`
      : printingImage(
          card.printing_id,
          "normal",
          card.faces > 0 ? 0 : undefined,
        );
  // A pack's new cards all load at once: one the server cannot send yet is tried again (v0.4.4).
  const image = useImageRetry(src);
  return (
    <span
      className={[styles.face, glow ? foilGlow(card.finish) : undefined]
        .filter(Boolean)
        .join(" ")}
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
  art,
  tutorial = true,
  summaryLine,
  deck,
  doneLabel = "Back to the shop",
  noun = "pack",
}: {
  opening: Opening;
  /** The pack is a deck (v0.9.8): its summary asks whether to keep the cards together. */
  deck?: DeckChoice;
  /** What the summary's way out says. */
  doneLabel?: string;
  /** What tears open: a pack, or a deck in its box (a warden's, a starter deck). */
  noun?: "pack" | "deck";
  /** What tears open in place of the product's pack: a warden's deck box (v0.9.5). */
  art?: ReactNode;
  /** Whether the tutorial's tour hears of it (a pack from the shop does). */
  tutorial?: boolean;
  /** The summary's line in place of the count of new cards. */
  summaryLine?: string;
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
  // A basic land pack's summary opens on its counts by land and edition (v0.9.0).
  const lands = opening.product.kind === "lands";
  const [byEdition, setByEdition] = useState(lands);
  const timers = useRef<number[]>([]);
  const board = useRef<HTMLDivElement>(null);
  const pack = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
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
  // Each stage gives the keyboard to what it is about: the pack to tear, the cards to turn,
  // the summary's title. In its window (v0.9.9) the pack must be given it: the browser's own
  // choice as a pop-up opens is the first thing it finds, which may be the scrolling body.
  // Nothing scrolls for it: the body stays where it is.
  useEffect(() => {
    if (stage === "sealed") pack.current?.focus({ preventScroll: true });
    if (stage === "revealing") board.current?.focus({ preventScroll: true });
    if (stage === "summary") heading.current?.focus({ preventScroll: true });
  }, [stage]);
  // A pack opened here, not one from the history, tells the tutorial's tour (v0.8.4).
  useEffect(() => {
    if (stage === "summary" && !startOpen && tutorial)
      signalTutorial("pack_opened", cards);
  }, [stage, startOpen, cards, tutorial]);
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
    if (!next) return;
    flip(next);
    // Space turns the cards in order: in a large pack the next one may lie outside the window's
    // view (v0.9.9), so the body scrolls just far enough to show it.
    board.current
      ?.querySelector(`[data-position="${next.position}"]`)
      ?.scrollIntoView?.({
        block: "nearest",
        behavior: reduced ? "auto" : "smooth",
      });
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

  // The window is one scrolling surface (v0.9.9): the wheel over its head or its foot, and the
  // scrolling keys while the keyboard is there (the summary's title, a button), scroll the
  // body, as they did when the pack was part of a page that scrolled. Without this the wheel
  // would do nothing right after a press of Reveal all, with the pointer still on the foot.
  function onWheel(event: WheelEvent<HTMLElement>) {
    const area = body.current;
    if (!area || event.ctrlKey || !outsideBody(event)) return;
    // A wheel may count in pixels, in lines or in pages.
    const unit =
      event.deltaMode === 1
        ? LINE
        : event.deltaMode === 2
          ? area.clientHeight
          : 1;
    area.scrollTop += event.deltaY * unit;
  }

  function onScrollKey(event: KeyboardEvent<HTMLElement>) {
    const area = body.current;
    if (!area || event.defaultPrevented || !outsideBody(event)) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const page = Math.max(LINE, area.clientHeight - LINE);
    let top: number;
    if (event.key === "ArrowDown") top = area.scrollTop + LINE;
    else if (event.key === "ArrowUp") top = area.scrollTop - LINE;
    else if (event.key === "PageDown") top = area.scrollTop + page;
    else if (event.key === "PageUp") top = area.scrollTop - page;
    else if (event.key === "Home") top = 0;
    else if (event.key === "End") top = area.scrollHeight;
    else if (event.key === " " || event.key === "Spacebar") {
      // Space presses the button that has it; elsewhere it turns a page, as in any page.
      const target = event.target as HTMLElement;
      if (target.closest("button, a, input, select, textarea, summary")) return;
      top = area.scrollTop + (event.shiftKey ? -page : page);
    } else return;
    event.preventDefault();
    area.scrollTop = top;
  }

  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== " " && event.key !== "Spacebar") return;
    // A focused button answers Space itself.
    const target = event.target as HTMLElement;
    if (target.closest("button, input, select, textarea, a")) return;
    event.preventDefault();
    flipNext();
  }

  // The window's own way out, at every stage (v0.9.9): the page under it cannot be reached
  // while it is up, and the server gave the cards before any of this. It is drawn in the
  // window's top corner but comes last in it, so that an opening window gives the keyboard to
  // the pack, not to the way out.
  const close = (
    <button
      type="button"
      className={styles.windowClose}
      aria-label="Close"
      title="Close. The cards are already in your library."
      onClick={onDone}
    >
      ×
    </button>
  );
  const newCards = cards.filter((card) => card.new).length;
  const foils = cards.filter((card) => card.finish !== "nonfoil").length;
  const title = opening.product.name;

  if (stage === "summary")
    return (
      <section
        className={styles.opening}
        aria-labelledby="opening-summary-title"
        data-stage="summary"
        onWheel={onWheel}
        onKeyDown={onScrollKey}
      >
        <LengBackdrop />
        <header className={styles.openingHead}>
          <span className={shell.eyebrow}>{noun.toUpperCase()} OPENED</span>
          <h2 id="opening-summary-title" ref={heading} tabIndex={-1}>
            {title}
          </h2>
          <p className={styles.note}>
            {summaryLine ??
              `${cards.length} cards · ${newCards} new to your library`}
            {foils ? ` · ${foils} foil${foils === 1 ? "" : "s"}` : ""}. Every
            card is now in your library for good.
          </p>
        </header>
        {/* Its own key: the summary starts at its top, wherever the cards were scrolled to. */}
        <div
          key="summary"
          ref={body}
          className={styles.openingBody}
          data-opening-scroll
        >
          {deck && <DeckChoicePanel choice={deck} />}
          {lands && (
            <div
              className={styles.viewSwitch}
              role="group"
              aria-label="Show the pack"
            >
              <button
                type="button"
                className={styles.secondary}
                aria-pressed={byEdition}
                onClick={() => setByEdition(true)}
              >
                By land and edition
              </button>
              <button
                type="button"
                className={styles.secondary}
                aria-pressed={!byEdition}
                onClick={() => setByEdition(false)}
              >
                Every card
              </button>
            </div>
          )}
          {lands && byEdition ? (
            <LandTally cards={cards} />
          ) : (
            <ul className={styles.summary} aria-label="Cards in the pack">
              {cards.map((card) => (
                <li
                  key={card.position}
                  className={styles.summaryCard}
                  data-glow={glowOf(card) ?? undefined}
                  data-finish={card.finish}
                >
                  {/* The card itself opens its details (v0.9.1, the owner's request). */}
                  <button
                    type="button"
                    className={styles.faceButton}
                    aria-label={`Details of ${card.name}`}
                    onClick={() => setDetails(card)}
                  >
                    <CardFace card={card} glow />
                  </button>
                  <div className={styles.summaryText}>
                    <strong>{card.name}</strong>
                    <span>
                      {rarityLabels[card.rarity] ?? card.rarity}
                      {card.finish === "foil" && " · Foil"}
                      {card.finish === "etched" && " · Etched foil"}
                    </span>
                    {/* v0.6.2: the game has no rules for it yet; casual games play it as a stand-in. */}
                    {card.stand_in && (
                      <span
                        className={styles.standIn}
                        title="The game has no rules for this card yet: in casual games it plays as a stand-in with its cost, types, power and toughness."
                      >
                        Stand-in
                      </span>
                    )}
                    {/* Before v0.6.2 a card the game could not play gave way to this one; the
                    card drawn, listed before it, is now the player's too. */}
                    {card.extra && (
                      <span className={styles.extraMark}>
                        Extra: given in place of the card before it, which is
                        now yours too
                      </span>
                    )}
                    {/* New: the library held no copy of this edition before (v0.5.0). */}
                    {card.new && <span className={styles.newMark}>New</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div
          className={`${styles.actions} ${styles.openingFoot}`}
          data-opening-foot
        >
          {onAnother && remaining > 0 && (
            <button type="button" className={shell.primary} onClick={onAnother}>
              Open another {kindLabels[opening.product.kind] ?? "pack"} (
              {remaining} left)
            </button>
          )}
          <button type="button" className={styles.secondary} onClick={onDone}>
            {doneLabel}
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
          {/* Only the edition the pack held (v0.5.0, the owner's request): not every printing. */}
          {details && (
            <CardDetails
              cardId={details.card_id}
              chosenPrinting={details.printing_id}
              printings="chosen"
              finish={details.finish}
            />
          )}
        </dialog>
        {close}
      </section>
    );

  const left = cards.length - shown.size;
  return (
    <section
      className={styles.opening}
      aria-labelledby="opening-title"
      data-stage={stage}
      onWheel={onWheel}
      onKeyDown={onScrollKey}
    >
      <LengBackdrop />
      {/* The tour points at the head: the whole window would leave its bubble no room. */}
      <header className={styles.openingHead} data-tour="pack-opening">
        <span className={shell.eyebrow}>OPENING A {noun.toUpperCase()}</span>
        <h2 id="opening-title">{title}</h2>
        {stage !== "sealed" && stage !== "tearing" && (
          <p className={styles.note}>
            {stage === "dealing"
              ? "Dealing the cards…"
              : left
                ? `Click a card, or press Space, to turn it over. ${left} to go.`
                : "Every card is revealed."}
          </p>
        )}
      </header>
      <div
        key="cards"
        ref={body}
        className={styles.openingBody}
        data-opening-scroll
      >
        {stage === "sealed" || stage === "tearing" ? (
          <div className={styles.packStage}>
            <button
              ref={pack}
              type="button"
              className={styles.pack}
              data-torn={stage === "tearing" || undefined}
              onClick={stage === "sealed" ? tear : undefined}
              aria-label={`Tear open the ${title}`}
              data-tour="pack-tear"
            >
              {/* The same picture twice: the strip that tears off, and the rest of the pack. */}
              <span className={styles.packTop} aria-hidden="true">
                {art ?? (
                  <PackArt product={opening.product} size="large" height={20} />
                )}
              </span>
              <span className={styles.packBody} aria-hidden="true">
                {art ?? (
                  <PackArt product={opening.product} size="large" height={20} />
                )}
              </span>
            </button>
            <p className={styles.note}>
              {stage === "sealed"
                ? `Click the ${noun} to tear it open.`
                : "Tearing it open…"}
            </p>
          </div>
        ) : (
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
                  <li
                    key={card.position}
                    className={styles.slot}
                    data-position={card.position}
                  >
                    <button
                      type="button"
                      /* A foil turned up glows (v0.6.0): on the button, outside the turning
                         card. */
                      className={[
                        styles.card,
                        up ? foilGlow(card.finish) : undefined,
                      ]
                        .filter(Boolean)
                        .join(" ")}
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
        )}
      </div>
      {stage === "revealing" && (
        <div
          className={`${styles.actions} ${styles.openingFoot}`}
          data-opening-foot
        >
          {left > 0 ? (
            <button
              type="button"
              className={shell.primary}
              onClick={revealAll}
              data-tour="pack-reveal"
            >
              Reveal all
            </button>
          ) : (
            <button
              type="button"
              className={shell.primary}
              onClick={() => setStage("summary")}
            >
              See the summary
            </button>
          )}
        </div>
      )}
      <p className={styles.hidden} role="status" aria-live="polite">
        {announced}
      </p>
      {close}
    </section>
  );
}
