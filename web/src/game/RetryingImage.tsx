import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  RETRIES,
  backoff,
  knownMissing,
  rememberMissing,
  whyFailed,
} from "./images";

// A card image from our own server's cache, retried the way the table's textures are (images.ts):
// a failure asks the server why; an image it has none for stays failed, remembered by its key for
// a while; any other failure (a 429 or 503 while many cards load at once, a deploy) is tried again
// with backoff, up to RETRIES times (since v0.6.5 a busy answer, with its Retry-After, for as
// long as the picture is on the page). Every card picture uses it: the table's faces by card name,
// and since v0.4.4 the catalog's, the pack opening's and the decks' by printing, which until then
// gave up at the first failure and kept their text frame for good.

export type ImageState = "loading" | "loaded" | "failed";

export interface ImageRetry {
  state: ImageState;
  /** Each try is a new <img>, so the browser asks again: use it as the <img>'s key. */
  attempt: number;
  onLoad: () => void;
  onError: () => void;
  ref: (image: HTMLImageElement | null) => void;
}

/** The retries of one image. `key` is what a "no image" answer is remembered by (the card's name
 * for the table, the address otherwise). A new `src` starts again. */
export function useImageRetry(
  src: string | null,
  key: string | null = src,
): ImageRetry {
  const initial = (): ImageState =>
    key !== null && knownMissing(key) ? "failed" : "loading";
  const [shown, setShown] = useState(src);
  const [state, setState] = useState<ImageState>(initial);
  const [attempt, setAttempt] = useState(0);
  if (shown !== src) {
    setShown(src);
    setState(initial());
    setAttempt(0);
  }
  const retry = useRef<number | undefined>(undefined);
  // The address still shown, or null once the image is gone: a late answer retries nothing else.
  const live = useRef<string | null>(src);
  useEffect(() => {
    live.current = src;
    return () => {
      live.current = null;
      window.clearTimeout(retry.current);
    };
  }, [src]);

  function onError() {
    if (src === null) return;
    setState("failed");
    const tried = attempt;
    void whyFailed(src).then((why) => {
      if (why === "missing") {
        if (key !== null) rememberMissing(key);
      } else if (
        live.current === src &&
        // A busy server (a Retry-After) is asked again as long as the picture is on the page
        // (v0.6.5): a big library's pictures queue for their downloads; other failures RETRIES
        // times.
        (tried < RETRIES || (typeof why === "number" && why > 0))
      )
        retry.current = window.setTimeout(
          () => {
            setAttempt(tried + 1);
            setState("loading");
          },
          why === "ready" ? 0 : backoff(tried, why),
        );
    });
  }

  return {
    state,
    attempt,
    onLoad: () => setState("loaded"),
    onError,
    ref: (image) => {
      // An image already in the browser's cache may be complete before React listens.
      if (image?.complete && image.naturalWidth > 0 && state === "loading")
        setState("loaded");
    },
  };
}

/** An <img> of a card image with its retries, and `fallback` in its place while it has none. */
export function RetryingImage({
  src,
  fallback = null,
  width,
  height,
  className,
}: {
  src: string;
  fallback?: ReactNode;
  width?: number;
  height?: number;
  className?: string;
}) {
  const image = useImageRetry(src);
  if (image.state === "failed") return <>{fallback}</>;
  return (
    <img
      key={image.attempt}
      src={src}
      alt=""
      width={width}
      height={height}
      className={className}
      loading="lazy"
      decoding="async"
      ref={image.ref}
      onLoad={image.onLoad}
      onError={image.onError}
    />
  );
}
