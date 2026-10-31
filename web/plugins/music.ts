// The music folder (v0.7.2): the gameplay track is not in the repository. The built site has it
// at /music/game.mp3 from the owner's private web image (web/nginx.conf serves the folder, and the
// public image answers 404); locally, Compose mounts the gitignored music/ folder beside
// compose.yaml into the web container, and this plugin serves the same folder from Vite's dev and
// preview servers, with the Range requests that seeking and the browser's own buffering make.
import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Plugin } from "vite";

export const MUSIC_PREFIX = "/music/";

const TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  webm: "audio/webm",
  json: "application/json",
};

/** The file name a music address asks for, or undefined: not under /music/, or not a plain name. */
export function musicFile(url: string): string | undefined {
  const query = url.indexOf("?");
  const path = query < 0 ? url : url.slice(0, query);
  if (!path.startsWith(MUSIC_PREFIX)) return undefined;
  const name = path.slice(MUSIC_PREFIX.length);
  // One file in the folder, named plainly: no folders, no dot files, nothing to decode.
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? name : undefined;
}

/** The bytes a Range header asks for in a file of `size` bytes: [start, end] inclusive, or null
 * for the whole file; "unsatisfiable" when it lies beyond the end. One range only. */
export function byteRange(
  header: string | undefined,
  size: number,
): [number, number] | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    // The last N bytes.
    const suffix = Number(match[2]);
    if (suffix === 0) return "unsatisfiable";
    return [Math.max(0, size - suffix), size - 1];
  }
  const start = Number(match[1]);
  if (start >= size) return "unsatisfiable";
  const end = match[2] === "" ? size - 1 : Math.min(size - 1, Number(match[2]));
  if (end < start) return "unsatisfiable";
  return [start, end];
}

/** The repository's music folder, beside compose.yaml: the web root's ../music. (Vite's root, or
 * the working directory, web/, as Vitest has it; under jsdom import.meta.url is no file address.) */
export function musicFolder(root: string = process.cwd()): string {
  return resolve(root, "..", "music");
}

function serve(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
): void {
  const name = musicFile(request.url ?? "");
  if (name === undefined) return next();
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.statusCode = 405;
    response.end();
    return;
  }
  const folder = musicFolder(root);
  const file = resolve(folder, name);
  let size: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error("not a file");
    size = stat.size;
  } catch {
    response.statusCode = 404;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end(
      `No ${name} in the music folder (${folder}). See docs/game-screen.md.`,
    );
    return;
  }
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  response.setHeader(
    "Content-Type",
    TYPES[extension] ?? "application/octet-stream",
  );
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Cache-Control", "public, max-age=604800");
  const range = byteRange(request.headers.range, size);
  if (range === "unsatisfiable") {
    response.statusCode = 416;
    response.setHeader("Content-Range", `bytes */${size}`);
    response.end();
    return;
  }
  const [start, end] = range ?? [0, size - 1];
  if (range) {
    response.statusCode = 206;
    response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  } else response.statusCode = 200;
  response.setHeader("Content-Length", end - start + 1);
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  const stream = createReadStream(file, { start, end });
  response.on("close", () => stream.destroy());
  stream.pipe(response);
}

export function music(): Plugin {
  let root = process.cwd();
  const middleware = (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ) => serve(root, request, response, next);
  return {
    name: "commander-duels:music",
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
