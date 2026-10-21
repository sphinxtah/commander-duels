// The public pages (v0.4.1): About, Privacy and Terms, plain HTML in public/pages/ that nginx
// serves at /about, /privacy and /terms (web/nginx.conf). Vite's dev server and `vite preview`
// answer the same addresses, so the browser journeys open them as on the built site, rather than
// getting the app's page as any unknown address does.
import type { Plugin } from "vite";

export const PUBLIC_PAGES = ["about", "privacy", "terms"] as const;

/** The file behind a public page's address, or undefined for any other address. */
export function publicPageFile(url: string): string | undefined {
  const query = url.indexOf("?");
  const path = query < 0 ? url : url.slice(0, query);
  const name = PUBLIC_PAGES.find((page) => path === `/${page}`);
  if (name === undefined) return undefined;
  return `/pages/${name}.html${query < 0 ? "" : url.slice(query)}`;
}

function rewrite(
  request: { url?: string },
  _response: unknown,
  next: () => void,
): void {
  const file = publicPageFile(request.url ?? "");
  if (file) request.url = file;
  next();
}

export function publicPages(): Plugin {
  return {
    name: "commander-duels:public-pages",
    // Before Vite's own middleware, which would answer with the app's index.html.
    configureServer(server) {
      server.middlewares.use(rewrite);
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite);
    },
  };
}
