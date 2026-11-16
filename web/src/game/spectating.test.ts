import { describe, expect, it } from "vitest";
import { delayWords, seenFrom, watchedPlayers } from "./spectating";
import type { PlayerView, Snapshot } from "./types";

const player = (seat: number, name: string) =>
  ({ seat, name, life: 20, hand_count: 7 }) as PlayerView;

/** The public view as the server draws it: from behind its first player. */
function watched(seats: number): Snapshot {
  const players = Array.from({ length: seats }, (_, seat) =>
    player(seat, `Human ${seat + 1}`),
  );
  return {
    game_id: "g1",
    revision: 3,
    status: "spectating",
    view: { seat: 0, you: players[0], opponents: players.slice(1), hand: [] },
  } as unknown as Snapshot;
}

const handles = [
  { seat: 0, handle: "ada" },
  { seat: 1, handle: "bob" },
  { seat: 2, handle: null },
  { seat: 3, handle: "dee" },
];

describe("a spectator's view (v1.0.0)", () => {
  it("names the players by their handles, and keeps the server's side with no seat chosen", () => {
    const seen = seenFrom(watched(4), null, handles)!;
    expect(seen.view?.you?.name).toBe("ada");
    expect(seen.view?.seat).toBe(0);
    expect(seen.view?.opponents.map((each) => each.name)).toEqual([
      "bob",
      "Human 3",
      "dee",
    ]);
  });

  it("is drawn from behind the player chosen, with every other player across", () => {
    const seen = seenFrom(watched(4), 2, handles)!;
    expect([seen.view?.seat, seen.view?.you?.seat]).toEqual([2, 2]);
    expect(seen.view?.opponents.map((each) => each.seat)).toEqual([0, 1, 3]);
    // Nothing is added: the hand stays empty, the player's entry the public one.
    expect(seen.view?.hand).toEqual([]);
    expect(seen.view?.you?.hand_count).toBe(7);
  });

  it("keeps the view as it came for a seat that is not in the game, or with no view", () => {
    const seen = seenFrom(watched(2), 5, null)!;
    expect(seen.view?.you?.seat).toBe(0);
    expect(seenFrom(null, 0, handles)).toBeNull();
    const empty = { game_id: "g1", revision: 1, view: null } as Snapshot;
    expect(seenFrom(empty, 0, handles)).toBe(empty);
  });

  it("lists the players in seat order, whoever is in front", () => {
    const seen = seenFrom(watched(4), 3, handles);
    expect(watchedPlayers(seen).map((each) => each.seat)).toEqual([0, 1, 2, 3]);
    expect(watchedPlayers(null)).toEqual([]);
  });

  it("says the delay in words", () => {
    expect(delayWords(0)).toBe("live");
    expect(delayWords(60)).toBe("a minute behind");
    expect(delayWords(120)).toBe("2 minutes behind");
    expect(delayWords(45)).toBe("45 seconds behind");
  });
});
