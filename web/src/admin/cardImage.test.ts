import { describe, expect, it, vi } from "vitest";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  CardImageError,
  IMAGE_BUDGET,
  encodeUnder,
  fitSize,
  toBase64,
} from "./cardImage";

describe("a custom card's image", () => {
  it("fits Scryfall's card size with its own aspect, larger or smaller", () => {
    expect(fitSize(1490, 2080)).toEqual({ width: 745, height: 1040 });
    expect(fitSize(149, 208)).toEqual({ width: 745, height: 1040 });
    // A wider picture fits the width; a taller one, the height.
    expect(fitSize(2000, 2000)).toEqual({ width: 745, height: 745 });
    expect(fitSize(500, 2000)).toEqual({ width: 260, height: 1040 });
    expect(fitSize(1, 1)).toEqual({ width: 745, height: 745 });
  });

  it("is sent as base64 small enough for the proxies' 1 MiB, with room for the card's text", () => {
    expect(CARD_WIDTH).toBe(745);
    expect(CARD_HEIGHT).toBe(1040);
    expect(Math.ceil(IMAGE_BUDGET / 3) * 4).toBeLessThanOrEqual(1_000_000);
  });

  it("is encoded at falling quality until it is under the budget", async () => {
    const sizes: Record<string, number> = {
      "0.92": 900,
      "0.85": 700,
      "0.78": 500,
    };
    const encode = vi.fn(
      async (quality: number) =>
        new Blob([new Uint8Array(sizes[String(quality)] ?? 100)], {
          type: "image/webp",
        }),
    );
    const found = await encodeUnder(encode, 600);
    expect(found?.quality).toBe(0.78);
    expect(found?.blob.size).toBe(500);
    expect(encode.mock.calls.map(([quality]) => quality)).toEqual([
      0.92, 0.85, 0.78,
    ]);
  });

  it("gives up when even the lowest quality is too heavy, and passes an encoder's failure on", async () => {
    const heavy = async () => new Blob([new Uint8Array(50)]);
    expect(await encodeUnder(heavy, 10)).toBeNull();
    await expect(
      encodeUnder(async () => {
        throw new CardImageError("This browser cannot make WebP images.");
      }),
    ).rejects.toThrow("This browser cannot make WebP images.");
  });

  it("becomes base64 without the data URL's prefix", async () => {
    expect(
      await toBase64(
        new Blob([new Uint8Array([1, 2, 3, 250])], { type: "image/webp" }),
      ),
    ).toBe("AQID+g==");
  });
});
