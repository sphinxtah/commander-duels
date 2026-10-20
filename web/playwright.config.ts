import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: process.env.CD_BROWSER_URL || "http://127.0.0.1:5173",
    viewport: { width: 1366, height: 900 },
    // Evidence for a failed journey, which CI keeps as an artifact.
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  // Both servers must answer before any test runs. The API command uses the active Python
  // environment; an API or Vite server that is already running is reused outside CI.
  webServer: process.env.CD_BROWSER_URL
    ? undefined
    : [
        {
          command:
            "python -m uvicorn api.main:create_app --factory --host 127.0.0.1 --port 8000 --no-proxy-headers",
          cwd: "..",
          // A placeholder Google client ID turns the sign-in button on; the tests replace
          // Google's script. Vite's proxy connects from loopback, SysOp's network here.
          env: {
            CD_GOOGLE_CLIENT_ID: "e2e-client.apps.googleusercontent.com",
            CD_SYSOP_NETWORKS: "127.0.0.1/32,::1/128",
          },
          url: "http://127.0.0.1:8000/api/v1/health",
          reuseExistingServer: !process.env.CI,
        },
        {
          command: "pnpm dev",
          url: "http://127.0.0.1:5173",
          reuseExistingServer: !process.env.CI,
        },
      ],
});
