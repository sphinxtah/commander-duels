import { describe, expect, it } from "vitest";
import {
  containFit,
  isPortraitId,
  portraitBox,
  portraitName,
  portraitSize,
  portraitUrl,
} from "./portrait";

describe("Planeswalker portraits at the table", () => {
  it("ask only for roster IDs, from the portraits folder", () => {
    for (const id of ["rowan", "ajani-goldmane", "b-o-b", "the-sphinx"])
      expect(isPortraitId(id)).toBe(true);
    for (const id of [
      null,
      undefined,
      "",
      "Rowan",
      "../api/v1/me",
      "rowan/../../x",
      "rowan.webp",
      "-rowan",
      "rowan-",
      "a".repeat(65),
    ])
      expect(isPortraitId(id)).toBe(false);
    expect(portraitUrl("rowan", 256)).toBe("/portraits/rowan-256.webp");
  });

  it("are named for screen readers from their ID", () => {
    expect(portraitName("rowan")).toBe("Rowan");
    expect(portraitName("ajani-goldmane")).toBe("Ajani Goldmane");
    expect(portraitName("the-sphinx")).toBe("The Sphinx");
    expect(portraitName("b-o-b")).toBe("B.O.B.");
    expect(portraitName("mr-monopoly")).toBe("Mr. Monopoly");
  });

  it("take the 512 file only where the 256 would be stretched", () => {
    expect(portraitSize(161)).toBe(256);
    expect(portraitSize(288)).toBe(256);
    expect(portraitSize(289)).toBe(512);
    expect(portraitSize(645)).toBe(512);
  });

  it("stand nearly as wide as their diamond, raised a little, never cropped", () => {
    // Your diamond (design §8.4): ◇(118,912) 124, its box 30.3–205.7 × 824.3–999.7.
    const box = portraitBox({ cx: 118, cy: 912, side: 124 });
    const span = 124 * Math.SQRT2;
    expect(box.w).toBe(box.h);
    expect(box.w).toBeLessThan(span);
    expect(box.w).toBeGreaterThan(span * 0.85);
    expect(box.x + box.w / 2).toBeCloseTo(118, 6);
    // Raised: the head fills the frame's upper half, the foot rests behind the life badge.
    expect(box.y + box.h / 2).toBeLessThan(912);
    expect(box.y).toBeGreaterThan(912 - span / 2 - 12);
    // A picture is fitted whole: a square fills the box, a wide one keeps its shape, centred.
    expect(containFit(box, 512, 512)).toEqual(box);
    const wide = containFit({ x: 0, y: 0, w: 100, h: 100 }, 200, 100);
    expect(wide).toEqual({ x: 0, y: 25, w: 100, h: 50 });
    const tall = containFit({ x: 10, y: 0, w: 100, h: 100 }, 50, 100);
    expect(tall).toEqual({ x: 35, y: 0, w: 50, h: 100 });
  });
});
