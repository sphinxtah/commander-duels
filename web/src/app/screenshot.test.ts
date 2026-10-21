import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LONG_EDGE,
  MAX_BYTES,
  SMALL_BYTES,
  ScreenshotError,
  allowedType,
  base64Of,
  fitWithin,
  prepareScreenshot,
  sendsAsIs,
  sizeText,
} from "./screenshot";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function file(bytes: number, type = "image/png", name = "shot.png") {
  return new File([new Uint8Array(bytes)], name, { type });
}

/** The picture the browser decodes from any file: this size. */
function decodes(width: number, height: number) {
  const close = vi.fn();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width, height, close })),
  );
  return close;
}

/**
 * jsdom draws nothing: a canvas whose encodings weigh what `weigh` says, and hand back PNG for
 * WebP where the browser cannot write it (as Safari does). Returns the sizes drawn at.
 */
function canvas(
  weigh: (width: number, type: string, quality: number) => number,
  { webp = true } = {},
) {
  const drawn: number[][] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    function (this: HTMLCanvasElement) {
      const target = this;
      return {
        drawImage: () => drawn.push([target.width, target.height]),
      } as never;
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    done,
    type = "image/png",
    quality = 1,
  ) {
    const made = type === "image/webp" && !webp ? "image/png" : type;
    done(
      new Blob([new Uint8Array(weigh(this.width, made, Number(quality)))], {
        type: made,
      }),
    );
  });
  return drawn;
}

describe("a problem report's screenshot", () => {
  it("fits 2560 px on its long edge with its own aspect, never larger", () => {
    expect(LONG_EDGE).toBe(2560);
    expect(fitWithin(4000, 3000)).toEqual({ width: 2560, height: 1920 });
    expect(fitWithin(1080, 5120)).toEqual({ width: 540, height: 2560 });
    expect(fitWithin(1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(fitWithin(1280, 720, 0.5)).toEqual({ width: 640, height: 360 });
  });

  it("goes as it is within 5 MB and 2560 px", () => {
    expect(MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(sendsAsIs(MAX_BYTES, 2560, 1440)).toBe(true);
    expect(sendsAsIs(MAX_BYTES + 1, 2560, 1440)).toBe(false);
    expect(sendsAsIs(1000, 2561, 100)).toBe(false);
    expect(sendsAsIs(SMALL_BYTES + 1, 1920, 1080, SMALL_BYTES)).toBe(false);
    // The small budget still fits a 1 MB request once in base64.
    expect(Math.ceil(SMALL_BYTES / 3) * 4).toBeLessThanOrEqual(1_000_000);
  });

  it("takes PNG, JPEG and WebP, by type or, without one, by name", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"])
      expect(allowedType(file(1, type))).toBe(true);
    expect(allowedType(file(1, "image/gif", "a.gif"))).toBe(false);
    expect(allowedType(file(1, "", "Photo.JPG"))).toBe(true);
    expect(allowedType(file(1, "", "photo.heic"))).toBe(false);
  });

  it("says sizes as people read them", () => {
    expect(sizeText(1_258_291)).toBe("1.2 MB");
    expect(sizeText(655_360)).toBe("640 KB");
    expect(sizeText(10)).toBe("1 KB");
  });

  it("keeps a small file as it is, as a data URL", async () => {
    const close = decodes(1280, 720);
    const drawn = canvas(() => 1);
    const shot = await prepareScreenshot(file(3, "image/png"));
    expect(shot).toEqual({
      dataUrl: "data:image/png;base64,AAAA",
      type: "image/png",
      size: 3,
      width: 1280,
      height: 720,
    });
    expect(base64Of(shot)).toBe("AAAA");
    expect(drawn).toEqual([]);
    expect(close).toHaveBeenCalled();
  });

  it("draws a file over 5 MB, or over 2560 px, smaller as WebP", async () => {
    decodes(4000, 3000);
    const drawn = canvas(() => 2_000_000);
    const shot = await prepareScreenshot(file(MAX_BYTES + 1, "image/jpeg"));
    expect(drawn).toEqual([[2560, 1920]]);
    expect(shot).toMatchObject({
      type: "image/webp",
      size: 2_000_000,
      width: 2560,
      height: 1920,
    });
    expect(shot.dataUrl).toMatch(/^data:image\/webp;base64,/);
  });

  it("writes JPEG where the browser cannot write WebP", async () => {
    decodes(3000, 2000);
    canvas(() => 1_000_000, { webp: false });
    const shot = await prepareScreenshot(file(1000, "image/png"));
    expect(shot.type).toBe("image/jpeg");
  });

  it("lowers the quality, then the size, until it fits the budget", async () => {
    decodes(4000, 2000);
    const qualities: number[] = [];
    const drawn = canvas((width, _type, quality) => {
      qualities.push(quality);
      return width > 1600 ? SMALL_BYTES + 1 : SMALL_BYTES;
    });
    const shot = await prepareScreenshot(file(900_000), SMALL_BYTES);
    expect(drawn.map(([width]) => width)).toEqual([2560, 2048, 1536]);
    expect(shot.size).toBe(SMALL_BYTES);
    // Every quality of both types at the first two sizes, then the first one fits.
    expect(qualities).toHaveLength(6 * 2 * 2 + 1);
  });

  it("refuses other types and files the browser cannot read", async () => {
    await expect(
      prepareScreenshot(file(10, "image/gif", "a.gif")),
    ).rejects.toThrow(new ScreenshotError("Choose a PNG, JPEG or WebP image."));
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new DOMException("bad", "InvalidStateError");
      }),
    );
    await expect(prepareScreenshot(file(10))).rejects.toThrow(
      "That file is not an image this browser can read.",
    );
  });

  it("gives up on an image that stays too heavy", async () => {
    decodes(4000, 3000);
    canvas(() => MAX_BYTES + 1);
    await expect(prepareScreenshot(file(MAX_BYTES + 1))).rejects.toThrow(
      "The image stays too large even at low quality. Try a smaller one.",
    );
  });
});
