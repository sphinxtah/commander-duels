import { useEffect, useState } from "react";
import { client } from "../api";
import type { components } from "../generated/api";

// Human tables (v0.4.0, docs/tables.md): what the lobby and a table's page share.

export type TableView = components["schemas"]["TableView"];
export type TablePlayer = components["schemas"]["TablePlayer"];
export type OwnDeck = components["schemas"]["DeckSummary"];
export type TableFormat = TableView["format"];

/** How often the lobby and a table's page ask again: who sat down, who is ready, the start. */
export const POLL_MS = 3000;

export const formatNames: Record<TableFormat, string> = {
  legacy: "Legacy",
  commander: "Commander",
};

/** Asks again every POLL_MS while the page is shown; the answer of an unmounted page is dropped.
 * The second value asks again now. */
export function usePolled<T>(
  load: () => Promise<T | undefined>,
): [T | undefined, () => void] {
  const [value, setValue] = useState<T>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let active = true;
    void load().then((found) => {
      if (active && found !== undefined) setValue(found);
    });
    const timer = window.setTimeout(() => setTick((n) => n + 1), POLL_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [load, tick]);
  return [value, () => setTick((n) => n + 1)];
}

/** The account's decks; null until they arrive. */
export function useOwnDecks(): OwnDeck[] | null {
  const [decks, setDecks] = useState<OwnDeck[] | null>(null);
  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/decks", { params: { query: { view: "active" } } })
      .then(({ data }) => {
        if (active) setDecks(data ?? []);
      });
    return () => {
      active = false;
    };
  }, []);
  return decks;
}
