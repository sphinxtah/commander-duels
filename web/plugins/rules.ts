// The official rules (v0.8.6): Wizards of the Coast's Comprehensive Rules text is not in the
// repository. The built site has it at /rules/comprehensive-rules.txt from the owner's private web
// image (web/nginx.conf serves the folder, and the public image answers 404, so How to play shows
// its own guide and a link to Wizards' rules page); locally, Compose mounts the gitignored rules/
// folder beside compose.yaml into the web container, and this plugin serves the same folder from
// Vite's dev and preview servers.
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { Plugin } from "vite";

export const RULES_PREFIX = "/rules/";

const TYPES: Record<string, string> = {
  txt: "text/plain; charset=utf-8",
  json: "application/json",
};

/** The file name a rules address asks for, or undefined: not under /rules/, or not a plain name. */
export function rulesFile(url: string): string | undefined {
  const query = url.indexOf("?");
  const path = query < 0 ? url : url.slice(0, query);
  if (!path.startsWith(RULES_PREFIX)) return undefined;
  const name = path.slice(RULES_PREFIX.length);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? name : undefined;
}

/** The repository's rules folder, beside compose.yaml: the web root's ../rules. */
export function rulesFolder(root: string = process.cwd()): string {
  return resolve(root, "..", "rules");
}

function serve(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
): void {
  const name = rulesFile(request.url ?? "");
  if (name === undefined) return next();
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.statusCode = 405;
    response.end();
    return;
  }
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  const file = resolve(rulesFolder(root), name);
  let body: Buffer;
  try {
    if (!statSync(file).isFile() || !(extension in TYPES))
      throw new Error("no");
    body = readFileSync(file);
  } catch {
    response.statusCode = 404;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end(`No ${name} in the rules folder. See docs/how-to-play.md.`);
    return;
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", TYPES[extension]!);
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Content-Length", body.length);
  response.end(request.method === "HEAD" ? undefined : body);
}

export function rules(): Plugin {
  let root = process.cwd();
  const middleware = (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ) => serve(root, request, response, next);
  return {
    name: "commander-duels:rules",
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
