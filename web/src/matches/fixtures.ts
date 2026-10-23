import type { MatchPlayer, MatchView, SideboardCard } from "./matches";

// Matches for the tests (v0.5.0): Ada, seat 0, against Bob, between games 1 and 2.

export function sideboardCard(
  name: string,
  main: number,
  sideboard: number,
): SideboardCard {
  return {
    card_id: `id-${name}`,
    printing_id: null,
    name,
    type_line: "Instant",
    mana_cost: null,
    main,
    sideboard,
  };
}

export function matchPlayer(
  fields: Partial<MatchPlayer> & { seat: number },
): MatchPlayer {
  return {
    player: "human",
    handle: null,
    portrait: null,
    you: false,
    game_wins: 0,
    ready: false,
    left: null,
    deck_cards: null,
    ...fields,
  };
}

export function matchView(fields: Partial<MatchView> = {}): MatchView {
  return {
    id: "00000000-0000-4000-8000-00000000aaaa",
    kind: "table",
    format: "legacy",
    best_of: 3,
    status: "sideboarding",
    game_number: 2,
    players: [
      matchPlayer({ seat: 0, handle: "ada", you: true, game_wins: 1 }),
      matchPlayer({ seat: 1, handle: "bob" }),
    ],
    games: [],
    your_seat: 0,
    game_id: null,
    chooser_seat: 1,
    starting_seat: null,
    sideboard_until: null,
    winner_seat: null,
    draw: false,
    end_reason: null,
    waiting: null,
    created_at: "2026-10-22T10:00:00Z",
    finished_at: null,
    ...fields,
  };
}
