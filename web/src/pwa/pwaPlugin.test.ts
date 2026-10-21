import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  precacheList,
  pwa,
  swVersion,
  writePlaceholders,
} from "../../plugins/pwa";

// The build step that writes /sw.js (web/plugins/pwa.ts), run on a made-up bundle.
const worker = [
  'var e="cd-shell-__CD_SW_VERSION__";',
  'caches.open(e).then(c=>c.addAll("__CD_PRECACHE__"));',
].join("");

function chunk(
  code: string,
  imports: string[] = [],
  dynamicImports: string[] = [],
) {
  return {
    type: "chunk",
    code,
    imports,
    dynamicImports,
    exports: [] as string[],
  };
}

let folder: string | undefined;
afterEach(() => {
  if (folder) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

/** Runs the plugin's hooks as Vite would, with a public folder holding brand/icon.png. */
function build(bundle: Record<string, unknown>) {
  folder = mkdtempSync(join(tmpdir(), "cd-pwa-"));
  mkdirSync(join(folder, "brand"));
  writeFileSync(join(folder, "brand", "icon.png"), "png");
  writeFileSync(join(folder, "manifest.webmanifest"), "{}");
  const plugin = pwa({ version: "0.3.0" });
  const emitted: unknown[] = [];
  const context = {
    emitFile: (file: unknown) => emitted.push(file),
    error: (message: string) => {
      throw new Error(message);
    },
  };
  const hook = <T>(value: unknown) => value as T;
  hook<(config: unknown) => void>(plugin.configResolved)({
    root: "/repo/web",
    publicDir: folder,
  });
  hook<(this: unknown) => void>(plugin.buildStart).call(context);
  hook<(this: unknown, o: unknown, b: unknown) => void>(
    plugin.generateBundle,
  ).call(context, {}, bundle);
  return { emitted, bundle };
}

describe("the service worker build", () => {
  it("lists every chunk, lazy ones too, every asset and public file, and the version", () => {
    const sw = chunk(worker);
    const { emitted } = build({
      "sw.js": sw,
      "index.html": { type: "asset", source: "<html>" },
      "assets/index-a1.js": chunk("main", [], ["assets/scene-b2.js"]),
      "assets/scene-b2.js": chunk("pixi"),
      "assets/index-c3.css": { type: "asset", source: "body{}" },
      "assets/index-a1.js.map": { type: "asset", source: "{}" },
    });
    expect(emitted).toEqual([
      { type: "chunk", id: "/repo/web/sw/sw.ts", fileName: "sw.js" },
    ]);
    const list = JSON.parse(/addAll\((\[.*?\])\)/.exec(sw.code)![1]!);
    expect(list).toEqual([
      "/",
      "/assets/index-a1.js",
      "/assets/index-c3.css",
      "/assets/scene-b2.js",
      "/brand/icon.png",
      "/index.html",
      "/manifest.webmanifest",
    ]);
    expect(sw.code).toMatch(/"cd-shell-0\.3\.0\+[0-9a-f]{10}"/);
    expect(sw.code).not.toContain("__CD_");
  });

  it("fails when the worker imports anything", () => {
    for (const sw of [
      chunk(worker, ["assets/shared-x.js"]),
      chunk(worker, [], ["assets/lazy-y.js"]),
    ])
      expect(() => build({ "sw.js": sw })).toThrow(/no imports/);
  });

  it("fails when a placeholder is gone", () => {
    expect(() => build({ "sw.js": chunk("var e=1;") })).toThrow(
      /__CD_PRECACHE__/,
    );
    expect(() =>
      writePlaceholders('x("__CD_PRECACHE__")', { precache: [], version: "1" }),
    ).toThrow(/__CD_SW_VERSION__/);
    expect(() =>
      writePlaceholders(worker, { precache: [], version: 'x"; evil()' }),
    ).toThrow(/Unsafe/);
  });

  it("changes the version with any file's contents", () => {
    const a = swVersion("0.3.0", [{ name: "assets/a.js", content: "1" }]);
    expect(swVersion("0.3.0", [{ name: "assets/a.js", content: "1" }])).toBe(a);
    expect(
      swVersion("0.3.0", [{ name: "assets/a.js", content: "2" }]),
    ).not.toBe(a);
    expect(precacheList(["b", "a", "a"])).toEqual(["/", "/a", "/b"]);
    // Portraits load on demand, and the public pages are not the app.
    expect(
      precacheList([
        "portraits/jace-128.webp",
        "brand/mark.webp",
        "pages/about.html",
        "pages/pages.css",
      ]),
    ).toEqual(["/", "/brand/mark.webp"]);
    expect(
      writePlaceholders("f('__CD_PRECACHE__',`__CD_SW_VERSION__`)", {
        precache: ["/"],
        version: "1+ab",
      }),
    ).toBe('f(["/"],`1+ab`)');
  });
});
