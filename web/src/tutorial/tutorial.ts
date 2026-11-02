import { useEffect, useRef } from "react";
import { client, describe, type Me } from "../api";

// The first-time tutorial (v0.8.4, docs/menus.md#the-tutorial): its path and stage live on the
// account (PUT /api/v1/me/tutorial), so a reload or another device picks up where the player
// was. The pages it walks through say what happened (a pack opened, a card listed) with a window
// event, which the tour listens for.

export type Tutorial = Me["tutorial"];
export type TutorialStage = Tutorial["stage"];
export type TutorialPath = NonNullable<Tutorial["path"]>;

/** The address of the Beginner's watched game. */
export const DEMO_ROUTE = "#tutorial/demo";

/** Moves the account's tutorial along; the account as the server now has it, or an error. */
export async function moveTutorial(change: {
  stage: TutorialStage;
  path?: TutorialPath;
  skipped?: boolean;
}): Promise<{ me: Me } | { error: string }> {
  try {
    const { data, error } = await client.PUT("/api/v1/me/tutorial", {
      body: {
        stage: change.stage,
        path: change.path ?? null,
        skipped: change.skipped ?? false,
      },
    });
    return data ? { me: data } : { error: describe(error) };
  } catch {
    return { error: "The tutorial could not be saved. Check your connection." };
  }
}

/** Whether the path has the setup's tips and the main menu's tour. */
export function guided(tutorial: Tutorial): boolean {
  return tutorial.path === "beginner" || tutorial.path === "novice";
}

/** The main menu's tour's stages, in order: Leng's shop, Tivit's, then (v0.8.5) Decks and the
 * Play page. */
export const TOUR_STAGES = [
  "tour_shop",
  "tour_auctions",
  "tour_decks",
  "tour_play",
] as const satisfies readonly TutorialStage[];
export type TourStage = (typeof TOUR_STAGES)[number];

/** Whether the main menu's tour is on. */
export function touring(me: Me | null | undefined): boolean {
  const stage = me?.tutorial?.stage;
  return (TOUR_STAGES as readonly string[]).includes(stage ?? "");
}

/** Whether the wizard should open by itself for the tutorial: before the setup's own steps, and
 * for a guided player whose setup has not yet led on to the tour. */
export function tutorialPending(me: Me): boolean {
  const tutorial = me.tutorial;
  if (!tutorial) return false;
  const stage = tutorial.stage;
  return (
    stage === "choose" ||
    stage === "demo" ||
    stage === "overview" ||
    (stage === "setup" && guided(tutorial))
  );
}

/* ---------- what the pages tell the tour ---------- */

const EVENT = "cd:tutorial";
export type TutorialSignal = "pack_opened" | "card_listed";

interface SignalDetail {
  signal: TutorialSignal;
  /** pack_opened: the pack's cards. */
  cards?: readonly Pulled[];
}

export function signalTutorial(
  signal: TutorialSignal,
  cards?: readonly Pulled[],
): void {
  window.dispatchEvent(
    new CustomEvent<SignalDetail>(EVENT, { detail: { signal, cards } }),
  );
}

export function useTutorialSignal(
  handler: (signal: TutorialSignal, cards: readonly Pulled[]) => void,
): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const listen = (event: Event) => {
      const detail = (event as CustomEvent<SignalDetail>).detail;
      latest.current(detail.signal, detail.cards ?? []);
    };
    window.addEventListener(EVENT, listen);
    return () => window.removeEventListener(EVENT, listen);
  }, []);
}

/* ---------- the card the tour lists ---------- */

/** A card from the pack the tour opened, to list at Tivit's. */
export interface TourCard {
  printingId: string;
  name: string;
  rarity: string;
  finish: string;
}

const CARD_KEY = "cd.tutorial.card";
const RANK: Record<string, number> = {
  special: 5,
  mythic: 4,
  rare: 3,
  uncommon: 2,
  common: 1,
};

export interface Pulled {
  printing_id: string;
  name: string;
  rarity: string;
  finish: string;
  type_line: string;
  stand_in: boolean;
}

/** The pack's best card to list: its rarest, a foil before a plain one, never a basic land. */
export function bestPulled(cards: readonly Pulled[]): TourCard | null {
  let best: Pulled | null = null;
  const score = (card: Pulled) =>
    (RANK[card.rarity] ?? 0) * 2 + (card.finish === "nonfoil" ? 0 : 1);
  for (const card of cards) {
    if (card.stand_in || card.type_line.startsWith("Basic ")) continue;
    if (!best || score(card) > score(best)) best = card;
  }
  return best
    ? {
        printingId: best.printing_id,
        name: best.name,
        rarity: best.rarity,
        finish: best.finish,
      }
    : null;
}

export function rememberTourCard(card: TourCard | null): void {
  try {
    if (card) sessionStorage.setItem(CARD_KEY, JSON.stringify(card));
    else sessionStorage.removeItem(CARD_KEY);
  } catch {
    // Without storage the tour lets the player pick any card.
  }
}

export function tourCard(): TourCard | null {
  try {
    const raw = sessionStorage.getItem(CARD_KEY);
    if (!raw) return null;
    const card = JSON.parse(raw) as Partial<TourCard>;
    return typeof card.printingId === "string" && typeof card.name === "string"
      ? (card as TourCard)
      : null;
  } catch {
    return null;
  }
}

/** The prices the tour suggests for a first listing, by rarity: a starting bid that invites
 * bids, and a Buy Now three times it. Foils start at twice the bid. The player changes either
 * before listing; nothing is listed until they press List it. */
export function suggestedPrices(
  rarity: string,
  finish: string,
): { startingBid: number; buyNow: number } {
  const base: Record<string, number> = {
    common: 10,
    uncommon: 25,
    rare: 100,
    mythic: 250,
    special: 250,
  };
  const start = (base[rarity] ?? 25) * (finish === "nonfoil" ? 1 : 2);
  return { startingBid: start, buyNow: start * 3 };
}

/** The account's tutorial; one from before v0.8.4 that has none counts as done. */
export function tutorialOf(me: Me): Tutorial {
  return me.tutorial ?? { path: null, stage: "done", skipped: false };
}
