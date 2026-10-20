import { act, fireEvent, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameView, PlayerView, PriorityControls, Prompt } from "../types";
import type {
  TableUiSnapshot,
  TableUiStore,
  TimerInput,
  TimerView,
} from "./types";
import { useResponseTimer, useWindowAttention } from "./useResponseTimer";

const controls: PriorityControls = {
  passing: null,
  your_turn: ["main1", "main2"],
  opponent_turn: ["end_of_turn"],
  stop_on_new_stack_objects: true,
  stop_on_attackers: true,
  stop_on_blockers: true,
  pass_after_casting: false,
  full_control: false,
};

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

const view: GameView = {
  seat: 0,
  turn: 3,
  active_seat: 1,
  priority_seat: 0,
  phase: "precombat_main",
  step: "precombat_main",
  you: player(0, "Alice"),
  opponents: [player(1, "Bot 1")],
  hand: [],
  battlefield: [],
  stack: [
    {
      id: "s1",
      kind: "spell",
      controller_seat: 1,
      name: "Lightning Bolt",
      text: null,
      hidden: false,
      targets: [],
    },
  ],
  combat: [],
  revealed: [],
  looked_at: [],
  messages: [],
  priority: controls,
};

function prompt(id: string): Prompt {
  return {
    id,
    kind: "priority",
    message: "Respond?",
    detail: null,
    options: [
      {
        id: "o1",
        action: "pass",
        label: null,
        object_id: null,
        seat: null,
        selected: false,
      },
    ],
    amounts: null,
    piles: null,
    xmage_query: null,
  };
}

function input(fields: Partial<TimerInput>): TimerInput {
  return {
    prompt: prompt("p1"),
    revision: 10,
    view,
    status: "your_prompt",
    canAnswer: true,
    observing: false,
    role: "controller",
    phase: "open",
    pending: false,
    controls,
    seconds: 8,
    hidden: false,
    blurred: false,
    settledRevision: null,
    armCapMs: 1200,
    ...fields,
  };
}

/** The table's store, as the contract describes it, recording every timer it is given. */
function fakeUi(): TableUiStore & { writes: (TimerView | null)[] } {
  let snapshot: TableUiSnapshot = {
    hover: null,
    focus: null,
    focusVisible: false,
    pointer: null,
    risen: null,
    magnified: null,
    menu: null,
    drawer: null,
    drag: null,
    timer: null,
  };
  const listeners = new Set<() => void>();
  const writes: (TimerView | null)[] = [];
  return {
    writes,
    get: () => snapshot,
    set(patch) {
      snapshot = { ...snapshot, ...patch };
      if ("timer" in patch) writes.push(patch.timer ?? null);
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function mount(first: Partial<TimerInput> = {}, ui = fakeUi(), strict = false) {
  const onExpire = vi.fn();
  let renders = 0;
  const hook = renderHook(
    ({ fields }: { fields: Partial<TimerInput> }) => {
      renders += 1;
      return useResponseTimer(input(fields), ui, onExpire);
    },
    {
      initialProps: { fields: first },
      wrapper: strict ? StrictMode : undefined,
    },
  );
  return {
    ui,
    onExpire,
    hook,
    renders: () => renders,
    phase: () => hook.result.current.view?.phase ?? "idle",
    update: (fields: Partial<TimerInput>) => hook.rerender({ fields }),
  };
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Mounted and past the 1200 ms arming cap: running, 8 s left. */
function started(ui = fakeUi()) {
  const timer = mount({}, ui);
  advance(1200);
  expect(timer.phase()).toBe("running");
  return timer;
}

function add<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes))
    element.setAttribute(name, value);
  document.body.append(element);
  return element;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("the response timer hook", () => {
  it("arms, runs and continues for the player exactly once", () => {
    const timer = mount();
    expect(timer.phase()).toBe("arming");
    expect(timer.hook.result.current.view).toMatchObject({
      key: "p1|s1",
      totalMs: 8000,
      subject: "Bot 1's Lightning Bolt",
    });
    advance(1199);
    expect(timer.phase()).toBe("arming");
    advance(1);
    expect(timer.phase()).toBe("running");
    advance(7900);
    expect(timer.onExpire).not.toHaveBeenCalled();
    advance(100);
    expect(timer.onExpire).toHaveBeenCalledTimes(1);
    expect(timer.onExpire).toHaveBeenCalledWith("p1|s1");
    expect(timer.phase()).toBe("expired");
    timer.update({ revision: 11 });
    advance(10000);
    expect(timer.onExpire).toHaveBeenCalledTimes(1);
  });

  it("runs as soon as the table has drawn the moment", () => {
    const timer = mount();
    timer.update({ settledRevision: 10 });
    expect(timer.phase()).toBe("running");
  });

  it("re-renders only on phase changes while the store gets the progress at 10 Hz", () => {
    const timer = started();
    const renders = timer.renders();
    const writes = timer.ui.writes.length;
    advance(3000);
    expect(timer.renders()).toBe(renders);
    expect(timer.ui.writes.length - writes).toBe(30);
    expect(timer.ui.get().timer).toMatchObject({
      phase: "running",
      remainingMs: 5000,
    });
  });

  it("stops for good with Stop Timer", () => {
    const timer = started();
    act(() => timer.hook.result.current.stop());
    expect(timer.phase()).toBe("stopped");
    expect(timer.ui.get().timer?.phase).toBe("stopped");
    timer.update({ revision: 11 });
    advance(20000);
    expect(timer.phase()).toBe("stopped");
    expect(timer.onExpire).not.toHaveBeenCalled();
  });

  it("stops when the player presses any other key", () => {
    const timer = started();
    const stop = add("button", { "data-timer-stop": "" });
    // Escape is the screen's, modifiers do nothing, and T and Space are left to keys.ts, which
    // calls stop() and keeps Space from pressing the focused Continue.
    for (const key of ["Escape", "Shift", "Control", " ", "t", "T"])
      fireEvent.keyDown(document.body, { key });
    fireEvent.keyDown(stop, { key: "Enter" });
    expect(timer.phase()).toBe("running");
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(timer.phase()).toBe("stopped");
    advance(20000);
    expect(timer.onExpire).not.toHaveBeenCalled();
  });

  it("stops on a press on a control, not on the table or Stop Timer", () => {
    const timer = started();
    fireEvent.pointerDown(add("div"));
    fireEvent.pointerDown(add("button", { "data-timer-stop": "" }));
    expect(timer.phase()).toBe("running");
    const card = add("button", { "data-card": "c1" });
    fireEvent.pointerDown(card);
    expect(timer.phase()).toBe("stopped");
  });

  it.each<[string, Partial<TableUiSnapshot>]>([
    ["a menu opens", { menu: "battlefield:c1" }],
    ["another drawer opens", { drawer: "priority" }],
    [
      "a drag starts",
      {
        drag: { key: "hand:h1", point: { x: 0, y: 0 }, over: null, valid: [] },
      },
    ],
  ])("stops when %s, but not for a drawer already open", (_, patch) => {
    const ui = fakeUi();
    ui.set({ drawer: "log" });
    const timer = started(ui);
    act(() => ui.set({ hover: "battlefield:c2" }));
    expect(timer.phase()).toBe("running");
    act(() => ui.set(patch));
    expect(timer.phase()).toBe("stopped");
  });

  it("stops when a dialog opens", () => {
    const timer = started();
    add("dialog", { open: "" });
    advance(100);
    expect(timer.phase()).toBe("stopped");
  });

  it("pauses while the window is unfocused and resumes with at least 2 s", () => {
    const timer = started();
    advance(7500);
    timer.update({ blurred: true });
    expect(timer.phase()).toBe("paused");
    advance(60000);
    expect(timer.onExpire).not.toHaveBeenCalled();
    timer.update({ blurred: false });
    expect(timer.hook.result.current.view).toMatchObject({
      phase: "running",
      remainingMs: 2000,
    });
    advance(1900);
    expect(timer.onExpire).not.toHaveBeenCalled();
    advance(100);
    expect(timer.onExpire).toHaveBeenCalledTimes(1);
  });

  it("never fires after the prompt changes or while a command is pending", () => {
    const changed = started();
    advance(7900);
    changed.update({ prompt: prompt("p2") });
    expect(changed.hook.result.current.view).toMatchObject({
      key: "p2|s1",
      phase: "arming",
    });
    advance(200);
    expect(changed.onExpire).not.toHaveBeenCalled();
    changed.hook.unmount();

    const pending = started();
    pending.update({ pending: true, canAnswer: false });
    expect(pending.phase()).toBe("paused");
    advance(30000);
    expect(pending.onExpire).not.toHaveBeenCalled();
  });

  it("is idle when the moment is not a response", () => {
    const timer = mount({ seconds: 0 });
    expect(timer.hook.result.current.view).toBeNull();
    advance(20000);
    expect(timer.onExpire).not.toHaveBeenCalled();
    expect(timer.ui.get().timer).toBeNull();
  });

  it("runs once under StrictMode and clears the store when unmounted", () => {
    const timer = mount({}, fakeUi(), true);
    advance(1200);
    expect(timer.ui.get().timer?.phase).toBe("running");
    advance(8000);
    expect(timer.onExpire).toHaveBeenCalledTimes(1);
    timer.hook.unmount();
    expect(timer.ui.get().timer).toBeNull();
  });
});

describe("the window's attention", () => {
  it("follows the tab's visibility and the window's focus events", () => {
    const { result } = renderHook(() => useWindowAttention());
    // Focused until a blur says otherwise.
    expect(result.current).toEqual({ hidden: false, blurred: false });
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(result.current.blurred).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(result.current.blurred).toBe(false);
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current.hidden).toBe(true);
    visibility.mockRestore();
  });
});
