import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLIC_PAGES, publicPageFile } from "../../plugins/publicPages";
import { PUBLIC_PAGES as WORKER_PAGES } from "../pwa/swRules";

// The public pages (v0.4.1) as files: public/pages/ holds them, the dev server and nginx serve
// them at the same addresses (tests/test_deploy_kit.py checks nginx's), and the worker leaves
// those addresses alone (swRules.test.ts). Vitest runs in web/; under jsdom, import.meta.url is
// no file address.
const folder = join(process.cwd(), "public", "pages");
const page = (name: string) =>
  readFileSync(join(folder, `${name}.html`), "utf8");
/** What a reader sees: no comments or tags, and whitespace as the browser shows it. */
const text = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
// Word for word as the app's footer has it (App.tsx); App.test.tsx reads the footer.
const FAN_CONTENT =
  "Commander Duels is unofficial Fan Content permitted under the Fan Content Policy. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC. Card images from Scryfall.";

describe("the public pages", () => {
  it("are the same three for the dev server, the worker and the folder", () => {
    expect(PUBLIC_PAGES.map((name) => `/${name}`)).toEqual(WORKER_PAGES);
    expect(readdirSync(folder).sort()).toEqual([
      "about.html",
      "pages.css",
      "privacy.html",
      "terms.html",
    ]);
    expect(publicPageFile("/about")).toBe("/pages/about.html");
    expect(publicPageFile("/privacy?from=google")).toBe(
      "/pages/privacy.html?from=google",
    );
    // Anything else is left to Vite: the app's page, or the file itself.
    for (const url of [
      "/",
      "/terms/",
      "/termsx",
      "/pages/terms.html",
      "/#about",
    ])
      expect(publicPageFile(url)).toBeUndefined();
  });

  it("lead to each other, back to the site and to the contact address", () => {
    for (const name of PUBLIC_PAGES) {
      const html = page(name);
      for (const other of PUBLIC_PAGES)
        expect(html).toContain(`<a href="/${other}"`);
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
      expect(html).toContain(`<a href="/${name}" aria-current="page">`);
      expect(html).toContain('<a class="brand" href="/">');
      expect(html).toContain('href="mailto:info@thesphinx.co"');
      expect(html).toContain('<html lang="en">');
      expect(html).toContain(
        '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      );
    }
  });

  it("carry the Fan Content notice word for word", () => {
    for (const name of PUBLIC_PAGES)
      expect(text(page(name))).toContain(FAN_CONTENT);
  });

  it("say what Google's branding check looks for", () => {
    const about = text(page("about"));
    // The home page given to Google describes the app and links to the privacy policy.
    expect(about).toContain("Commander Duels is a free, unofficial beta");
    expect(page("about")).toContain('<a href="/privacy">privacy policy</a>');
    expect(about).toContain('Press "Sign in with Google" on the home page');
    // The policy and the terms carry their effective date, and the policy its version: v0.4.3
    // added the player search, friends, presence and notifications to the policy.
    expect(text(page("terms"))).toContain(
      "Effective 21 October 2026 (2026-10-21)",
    );
    expect(text(page("privacy"))).toContain(
      "Effective 22 October 2026 (2026-10-22)",
    );
    expect(text(page("privacy"))).toContain("Commander Duels version 0.4.3");
    expect(text(page("privacy"))).toContain(
      "Your friends see whether you are online, idle or in a game.",
    );
    // Only the basic sign-in scopes, which need no verification by Google.
    expect(page("privacy")).toMatch(
      /<code>openid<\/code>,\s*<code>email<\/code> and <code>profile<\/code> scopes/,
    );
  });
});
