// A custom card's image, made ready in the browser before SysOp uploads it (v0.3.1). The proxies
// in front of the API take requests of at most 1 MB, so the picture is scaled to fit Scryfall's
// card size, 745 x 1040 (its aspect kept, the whole of it shown), and encoded as WebP at falling
// quality until it is small enough to send.

export const CARD_WIDTH = 745;
export const CARD_HEIGHT = 1040;
/**
 * The most the encoded image may weigh. Sent as base64 it grows by a third: 750,000 bytes become
 * 1,000,000 characters, which leaves room in a 1 MiB request for the card's own text. (An image of
 * 800 KB would already be 1,066,668 characters on its own, over the limit.)
 */
export const IMAGE_BUDGET = 750_000;
// The qualities tried in turn, best first.
const QUALITIES = [0.92, 0.85, 0.78, 0.7, 0.6, 0.5, 0.4, 0.3];
// Should the lowest quality still weigh too much, the picture itself shrinks, this much each time.
const SHRINKS = [1, 0.85, 0.7, 0.55];

/** What the page says when an image cannot be made ready. */
export class CardImageError extends Error {}

export type FittedImage = {
  blob: Blob;
  width: number;
  height: number;
  /** The WebP quality that met the budget. */
  quality: number;
};

/** The size that fits the card's box with the picture's own aspect: larger or smaller. */
export function fitSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const scale = Math.min(CARD_WIDTH / width, CARD_HEIGHT / height);
  return {
    width: Math.max(1, Math.min(CARD_WIDTH, Math.round(width * scale))),
    height: Math.max(1, Math.min(CARD_HEIGHT, Math.round(height * scale))),
  };
}

/**
 * The first encoding under the budget, trying each quality in turn; null if none is. An encoder
 * that fails throws, and so does this.
 */
export async function encodeUnder(
  encode: (quality: number) => Promise<Blob>,
  budget = IMAGE_BUDGET,
): Promise<{ blob: Blob; quality: number } | null> {
  for (const quality of QUALITIES) {
    const blob = await encode(quality);
    if (blob.size <= budget) return { blob, quality };
  }
  return null;
}

function webp(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => {
        if (!blob)
          reject(new CardImageError("The image could not be encoded."));
        // A browser that cannot write WebP hands back a PNG instead.
        else if (blob.type !== "image/webp")
          reject(
            new CardImageError(
              "This browser cannot make WebP images. Use a current Chrome, Edge or Firefox.",
            ),
          );
        else resolve(blob);
      },
      "image/webp",
      quality,
    ),
  );
}

/** Scales the chosen file to the card's size and encodes it as WebP under the budget. */
export async function fitCardImage(file: Blob): Promise<FittedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new CardImageError(
      "That file is not an image this browser can read.",
    );
  }
  try {
    const fitted = fitSize(bitmap.width, bitmap.height);
    for (const shrink of SHRINKS) {
      const width = Math.max(1, Math.round(fitted.width * shrink));
      const height = Math.max(1, Math.round(fitted.height * shrink));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context)
        throw new CardImageError("This browser cannot resize images.");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, width, height);
      const encoded = await encodeUnder((quality) => webp(canvas, quality));
      if (encoded) return { ...encoded, width, height };
    }
    throw new CardImageError(
      "The image stays over 750 KB even at low quality. Try a simpler picture.",
    );
  } finally {
    bitmap.close();
  }
}

/** The blob as base64, without the data URL's prefix: what the API's JSON carries. */
/** The image as a data: URL. The preview shows it so (v0.4.2): the site's Content-Security-Policy
 * lets images come from the site and from data: URLs only, so a blob: object URL would not show. */
export function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function toBase64(blob: Blob): Promise<string> {
  return (await toDataUrl(blob)).replace(/^data:[^,]*,/, "");
}
