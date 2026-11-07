import { useSyncExternalStore } from "react";
import { client } from "../api";

/**
 * The card back this player's table draws (v0.8.8): the official Magic card back, or a campaign
 * reward's (api/cosmetics.py) chosen on the Campaign page. One value for the whole app, read by the
 * DOM's card faces and the table's canvas, loaded from the server once per session and changed
 * when the player chooses another.
 */
export const OFFICIAL_BACK = "/brand/card-back.webp";

let slug: string | null = null;
let loaded = false;
const listeners = new Set<() => void>();

/** The picture of a back by its slug; the official one for none. */
export function backUrl(chosen: string | null): string {
  return chosen ? `/brand/backs/${chosen}.svg` : OFFICIAL_BACK;
}

export function cardBackUrl(): string {
  return backUrl(slug);
}

export function setCardBack(chosen: string | null): void {
  loaded = true;
  if (chosen === slug) return;
  slug = chosen;
  for (const listener of listeners) listener();
}

export function onCardBack(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Asks the server which back the player uses, once; a failure keeps the official one. */
export function loadCardBack(): void {
  if (loaded) return;
  loaded = true;
  void client
    .GET("/api/v1/me/cosmetics")
    .then(({ data }) => {
      if (data) setCardBack(data.card_back ?? null);
    })
    .catch(() => {
      // The official back stays.
    });
}

/** The back's picture, for a component that draws one. */
export function useCardBack(): string {
  return useSyncExternalStore(onCardBack, cardBackUrl, cardBackUrl);
}

/** For tests: back to the official back, not yet asked. */
export function resetCardBack(): void {
  slug = null;
  loaded = false;
  for (const listener of listeners) listener();
}
