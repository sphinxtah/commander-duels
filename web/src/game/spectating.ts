import type { PlayerView, Seat, Snapshot } from "./types";

// A spectator's view of a table's game (v1.0.0, docs/tables.md): the game's public view, which
// the server draws from behind its first player (api/games.py `behind`), so that the table lays
// its players out as a seat's own screen does. Every player's entry in it is the public one,
// with no hand, so the screen draws it from behind any of them by itself: nothing is asked of
// the server, and nothing more is learned.

/** A seat's handle at the table, where the game's summary has one. */
type Handles = readonly { seat: Seat; handle?: string | null }[];

/** Every player of the view, in seat order. */
export function watchedPlayers(snapshot: Snapshot | null): PlayerView[] {
  const view = snapshot?.view;
  if (!view) return [];
  return [...(view.you ? [view.you] : []), ...view.opponents].sort(
    (one, other) => one.seat - other.seat,
  );
}

/** The public view drawn from behind a seat, with its players named by their handles. A seat
 * that is not in the game leaves the view as the server drew it. */
export function seenFrom(
  snapshot: Snapshot | null,
  behind: Seat | null,
  handles: Handles | null,
): Snapshot | null {
  const view = snapshot?.view;
  if (!snapshot || !view) return snapshot;
  const named = (player: PlayerView): PlayerView => {
    const handle = handles?.find((entry) => entry.seat === player.seat)?.handle;
    return handle ? { ...player, name: handle } : player;
  };
  const players = watchedPlayers(snapshot).map(named);
  const front =
    players.find((player) => player.seat === behind) ??
    players.find((player) => player.seat === view.you?.seat) ??
    players[0];
  if (!front) return snapshot;
  return {
    ...snapshot,
    view: {
      ...view,
      seat: front.seat,
      you: front,
      opponents: players.filter((player) => player !== front),
    },
  };
}

/** How far behind the game a spectator watches, in words. */
export function delayWords(seconds: number): string {
  if (seconds <= 0) return "live";
  if (seconds === 60) return "a minute behind";
  return seconds % 60 === 0
    ? `${seconds / 60} minutes behind`
    : `${seconds} seconds behind`;
}
