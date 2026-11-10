import { afterEach, describe, expect, it, vi } from "vitest";
import { cardCrop, SEND_BYTES, shrinkPicture } from "./shrinkPicture";

// The owner's report (v0.9.3): a 3.4 MB sleeve picture would not upload. A picture above
// SEND_BYTES is cropped to a card's shape and encoded again, smaller, before it is sent.

/** A canvas whose JPEG weighs what `sizes` says for each quality asked, in turn. */
function fakeCanvas(sizes: number[]) {
  const drawn: number[][] = [];
  const asked: number[] = [];
  const canvases: { width: number; height: number }[] = [];
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
    if (tag !== "canvas") throw new Error(tag);
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({
        fillStyle: "",
        fillRect: () => {},
        drawImage: (...args: unknown[]) =>
          drawn.push((args.slice(1) as number[]).map(Number)),
      }),
      toBlob: (done: (blob: Blob) => void, _type: string, quality: number) => {
        asked.push(quality);
        const size = sizes.shift() ?? 1;
        done(new Blob([new Uint8Array(size)], { type: "image/jpeg" }));
      },
    };
    canvases.push(canvas);
    return canvas;
  }) as never);
  return { drawn, asked, canvases };
}

function bitmapOf(width: number, height: number) {
  const close = vi.fn();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width, height, close })),
  );
  return close;
}

describe("shrinkPicture", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("crops about the centre to a card's shape, as the server does", () => {
    expect(cardCrop(630, 880)).toEqual({ x: 0, y: 0, width: 630, height: 880 });
    // Too wide: the sides go. Too tall: the top and bottom go.
    expect(cardCrop(2000, 880)).toEqual({
      x: 685,
      y: 0,
      width: 630,
      height: 880,
    });
    expect(cardCrop(630, 1200)).toEqual({
      x: 0,
      y: 160,
      width: 630,
      height: 880,
    });
  });

  it("sends a small picture as it is", async () => {
    const small = new Blob([new Uint8Array(SEND_BYTES)], { type: "image/png" });
    expect(await shrinkPicture(small)).toBe(small);
  });

  it("makes a 3.4 MB picture a JPEG under the limit, lowering its quality first", async () => {
    const close = bitmapOf(3000, 4000);
    const { drawn, asked, canvases } = fakeCanvas([
      SEND_BYTES + 10,
      SEND_BYTES - 10,
    ]);
    const big = new Blob([new Uint8Array(3.4 * 1024 * 1024)], {
      type: "image/png",
    });
    const sent = await shrinkPicture(big);
    expect(sent.size).toBeLessThanOrEqual(SEND_BYTES);
    expect(sent.type).toBe("image/jpeg");
    expect(asked).toEqual([0.92, 0.85]);
    // At most 1008 wide, a card's shape, from the card-shaped centre of the picture.
    expect(canvases[0]).toMatchObject({ width: 1008, height: 1408 });
    expect(drawn[0].slice(0, 4)).toEqual(Object.values(cardCrop(3000, 4000)));
    expect(close).toHaveBeenCalled();
  });

  it("shrinks the size too when no quality is small enough", async () => {
    bitmapOf(1200, 1676);
    const { canvases } = fakeCanvas([
      ...Array(5).fill(SEND_BYTES * 2),
      SEND_BYTES - 1,
    ]);
    const sent = await shrinkPicture(
      new Blob([new Uint8Array(SEND_BYTES * 3)]),
    );
    expect(sent.size).toBeLessThan(SEND_BYTES);
    expect(canvases.map((canvas) => canvas.width)).toEqual([1008, 806]);
  });
});
