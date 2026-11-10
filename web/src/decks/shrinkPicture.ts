// A sleeve's picture made small before it is sent (v0.9.3, the owner's report: a 3.4 MB picture
// would not upload). The server keeps only a 504 by 704 WebP cropped about its centre to a card's
// shape (api/sleeves.py), so nothing it keeps is lost here: a picture above SEND_BYTES is cropped
// the same way, scaled to at most twice that size, and encoded again as JPEG, its quality and then
// its size lowered until it fits. SEND_BYTES leaves room for the request's base64 inside a
// proxy's 1 MB limit.

/** The most a picture may weigh as sent: about 0.7 MB, about 0.95 MB once in base64. */
export const SEND_BYTES = 700 * 1024;
/** A card's shape, width to height (63 by 88 mm), as the server crops it. */
const CARD = 63 / 88;
/** Twice the size the server keeps (504 by 704): sharp on any screen, never wasted. */
const MAX_WIDTH = 1008;
const QUALITIES = [0.92, 0.85, 0.78, 0.7, 0.6];

/** The part of a width × height picture a card's shape keeps, about its centre. */
export function cardCrop(width: number, height: number) {
  let w = width;
  let h = height;
  if (w / h > CARD) w = Math.round(h * CARD);
  else h = Math.round(w / CARD);
  return {
    x: Math.floor((width - w) / 2),
    y: Math.floor((height - h) / 2),
    width: w,
    height: h,
  };
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("The picture could not be encoded.")),
      "image/jpeg",
      quality,
    ),
  );
}

/**
 * The picture to send: the file itself when it is small enough, else a JPEG of its card-shaped
 * centre, at most 1008 pixels wide, under SEND_BYTES. Throws when the browser cannot read it.
 */
export async function shrinkPicture(file: Blob): Promise<Blob> {
  if (file.size <= SEND_BYTES) return file;
  // createImageBitmap turns a photo upright from its EXIF orientation, as the server does.
  const bitmap = await createImageBitmap(file);
  try {
    const crop = cardCrop(bitmap.width, bitmap.height);
    let width = Math.min(MAX_WIDTH, crop.width);
    for (let attempt = 0; attempt < 6; attempt++) {
      const height = Math.max(1, Math.round(width / CARD));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("The picture could not be drawn.");
      // A transparent PNG keeps a dark backing rather than JPEG's black.
      context.fillStyle = "#101418";
      context.fillRect(0, 0, width, height);
      context.drawImage(
        bitmap,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        width,
        height,
      );
      for (const quality of QUALITIES) {
        const blob = await encode(canvas, quality);
        if (blob.size <= SEND_BYTES) return blob;
      }
      width = Math.max(1, Math.round(width * 0.8));
    }
    throw new Error("The picture could not be made small enough.");
  } finally {
    bitmap.close();
  }
}
