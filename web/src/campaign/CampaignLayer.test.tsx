import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GameView,
  PermanentView,
  PlayerView,
  Prompt,
} from "../game/types";
import * as campaignApi from "./campaign";
import { CampaignLayer } from "./CampaignLayer";

// Kaya's lessons at the table (v0.9.1): a lesson whose moment came while another showed is looked
// at again when that one closes, so the mulligan's lesson and the first creature's aren't lost.

function permanent(
  id: string,
  seat: number,
  type: string,
  extra: Partial<PermanentView> = {},
): PermanentView {
  return {
    id,
    controller_seat: seat,
    owner_seat: seat,
    card: {
      id: `c-${id}`,
      hidden: false,
      name: id,
      mana_cost: null,
      type_line: type,
      power: "2",
      toughness: "2",
      rules: [],
    },
    tapped: false,
    summoning_sick: false,
    damage: 0,
    counters: {},
    attacking: false,
    blocking: false,
    attached_to: null,
    ...extra,
  };
}

function player(
  seat: number,
  life: number,
  extra: Partial<PlayerView> = {},
): PlayerView {
  return {
    seat,
    name: seat === 0 ? "Human 1" : "Bot 2",
    life,
    counters: {},
    library_count: 80,
    hand_count: 7,
    graveyard: [],
    exile: [],
    mana_pool: { white: 0, blue: 0, black: 0, red: 0, green: 0, colorless: 0 },
    lost: false,
    won: false,
    color_identity: null,
    command_zone: [],
    commanders: [],
    ...extra,
  };
}

function view(
  battlefield: PermanentView[],
  you: PlayerView,
  boss: PlayerView,
  extra: Partial<GameView> = {},
): GameView {
  return {
    seat: 0,
    turn: 3,
    active_seat: 0,
    priority_seat: 0,
    phase: "precombat_main",
    step: "main1",
    you,
    opponents: [boss],
    hand: [],
    battlefield,
    stack: [],
    combat: [],
    revealed: [],
    looked_at: [],
    messages: [],
    priority: null,
    ...extra,
  };
}

function asked(kind: Prompt["kind"]): Prompt {
  return {
    id: `p-${kind}`,
    kind,
    message: "",
    detail: null,
    options: [],
    amounts: null,
    piles: null,
    xmage_query: null,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("Kaya's lessons", () => {
  it("teach the mulligan first, then the welcome, and keep a creature that came meanwhile", () => {
    const taught = vi
      .spyOn(campaignApi, "changeTutorial")
      .mockResolvedValue(null);
    const campaign = { encounter: 1, hints: true, finale: null } as never;
    const empty = view([], player(0, 40), player(1, 40));
    const layer = (shown: GameView, prompt: Prompt) => (
      <CampaignLayer
        gameId="g"
        campaign={campaign}
        view={shown}
        prompt={prompt}
        log={[]}
        over={false}
      />
    );
    const { rerender } = render(layer(empty, asked("mulligan")));
    expect(screen.getByText(/Kaya.s lesson · T02/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    // Kept: the first priority brings the welcome.
    rerender(layer({ ...empty, turn: 1 }, asked("priority")));
    expect(screen.getByText(/Kaya.s lesson · T01/)).toBeInTheDocument();
    // A creature enters while the welcome still shows.
    const one = view(
      [permanent("lion", 0, "Creature")],
      player(0, 40),
      player(1, 40),
    );
    rerender(layer({ ...one, turn: 1 }, asked("priority")));
    expect(screen.getByText(/Kaya.s lesson · T01/)).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    });
    expect(screen.getByText(/Kaya.s lesson · T06/)).toBeInTheDocument();
    expect(taught.mock.calls.map(([body]) => body.lessons)).toEqual([
      ["T02"],
      ["T01"],
      ["T06"],
    ]);
  });
});
