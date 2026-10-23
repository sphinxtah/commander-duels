// A card picture's rounded corners (v0.5.1, the owner's report of square corners in the hand).
// Scryfall's normal and large pictures, which the board and the hand draw, are JPEGs whose
// corners are filled in; only the png, which the magnifier shows from the DOM, has them
// transparent. So each picture is cut to the card's rounded outline once, as it is decoded: the
// scene still never masks a card, and the dom painter rounds its faces with CSS at the same
// radius (`.paint` in table.module.css).

/** The corner's radius as a share of the card's width: the dom painter's. */
export const CORNER = 0.055;

type Canvas = OffscreenCanvas | HTMLCanvasElement;

function canvasOf(width: number, height: number): Canvas {
  if (typeof OffscreenCanvas !== "undefined")
    return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * The picture with its corners cut away (transparent), as a new bitmap; the one given is closed.
 * Where no 2D canvas is to be had, the picture as it is.
 */
export async function roundCorners(bitmap: ImageBitmap): Promise<ImageBitmap> {
  const { width, height } = bitmap;
  const canvas = canvasOf(width, height);
  const context = canvas.getContext("2d") as
    OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!context) return bitmap;
  context.beginPath();
  context.roundRect(0, 0, width, height, width * CORNER);
  context.clip();
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return "transferToImageBitmap" in canvas
    ? canvas.transferToImageBitmap()
    : createImageBitmap(canvas);
}
