import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import styles from "./tutorial.module.css";

// The tutorial's pointers (v0.8.4): a tip written into a form, with its arrow pointing at what
// follows, and the tour's coach, a bubble with an arrow at something on the page, found by its
// data-tour name, and a ring around it. Neither ever covers or blocks what it points at.

/** A tip inside a form, numbered, its arrow pointing down at the field it explains. */
export function TourTip({
  step,
  children,
}: {
  step?: number;
  children: ReactNode;
}) {
  return (
    <p className={styles.tip} role="note">
      {step !== undefined && (
        <span className={styles.tipStep} aria-label={`Step ${step}`}>
          {step}
        </span>
      )}
      <span>{children}</span>
    </p>
  );
}

/** One thing the coach may point at: the first of a list found on the page wins. */
export interface CoachStep {
  /** A data-tour name; none floats the bubble in the corner, pointing at nothing. */
  target?: string;
  /** Where a page carries no data-tour name for the target (v0.8.5): finds it otherwise, tried
   * after the name. */
  locate?: () => HTMLElement | null;
  title: string;
  text: ReactNode;
  /** This step's own buttons, before the coach's. */
  actions?: ReactNode;
}

/** The element a step points at: its data-tour name first, then its selector. */
function targetOf(step: CoachStep): HTMLElement | null {
  if (!step.target) return null;
  const named = document.querySelector<HTMLElement>(
    `[data-tour="${step.target}"]`,
  );
  return named ?? step.locate?.() ?? null;
}

interface Placed {
  step: CoachStep;
  rect: DOMRect | null;
  /** The open dialog the target is in, which the coach is drawn into. */
  host: HTMLElement | null;
}

const BUBBLE = 340;
/** Between the bubble and its target, room for the arrow and the ring. */
const GAP = 18;
/** The least room kept clear at the window's edges. */
const EDGE = 12;
/** The ring's reach outside its target (its 6 px inset and its 4 px glow). */
const RING = 10;
/** Before the bubble is measured, a guess at its height. */
const GUESS = 190;
/** Where the arrow may sit along the bubble, clear of its rounded corners. */
const ARROW_INSET = 22;
/** How much of a target's top stays uncovered when it is too tall for the bubble beside it. */
export const VISIBLE = 56;

export interface CoachPlacement {
  /** Below or above the target, or (a short, wide window: a phone turned sideways) to its right
   * or left; "corner" when there is no target, "over" when no side has room and the bubble lies
   * over the target's lower part, its top left uncovered. */
  side: "below" | "above" | "right" | "left" | "corner" | "over";
  left: number;
  top: number;
  width: number;
  /** The arrow's distance along the bubble's edge (from its left below and above, from its top
   * beside); null for none. */
  arrow: number | null;
}

/** Where the bubble goes in a window of the given size, for a target's rect (viewport units)
 * and the bubble's measured height: below the target when it fits, above when that fits better,
 * always inside the window, and never over the target or its ring while a side has room. A
 * target too tall for that leaves the bubble at the window's foot, over its lower part only. */
export function placeCoach(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height"> | null,
  height: number,
  viewport: { width: number; height: number; top?: number },
): CoachPlacement {
  // The page's top may lie under a sticky bar: the bubble keeps below it, unless the target is
  // in the bar itself.
  const inset =
    rect && rect.top + rect.height <= (viewport.top ?? 0)
      ? 0
      : (viewport.top ?? 0);
  const ceiling = inset + EDGE;
  const width = Math.min(BUBBLE, viewport.width - 2 * EDGE);
  const maxLeft = viewport.width - width - EDGE;
  if (!rect) {
    // The lower right corner, above the chat bar and the music's pill.
    return {
      side: "corner",
      left: maxLeft,
      top: Math.max(ceiling, viewport.height - height - 88),
      width,
      arrow: null,
    };
  }
  const bottom = rect.top + rect.height;
  const centre = rect.left + rect.width / 2;
  const left = Math.max(EDGE, Math.min(centre - width / 2, maxLeft));
  const arrow = Math.max(
    ARROW_INSET,
    Math.min(centre - left, width - ARROW_INSET),
  );
  const roomBelow = viewport.height - EDGE - (bottom + GAP);
  const roomAbove = rect.top - GAP - ceiling;
  const clampTop = (top: number) =>
    Math.max(ceiling, Math.min(top, viewport.height - height - EDGE));
  if (roomBelow >= height)
    return { side: "below", left, top: bottom + GAP, width, arrow };
  if (roomAbove >= height)
    return { side: "above", left, top: rect.top - GAP - height, width, arrow };
  // A short, wide window: beside the target, level with it.
  const middle = rect.top + rect.height / 2;
  const besideTop = clampTop(middle - height / 2);
  const besideArrow = Math.max(
    ARROW_INSET,
    Math.min(middle - besideTop, height - ARROW_INSET),
  );
  const right = rect.left + rect.width + GAP;
  if (right + width <= viewport.width - EDGE)
    return {
      side: "right",
      left: right,
      top: besideTop,
      width,
      arrow: besideArrow,
    };
  if (rect.left - GAP - width >= EDGE)
    return {
      side: "left",
      left: rect.left - GAP - width,
      top: besideTop,
      width,
      arrow: besideArrow,
    };
  // No side has room (a tile taller than a phone turned sideways): the bubble keeps to the
  // window's foot, so the target's top, where its name is, stays in view and can be pressed;
  // or to its head, when the target lies low in the window.
  const foot = clampTop(viewport.height - height - EDGE);
  if (rect.top + VISIBLE <= foot)
    return {
      side: foot < bottom ? "over" : "below",
      left,
      top: foot,
      width,
      arrow,
    };
  return { side: "above", left, top: ceiling, width, arrow };
}

function find(steps: CoachStep[]): Placed | null {
  const open = [
    ...document.querySelectorAll<HTMLDialogElement>("dialog[open]"),
  ];
  for (const step of steps) {
    if (!step.target) {
      // A dialog over the page hides a bubble that points at nothing on it.
      return open.length ? null : { step, rect: null, host: null };
    }
    const element = targetOf(step);
    if (!element) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const host = open.find((dialog) => dialog.contains(element)) ?? null;
    // Something modal over the target: the coach waits until it closes.
    if (open.length && !host) return null;
    return { step, rect, host };
  }
  return null;
}

interface Viewport {
  width: number;
  height: number;
  /** What the sticky top bar covers of the window's top. */
  top: number;
}

/** The page's sticky top bar's foot, when it is stuck to the window's top. */
function barFoot(): number {
  const bar = document.querySelector("header")?.getBoundingClientRect();
  return bar && bar.top <= 0 && bar.bottom > 0 ? Math.round(bar.bottom) : 0;
}

function viewport(): Viewport {
  // The visual viewport is the part of the page a phone shows (it shrinks for the keyboard and
  // the browser's bars); the layout viewport's size where there is none.
  const visual = window.visualViewport;
  return {
    width: Math.round(
      Math.min(window.innerWidth, visual?.width ?? Infinity) || 0,
    ),
    height: Math.round(
      Math.min(window.innerHeight, visual?.height ?? Infinity) || 0,
    ),
    top: barFoot(),
  };
}

/** Brings a target into view once, with room beside it for the bubble where the window allows:
 * below it on a phone's tall window, else centred. */
function bringIntoView(element: HTMLElement, bubble: number): void {
  const rect = element.getBoundingClientRect();
  const view = viewport();
  const top = rect.top - RING;
  const bottom = rect.bottom + RING;
  // The sticky top bar covers the page's top: what lies under it is not in view.
  const clear = view.top + EDGE;
  const roomy = (at: number) =>
    at >= clear &&
    (at + (bottom - top) + GAP + bubble <= view.height - EDGE ||
      at - GAP - bubble >= clear);
  if (roomy(top) && bottom <= view.height - EDGE) return;
  // Where the target's top should be: under the bar with the bubble below it, if both fit;
  // else centred.
  const height = bottom - top;
  const wanted =
    clear + height + GAP + bubble <= view.height - EDGE
      ? clear
      : Math.max(clear, (view.height - height) / 2);
  if (Math.abs(top - wanted) < 2) return;
  const reduced = document.documentElement.dataset.reducedMotion === "true";
  window.scrollBy({
    top: top - wanted,
    behavior: reduced ? "auto" : "smooth",
  });
}

/** How long after a target appears, or the window turns, the coach keeps it in view while the
 * page settles (pictures and lists arriving move it), unless the player scrolls first. */
const SETTLE_MS = 2_500;

/** The tour's bubble: it follows its target as the page scrolls, resizes, turns and changes. */
export function Coach({
  steps,
  actions,
  label = "Tour",
}: {
  steps: CoachStep[];
  actions?: ReactNode;
  label?: string;
}) {
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [size, setSize] = useState(viewport);
  const [height, setHeight] = useState(GUESS);
  const bubbleRef = useRef<HTMLElement | null>(null);
  /** The target last brought into view, and until when it is kept there. */
  const scrolled = useRef<{ target: string; until: number } | null>(null);
  const latest = useRef(steps);
  latest.current = steps;
  const heightNow = useRef(height);
  heightNow.current = height;

  useLayoutEffect(() => {
    let frame = 0;
    // keep: bring the target into view again while the page settles. Never from a scroll event,
    // which a smooth scroll sends every frame.
    const measure = (keep = false) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const found = find(latest.current);
        setPlaced((before) => (same(before, found) ? before : found));
        const now = viewport();
        setSize((before) =>
          before.width === now.width &&
          before.height === now.height &&
          before.top === now.top
            ? before
            : now,
        );
        // While the page settles, the target is kept in view.
        const kept = scrolled.current;
        if (
          keep &&
          found?.step.target &&
          !found.host &&
          kept &&
          Date.now() < kept.until
        ) {
          const element = targetOf(found.step);
          if (element) bringIntoView(element, heightNow.current);
        }
        const bubble = bubbleRef.current?.offsetHeight;
        if (bubble)
          setHeight((before) => (before === bubble ? before : bubble));
      });
    };
    // A resize or a turn of the phone keeps the target in view again, for a while.
    const resized = () => {
      if (scrolled.current)
        scrolled.current = {
          ...scrolled.current,
          until: Date.now() + SETTLE_MS,
        };
      measure(true);
    };
    const tick = () => measure(true);
    const moved = () => measure();
    // The player's own scrolling ends that at once.
    const own = () => {
      if (scrolled.current)
        scrolled.current = { ...scrolled.current, until: 0 };
    };
    measure();
    const timer = window.setInterval(tick, 300);
    const visual = window.visualViewport;
    window.addEventListener("resize", resized);
    window.addEventListener("orientationchange", resized);
    window.addEventListener("scroll", moved, true);
    window.addEventListener("wheel", own, { passive: true });
    window.addEventListener("touchstart", own, { passive: true });
    window.addEventListener("keydown", own);
    visual?.addEventListener("resize", resized);
    visual?.addEventListener("scroll", moved);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(timer);
      window.removeEventListener("resize", resized);
      window.removeEventListener("orientationchange", resized);
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("wheel", own);
      window.removeEventListener("touchstart", own);
      window.removeEventListener("keydown", own);
      visual?.removeEventListener("resize", resized);
      visual?.removeEventListener("scroll", moved);
    };
  }, []);
  // The bubble's own height, measured as soon as it is drawn (its words differ step to step).
  useLayoutEffect(() => {
    const bubble = bubbleRef.current?.offsetHeight;
    if (bubble && bubble !== height) setHeight(bubble);
  });
  // A new target is brought into view once, with room for the bubble beside it.
  useEffect(() => {
    const target = placed?.step.target;
    if (!target || scrolled.current?.target === target) return;
    scrolled.current = { target, until: Date.now() + SETTLE_MS };
    const element = targetOf(placed.step);
    // Inside a dialog the dialog scrolls itself; the page stays put.
    if (element && !placed?.host) bringIntoView(element, height);
  }, [placed?.step.target, placed?.host, height]);

  if (!placed) return null;
  const { rect } = placed;
  // The words as they are now (a balance, a card's name), for the step found.
  const step =
    steps.find(
      (s) => s.target === placed.step.target && s.title === placed.step.title,
    ) ?? placed.step;
  const place = placeCoach(rect, height, size);
  const style: CSSProperties = {
    left: place.left,
    top: place.top,
    width: place.width,
  };
  const arrowSide = {
    below: "up",
    over: "up",
    above: "down",
    right: "left",
    left: "right",
    corner: null,
  }[place.side];
  const across = arrowSide === "left" || arrowSide === "right";
  const bubble = (
    <>
      {rect && (
        <div
          className={styles.ring}
          aria-hidden="true"
          style={ringStyle(rect, size)}
        />
      )}
      <section
        ref={bubbleRef}
        className={styles.coach}
        style={style}
        aria-label={label}
        data-tutorial="coach"
        data-target={step.target ?? ""}
        data-side={place.side}
      >
        {arrowSide && place.arrow !== null && (
          <span
            className={styles.coachArrow}
            data-side={arrowSide}
            style={across ? { top: place.arrow } : { left: place.arrow }}
            aria-hidden="true"
          />
        )}
        <h2 className={styles.coachTitle}>{step.title}</h2>
        <p aria-live="polite" className={styles.coachText}>
          {step.text}
        </p>
        {(step.actions || actions) && (
          <div className={styles.coachActions}>
            {step.actions}
            {actions}
          </div>
        )}
      </section>
    </>
  );
  return createPortal(bubble, placed.host ?? document.body);
}

/** The ring around the target, kept inside the window (a tile wider than a phone, a target
 * scrolled half out of view) so its glow is never cut off on one side only. */
function ringStyle(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  size: Viewport,
): CSSProperties {
  const inset = 6;
  const keep = 4;
  // A target below the sticky bar keeps its ring below it too.
  const under = rect.top + rect.height > size.top ? size.top : 0;
  const left = Math.max(keep, rect.left - inset);
  const top = Math.max(keep + under, rect.top - inset);
  const right = Math.min(size.width - keep, rect.left + rect.width + inset);
  const bottom = Math.min(size.height - keep, rect.top + rect.height + inset);
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function same(a: Placed | null, b: Placed | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (
    a.step.target !== b.step.target ||
    a.step.title !== b.step.title ||
    a.host !== b.host
  )
    return false;
  if (!a.rect || !b.rect) return a.rect === b.rect;
  return (
    Math.round(a.rect.left) === Math.round(b.rect.left) &&
    Math.round(a.rect.top) === Math.round(b.rect.top) &&
    Math.round(a.rect.width) === Math.round(b.rect.width) &&
    Math.round(a.rect.height) === Math.round(b.rect.height)
  );
}
