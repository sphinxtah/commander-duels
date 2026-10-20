import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GameContext, type GameContextValue } from "./Board";
import type { GameState } from "./connection";
import { objectIndex, optionsByObject, optionsBySeat } from "./model";
import { PromptPanel } from "./PromptPanel";
import type { AmountEntry, Prompt, PromptOption, Snapshot } from "./types";

function option(id: string, action: PromptOption["action"]): PromptOption {
  return {
    id,
    action,
    label: null,
    object_id: null,
    seat: null,
    selected: false,
  };
}

function priority(id: string): Prompt {
  return {
    id,
    kind: "priority",
    message: `Prompt ${id}`,
    detail: null,
    options: [option("1", "pass"), option("2", "cast"), option("3", "cast")],
    amounts: null,
    piles: null,
    xmage_query: null,
  };
}

function amounts(id: string, entries: AmountEntry[], total: number): Prompt {
  return {
    id,
    kind: "assign_amounts",
    message: "Assign combat damage",
    detail: null,
    options: [],
    amounts: { total_min: total, total_max: total, entries },
    piles: null,
    xmage_query: null,
  };
}

const entry = (max: number, suggested: number): AmountEntry => ({
  label: "Blocker",
  min: 0,
  max,
  suggested,
});

function snapshot(revision: number, prompt: Prompt | null): Snapshot {
  return {
    game_id: "g1",
    revision,
    status: prompt ? "your_prompt" : "waiting",
    seat: 0,
    settings: {
      format: "legacy",
      rules_profile: "legacy",
      seats: [],
      skill: 3,
      turn_cap: 20,
      idle_timeout_seconds: 900,
      spectator_delay_seconds: 0,
    },
    prompt,
    view: null,
    result: null,
    log_count: 0,
    log_from: 0,
    log: [],
  };
}

function state(snap: Snapshot, pending = false): GameState {
  return {
    phase: "open",
    ended: null,
    seat: 0,
    role: "controller",
    controlled: true,
    takenOver: false,
    snapshot: snap,
    log: [],
    inspection: null,
    pending: pending
      ? {
          v: 1,
          game_id: "g1",
          action_id: "a",
          expected_revision: snap.revision,
          type: "submit_choice",
          payload: { option_id: "2" },
        }
      : null,
    refusal: null,
    interrupted: false,
    crowded: false,
    priority: null,
  };
}

/** The panel inside the game's context, as GameScreen draws it for one state. */
function Panel({ game }: { game: GameState }) {
  const prompt = game.snapshot?.prompt ?? null;
  const context: GameContextValue = {
    view: null,
    prompt,
    index: objectIndex(null),
    byObject: optionsByObject(prompt),
    bySeat: optionsBySeat(prompt),
    canAnswer: game.pending === null,
    observing: false,
    choose: vi.fn(),
    zoom: vi.fn(),
    preview: vi.fn(),
  };
  return (
    <GameContext.Provider value={context}>
      <button type="button">Elsewhere on the board</button>
      <PromptPanel
        state={game}
        onAnswer={vi.fn()}
        onTakeControl={vi.fn()}
        onConcede={vi.fn()}
      />
    </GameContext.Provider>
  );
}

describe("the amounts form", () => {
  it("starts each prompt from its own entries, even when the lengths differ", () => {
    const view = render(
      <Panel
        game={state(
          snapshot(5, amounts("a", [entry(4, 2), entry(4, 1), entry(4, 1)], 4)),
        )}
      />,
    );
    // The next prompt arrives with the waiting state in between never drawn.
    view.rerender(
      <Panel
        game={state(snapshot(7, amounts("b", [entry(2, 1), entry(2, 1)], 2)))}
      />,
    );
    const inputs = screen.getAllByRole("spinbutton");
    expect(inputs.map((input) => (input as HTMLInputElement).value)).toEqual([
      "1",
      "1",
    ]);
    expect(
      screen.getByRole("button", { name: "Confirm amounts" }),
    ).toBeEnabled();
  });

  it("keeps what the player typed when the same prompt comes at a new revision", () => {
    const prompt = () => amounts("a", [entry(4, 2), entry(4, 2)], 4);
    const view = render(<Panel game={state(snapshot(5, prompt()))} />);
    const [first, second] = screen.getAllByRole("spinbutton");
    fireEvent.change(first, { target: { value: "3" } });
    fireEvent.change(second, { target: { value: "1" } });
    view.rerender(<Panel game={state(snapshot(6, prompt()))} />);
    expect(
      screen
        .getAllByRole("spinbutton")
        .map((input) => (input as HTMLInputElement).value),
    ).toEqual(["3", "1"]);
  });
});

describe("paying mana", () => {
  it("lists a special payment with the other mana options", () => {
    const prompt: Prompt = {
      id: "m",
      kind: "pay_mana",
      message: "Pay {2}{R}",
      detail: null,
      options: [
        option("1", "tap_source"),
        option("2", "special_payment"),
        option("3", "cancel"),
      ],
      amounts: null,
      piles: null,
      xmage_query: null,
    };
    render(<Panel game={state(snapshot(5, prompt))} />);
    const mana = screen.getByRole("heading", {
      level: 3,
      name: "Mana",
    }).parentElement!;
    expect(
      Array.from(mana.querySelectorAll("[data-option]")).map(
        (button) => button.textContent,
      ),
    ).toEqual(["Tap", "Special payment"]);
  });
});

describe("the prompt on screen", () => {
  it("is named on the panel, for the browser tests to wait on", () => {
    const view = render(<Panel game={state(snapshot(5, priority("A")))} />);
    const panel = () => document.querySelector("section")!;
    expect(panel()).toHaveAttribute("data-prompt", "A");
    expect(panel()).toHaveAttribute("data-revision", "5");
    view.rerender(<Panel game={state(snapshot(6, null))} />);
    expect(panel()).not.toHaveAttribute("data-prompt");
    expect(panel()).toHaveAttribute("data-revision", "6");
  });
});

describe("keyboard focus in the prompt panel", () => {
  it("moves to the next prompt's first control after an answer from the panel", () => {
    const view = render(<Panel game={state(snapshot(5, priority("A")))} />);
    document.querySelector<HTMLElement>('[data-option="2"]')!.focus();

    // The answer is sent, then the table waits: the focused button is disabled, then removed.
    view.rerender(<Panel game={state(snapshot(5, priority("A")), true)} />);
    view.rerender(<Panel game={state(snapshot(6, null))} />);
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 2, name: /Table/ }),
    );

    view.rerender(<Panel game={state(snapshot(7, priority("B")))} />);
    const first = document.querySelector("[data-first]");
    expect(first).toHaveTextContent("Pass priority");
    expect(document.activeElement).toBe(first);
  });

  it("returns to the same control when the same prompt is enabled again", () => {
    const view = render(<Panel game={state(snapshot(5, priority("A")))} />);
    const third = document.querySelector<HTMLElement>('[data-option="3"]')!;
    third.focus();
    // Chromium drops focus from a button as it is disabled (jsdom does not, so the test does).
    third.blur();
    view.rerender(<Panel game={state(snapshot(5, priority("A")), true)} />);
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 2, name: /Priority/ }),
    );
    // The answer is refused: the prompt is enabled again.
    view.rerender(<Panel game={state(snapshot(5, priority("A")))} />);
    expect(document.activeElement).toBe(
      document.querySelector('[data-option="3"]'),
    );
  });

  it("leaves focus alone once the player has moved on to the board", () => {
    const view = render(<Panel game={state(snapshot(5, priority("A")))} />);
    document.querySelector<HTMLElement>("[data-first]")!.focus();
    const board = screen.getByRole("button", {
      name: "Elsewhere on the board",
    });
    fireEvent.pointerDown(board);
    board.focus();
    view.rerender(<Panel game={state(snapshot(6, null))} />);
    view.rerender(<Panel game={state(snapshot(7, priority("B")))} />);
    expect(document.activeElement).toBe(board);
  });
});
