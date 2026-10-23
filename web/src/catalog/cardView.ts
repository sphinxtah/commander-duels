import { useState } from "react";

/** How the Cards page shows its cards (v0.5.0): their pictures, or a list of their names. */
export type CardView = "pictures" | "list";

const KEY = "cd.cards.view.v1";

/** The view this browser chose last; pictures, as the owner asked, until it chooses. */
export function readCardView(): CardView {
  try {
    return localStorage.getItem(KEY) === "list" ? "list" : "pictures";
  } catch {
    return "pictures";
  }
}

export function saveCardView(view: CardView): void {
  try {
    localStorage.setItem(KEY, view);
  } catch {
    // A browser that keeps nothing still switches, for this visit.
  }
}

/** The Cards page's view, shared by its tabs and remembered in this browser. */
export function useCardView(): [CardView, (view: CardView) => void] {
  const [view, setView] = useState<CardView>(readCardView);
  return [
    view,
    (chosen) => {
      saveCardView(chosen);
      setView(chosen);
    },
  ];
}
