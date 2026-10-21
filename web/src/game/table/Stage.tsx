import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { stageFit } from "./stage";
import type { Arrangement, Painter, SceneStatus, StageFit } from "./types";
import styles from "./screen.module.css";

// The stage (design §7): the table designed at 1920 × 1080, scaled by k to the window and
// centred, with the canvas behind it covering the whole viewport. The root carries the hooks
// the browser tests and the screen's CSS read: the scale, the renderer, whether the first frame
// is drawn, the revisions drawn and settled, the arrangement and the number of opponents.

function same(a: StageFit, b: StageFit): boolean {
  return (
    a.cssW === b.cssW &&
    a.cssH === b.cssH &&
    a.dpr === b.dpr &&
    a.resolution === b.resolution
  );
}

function measure(devicePxW?: number): StageFit {
  return stageFit(
    window.innerWidth,
    window.innerHeight,
    window.devicePixelRatio || 1,
    devicePxW,
  );
}

/** The stage's fit to the window, measured again once per frame of a resize. Where the browser
 * reports the viewport's width in device pixels (device-pixel-content-box), the canvas is drawn
 * at exactly that many. */
export function useStageFit(): StageFit {
  const [fit, setFit] = useState(() => measure());
  useEffect(() => {
    let frame = 0;
    /** The viewport's last reported width, in CSS and in device pixels. */
    let observed: { css: number; device: number } | undefined;
    // Only a box the width of the viewport now says how wide it is (a resize can come before
    // its report), and only one that agrees with the pixel ratio: it snaps a fractional scale
    // (1.25, 1.5) to whole device pixels, but under an emulated scale Chromium reports it in
    // CSS pixels.
    const devicePxW = () => {
      const dpr = window.devicePixelRatio || 1;
      return observed &&
        Math.abs(observed.css - window.innerWidth) < 1 &&
        Math.abs(observed.device - window.innerWidth * dpr) <= dpr + 1
        ? observed.device
        : undefined;
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = measure(devicePxW());
        setFit((current) => (same(current, next) ? current : next));
      });
    };
    window.addEventListener("resize", update);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver === "function") {
      observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        const box = entry?.devicePixelContentBoxSize?.[0];
        observed = box
          ? { css: entry.contentRect.width, device: box.inlineSize }
          : undefined;
        update();
      });
      try {
        observer.observe(document.documentElement, {
          box: "device-pixel-content-box",
        });
      } catch {
        // Browsers without that box: k × dpr is near enough.
        observer.disconnect();
        observer = undefined;
      }
    }
    update();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, []);
  return fit;
}

export function Stage({
  fit,
  painter,
  status,
  revision,
  arrangement,
  opponents,
  keyboardLock,
  canvas,
  children,
}: {
  fit: StageFit;
  painter: Painter;
  status: SceneStatus | null;
  /** The revision on screen, which the DOM painter has drawn as soon as it renders. */
  revision: number | null;
  arrangement: Arrangement | null;
  opponents: number;
  keyboardLock: boolean;
  canvas: ReactNode;
  children: ReactNode;
}) {
  const webgl = painter === "webgl";
  const renderer = webgl
    ? status?.renderer === "webgl"
      ? "webgl"
      : "starting"
    : "dom";
  const drawn = webgl ? (status?.drawnRevision ?? null) : revision;
  const settled = webgl ? (status?.settledRevision ?? null) : revision;
  return (
    <div
      className={styles.viewport}
      data-screen="table"
      data-scale={fit.k.toFixed(3)}
      data-renderer={renderer}
      data-ready={(webgl ? drawn !== null : true) || undefined}
      data-drawn-revision={drawn ?? undefined}
      data-settled-revision={settled ?? undefined}
      data-arrangement={arrangement ?? undefined}
      data-opponents={opponents || 1}
      data-small={fit.small || undefined}
      data-keyboard-lock={keyboardLock || undefined}
      style={{ "--stage-k": fit.k } as CSSProperties}
    >
      {!webgl && <div className={styles.plainTable} aria-hidden="true" />}
      {canvas}
      <div
        className={styles.stage}
        style={{
          transform: `translate(${fit.ox}px, ${fit.oy}px) scale(${fit.k})`,
        }}
      >
        {!webgl && <div className={styles.plainBand} aria-hidden="true" />}
        {children}
      </div>
    </div>
  );
}
