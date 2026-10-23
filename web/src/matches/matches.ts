import type { components } from "../generated/api";

// Best-of-three Legacy matches (v0.5.0, docs/matches.md): what the match page, the game screen and
// the Play page share.

export type MatchView = components["schemas"]["MatchView"];
export type MatchPlayer = components["schemas"]["MatchPlayerView"];
export type Sideboard = components["schemas"]["Sideboard"];
export type SideboardCard = components["schemas"]["SideboardCard"];
export type GameMatch = components["schemas"]["GameMatch"];
export type ArrangedCard = components["schemas"]["ArrangedCard"];

/** Legacy's deck rules for an arrangement; the server checks them again, and the library too. */
export const MIN_MAIN = 60;
export const MAX_SIDEBOARD = 15;

/** Whether a match is still being played: a game in play, or sideboarding for the next. */
export function running(status: MatchView["status"]): boolean {
  return status === "playing" || status === "sideboarding";
}

/** A seat's name on the match page: "You", the bot, or the player's handle. */
export function seatName(match: MatchView, seat: number | null): string {
  const player = match.players.find((entry) => entry.seat === seat);
  if (!player) return "Nobody";
  if (player.you) return "You";
  return player.player === "bot" ? "The bot" : (player.handle ?? "A player");
}

/** The other seat of a two-player match. */
export function opponentOf(match: MatchView, seat: number | null) {
  return match.players.find((entry) => entry.seat !== seat) ?? null;
}

/** The score from a seat's side, its own game wins first ("1–0"); in seat order for an observer. */
export function score(wins: number[], seat: number | null): string {
  if (seat === null || seat < 0 || seat >= wins.length || wins.length !== 2)
    return wins.join("–");
  return `${wins[seat]}–${wins[1 - seat]}`;
}

/** The game screen's line for a match's game: "Game 2 · 1–0". */
export function gameLine(match: GameMatch, seat: number | null): string {
  return `Game ${match.game} · ${score(match.wins, seat)}`;
}

/** How the match stands once a game of it is over, for the game's result. */
export function matchAfterGame(
  match: GameMatch,
  seat: number | null,
): { title: string; detail: string } {
  const line = score(match.wins, seat);
  if (match.status === "finished") {
    if (match.draw)
      return { title: `The match is a draw, ${line}`, detail: "Five games." };
    if (seat === null)
      return {
        title: `Match over, ${line}`,
        detail: `Seat ${(match.winner_seat ?? 0) + 1} won the match.`,
      };
    return match.winner_seat === seat
      ? {
          title: `You won the match, ${line}`,
          detail: "Every game you won counted.",
        }
      : {
          title: `You lost the match, ${line}`,
          detail: "Every game you won counted.",
        };
  }
  if (match.status === "closed")
    return {
      title: "The match ended",
      detail: "It ended without a result.",
    };
  return {
    title: `Match ${line}`,
    detail: `Game ${match.game + 1} is next: sideboard, then get ready.`,
  };
}

/** The match page's verdict once a match is over. */
export function matchVerdict(match: MatchView): string {
  const line = score(
    match.players.map((player) => player.game_wins),
    match.your_seat,
  );
  if (match.status === "closed")
    return match.end_reason === "failed"
      ? "The match ended without a result: the rules engine refused the next game's decks."
      : "The match ended without a result: a game of it was closed, or timed out.";
  if (match.draw) return `The match is a draw, ${line}, after five games.`;
  const loser = seatName(
    match,
    opponentOf(match, match.winner_seat)?.seat ?? null,
  );
  const why =
    match.end_reason === "conceded"
      ? ` ${loser} conceded it.`
      : match.end_reason === "removed"
        ? ` ${loser === "You" ? "You were" : `${loser} was`} removed while away.`
        : "";
  const winner = seatName(match, match.winner_seat);
  return `${winner} won the match, ${line}.${why}`;
}

/** A game's result in the match's list: "You won in 7 turns", "A draw", "No result". */
export function gameOutcome(
  match: MatchView,
  game: MatchView["games"][number],
): string {
  if (game.status === "active") return "In play";
  if (game.status === "interrupted") return "No result: the engine lost it";
  const result = game.result;
  if (!result) return "Finished";
  const turns = `${result.turns} turn${result.turns === 1 ? "" : "s"}`;
  if (result.draw) return `A draw after ${turns}`;
  if (result.winner_seat !== null) {
    const winner = seatName(match, result.winner_seat);
    return `${winner} won in ${turns}`;
  }
  const kinds: Record<string, string> = {
    turn_limit: "No result: the turn limit",
    closed: "Closed",
    idle_timeout: "Timed out",
    error: "No result: an engine error",
  };
  return kinds[result.kind] ?? "No result";
}

/** Counts of an arrangement: the main deck's and the sideboard's. */
export function counts(cards: SideboardCard[]): {
  main: number;
  sideboard: number;
} {
  return cards.reduce(
    (sum, card) => ({
      main: sum.main + card.main,
      sideboard: sum.sideboard + card.sideboard,
    }),
    { main: 0, sideboard: 0 },
  );
}

/** What keeps an arrangement from being a Legacy deck, in the server's words. */
export function problems(cards: SideboardCard[]): string[] {
  const { main, sideboard } = counts(cards);
  const found: string[] = [];
  if (main < MIN_MAIN)
    found.push(
      `The main deck has ${main} cards; Legacy needs at least ${MIN_MAIN}.`,
    );
  if (sideboard > MAX_SIDEBOARD)
    found.push(
      `The sideboard has ${sideboard} cards; Legacy allows ${MAX_SIDEBOARD}.`,
    );
  return found;
}

/** One copy of a card moved between the main deck and the sideboard. */
export function moved(
  cards: SideboardCard[],
  index: number,
  to: "main" | "sideboard",
): SideboardCard[] {
  return cards.map((card, i) => {
    if (i !== index) return card;
    if (to === "sideboard" && card.main > 0)
      return { ...card, main: card.main - 1, sideboard: card.sideboard + 1 };
    if (to === "main" && card.sideboard > 0)
      return { ...card, main: card.main + 1, sideboard: card.sideboard - 1 };
    return card;
  });
}

/** An arrangement as the server takes it. */
export function arranged(cards: SideboardCard[]): ArrangedCard[] {
  return cards.map((card) => ({
    card_id: card.card_id,
    printing_id: card.printing_id,
    main: card.main,
    sideboard: card.sideboard,
  }));
}

/** Whether two arrangements hold the same counts. */
export function same(a: SideboardCard[], b: SideboardCard[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (card, i) =>
        card.card_id === b[i]?.card_id &&
        card.printing_id === b[i]?.printing_id &&
        card.main === b[i]?.main &&
        card.sideboard === b[i]?.sideboard,
    )
  );
}

/** "4:05" for a number of seconds. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
