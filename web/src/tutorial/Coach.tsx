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
  title: string;
  text: ReactNode;
}

interface Placed {
  step: CoachStep;
  rect: DOMRect | null;
  /** The open dialog the target is in, which the coach is drawn into. */
  host: HTMLElement | null;
}

const BUBBLE = 340;
const GAP = 18;

function find(steps: CoachStep[]): Placed | null {
  const open = [
    ...document.querySelectorAll<HTMLDialogElement>("dialog[open]"),
  ];
  for (const step of steps) {
    if (!step.target) {
      // A dialog over the page hides a bubble that points at nothing on it.
      return open.length ? null : { step, rect: null, host: null };
    }
    const element = document.querySelector<HTMLElement>(
      `[data-tour="${step.target}"]`,
    );
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

/** The tour's bubble: it follows its target as the page scrolls and changes. */
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
  const scrolled = useRef<string | null>(null);
  const latest = useRef(steps);
  latest.current = steps;

  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const found = find(latest.current);
        setPlaced((before) => (same(before, found) ? before : found));
      });
    };
    measure();
    const timer = window.setInterval(measure, 300);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(timer);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, []);
  // A new target is brought into view once.
  useEffect(() => {
    const target = placed?.step.target;
    if (!target || scrolled.current === target) return;
    scrolled.current = target;
    const element = document.querySelector<HTMLElement>(
      `[data-tour="${target}"]`,
    );
    const rect = element?.getBoundingClientRect();
    if (rect && (rect.top < 80 || rect.bottom > window.innerHeight - 40))
      element?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [placed?.step.target]);

  if (!placed) return null;
  const { rect } = placed;
  // The words as they are now (a balance, a card's name), for the step found.
  const step =
    steps.find(
      (s) => s.target === placed.step.target && s.title === placed.step.title,
    ) ?? placed.step;
  const width = Math.min(BUBBLE, window.innerWidth - 32);
  let style: CSSProperties;
  let arrow: "up" | "down" | null = null;
  let arrowLeft = 0;
  if (rect) {
    const centre = rect.left + rect.width / 2;
    const left = Math.max(
      16,
      Math.min(centre - width / 2, window.innerWidth - width - 16),
    );
    arrowLeft = Math.max(18, Math.min(centre - left, width - 18));
    const below =
      rect.bottom + GAP + 190 < window.innerHeight || rect.top < 220;
    arrow = below ? "up" : "down";
    style = below
      ? { left, top: rect.bottom + GAP, width }
      : { left, bottom: window.innerHeight - rect.top + GAP, width };
  } else {
    style = { right: 16, bottom: 88, width };
  }
  const bubble = (
    <>
      {rect && (
        <div
          className={styles.ring}
          aria-hidden="true"
          style={{
            left: rect.left - 6,
            top: rect.top - 6,
            width: rect.width + 12,
            height: rect.height + 12,
          }}
        />
      )}
      <section
        className={styles.coach}
        style={style}
        aria-label={label}
        data-tutorial="coach"
        data-target={step.target ?? ""}
      >
        {arrow && (
          <span
            className={styles.coachArrow}
            data-side={arrow}
            style={{ left: arrowLeft }}
            aria-hidden="true"
          />
        )}
        <h2 className={styles.coachTitle}>{step.title}</h2>
        <p aria-live="polite" className={styles.coachText}>
          {step.text}
        </p>
        {actions && <div className={styles.coachActions}>{actions}</div>}
      </section>
    </>
  );
  return createPortal(bubble, placed.host ?? document.body);
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
