import type { CardImageSize } from "./table/types";

// Card images from our own server's cache (Scryfall's, fetched once), shared by the DOM's card
// faces and the table's textures (design §11). Both follow the same rules: a name the server has
// no image for is remembered for a while, and any other failure is retried with backoff, so the
// two never disagree about a card and a board of failures never asks all at once.

// Names the server says it has no image for, and when it said so. Only that answer is
// remembered, and only for a while, since the server asks Scryfall again after a week. Any other
// failure (a 503 or 429 while Scryfall is slow, a deploy, an expired session) is retried with
// backoff, waiting at least as long as the server's Retry-After, or at once when the server has
// the image by the time the page asks why. The memory is by name alone: for `png` the server
// falls back to `large` without recording anything, so a missing png never blanks a card (C17).
const missing = new Map<string, number>();
const MISSING_FOR_MS = 60 * 60 * 1000;
export const RETRIES = 5;

export function knownMissing(name: string): boolean {
  const since = missing.get(name);
  if (since === undefined) return false;
  if (Date.now() - since < MISSING_FOR_MS) return true;
  missing.delete(name);
  return false;
}

export function rememberMissing(name: string): void {
  missing.set(name, Date.now());
}

/** Whether the server's 404 says it has no image for the name (rather than a lost route). */
async function saysMissing(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as { code?: string };
    return (
      body.code === "card_image_missing" || body.code === "images_unavailable"
    );
  } catch {
    return false;
  }
}

/** Asks the server why an image failed: "missing" when it has no image for the name, "ready" when
 * it has one by now, otherwise how many seconds it asked the page to wait (0 when it did not say). */
export async function whyFailed(
  url: string,
): Promise<"missing" | "ready" | number> {
  try {
    const response = await fetch(url, { credentials: "same-origin" });
    if (response.ok) {
      // Read it all, so the image lands in the browser's cache and the retry draws it from there.
      await response.blob();
      return "ready";
    }
    if (response.status === 404 && (await saysMissing(response)))
      return "missing";
    return Number(response.headers.get("Retry-After")) || 0;
  } catch {
    return 0;
  }
}

/** How long to wait before asking again: doubling from 2 s up to a minute and never less than the
 * server's Retry-After, then spread by up to a quarter, so a board of failed cards does not ask
 * all at the same moment. */
export function backoff(attempt: number, retryAfter: number): number {
  const wait = Math.max(
    Math.min(60_000, 2_000 * 2 ** attempt),
    retryAfter * 1000,
  );
  return wait * (1 + Math.random() / 4);
}

export function cardImageUrl(name: string, size: CardImageSize): string {
  return `/api/v1/card-images?name=${encodeURIComponent(name)}&size=${size}`;
}

/** The smallest size that covers a card drawn this many device pixels tall: Scryfall's `normal`
 * is 680 tall, `large` 936 and `png` 1040. */
export function imageSizeFor(deviceHeight: number): CardImageSize {
  if (deviceHeight <= 680) return "normal";
  if (deviceHeight <= 936) return "large";
  return "png";
}

function abortError(): DOMException {
  return new DOMException("The image is no longer wanted.", "AbortError");
}

/** Waits, or rejects as soon as the signal aborts. */
function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    function stop() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/**
 * A card image's bytes, for the table's textures: "missing" when the server has none for the name
 * (remembered, as CardFace remembers it), otherwise the image. Other failures are retried with
 * the same backoff and limit as CardFace; after the last one the promise rejects, and the card
 * keeps its text frame. An aborted signal rejects at once with an AbortError.
 */
export async function fetchCardImage(
  name: string,
  size: CardImageSize,
  o: { signal?: AbortSignal } = {},
): Promise<Blob | "missing"> {
  if (knownMissing(name)) return "missing";
  const url = cardImageUrl(name, size);
  for (let attempt = 0; ; attempt += 1) {
    if (o.signal?.aborted) throw abortError();
    let retryAfter = 0;
    try {
      const response = await fetch(url, {
        credentials: "same-origin",
        signal: o.signal,
      });
      if (response.ok) return await response.blob();
      if (response.status === 404 && (await saysMissing(response))) {
        rememberMissing(name);
        return "missing";
      }
      retryAfter = Number(response.headers.get("Retry-After")) || 0;
    } catch (error) {
      if (o.signal?.aborted) throw abortError();
      if (error instanceof DOMException && error.name === "AbortError")
        throw error;
    }
    if (attempt >= RETRIES)
      throw new Error(`No image for ${name} after ${RETRIES + 1} tries.`);
    await wait(backoff(attempt, retryAfter), o.signal);
  }
}
