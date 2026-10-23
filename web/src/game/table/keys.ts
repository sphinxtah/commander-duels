import { useEffect, useLayoutEffect, useRef } from "react";
import { timerLive } from "./timer";
import type { FullscreenState, ResponseTimer } from "./types";

// The table's own keys (design §9.4), on top of the screen's P and every control's own keys:
// T and Space stop the response timer while it runs, F turns full screen on and off, and Escape
// closes one layer per press (a drag, the Game menu, a drawer, the magnified card, an expanded
// board). Escape that closes nothing is left to PriorityPanel, which stops a pass with it; an open
// menu and a native dialog keep their own Escape.

/** Where a key is text being typed, or belongs to a dialog: the table's keys stay out. */
function typing(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("input, textarea, select, [contenteditable=true]") !== null
  );
}

/** A key pressed in the chat bar (v0.5.1), which floats over the table when brought out: the
 * chat's own, Escape included (it puts the bar away). */
export function inChatBar(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest("[data-chat-bar]") !== null
  );
}

function dialogOpen(): boolean {
  return document.querySelector("dialog[open]") !== null;
}

function plain(event: KeyboardEvent): boolean {
  return !event.ctrlKey && !event.metaKey && !event.altKey;
}

function isSpace(event: KeyboardEvent): boolean {
  return event.key === " " || event.key === "Spacebar";
}

export function useTableKeys(a: {
  timer: ResponseTimer | null;
  fullscreen: FullscreenState;
  /** Closes the topmost layer; true when there was one. */
  closeLayer(): boolean;
}): void {
  const latest = useRef(a);
  useLayoutEffect(() => {
    latest.current = a;
  });

  useEffect(() => {
    // A Space whose press stopped the timer: its release must not press the focused button
    // (buttons act on Space's keyup), or stopping the timer would pass after all.
    let swallowSpace = false;
    const timerRunning = () => {
      const view = latest.current.timer?.view;
      return view ? timerLive(view.phase) : false;
    };

    const down = (event: KeyboardEvent) => {
      if (inChatBar(event.target)) return;
      if (event.key === "Escape") {
        if (event.defaultPrevented || dialogOpen()) return;
        if (
          event.target instanceof Element &&
          event.target.closest("[role=menu]")
        )
          return;
        if (latest.current.closeLayer()) event.preventDefault();
        return;
      }
      if (!plain(event) || typing(event.target) || dialogOpen()) return;
      if (isSpace(event)) {
        if (!timerRunning()) return;
        event.preventDefault();
        event.stopPropagation();
        swallowSpace = true;
        latest.current.timer?.stop();
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "t" && timerRunning()) {
        event.preventDefault();
        latest.current.timer?.stop();
      } else if (key === "f" && !event.repeat) {
        const fullscreen = latest.current.fullscreen;
        if (!fullscreen.available) return;
        event.preventDefault();
        fullscreen.toggle();
      }
    };
    const up = (event: KeyboardEvent) => {
      if (!isSpace(event) || !swallowSpace) return;
      swallowSpace = false;
      event.preventDefault();
      event.stopPropagation();
    };
    // Capture phase: the table's keys come before any control's own.
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, []);
}
