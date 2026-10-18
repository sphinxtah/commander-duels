import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The repository's VERSION file is the single source of truth for the release number.
const version = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { proxy: { "/api": "http://127.0.0.1:8000" } },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
    include: ["src/**/*.test.ts*"],
  },
});
