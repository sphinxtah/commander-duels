import { describe, expect, it } from "vitest";
import { DURATIONS, Timeline, duration, linear } from "./timeline";

function clock(start = 0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const rest = { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 };

describe("the timeline", () => {
  it("moves a pose from where it starts to its target", () => {
    const time = clock();
    const timeline = new Timeline(time.now);
    timeline.to("a", rest, { ...rest, x: 100 }, 200, { ease: linear });
    expect(timeline.sample("a")!.x).toBe(0);
    time.advance(50);
    expect(timeline.sample("a")!.x).toBe(25);
    expect(timeline.busy()).toBe(true);
    time.advance(150);
    expect(timeline.sample("a")!.x).toBe(100);
    expect(timeline.busy()).toBe(false);
    expect(timeline.prune()).toEqual(["a"]);
    expect(timeline.sample("a")).toBeNull();
  });

  it("retargets from the pose drawn now, so a new commit never makes a card jump", () => {
    const time = clock();
    const timeline = new Timeline(time.now);
    timeline.to("a", rest, { ...rest, x: 100, rotation: 90 }, 300);
    time.advance(120);
    const before = timeline.sample("a")!;
    timeline.retarget("a", rest, { ...rest, x: -50, rotation: 0 }, 80);
    const after = timeline.sample("a")!;
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.rotation).toBeCloseTo(before.rotation, 9);
    time.advance(80);
    expect(timeline.sample("a")).toMatchObject({ x: -50, rotation: 0 });
  });

  it("starts a still card's retarget from its resting pose", () => {
    const time = clock();
    const timeline = new Timeline(time.now);
    timeline.retarget("b", { ...rest, x: 10 }, { ...rest, x: 20 }, 100, {
      ease: linear,
    });
    expect(timeline.sample("b")!.x).toBe(10);
    time.advance(50);
    expect(timeline.sample("b")!.x).toBe(15);
  });

  it("holds the starting values through a delay", () => {
    const time = clock();
    const timeline = new Timeline(time.now);
    timeline.to("c", { alpha: 0 }, { alpha: 1 }, 100, {
      delay: 60,
      ease: linear,
    });
    time.advance(59);
    expect(timeline.sample("c")!.alpha).toBe(0);
    expect(timeline.active("c")).toBe(true);
    time.advance(51);
    expect(timeline.sample("c")!.alpha).toBeCloseTo(0.5, 9);
  });

  it("lands a zero-length tween at once and keeps nothing running", () => {
    const timeline = new Timeline(clock().now);
    timeline.to("d", rest, { ...rest, x: 5 }, 0);
    expect(timeline.has("d")).toBe(false);
    expect(timeline.busy()).toBe(false);
  });

  it("can leave idle effects out of whether it is busy", () => {
    const time = clock();
    const timeline = new Timeline(time.now);
    timeline.to("breath", { t: 0 }, { t: 1 }, 2400);
    timeline.to("p:a", rest, { ...rest, x: 10 }, 100);
    const idle = new Set(["breath"]);
    expect(timeline.busy(time.now(), idle)).toBe(true);
    time.advance(100);
    expect(timeline.busy(time.now(), idle)).toBe(false);
    expect(timeline.busy()).toBe(true);
  });

  it("reports progress for effects that are not poses", () => {
    const time = clock();
    const timeline = new Timeline(time.now);
    timeline.to("glow", { t: 0 }, { t: 1 }, 400, { ease: linear });
    time.advance(100);
    expect(timeline.progress("glow")).toBe(0.25);
    expect(timeline.progress("none")).toBeNull();
  });
});

describe("durations", () => {
  it("follow the speed setting", () => {
    expect(duration("cast", "normal")).toBe(DURATIONS.cast);
    expect(duration("cast", "fast")).toBe(Math.round(DURATIONS.cast * 0.6));
    expect(duration("cast", "faster")).toBe(Math.round(DURATIONS.cast * 0.35));
    expect(duration("emblem", "faster")).toBe(
      Math.round(DURATIONS.emblem * 0.35),
    );
  });

  it("move nothing with reduced motion, keep fades short and hold emblems still", () => {
    for (const name of [
      "draw",
      "cast",
      "resolve",
      "enter",
      "leave",
      "tap",
      "damage",
      "attack",
      "move",
      "retarget",
      "rise",
    ] as const)
      expect(duration(name, "none")).toBe(0);
    expect(duration("fade", "none")).toBeLessThanOrEqual(120);
    expect(duration("imageFade", "none")).toBeLessThanOrEqual(120);
    expect(duration("emblem", "none")).toBe(600);
  });
});
