import { describe as suite, expect, it } from "vitest";
import { describe, type GameEvent } from "../timeline/events";
import {
  delayOf,
  indexAt,
  LINE_MS,
  matches,
  NOTE_MS,
  REPLAY_ROUTE,
  replayHref,
  REPLAYS_ROUTE,
  scoreboard,
  turnStarts,
  turnStep,
  type ReplayStart,
} from "./replay";

// A replay's own arithmetic (v1.0.0): the scoreboard as the events tell it, and the place and
// pace of playback over the timeline's lines.

let seq = 0;
function event(type: string, rest: Partial<GameEvent> = {}): GameEvent {
  seq += 1;
  return {
    v: 2,
    seq,
    epoch: 0,
    turn: 1,
    step: "precombat_main",
    type,
    ...rest,
  };
}
const card = (name: string, ref: string, owner = 0) => ({ ref, name, owner });

const DUEL: ReplayStart[] = [
  { seat: 0, life: 20, team: null, shared_life: false },
  { seat: 1, life: 20, team: null, shared_life: false },
];
const seatName = (seat: number) => ["ada", "Bot 2", "cy", "dee"][seat] ?? "?";

suite("the scoreboard", () => {
  it("is each seat's counts as the events last told them", () => {
    seq = 0;
    const events = [
      event("step", { active: 0 }),
      event("zone_change", {
        from: "hand",
        to: "battlefield",
        player: 0,
        object: card("Mountain", "o1"),
        tally: [
          [20, 6, 53, 0, 1],
          [20, 7, 53, 0, 0],
        ],
      }),
      event("cast", { player: 0, object: card("Lightning Bolt", "o2") }),
      event("life_lost", {
        player: 1,
        amount: 3,
        tally: [
          [20, 5, 53, 0, 1],
          [17, 7, 53, 0, 0],
        ],
      }),
      event("eliminated", { turn: 9, player: 1 }),
      event("won", { turn: 9, player: 0 }),
    ];
    const board = scoreboard(events, DUEL);
    expect(board.counted).toBe(true);
    // Before the first telling: where each seat started, and counts nobody has told yet.
    expect(board.at(0)).toEqual([
      expect.objectContaining({ seat: 0, life: 20, hand: null, library: null }),
      expect.objectContaining({ seat: 1, life: 20, hand: null }),
    ]);
    expect(board.at(1)[0]).toMatchObject({ life: 20, hand: null });
    expect(board.at(2)).toEqual([
      {
        seat: 0,
        life: 20,
        hand: 6,
        library: 53,
        graveyard: 0,
        battlefield: 1,
        out: false,
        won: false,
      },
      expect.objectContaining({ seat: 1, life: 20, hand: 7, battlefield: 0 }),
    ]);
    // An event that tells no counts leaves them as they were.
    expect(board.at(3)).toBe(board.at(2));
    expect(board.at(4)[1]).toMatchObject({ life: 17, hand: 7 });
    expect(board.at(4)[0]).toMatchObject({ hand: 5 });
    expect(board.at(5)[1]).toMatchObject({ out: true, won: false });
    expect(board.at(6)[0]).toMatchObject({ won: true, out: false });
    expect(board.at(999)).toBe(board.at(6));
  });

  it("counts life from the start where a game tells no counts, a team's together", () => {
    seq = 0;
    const giants: ReplayStart[] = [0, 1, 2, 3].map((seat) => ({
      seat,
      life: 30,
      team: seat < 2 ? 0 : 1,
      shared_life: true,
    }));
    const events = [
      event("life_lost", { v: 1, player: 3, amount: 4 }),
      event("life_gained", { v: 1, player: 0, amount: 2 }),
      event("damage", { v: 1, target: { seat: 2 }, amount: 4 }),
    ];
    const board = scoreboard(events, giants);
    expect(board.counted).toBe(false);
    expect(board.at(1).map((score) => score.life)).toEqual([30, 30, 26, 26]);
    expect(board.at(3).map((score) => score.life)).toEqual([32, 32, 26, 26]);
    expect(board.at(3)[0]!.hand).toBeNull();
    // Apart, in a duel: only the player's own.
    seq = 0;
    const duel = scoreboard(
      [event("life_lost", { v: 1, player: 1, amount: 5 })],
      DUEL,
    );
    expect(duel.at(1).map((score) => score.life)).toEqual([20, 15]);
  });

  it("goes by the counts once a game tells them, never by both", () => {
    seq = 0;
    const board = scoreboard(
      [
        event("life_lost", {
          player: 1,
          amount: 3,
          tally: [
            [20, 7, 53, 0, 0],
            [17, 7, 53, 0, 0],
          ],
        }),
        // Told without its counts (they were told a step early): not taken off again.
        event("life_lost", { player: 1, amount: 3 }),
      ],
      DUEL,
    );
    expect(board.at(2)[1]!.life).toBe(17);
  });
});

suite("the place and the pace", () => {
  seq = 0;
  const events = [
    event("step", { active: 0 }),
    event("cast", { player: 0, object: card("Lightning Bolt", "o2") }),
    event("resolve", { player: 0, object: card("Lightning Bolt", "o2") }),
    event("step", { turn: 2, step: "draw", active: 1 }),
    event("zone_change", {
      turn: 2,
      step: "draw",
      from: "library",
      to: "hand",
      player: 1,
      object: { hidden: true, owner: 1 },
    }),
    event("step", { turn: 3, step: "declare_attackers", active: 0 }),
    event("attack", {
      turn: 3,
      step: "declare_attackers",
      player: 0,
      object: card("Goblin Guide", "o5"),
      target: { seat: 1 },
    }),
  ];
  const lines = describe(events).filter((line) => !line.quiet);

  it("finds the line at an event's number, and where each turn begins", () => {
    expect(lines.map((line) => line.turn)).toEqual([1, 1, 2, 3]);
    expect(indexAt(lines, 0)).toBe(-1);
    expect(indexAt(lines, lines[1]!.seq)).toBe(1);
    // A number between two lines is the earlier one's; one past the end, the last.
    expect(indexAt(lines, lines[2]!.seq - 1)).toBe(1);
    expect(indexAt(lines, 999)).toBe(3);
    expect(turnStarts(lines)).toEqual([
      { turn: 1, index: 0 },
      { turn: 2, index: 2 },
      { turn: 3, index: 3 },
    ]);
  });

  it("steps by turns: on to the next one's first line, back to this one's, then the one before", () => {
    expect(turnStep(lines, 0, 1)).toBe(2);
    expect(turnStep(lines, 2, 1)).toBe(3);
    expect(turnStep(lines, 3, 1)).toBe(3);
    expect(turnStep(lines, 1, -1)).toBe(0);
    expect(turnStep(lines, 3, -1)).toBe(2);
    expect(turnStep(lines, 0, -1)).toBe(0);
    expect(turnStep([], 0, 1)).toBe(0);
  });

  it("finds lines by their words, and a hidden card by no name", () => {
    expect(matches(lines, "bolt", seatName)).toEqual([0, 1]);
    expect(matches(lines, "  ADA ", seatName)).toEqual([0]);
    expect(matches(lines, "bot 2", seatName)).toEqual([2, 3]);
    expect(matches(lines, "", seatName)).toEqual([]);
    expect(matches(lines, "counterspell", seatName)).toEqual([]);
    expect(matches(lines, "hidden card", seatName)).toEqual([2]);
  });

  it("lets a line stand its time, longer with explanations, shorter at speed", () => {
    expect(delayOf(lines[0], 1)).toBe(LINE_MS);
    expect(delayOf(lines[0], 4)).toBe(LINE_MS / 4);
    expect(delayOf(lines[0], 0.5)).toBe(LINE_MS * 2);
    const explained = {
      ...lines[0]!,
      notes: [{ text: ["a"] }, { text: ["b"] }, { text: ["c"] }],
    };
    expect(delayOf(explained, 1)).toBe(LINE_MS + 2 * NOTE_MS);
    expect(delayOf(undefined, 2)).toBe(LINE_MS / 2);
  });
});

suite("a replay's address", () => {
  const game = "11111111-2222-3333-4444-555555555555";
  const friend = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  it("names the game, and whose share it is", () => {
    expect(REPLAY_ROUTE.exec(replayHref(game))?.slice(1, 3)).toEqual([
      game,
      undefined,
    ]);
    expect(REPLAY_ROUTE.exec(replayHref(game, friend))?.slice(1, 3)).toEqual([
      game,
      friend,
    ]);
    expect(REPLAY_ROUTE.test("#replay/nonsense")).toBe(false);
    expect(REPLAY_ROUTE.test(`#replay/${game}/x`)).toBe(false);
    expect(REPLAYS_ROUTE.test("#replays")).toBe(true);
    expect(REPLAYS_ROUTE.test(`#replay/${game}`)).toBe(false);
  });
});
