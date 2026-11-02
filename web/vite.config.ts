import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
// With its extension: Vite's coming native config loader resolves no other way.
import { music } from "./plugins/music.ts";
import { publicPages } from "./plugins/publicPages.ts";
import { pwa } from "./plugins/pwa.ts";
import { rules } from "./plugins/rules.ts";

// The repository's VERSION file is the single source of truth for the release number.
const version = readFileSync(
  new URL("../VERSION", import.meta.url),
  "utf8",
).trim();

export default defineConfig({
  // pwa: the service worker, /sw.js, built with its precache list (v0.3.0). publicPages: the
  // About, Privacy and Terms pages at their own addresses in dev and preview, as nginx serves them
  // (v0.4.1). music: the gitignored music folder at /music/ in dev and preview, as nginx serves it
  // from the owner's private web image (v0.7.2). rules: the gitignored rules folder at /rules/,
  // likewise (v0.8.6), for How to play's official text.
  plugins: [react(), pwa({ version }), publicPages(), music(), rules()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  // ws: game events arrive over a WebSocket under /api (v0.0.6).
  server: { proxy: { "/api": { target: "http://127.0.0.1:8000", ws: true } } },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
    include: ["src/**/*.test.ts*"],
    // afterEach hooks run in the order they are defined, not reversed: the setup file's, which
    // unmounts the page, runs before a test file's own, which restores the file's mocks. In the
    // other order a page still mounted at a test's end could reach the real network.
    sequence: { hooks: "list" },
  },
});
