import { describe, expect, it } from "vitest";
import { MAX_BACKING, stageFit, toDesign } from "./stage";

const scale = (w: number, h: number) => Number(stageFit(w, h, 1).k.toFixed(3));
const backing = (fit: ReturnType<typeof stageFit>) =>
  fit.designW * fit.resolution * (fit.designH * fit.resolution);

describe("the stage fit (§7)", () => {
  it("scales the 1920 × 1080 table to the window", () => {
    expect(scale(1280, 720)).toBe(0.667);
    expect(scale(1366, 768)).toBe(0.711);
    expect(scale(1920, 1080)).toBe(1);
    expect(scale(2560, 1440)).toBe(1.333);
    expect(scale(3840, 2160)).toBe(2);
    // Windows' scaling and other shapes.
    expect(scale(1366, 900)).toBe(0.711);
    expect(scale(1536, 864)).toBe(0.8);
    expect(scale(2048, 1152)).toBe(1.067);
    expect(scale(3440, 1440)).toBe(1.333);
  });

  it("letterboxes the stage, with more table showing on an ultrawide screen", () => {
    const tall = stageFit(1366, 900, 1);
    expect(tall.ox).toBe(0);
    expect(tall.oy).toBe(66);
    expect(tall.designH).toBeCloseTo(1265, 0);
    const wide = stageFit(3440, 1440, 1);
    expect(wide.ox).toBe(440);
    expect(wide.designW).toBeCloseTo(2580);
    expect(wide.designH).toBeCloseTo(1080);
  });

  it("rounds the stage's origin to whole device pixels", () => {
    for (const [w, h, dpr] of [
      [1366, 768, 1.25],
      [1366, 900, 1.5],
      [1281, 721, 1.25],
      [3441, 1440, 2],
    ])
      for (const offset of [stageFit(w, h, dpr).ox, stageFit(w, h, dpr).oy])
        expect(Math.abs(offset * dpr - Math.round(offset * dpr))).toBeLessThan(
          1e-9,
        );
  });

  it("draws as many device pixels as the screen has, up to a 4K backing store", () => {
    expect(stageFit(1920, 1080, 1).resolution).toBe(1);
    expect(stageFit(1920, 1080, 2).resolution).toBe(2);
    expect(stageFit(3840, 2160, 1).resolution).toBe(2);
    expect(stageFit(1280, 720, 1.5).resolution).toBeCloseTo(1);
    expect(stageFit(1920, 1080, 1.25, 2401).resolution).toBeCloseTo(
      2401 / 1920,
    );
    for (const [w, h, dpr] of [
      [3840, 2160, 1],
      [3840, 2160, 2],
      [2560, 1440, 2],
      [3440, 1440, 2],
      [1920, 1080, 3],
      [5120, 1440, 1.5],
    ]) {
      const fit = stageFit(w, h, dpr);
      expect(backing(fit)).toBeLessThanOrEqual(MAX_BACKING + 1);
    }
    expect(stageFit(2560, 1440, 2).resolution).toBe(2);
  });

  it("keeps each side within the renderer's largest texture", () => {
    const fit = stageFit(3840, 2160, 2, undefined, 2048);
    expect(fit.designW * fit.resolution).toBeLessThanOrEqual(2048 + 1e-6);
    expect(fit.designH * fit.resolution).toBeLessThanOrEqual(2048 + 1e-6);
  });

  it("calls a window below 1280 × 720 small, and never shrinks below a quarter", () => {
    expect(stageFit(1280, 720, 1).small).toBe(false);
    expect(stageFit(1279, 720, 1).small).toBe(true);
    expect(stageFit(1280, 719, 1).small).toBe(true);
    expect(stageFit(200, 100, 1).k).toBe(0.25);
  });

  it("turns a pointer's position into stage units", () => {
    const fit = stageFit(2560, 1440, 1);
    expect(toDesign(fit, 1280, 720)).toEqual({ x: 960, y: 540 });
    const wide = stageFit(3440, 1440, 1);
    expect(toDesign(wide, 440, 0)).toEqual({ x: 0, y: 0 });
    expect(toDesign(wide, 0, 0).x).toBeCloseTo(-330);
  });
});
