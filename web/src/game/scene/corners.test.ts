import { afterEach, describe, expect, it, vi } from "vitest";
import { CORNER, roundCorners } from "./corners";

// jsdom has no 2D canvas, so an OffscreenCanvas that records what is drawn stands in for one.
function recorder() {
  const calls: unknown[][] = [];
  const result = { cut: true } as unknown as ImageBitmap;
  class FakeCanvas {
    constructor(
      public width: number,
      public height: number,
    ) {
      calls.push(["canvas", width, height]);
    }
    getContext() {
      return {
        beginPath: () => calls.push(["beginPath"]),
        roundRect: (...args: unknown[]) => calls.push(["roundRect", ...args]),
        clip: () => calls.push(["clip"]),
        drawImage: (...args: unknown[]) => calls.push(["drawImage", ...args]),
      };
    }
    transferToImageBitmap() {
      calls.push(["transfer"]);
      return result;
    }
  }
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
  return { calls, result };
}

afterEach(() => vi.unstubAllGlobals());

describe("a card picture's corners (v0.5.1)", () => {
  it("are cut to the dom painter's radius before anything is drawn, and the source is closed", async () => {
    const { calls, result } = recorder();
    const close = vi.fn();
    const bitmap = { width: 488, height: 680, close } as unknown as ImageBitmap;
    expect(await roundCorners(bitmap)).toBe(result);
    expect(calls).toEqual([
      ["canvas", 488, 680],
      ["beginPath"],
      ["roundRect", 0, 0, 488, 680, 488 * CORNER],
      ["clip"],
      ["drawImage", bitmap, 0, 0],
      ["transfer"],
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("stay as they are where there is no 2D canvas", async () => {
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return null;
        }
      },
    );
    const close = vi.fn();
    const bitmap = { width: 128, height: 178, close } as unknown as ImageBitmap;
    expect(await roundCorners(bitmap)).toBe(bitmap);
    expect(close).not.toHaveBeenCalled();
  });
});
