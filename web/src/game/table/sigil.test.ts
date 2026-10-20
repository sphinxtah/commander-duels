import { describe, expect, it } from "vitest";
import { fnv1a, mulberry32, sigilSpec } from "./sigil";

describe("sigils", () => {
  it("grow the same from the same seed, for every viewer and every game", () => {
    expect(sigilSpec("handle:alice", false)).toEqual(
      sigilSpec("handle:alice", false),
    );
    expect(sigilSpec("handle:alice", false)).not.toEqual(
      sigilSpec("handle:bob", false),
    );
    expect(sigilSpec("bot:1", true)).not.toEqual(sigilSpec("bot:2", true));
  });

  it("change only their colour when grey", () => {
    const colour = sigilSpec("bot:3", false);
    const grey = sigilSpec("bot:3", true);
    expect(grey.grey).toBe(true);
    expect(colour.grey).toBe(false);
    expect({ ...grey, grey: false }).toEqual(colour);
  });

  it("stay within their ranges, outer layers first", () => {
    for (let i = 0; i < 200; i++) {
      const spec = sigilSpec(`seat:${i}`, false);
      expect(spec.hue).toBeGreaterThanOrEqual(0);
      expect(spec.hue).toBeLessThan(360);
      expect(spec.symmetry).toBeGreaterThanOrEqual(3);
      expect(spec.symmetry).toBeLessThanOrEqual(8);
      expect(spec.layers.length).toBeGreaterThanOrEqual(3);
      expect(spec.layers.length).toBeLessThanOrEqual(5);
      spec.layers.forEach((layer, j) => {
        expect(layer.radius).toBeGreaterThanOrEqual(0.2);
        expect(layer.radius).toBeLessThan(0.95);
        expect(layer.width).toBeGreaterThan(0);
        expect(layer.turn).toBeLessThan(1 / spec.symmetry);
        if (j > 0)
          expect(layer.radius).toBeLessThanOrEqual(spec.layers[j - 1].radius);
      });
    }
  });
});

describe("the seeded numbers under them", () => {
  it("hash strings with 32-bit FNV-1a", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("foobar")).toBe(0xbf9cf968);
  });

  it("give the same sequence for the same seed, in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const values = Array.from({ length: 100 }, () => a());
    expect(Array.from({ length: 100 }, () => b())).toEqual(values);
    for (const value of values) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(mulberry32(43)()).not.toBe(values[0]);
  });
});
