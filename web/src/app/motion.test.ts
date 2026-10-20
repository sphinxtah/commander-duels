import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TableSettings } from "../game/table/types";
import { useLargeText, useMotionLevel } from "./motion";
import { useOnline } from "./online";

afterEach(() => {
  delete document.documentElement.dataset.reducedMotion;
  delete document.documentElement.dataset.largeText;
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "matchMedia");
});

/** Lets the MutationObserver report an attribute change. */
async function observed(change: () => void) {
  await act(async () => {
    change();
    await Promise.resolve();
  });
}

describe("the page's settings, for the table's drawing", () => {
  it("motion follows the table's speed until Reduce motion stills it", async () => {
    const { result, rerender } = renderHook(
      ({ speed }: { speed: TableSettings["animationSpeed"] }) =>
        useMotionLevel(speed),
      { initialProps: { speed: "fast" } },
    );
    expect(result.current).toBe("fast");
    await observed(() => {
      document.documentElement.dataset.reducedMotion = "true";
    });
    expect(result.current).toBe("none");
    await observed(() => {
      document.documentElement.dataset.reducedMotion = "false";
    });
    rerender({ speed: "faster" });
    expect(result.current).toBe("faster");
  });

  it("the system's reduced motion counts too", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    const { result } = renderHook(() => useMotionLevel("normal"));
    expect(result.current).toBe("none");
  });

  it("Larger text is read from the page", async () => {
    const { result } = renderHook(() => useLargeText());
    expect(result.current).toBe(false);
    await observed(() => {
      document.documentElement.dataset.largeText = "true";
    });
    expect(result.current).toBe(true);
  });

  it("online follows the browser's events", () => {
    let online = true;
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(true);
    online = false;
    act(() => void window.dispatchEvent(new Event("offline")));
    expect(result.current).toBe(false);
    online = true;
    act(() => void window.dispatchEvent(new Event("online")));
    expect(result.current).toBe(true);
  });
});
