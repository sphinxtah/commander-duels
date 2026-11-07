import { describe, expect, it } from "vitest";
import {
  alliesOf,
  objectIndex,
  optionText,
  playerName,
  readableRule,
  resultText,
  teamNote,
  teammateOf,
  turnHolder,
} from "./model";
import { kingsPlayer, tableFixture } from "./table/fixtures";
import type { GameView, PlayerView, Prompt, PromptOption } from "./types";

function player(seat: number, name: string): PlayerView {
  return {
    seat,
    name,
    life: 20,
    counters: {},
    library_count: 40,
    hand_count: 7,
    graveyard: [],
    exile: [],
    mana_pool: { white: 0, blue: 0, black: 0, red: 0, green: 0, colorless: 0 },
    lost: false,
    won: false,
    color_identity: null,
    command_zone: [],
    commanders: [],
  };
}

// The owner's seat view, as SysOp receives it when observing the owner's game.
const view: GameView = {
  seat: 0,
  turn: 12,
  active_seat: 0,
  priority_seat: 0,
  phase: null,
  step: null,
  you: player(0, "Alice"),
  opponents: [player(1, "Bot 2")],
  hand: [],
  battlefield: [],
  stack: [],
  combat: [],
  revealed: [],
  looked_at: [],
  messages: [],
  priority: null,
};
const won = (winner_seat: number) => ({
  kind: "completed",
  winner_seat,
  draw: false,
  turns: 12,
});

describe("the result in words", () => {
  it("speaks to the seat's owner", () => {
    expect(resultText(view, 0, won(0))).toEqual({
      title: "Victory",
      detail: "You won in 12 turns.",
    });
    expect(resultText(view, 0, won(1))).toEqual({
      title: "Defeat",
      detail: "Bot 2 won in 12 turns.",
    });
  });

  it("stays neutral for SysOp observing someone else's game", () => {
    expect(resultText(view, null, won(0))).toEqual({
      title: "Game over",
      detail: "Alice won in 12 turns.",
    });
    expect(resultText(view, null, won(1))).toEqual({
      title: "Game over",
      detail: "Bot 2 won in 12 turns.",
    });
  });

  it("names the owner instead of 'You' when observing", () => {
    expect(playerName(view, 0)).toBe("You");
    expect(playerName(view, 0, true)).toBe("Alice");
    expect(playerName(view, 1, true)).toBe("Bot 2");
  });
});

describe("Two-Headed Giant (v0.5.0)", () => {
  // Seat 0's view: seat 1 is its teammate; seats 2 and 3 the other team.
  const team = (seat: number, name: string): PlayerView => ({
    ...player(seat, name),
    team: Math.floor(seat / 2),
    life: 30,
  });
  const giant: GameView = {
    ...view,
    you: team(0, "Alice"),
    opponents: [team(1, "Bot 2"), team(2, "Bot 3"), team(3, "Bot 4")],
  };
  const teamWon = (winners: number[]) => ({
    ...won(winners[0]),
    winner_seats: winners,
  });

  it("knows the viewer's teammate", () => {
    expect(teammateOf(giant)).toBe(1);
    expect(teammateOf(view)).toBeNull();
    expect(teammateOf({ ...giant, you: null })).toBeNull();
  });

  it("indexes the teammate's hand it shows, so prompts may name its cards (v0.5.1)", () => {
    const bolt = {
      id: "mate-1",
      hidden: false,
      name: "Lightning Bolt",
      mana_cost: "{R}",
      type_line: "Instant",
      power: null,
      toughness: null,
      rules: [],
    };
    const shown: GameView = {
      ...giant,
      opponents: [
        { ...giant.opponents[0], hand: [bolt], hand_count: 1 },
        ...giant.opponents.slice(1),
      ],
    };
    expect(objectIndex(shown).get("mate-1")).toEqual({
      id: "mate-1",
      zone: "hand",
      seat: 1,
      card: bolt,
    });
    expect(objectIndex(giant).has("mate-1")).toBe(false);
  });

  it("tells a team's win to both teammates, naming the team (v0.5.1)", () => {
    expect(resultText(giant, 0, teamWon([0, 1]))).toEqual({
      title: "Victory",
      detail: "You and Bot 2 won in 12 turns.",
    });
    // Seat 1's teammate is seat 0, here by the name its own view would give it.
    expect(
      resultText(giant, 1, teamWon([0, 1]), (seat) =>
        seat === 0 ? "Alice" : `Seat ${seat + 1}`,
      ),
    ).toEqual({
      title: "Victory",
      detail: "You and Alice won in 12 turns.",
    });
    expect(resultText(giant, 0, teamWon([2, 3]))).toEqual({
      title: "Defeat",
      detail: "Bot 3 and Bot 4 won in 12 turns.",
    });
  });

  it("says what a prompt is to the team (rules 805.5 to 805.7, v0.6.1)", () => {
    const prompt = (kind: Prompt["kind"], passed: boolean | null): Prompt => ({
      id: "p",
      kind,
      message: "",
      detail: null,
      options: [],
      amounts: null,
      piles: null,
      xmage_query: null,
      team: { teammate_passed: passed },
    });
    expect(teamNote(prompt("priority", false), null)).toBe(
      "Your team has priority: after a pass, your teammate may still act before the other team.",
    );
    expect(teamNote(prompt("priority", true), null)).toBe(
      "Your teammate has passed: a pass now passes for your team, and the other team gets priority.",
    );
    expect(teamNote(prompt("declare_attackers", null), "Bob")).toBe(
      "Bob’s team attacks together: Bob’s teammate’s attackers count too, and the whole attack must be legal. If Bob’s teammate changes it, this choice comes back.",
    );
    expect(teamNote(prompt("order_triggers", null), null)).toMatch(
      /^Your team puts its triggered abilities on the stack in one order/,
    );
    expect(teamNote(prompt("yes_no", null), null)).toBeNull();
    expect(
      teamNote({ ...prompt("priority", true), team: null }, null),
    ).toBeNull();
  });

  it("says whose each of a team's triggers is (rule 805.7, v0.6.1)", () => {
    const trigger = (seat: number | null): PromptOption => ({
      id: "1",
      action: "put_first",
      label: "Whenever another creature enters, you gain 1 life.",
      object_id: null,
      seat,
      selected: false,
    });
    const index = objectIndex(giant);
    expect(optionText(trigger(0), index, giant)).toBe(
      "Whenever another creature enters, you gain 1 life. · yours",
    );
    expect(optionText(trigger(1), index, giant)).toBe(
      "Whenever another creature enters, you gain 1 life. · Bot 2",
    );
    expect(optionText(trigger(null), index, view)).toBe(
      "Whenever another creature enters, you gain 1 life.",
    );
  });

  it("names the winning team by its number to SysOp observing (v0.5.1)", () => {
    expect(resultText(giant, null, teamWon([2, 3]))).toEqual({
      title: "Game over",
      detail: "Team 2 won in 12 turns: Bot 3 and Bot 4.",
    });
    expect(resultText(giant, null, teamWon([0, 1]))).toEqual({
      title: "Game over",
      detail: "Team 1 won in 12 turns: Alice and Bot 2.",
    });
  });
});

describe("whose turn it is", () => {
  const name = (seat: number) => ["ada", "bob", "cara", "dan"][seat];
  const team = (seat: number, controlledBy: number | null = null) => ({
    ...player(seat, name(seat)),
    team: Math.floor(seat / 2),
    controlled_by: controlledBy,
  });

  it("says yours, a team's or the holder's, as before", () => {
    expect(turnHolder(view, false, name)).toBe("Your turn");
    expect(turnHolder({ ...view, active_seat: 1 }, false, name)).toBe(
      "bob’s turn",
    );
    expect(turnHolder({ ...view, active_seat: null }, false, name)).toBeNull();
    const giant: GameView = {
      ...view,
      you: team(0),
      opponents: [team(1), team(2), team(3)],
    };
    expect(turnHolder({ ...giant, active_seat: 1 }, false, name)).toBe(
      "Your team’s turn",
    );
    expect(turnHolder({ ...giant, active_seat: 2 }, false, name)).toBe(
      "Other team’s turn",
    );
    expect(turnHolder({ ...giant, active_seat: 2 }, true, name)).toBe(
      "Team 2’s turn",
    );
  });

  it("says who controls a controlled turn (rule 723, v0.5.1)", () => {
    // Ada controls bob's turn; bob's view of it; a third player's and SysOp's.
    const controlling: GameView = {
      ...view,
      active_seat: 1,
      you: { ...player(0, "ada") },
      opponents: [{ ...player(1, "bob"), controlled_by: 0 }],
    };
    expect(turnHolder(controlling, false, name)).toBe("You control bob’s turn");
    expect(turnHolder(controlling, true, name)).toBe("ada controls bob’s turn");
    const controlled: GameView = {
      ...view,
      seat: 1,
      active_seat: 1,
      you: { ...player(1, "bob"), controlled_by: 0 },
      opponents: [player(0, "ada"), player(2, "cara")],
    };
    expect(turnHolder(controlled, false, name)).toBe("ada controls your turn");
    const third: GameView = {
      ...view,
      seat: 2,
      active_seat: 1,
      you: player(2, "cara"),
      opponents: [player(0, "ada"), { ...player(1, "bob"), controlled_by: 0 }],
    };
    expect(turnHolder(third, false, name)).toBe("ada controls bob’s turn");
    // 805.8: controlling a player of a team controls the team's turn.
    const giant: GameView = {
      ...view,
      active_seat: 2,
      you: team(0),
      opponents: [team(1), team(2, 0), team(3, 0)],
    };
    expect(turnHolder(giant, false, name)).toBe(
      "You control the other team’s turn",
    );
    expect(turnHolder(giant, true, name)).toBe("ada controls Team 2’s turn");
    const theirs: GameView = {
      ...view,
      seat: 2,
      active_seat: 2,
      you: team(2, 0),
      opponents: [team(0), team(1), team(3, 0)],
    };
    expect(turnHolder(theirs, false, name)).toBe("ada controls your turn");
    const mate: GameView = {
      ...theirs,
      seat: 3,
      you: team(3, 0),
      opponents: [team(0), team(1), team(2, 0)],
    };
    expect(turnHolder(mate, false, name)).toBe("ada controls your team’s turn");
  });
});

describe("King's Table (v0.8.7)", () => {
  /** The kings fixture's view: Alice in seat 2, team A's Right General, among five bots. */
  const kingsView = (): GameView => tableFixture("kings").snapshot.view!;
  const finished = (fields: {
    winner_seat?: number | null;
    winner_seats?: number[];
    draw?: boolean;
  }) => ({
    kind: "completed",
    winner_seat: null,
    winner_seats: [],
    draw: false,
    turns: 14,
    ...fields,
  });

  it("has allies, never the shared-turn teammate of Two-Headed Giant", () => {
    const view = kingsView();
    expect(teammateOf(view)).toBeNull();
    expect(alliesOf(view)).toEqual([0, 1]);
  });

  it("gives each turn to its player: teammates take their own", () => {
    const view = kingsView();
    const name = (seat: number) => playerName(view, seat);
    expect(turnHolder({ ...view, active_seat: 2 }, false, name)).toBe(
      "Your turn",
    );
    expect(turnHolder({ ...view, active_seat: 1 }, false, name)).toBe(
      "Bot 2’s turn",
    );
    expect(turnHolder({ ...view, active_seat: 4 }, false, name)).toBe(
      "Bot 5’s turn",
    );
  });

  it("names the winning team, every one of its players, a General out earlier too", () => {
    const view = kingsView();
    // Bot 1, team A's Left General, left the game before team B's King fell: the engine names
    // only the winners still in, and the team's win is still all three's.
    expect(
      resultText(view, 2, finished({ winner_seat: 1, winner_seats: [1, 2] })),
    ).toEqual({
      title: "Victory",
      detail: "Your team, Team A, won in 14 turns: Bot 1, Bot 2 and you.",
    });
    expect(
      resultText(
        view,
        2,
        finished({ winner_seat: 3, winner_seats: [3, 4, 5] }),
      ),
    ).toEqual({
      title: "Defeat",
      detail: "Team B won in 14 turns: Bot 4, Bot 5 and Bot 6.",
    });
    // SysOp observing, or a spectator: the team by its letter.
    expect(
      resultText(view, null, finished({ winner_seat: 4, winner_seats: [4] })),
    ).toEqual({
      title: "Game over",
      detail: "Team B won in 14 turns: Bot 4, Bot 5 and Bot 6.",
    });
    // The API's recorded result names the team itself.
    expect(
      resultText(view, 2, { ...finished({ winner_seat: 0 }), winner_team: 0 })
        .title,
    ).toBe("Victory");
  });

  it("calls both Kings at once a draw, and a game with no winner over", () => {
    const view = kingsView();
    expect(resultText(view, 2, finished({ draw: true }))).toEqual({
      title: "A draw",
      detail: "Neither team won: the game ended in a draw after 14 turns.",
    });
    expect(
      resultText(view, 2, { ...finished({}), kind: "turn_limit" }),
    ).toEqual({
      title: "Game over",
      detail: "The turn limit was reached after 14 turns.",
    });
  });

  it("reads the Deploy ability with its name first", () => {
    expect(
      readableRule(
        "{T}: Target teammate in your range gains control of this creature. Activate only as a sorcery. (Deploy)",
      ),
    ).toBe(
      "Deploy — {T}: Target teammate in your range gains control of this creature. Activate only as a sorcery.",
    );
    expect(readableRule("Flying")).toBe("Flying");
    const view = kingsView();
    const choice: PromptOption = {
      id: "1",
      action: "deploy",
      label:
        "{T}: Target teammate in your range gains control of this creature. Activate only as a sorcery. (Deploy)",
      object_id: null,
      seat: null,
      selected: false,
    };
    expect(optionText(choice, objectIndex(view), view)).toBe(
      "Deploy: tap this creature to give it to a teammate in your range (as a sorcery)",
    );
    // Since v0.8.8 the engine's mark, not the words, says it is Deploy (v0.8.8).
    expect(
      optionText({ ...choice, action: "use_ability" }, objectIndex(view), view),
    ).not.toMatch(/^Deploy:/);
    // The teammate it goes to is named as any player is.
    expect(
      optionText(
        { ...choice, action: "choose", label: null, seat: 1 },
        objectIndex(view),
        view,
      ),
    ).toBe("Choose Bot 2");
  });

  it("builds plates from a seat's view of the circle", () => {
    const settings = {
      deck_format: "legacy" as const,
      life: "all_20" as const,
      king_attacks_anyone: true,
    };
    // A King under the house rule may attack any opponent, in range or not.
    expect(kingsPlayer(3, "Bot 4", 1, settings)).toMatchObject({
      in_range: true,
      attackable: true,
    });
    expect(kingsPlayer(4, "Bot 5", 1, settings)).toMatchObject({
      in_range: false,
      attackable: true,
      starting_life: 20,
    });
    // A General keeps to the usual restriction.
    expect(kingsPlayer(4, "Bot 5", 2, settings)).toMatchObject({
      in_range: false,
      attackable: false,
    });
  });
});
