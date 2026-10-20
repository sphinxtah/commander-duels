import { STAGE_H, STAGE_W, type Point, type StageFit } from "./types";

// The stage: one 16:9 table designed at 1920 × 1080 and scaled to the window (design §7). The
// DOM layer is one box scaled by k; the canvas covers the whole viewport outside that transform
// and draws at `resolution` device pixels per stage unit, so the table is as sharp as the
// screen allows at 1440p and 4K without a backing store larger than 4K's.

/** The largest backing store the canvas gets: 3840 × 2160 device pixels. */
export const MAX_BACKING = 3840 * 2160;
/** A safe MAX_TEXTURE_SIZE when the renderer has not said its own. */
export const DEFAULT_MAX_TEXTURE = 8192;
/** The table never shrinks below a quarter of its size, however small the window. */
export const MIN_SCALE = 1 / 4;

/** Rounds a CSS length to whole device pixels, so the stage's edges stay crisp. */
function toDevicePixels(value: number, dpr: number): number {
  return Math.round(value * dpr) / dpr;
}

/** How the stage fits a viewport of cssW × cssH CSS pixels. `devicePxW` is the canvas's width in
 * device pixels when a ResizeObserver reported it (device-pixel-content-box); otherwise
 * cssW × dpr. */
export function stageFit(
  cssW: number,
  cssH: number,
  dpr: number,
  devicePxW?: number,
  maxTexture: number = DEFAULT_MAX_TEXTURE,
): StageFit {
  const w = Math.max(1, cssW);
  const h = Math.max(1, cssH);
  const ratio = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  const k = Math.max(MIN_SCALE, Math.min(w / STAGE_W, h / STAGE_H));
  const designW = w / k;
  const designH = h / k;
  const devicePx = devicePxW && devicePxW > 0 ? devicePxW : w * ratio;
  const resolution = Math.min(
    devicePx / designW,
    Math.sqrt(MAX_BACKING / (designW * designH)),
    maxTexture / designW,
    maxTexture / designH,
  );
  return {
    cssW: w,
    cssH: h,
    dpr: ratio,
    k,
    ox: toDevicePixels((w - STAGE_W * k) / 2, ratio),
    oy: toDevicePixels((h - STAGE_H * k) / 2, ratio),
    designW,
    designH,
    resolution,
    small: w < 1280 || h < 720,
  };
}

/** A point in the viewport (clientX, clientY) in stage units. */
export function toDesign(
  fit: StageFit,
  clientX: number,
  clientY: number,
): Point {
  return { x: (clientX - fit.ox) / fit.k, y: (clientY - fit.oy) / fit.k };
}
