import { useState } from "react";
import type { CardView } from "../catalog/cardView";

// How the deck editor shows a deck (v0.6.2, the owner's request): its cards' pictures by
// default, or the list it had before. Remembered in this browser, apart from the Cards page's.

const KEY = "cd.decks.view.v1";

export function readDeckView(): CardView {
  try {
    return localStorage.getItem(KEY) === "list" ? "list" : "pictures";
  } catch {
    return "pictures";
  }
}

export function saveDeckView(view: CardView): void {
  try {
    localStorage.setItem(KEY, view);
  } catch {
    // A browser that keeps nothing still switches, for this visit.
  }
}

export function useDeckView(): [CardView, (view: CardView) => void] {
  const [view, setView] = useState<CardView>(readDeckView);
  return [
    view,
    (chosen) => {
      saveDeckView(chosen);
      setView(chosen);
    },
  ];
}
