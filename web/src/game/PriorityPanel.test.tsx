import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { GameState } from "./connection";
import { passingText, PriorityPanel } from "./PriorityPanel";
import type { PriorityControls } from "./types";

beforeAll(() => {
  // jsdom draws <dialog> but may not open it modally.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

const defaults: PriorityControls = {
  passing: null,
  your_turn: ["main1", "main2"],
  opponent_turn: ["end_of_turn"],
  stop_on_new_stack_objects: true,
  stop_on_attackers: true,
  stop_on_blockers: true,
  pass_after_casting: false,
  full_control: false,
};

function state(
  controls: PriorityControls | null,
  fields: Partial<GameState> = {},
): GameState {
  return {
    phase: "open",
    ended: null,
    seat: 0,
    role: "controller",
    controlled: true,
    takenOver: false,
    snapshot: null,
    log: [],
    inspection: null,
    pending: null,
    refusal: null,
    interrupted: false,
    crowded: false,
    priority: controls,
    ...fields,
  };
}

describe("the priority panel", () => {
  it("is not drawn for a spectator", () => {
    const { container } = render(
      <PriorityPanel state={state(defaults, { seat: null })} onSet={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("turns on full control and holding priority after a spell", () => {
    const onSet = vi.fn();
    render(
      <PriorityPanel
        state={state({ ...defaults, pass_after_casting: true })}
        onSet={onSet}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Full control/ }));
    expect(onSet).toHaveBeenLastCalledWith({ full_control: true });
    const hold = screen.getByRole("checkbox", { name: /Hold priority/ });
    expect(hold).not.toBeChecked();
    fireEvent.click(hold);
    expect(onSet).toHaveBeenLastCalledWith({ pass_after_casting: false });
  });

  it("changes one turn's stops at a time", () => {
    const onSet = vi.fn();
    render(<PriorityPanel state={state(defaults)} onSet={onSet} />);
    fireEvent.click(screen.getByRole("button", { name: "Stops…" }));
    const yours = screen.getByRole("group", { name: "Your turns" });
    expect(
      within(yours).getByRole("checkbox", { name: "First main phase" }),
    ).toBeChecked();
    fireEvent.click(within(yours).getByRole("checkbox", { name: "Upkeep" }));
    expect(onSet).toHaveBeenLastCalledWith({
      your_turn: ["main1", "main2", "upkeep"],
    });
    const theirs = screen.getByRole("group", {
      name: "The other players' turns",
    });
    fireEvent.click(within(theirs).getByRole("checkbox", { name: "End step" }));
    expect(onSet).toHaveBeenLastCalledWith({ opponent_turn: [] });
  });

  it("shows a pass in progress and stops it", () => {
    const onSet = vi.fn();
    render(
      <PriorityPanel
        state={state({ ...defaults, passing: "until_my_turn" })}
        onSet={onSet}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Passing until your next turn.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop passing" }));
    expect(onSet).toHaveBeenCalledWith({ cancel_passes: true });
  });

  it("stops a pass with Escape, but not while a dialog is open", () => {
    const onSet = vi.fn();
    render(
      <PriorityPanel
        state={state({ ...defaults, passing: "until_end_of_turn" })}
        onSet={onSet}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stops…" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onSet).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onSet).toHaveBeenCalledWith({ cancel_passes: true });
  });

  it("waits while a command is answered, and in another tab's hands", () => {
    const pending = state(defaults, {
      pending: {
        v: 1,
        game_id: "g1",
        action_id: "a",
        expected_revision: 1,
        type: "set_priority",
        payload: { full_control: true },
      },
    });
    const { unmount } = render(
      <PriorityPanel state={pending} onSet={vi.fn()} />,
    );
    expect(
      screen.getByRole("checkbox", { name: /Full control/ }),
    ).toBeDisabled();
    unmount();
    render(
      <PriorityPanel
        state={state(defaults, { role: "observer" })}
        onSet={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("checkbox", { name: /Full control/ }),
    ).toBeDisabled();
  });
});

describe("a pass in progress on the table", () => {
  it("is said in words the prompt column shows", () => {
    expect(passingText("until_my_turn")).toBe("Passing until your next turn.");
    expect(passingText("until_stack_resolved")).toBe(
      "Passing until the stack resolves.",
    );
  });

  it("is left to the column with showPassing off, and Escape still stops it", () => {
    const onSet = vi.fn();
    render(
      <PriorityPanel
        state={state({ ...defaults, passing: "until_my_turn" })}
        onSet={onSet}
        showPassing={false}
      />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop passing" })).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onSet).toHaveBeenCalledWith({ cancel_passes: true });
  });
});
