import { canFullscreen, enterTableFullscreen } from "../app/fullscreen";
import { readTableSettings } from "../app/tableSettings";
import {
  KINGS_SEATS,
  KINGS_TABLE,
  seatTitle,
  type KingsTableSettings,
} from "../tables/kingsTable";
import { unfit, type TableRules } from "../tables/tables";
import type { components } from "../generated/api";

// What the Play wizard (PlayWizard.tsx) and the list of an account's games (GamesList.tsx) share,
// and what other pages take from the practice game: a deck's name, a game's format and outcome,
// and filling the screen as a game starts. Until v1.0.0 these lived in the practice table's one
// page (PracticeTable.tsx), which the wizard replaced.

export type PracticeOptions = components["schemas"]["PracticeOptions"];
export type GameSummary = components["schemas"]["GameSummary"];
export type PracticeRequest = components["schemas"]["PracticeGameRequest"];
export type FixtureDeck = NonNullable<PracticeRequest["deck"]>;
export type BestOf = NonNullable<PracticeRequest["best_of"]>;
export type OwnDeck = components["schemas"]["DeckSummary"];
export type PracticeFormatId = PracticeRequest["format"];

/** Own decks ride in the deck selects as "own:<id>"; fixture decks by name. */
export const OWN = "own:";

export function seatChoice(value: string): {
  deck?: FixtureDeck;
  deck_id?: string;
} {
  if (value.startsWith(OWN)) return { deck_id: value.slice(OWN.length) };
  return value ? { deck: value as FixtureDeck } : {};
}

/** "commander-mono-red-raiders" reads "Mono-red raiders". */
export function deckName(deck: string | null | undefined): string {
  if (!deck) return "Custom list";
  const text = deck.replace(/^(legacy|commander)-/, "").replace(/-/g, " ");
  return (text.charAt(0).toUpperCase() + text.slice(1)).replace(
    /^Mono (\w+)/,
    "Mono-$1",
  );
}

const time = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
export function ago(iso: string): string {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60000);
  if (Math.abs(minutes) < 60) return time.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return time.format(hours, "hour");
  return time.format(Math.round(hours / 24), "day");
}

export function outcome(game: GameSummary): string {
  const left = game.seats.find((seat) => seat.seat === game.your_seat)?.left;
  // At a human table (v0.4.0) a seat may be out while the others play on.
  if (game.status === "active")
    return left === "removed"
      ? "Removed while away · the game goes on"
      : left
        ? "You are out · the game goes on"
        : "In progress";
  if (game.status === "interrupted") return "Interrupted";
  const result = game.result;
  if (!result) return "Finished";
  const turns = `${result.turns} turn${result.turns === 1 ? "" : "s"}`;
  if (result.draw) return `Draw after ${turns}`;
  // In Two-Headed Giant (v0.5.0) a team wins together.
  if (result.winner_seat !== null && game.your_seat !== null)
    return result.winner_seat === game.your_seat ||
      (result.winner_seats ?? []).includes(game.your_seat)
      ? `Won in ${turns}`
      : `Lost in ${turns}`;
  const kinds: Record<string, string> = {
    turn_limit: "Turn limit",
    closed: "Closed",
    idle_timeout: "Timed out",
    humans_eliminated: "Lost",
    error: "Engine error",
  };
  return `${kinds[result.kind] ?? "Finished"} after ${turns}`;
}

/** The account's own decks, then the engine's fixture decks: offered to SysOp only (v0.3.1), so
 * a player's lists are empty and get no group. A deck the game's rules do not take (v0.4.5) is
 * greyed with the reason, as one that cannot play. */
export function DeckOptions({
  fixtures,
  own,
  rules,
}: {
  fixtures: string[];
  own: OwnDeck[];
  rules: TableRules;
}) {
  return (
    <>
      {own.length > 0 && (
        <optgroup label="Your decks">
          {own.map((d) => {
            const reason = unfit(d, rules);
            return (
              <option
                key={d.id}
                value={`${OWN}${d.id}`}
                disabled={reason !== null}
              >
                {d.title}
                {reason ? ` (${reason})` : ""}
              </option>
            );
          })}
        </optgroup>
      )}
      {fixtures.length > 0 && (
        <optgroup label="Fixture decks">
          {fixtures.map((d) => (
            <option key={d} value={d}>
              {deckName(d)}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );
}

/**
 * Starting or resuming a game fills the screen (v0.3.0), unless the player turned it off. The
 * browser allows it only inside the click, so this runs before anything is awaited. A human
 * table's host starts with it too (v0.4.0).
 */
export function tableFullscreen(): Promise<boolean> | null {
  return readTableSettings().fullscreenOnStart && canFullscreen()
    ? enterTableFullscreen()
    : null;
}

/**
 * A Ctrl, Shift, Alt or Meta click (or another button) opens the game in another tab or window,
 * so this page stays where it is and must not fill the screen for it.
 */
export function plainClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey
  );
}

export const formatNames: Record<GameSummary["format"], string> = {
  legacy: "Legacy",
  commander: "Commander",
  two_headed_giant: "Two-Headed Giant",
  kings_table: "King's Table",
};

/** What each format's choice says: the bots and life (Two-Headed Giant marked early from v0.5.0
 * until v0.6.1). */
export const formatLines: Record<PracticeFormatId, string> = {
  legacy: "One bot, 20 life",
  commander: "One to three bots, 40 life",
  two_headed_giant: "A bot teammate against two bots, 30 life a team",
  kings_table:
    "Five bots: two teams of three, a King and two Generals each, in the seat you choose",
};

/** The format a game's decks are built for: Two-Headed Giant plays Legacy decks (v0.5.0), King's
 * Table the deck format of its settings (v0.8.7). */
export function deckFormat(
  format: PracticeFormatId,
  kings?: Pick<KingsTableSettings, "deck_format"> | null,
): "legacy" | "commander" {
  if (format === KINGS_TABLE) return kings?.deck_format ?? "commander";
  return format === "two_headed_giant" ? "legacy" : format;
}

/** King's Table's bots sit in the seats you leave, in seat order (v0.8.7). */
export function botSeatsOf(seat: number): number[] {
  return KINGS_SEATS.filter((other) => other !== seat);
}

/** A bot seat's deck choice, by its place at the table. */
export function botLabel(
  format: PracticeFormatId,
  bots: number,
  index: number,
  seat: number,
) {
  if (format === KINGS_TABLE)
    return `Deck for ${seatTitle(botSeatsOf(seat)[index] ?? 0)}`;
  if (format === "two_headed_giant")
    return index === 0 ? "Teammate's deck" : `Opponent ${index}'s deck`;
  return bots === 1 ? "Bot's deck" : `Bot ${index + 1}'s deck`;
}

/** The bots' deck choices, one for each bot seat there may be (King's Table's five at most). */
export const blankBots = ["", "", "", "", ""];

/** What a refused start says, by the API's code. */
export const refusals: Record<string, string> = {
  deck_not_playable:
    "That deck has problems to fix first: open it in the deck builder to see them.",
  invalid_deck: "That deck cannot be played in this format.",
  game_limit:
    "You already have a game running. Resume it, or close it in Your games, first.",
  games_busy: "Every table is busy right now. Try again in half a minute.",
  games_unavailable: "Games are switched off on this server.",
  // team_decks keeps the server's message: it names the cards teammates' decks share.
  engine_unavailable: "The rules engine is not answering. Try again shortly.",
};
