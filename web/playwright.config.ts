import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: process.env.CD_BROWSER_URL || "http://127.0.0.1:5173",
    viewport: { width: 1366, height: 900 },
  },
  webServer: process.env.CD_BROWSER_URL
    ? undefined
    : {
        command: "pnpm dev",
        url: "http://127.0.0.1:5173",
        reuseExistingServer: !process.env.CI,
      },
});
