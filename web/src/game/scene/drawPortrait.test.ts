import { describe, expect, it } from "vitest";
import { greyOut } from "./drawPortrait";

describe("an opponent's portrait", () => {
  it("turns grey by luminance and keeps its transparency", () => {
    // Red, green, blue and a half-transparent white pixel.
    const data = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128,
    ]);
    let written: Uint8ClampedArray | null = null;
    greyOut(
      {
        getImageData: () => ({ data }) as ImageData,
        putImageData: (image: ImageData) => {
          written = image.data;
        },
      },
      2,
      2,
    );
    expect(written).toBe(data);
    expect([...data]).toEqual([
      54, 54, 54, 255, 182, 182, 182, 255, 18, 18, 18, 255, 255, 255, 255, 128,
    ]);
  });
});
