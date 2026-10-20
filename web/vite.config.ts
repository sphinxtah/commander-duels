import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
// With its extension: Vite's coming native config loader resolves no other way.
import { pwa } from "./plugins/pwa.ts";

// The repository's VERSION file is the single source of truth for the release number.
const version = readFileSync(
  new URL("../VERSION", import.meta.url),
  "utf8",
).trim();

export default defineConfig({
  // pwa: the service worker, /sw.js, built with its precache list (v0.3.0).
  plugins: [react(), pwa({ version })],
  define: { __APP_VERSION__: JSON.stringify(version) },
  // ws: game events arrive over a WebSocket under /api (v0.0.6).
  server: { proxy: { "/api": { target: "http://127.0.0.1:8000", ws: true } } },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
    include: ["src/**/*.test.ts*"],
  },
});
