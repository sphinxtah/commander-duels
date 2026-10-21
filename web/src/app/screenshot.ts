// A problem report's screenshot (v0.4.1), made ready in the browser. The API takes a PNG, JPEG or
// WebP of at most 5 MB, re-encodes it and keeps at most 2560 px on its long edge. A file that
// fits both goes as it is. A larger one, or one wider or taller than that, is drawn smaller on a
// canvas and encoded here first (WebP, or JPEG where the browser cannot write WebP), which also
// drops its metadata before it leaves the device.
//
// The preview is a data: URL. The site's Content-Security-Policy lets images come from the site
// and from data: URLs only, so a blob: object URL would not show.

export const SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp"];
/** 5 MB as a computer shows file sizes; the API's own limit. */
export const MAX_BYTES = 5 * 1024 * 1024;
export const LONG_EDGE = 2560;
/**
 * What goes through a proxy that keeps nginx's 1 MB limit on requests: 750 KB is 1,000,000
 * characters in base64, with room left for the report's text. The page falls back to it when a
 * larger screenshot is refused on the way (docs/reports.md).
 */
export const SMALL_BYTES = 750_000;
// The qualities tried in turn, best first, and how much the picture shrinks when none fits.
const QUALITIES = [0.9, 0.82, 0.74, 0.66, 0.58, 0.5];
const SHRINKS = [1, 0.8, 0.6, 0.45, 0.3];

/** What the dialog says when an image cannot be made ready. */
export class ScreenshotError extends Error {}

export type Screenshot = {
  /** The image as a data: URL: the preview's source, and the upload's. */
  dataUrl: string;
  type: string;
  /** Bytes, as sent. */
  size: number;
  width: number;
  height: number;
};

/** The image's base64, without the data URL's prefix: what the report's JSON carries. */
export function base64Of(shot: Screenshot): string {
  return shot.dataUrl.slice(shot.dataUrl.indexOf(",") + 1);
}

/** Whether the file is one the API takes; a file without a type goes by its name. */
export function allowedType(file: Blob & { name?: string }): boolean {
  if (file.type) return SCREENSHOT_TYPES.includes(file.type);
  return /\.(png|jpe?g|webp)$/i.test(file.name ?? "");
}

/** Whether a file goes as it is: within the budget and LONG_EDGE on its long edge. */
export function sendsAsIs(
  size: number,
  width: number,
  height: number,
  budget = MAX_BYTES,
): boolean {
  return size <= budget && Math.max(width, height) <= LONG_EDGE;
}

/** The size within LONG_EDGE with the picture's own aspect, scaled further by `shrink`. */
export function fitWithin(
  width: number,
  height: number,
  shrink = 1,
): { width: number; height: number } {
  const scale = Math.min(1, LONG_EDGE / Math.max(width, height)) * shrink;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** "1.2 MB", "640 KB": a size as people read it. */
export function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function blobOf(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** The first encoding within the budget, WebP first; null if none is. */
async function encoded(
  canvas: HTMLCanvasElement,
  budget: number,
): Promise<Blob | null> {
  for (const type of ["image/webp", "image/jpeg"]) {
    for (const quality of QUALITIES) {
      const blob = await blobOf(canvas, type, quality);
      if (!blob) throw new ScreenshotError("The image could not be encoded.");
      // A browser that cannot write this type hands back a PNG: try the next type.
      if (blob.type !== type) break;
      if (blob.size <= budget) return blob;
    }
  }
  return null;
}

/**
 * Reads a chosen, pasted or dropped file: refuses other types, keeps one that fits as it is, and
 * draws a larger one smaller until it fits the budget.
 */
export async function prepareScreenshot(
  file: Blob & { name?: string },
  budget = MAX_BYTES,
): Promise<Screenshot> {
  if (!allowedType(file))
    throw new ScreenshotError("Choose a PNG, JPEG or WebP image.");
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ScreenshotError(
      "That file is not an image this browser can read.",
    );
  }
  try {
    const { width, height } = bitmap;
    if (sendsAsIs(file.size, width, height, budget))
      return {
        dataUrl: await dataUrlOf(file),
        type: file.type || "image/png",
        size: file.size,
        width,
        height,
      };
    for (const shrink of SHRINKS) {
      const size = fitWithin(width, height, shrink);
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      if (!context)
        throw new ScreenshotError("This browser cannot resize images.");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(bitmap, 0, 0, size.width, size.height);
      const blob = await encoded(canvas, budget);
      if (blob)
        return {
          dataUrl: await dataUrlOf(blob),
          type: blob.type,
          size: blob.size,
          ...size,
        };
    }
    throw new ScreenshotError(
      "The image stays too large even at low quality. Try a smaller one.",
    );
  } finally {
    bitmap.close();
  }
}
