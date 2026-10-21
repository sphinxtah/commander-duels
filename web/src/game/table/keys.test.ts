import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTableKeys } from "./keys";
import type { FullscreenState, ResponseTimer, TimerPhase } from "./types";

function timer(phase: TimerPhase | null): ResponseTimer {
  return {
    view: phase
      ? { key: "k", phase, remainingMs: 5000, totalMs: 8000, subject: null }
      : null,
    stop: vi.fn(),
    engage: vi.fn(),
  };
}

function fullscreen(available = true): FullscreenState {
  return {
    available,
    active: false,
    escapeLocked: false,
    enteredByUs: false,
    toggle: vi.fn(),
  };
}

function keys(
  a: Partial<Parameters<typeof useTableKeys>[0]> = {},
): Parameters<typeof useTableKeys>[0] {
  return {
    timer: timer("running"),
    fullscreen: fullscreen(),
    closeLayer: vi.fn(() => false),
    ...a,
  };
}

function press(
  key: string,
  target: EventTarget = document.body,
  type: "keydown" | "keyup" = "keydown",
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
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

afterEach(() => {
  document.body.replaceChildren();
});

describe("the table's keys", () => {
  it("stop the running timer with T and Space, and Space's release presses nothing", () => {
    const a = keys();
    renderHook(() => useTableKeys(a));
    const continueButton = add("button");
    const listener = vi.fn();
    continueButton.addEventListener("keyup", listener);
    expect(press("t").defaultPrevented).toBe(true);
    expect(press(" ", continueButton).defaultPrevented).toBe(true);
    expect(press(" ", continueButton, "keyup").defaultPrevented).toBe(true);
    // The release is stopped before it reaches the button.
    expect(listener).not.toHaveBeenCalled();
    expect(a.timer!.stop).toHaveBeenCalledTimes(2);
    // A later Space release is the button's own again.
    expect(press(" ", continueButton, "keyup").defaultPrevented).toBe(false);
  });

  it("leave T and Space alone when no timer runs, and while typing or with a modifier", () => {
    const idle = keys({ timer: timer("stopped") });
    const { unmount } = renderHook(() => useTableKeys(idle));
    expect(press(" ").defaultPrevented).toBe(false);
    expect(press("t").defaultPrevented).toBe(false);
    unmount();

    const running = keys();
    renderHook(() => useTableKeys(running));
    expect(press("t", add("input")).defaultPrevented).toBe(false);
    expect(
      press("t", document.body, "keydown", { ctrlKey: true }).defaultPrevented,
    ).toBe(false);
    add("dialog", { open: "" });
    expect(press(" ").defaultPrevented).toBe(false);
    expect(running.timer!.stop).not.toHaveBeenCalled();
  });

  it("turn full screen on and off with F, where the browser offers it", () => {
    const a = keys();
    const { unmount } = renderHook(() => useTableKeys(a));
    press("f");
    press("F", document.body, "keydown", { repeat: true });
    expect(a.fullscreen.toggle).toHaveBeenCalledTimes(1);
    unmount();

    const none = keys({ fullscreen: fullscreen(false) });
    renderHook(() => useTableKeys(none));
    expect(press("f").defaultPrevented).toBe(false);
  });

  it("close one layer per Escape, and leave the rest to a menu, a dialog or a pass", () => {
    const closeLayer = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    renderHook(() => useTableKeys(keys({ closeLayer })));
    expect(press("Escape").defaultPrevented).toBe(true);
    // Nothing left to close: PriorityPanel's own listener may stop a pass.
    expect(press("Escape").defaultPrevented).toBe(false);
    expect(closeLayer).toHaveBeenCalledTimes(2);

    const item = add("div", { role: "menu" }).appendChild(
      document.createElement("button"),
    );
    press("Escape", item);
    add("dialog", { open: "" });
    press("Escape");
    expect(closeLayer).toHaveBeenCalledTimes(2);
  });
});
