import { canvas } from "./art";

// A Planeswalker's portrait made ready for the table (v0.3.1): copied onto a canvas of its own
// size with its transparency kept, and greyed for an opponent, as Magic Duels drew theirs. The
// portraits are the owner's art, not card images, so greying them is ours to do (the v0.3.0
// brief, docs/plans/0.3.0.md). The dom painter greys its picture with CSS's grayscale(), whose
// weights these are.

/** Luminance weights (Rec. 709), as CSS's grayscale() uses. */
const WEIGHTS = [0.2126, 0.7152, 0.0722] as const;

/** Turns the pixels of a 2D context grey, leaving their alpha. */
export function greyOut(
  ctx: Pick<CanvasRenderingContext2D, "getImageData" | "putImageData">,
  width: number,
  height: number,
): void {
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const y = Math.round(
      WEIGHTS[0] * data[i] +
        WEIGHTS[1] * data[i + 1] +
        WEIGHTS[2] * data[i + 2],
    );
    data[i] = y;
    data[i + 1] = y;
    data[i + 2] = y;
  }
  ctx.putImageData(image, 0, 0);
}

/** The portrait on a canvas of its own size, grey when `grey`. */
export function drawPortrait(
  picture: CanvasImageSource & { width: number; height: number },
  grey: boolean,
): HTMLCanvasElement {
  const c = canvas(picture.width, picture.height);
  const ctx = c.getContext("2d", { willReadFrequently: grey });
  if (!ctx) return c;
  ctx.drawImage(picture, 0, 0);
  if (grey) greyOut(ctx, c.width, c.height);
  return c;
}
