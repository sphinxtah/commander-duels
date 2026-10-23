import { useEffect, useState } from "react";
import { client } from "../api";
import type { components } from "../generated/api";

// Human tables (v0.4.0, docs/tables.md): what the lobby and a table's page share.

export type TableView = components["schemas"]["TableView"];
export type TablePlayer = components["schemas"]["TablePlayer"];
export type OwnDeck = components["schemas"]["DeckSummary"];
export type TableFormat = TableView["format"];
export type TableRules = components["schemas"]["TableRules"];

/** How often the lobby and a table's page ask again: who sat down, who is ready, the start. */
export const POLL_MS = 3000;

export const formatNames: Record<TableFormat, string> = {
  legacy: "Legacy",
  commander: "Commander",
  two_headed_giant: "Two-Headed Giant",
};

/** Two-Headed Giant (v0.5.1): four seats in two teams, seats 0 and 1 against 2 and 3. */
export const TEAM_FORMAT = "two_headed_giant";

/** The format a table's decks are built for, whose legality its rules follow: Two-Headed Giant
 * plays Legacy decks. */
export function deckFormat(format: TableFormat): "legacy" | "commander" {
  return format === TEAM_FORMAT ? "legacy" : format;
}

/** A team's name as the lobby says it: "Team 1", "Team 2". */
export function teamName(team: number): string {
  return `Team ${team + 1}`;
}

/** A new table's rules, and a new practice game's (v0.4.5): every card, whatever its legality. */
export const casualRules: TableRules = { banned: true, not_legal: true };
/** Neither banned cards nor cards not legal in the format. */
export const tournamentRules: TableRules = { banned: false, not_legal: false };

/** A table's rules as one tag: Casual, Tournament rules, or the one kind of card it allows. */
export function rulesTag(rules: TableRules, format: TableFormat): string {
  if (rules.banned && rules.not_legal) return "Casual";
  if (!rules.banned && !rules.not_legal) return "Tournament rules";
  return rules.banned
    ? "Banned cards allowed"
    : `Cards not legal in ${formatNames[deckFormat(format)]} allowed`;
}

/** A table's rules in a sentence, for its own page. */
export function rulesSentence(rules: TableRules, format: TableFormat): string {
  const name = formatNames[deckFormat(format)];
  if (rules.banned && rules.not_legal)
    return `Casual: decks may hold banned cards and cards not legal in ${name}.`;
  if (!rules.banned && !rules.not_legal)
    return `Tournament rules: no banned cards, and no cards not legal in ${name}.`;
  return rules.banned
    ? `Decks may hold banned cards, but no cards not legal in ${name}.`
    : `Decks may hold cards not legal in ${name}, but no banned cards.`;
}

/** Why a deck cannot sit at a table with these rules, or null when it can: the stored flags of
 * the deck list, which the server checks again. */
export function unfit(deck: OwnDeck, rules: TableRules): string | null {
  if (!deck.playable)
    return deck.collection_locked
      ? "needs cards you don't own"
      : "not playable yet";
  const refused = deck.needs.filter((need) => !rules[need]);
  if (refused.length === 0) return null;
  const name = formatNames[deckFormat(deck.format)];
  return refused.length > 1
    ? `holds banned cards and cards not legal in ${name}`
    : refused[0] === "banned"
      ? "holds banned cards"
      : `holds cards not legal in ${name}`;
}

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
