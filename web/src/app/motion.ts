import { useSyncExternalStore } from "react";
import type { MotionLevel, TableSettings } from "../game/table/types";

// The page's accessibility settings, for code that draws outside CSS (the PixiJS table, the
// timer's ring). App writes the account's choices to <html data-reduced-motion data-large-text>;
// the system's reduced-motion setting counts too, as it does in global.css.

const REDUCE = "(prefers-reduced-motion: reduce)";

function media(): MediaQueryList | null {
  try {
    return typeof window.matchMedia === "function"
      ? window.matchMedia(REDUCE)
      : null;
  } catch {
    return null;
  }
}

function subscribe(listener: () => void): () => void {
  const observer =
    typeof MutationObserver === "function"
      ? new MutationObserver(listener)
      : null;
  observer?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-reduced-motion", "data-large-text"],
  });
  const query = media();
  query?.addEventListener?.("change", listener);
  return () => {
    observer?.disconnect();
    query?.removeEventListener?.("change", listener);
  };
}

function reducedMotion(): boolean {
  return (
    document.documentElement.dataset.reducedMotion === "true" ||
    media()?.matches === true
  );
}

function largeText(): boolean {
  return document.documentElement.dataset.largeText === "true";
}

/** "none" whenever motion is reduced; otherwise the table's animation speed. */
export function useMotionLevel(
  speed: TableSettings["animationSpeed"],
): MotionLevel {
  const reduced = useSyncExternalStore(subscribe, reducedMotion, () => false);
  return reduced ? "none" : speed;
}

export function useLargeText(): boolean {
  return useSyncExternalStore(subscribe, largeText, () => false);
}
