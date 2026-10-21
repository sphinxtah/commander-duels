// The installable app's build step (v0.3.0, PWA03). web/sw/sw.ts is built beside the app as
// /sw.js, and once every other file is known, the build writes into it the files to precache
// and a version made from their contents, so any change to the site is a new worker.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";

export const SW_FILE = "sw.js";
const PLACEHOLDERS = {
  precache: "__CD_PRECACHE__",
  version: "__CD_SW_VERSION__",
} as const;

export interface BuiltFile {
  name: string;
  content: string | Uint8Array;
}

// The Planeswalker portraits (v0.3.1: 98 of them in three sizes, about 12 MB) load when a screen
// shows one, and the HTTP cache keeps them; precaching them would make every install and every
// update fetch them all.
const ON_DEMAND = ["portraits/"];

/**
 * "/" and every file by its URL, sorted: every chunk (lazy ones too), asset and public file,
 * except the folders loaded on demand.
 */
export function precacheList(names: string[]): string[] {
  const kept = names.filter(
    (name) => !ON_DEMAND.some((folder) => name.startsWith(folder)),
  );
  return ["/", ...[...new Set(kept)].sort().map((name) => `/${name}`)];
}

/** `<release>+<10 hex digits>` from the files' names and contents. */
export function swVersion(release: string, files: BuiltFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const digest = createHash("sha256").update(file.content).digest("hex");
    hash.update(`${file.name}\0${digest}\n`);
  }
  return `${release}+${hash.digest("hex").slice(0, 10)}`;
}

/**
 * Writes the values into the worker's code. The list replaces its whole quoted placeholder,
 * whatever quotes the minifier chose; the version is plain text that the minifier may have folded
 * into a longer string (the cache's name), so it replaces the bare word. Throws when either is
 * missing: a worker without its list would cache nothing.
 */
export function writePlaceholders(
  code: string,
  values: { precache: string[]; version: string },
): string {
  const list = new RegExp(`(["'\`])${PLACEHOLDERS.precache}\\1`, "g");
  if (!list.test(code))
    throw new Error(
      `${SW_FILE} has lost its ${PLACEHOLDERS.precache} placeholder`,
    );
  if (!code.includes(PLACEHOLDERS.version))
    throw new Error(
      `${SW_FILE} has lost its ${PLACEHOLDERS.version} placeholder`,
    );
  // Safe inside any string literal: no quotes, backslashes or template syntax.
  if (!/^[\w.+-]+$/.test(values.version))
    throw new Error(`Unsafe service worker version: ${values.version}`);
  return code
    .replace(list, () => JSON.stringify(values.precache))
    .replaceAll(PLACEHOLDERS.version, values.version);
}

/** Every file under a folder, as URL paths relative to it. */
function listFiles(folder: string): string[] {
  let entries;
  try {
    entries = readdirSync(folder, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(folder, join(entry.parentPath, entry.name)).split(sep).join("/"),
    );
}

export function pwa(o: { version: string }): Plugin {
  let root = process.cwd();
  let publicDir: string | false = false;
  return {
    name: "commander-duels:pwa",
    apply: "build",
    // After Vite's own plugins, so the bundle already holds index.html when the list is made.
    enforce: "post",
    configResolved(config) {
      root = config.root;
      publicDir = config.publicDir || false;
    },
    buildStart() {
      this.emitFile({
        type: "chunk",
        id: resolve(root, "sw/sw.ts"),
        fileName: SW_FILE,
      });
    },
    generateBundle(_options, bundle) {
      const sw = bundle[SW_FILE];
      if (!sw || sw.type !== "chunk") this.error(`${SW_FILE} was not built`);
      // A worker registered as a classic script cannot import, and a chunk it shared with the
      // app would tie the two versions together.
      const imports = [...sw.imports, ...sw.dynamicImports];
      if (imports.length > 0 || sw.exports.length > 0)
        this.error(
          `${SW_FILE} must be one file with no imports or exports; it has ${[...imports, ...sw.exports].join(", ")}`,
        );
      const files: BuiltFile[] = [];
      for (const [name, output] of Object.entries(bundle)) {
        if (name === SW_FILE || name.endsWith(".map") || name.startsWith("."))
          continue;
        files.push({
          name,
          content: output.type === "chunk" ? output.code : output.source,
        });
      }
      if (publicDir)
        for (const name of listFiles(publicDir))
          files.push({ name, content: readFileSync(join(publicDir, name)) });
      try {
        sw.code = writePlaceholders(sw.code, {
          precache: precacheList(files.map((file) => file.name)),
          version: swVersion(o.version, files),
        });
      } catch (error) {
        this.error(String((error as Error).message));
      }
    },
  };
}
