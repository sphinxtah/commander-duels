import { describe, expect, it } from "vitest";

// The scene's rules about card images (design §8.10, §11), checked on its source: jsdom has no
// WebGL, so the scene itself never runs in unit tests, and these rules must hold in every
// module of it. The browser journeys check the pictures themselves.

const sources = import.meta.glob(["./**/*.ts", "!./**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** The source without its comments, so the rules' own explanations do not count. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("the scene's source", () => {
  it("is all there", () => {
    expect(Object.keys(sources)).toEqual(
      expect.arrayContaining([
        "./createTableScene.ts",
        "./pixi.ts",
        "./nodes/CardNode.ts",
      ]),
    );
  });

  it("uses no filters, masks or skews anywhere", () => {
    for (const [file, text] of Object.entries(sources)) {
      const body = code(text);
      expect(body, file).not.toMatch(/\.filters\b|\bfilters\s*:/);
      expect(body, file).not.toMatch(/\.mask\b|\bmask\s*:|setMask\(/);
      expect(body, file).not.toMatch(/\.skew\b|\bskew\s*:/);
      expect(body, file).not.toMatch(/Filter\b/);
    }
  });

  it("never tints a card image and scales it evenly", () => {
    const card = code(sources["./nodes/CardNode.ts"]);
    expect(card).not.toMatch(/this\.image\.tint/);
    expect(card).not.toMatch(/this\.image\.(width|height)\s*=/);
    // The one scale it is given is the same on both axes.
    const scales = card.match(/this\.image\.scale\.set\([^)]*\)/g) ?? [];
    expect(scales.length).toBeGreaterThan(0);
    for (const call of scales) expect(call).toMatch(/\.set\((\w+), \1\)/);
  });

  it("imports pixi.js only through pixi.ts, which loads unsafe-eval first", () => {
    for (const [file, text] of Object.entries(sources))
      if (file !== "./pixi.ts")
        expect(code(text), file).not.toMatch(/from "pixi\.js/);
    const pixi = code(sources["./pixi.ts"]);
    const imports = [...pixi.matchAll(/^import .*$/gm)].map((m) => m[0]);
    expect(imports[0]).toBe('import "pixi.js/unsafe-eval";');
    expect(pixi).toMatch(/preferWorkers = false/);
  });

  it("starts Pixi without its accessibility, event and DOM systems", () => {
    const scene = code(sources["./createTableScene.ts"]);
    expect(scene).toMatch(/manageImports: false/);
    expect(scene).toMatch(/preference: \["webgl"\]/);
    expect(scene).toMatch(/autoStart: false/);
  });
});
