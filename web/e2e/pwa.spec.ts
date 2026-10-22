import { test, expect, type Page } from "@playwright/test";

// The installable app (v0.3.0, design §24.4) on the built image behind nginx: the manifest and
// icons, the service worker's headers, a worker that controls the page but never answers the
// API, and the drop-down install banner for a signed-in account. The update that waits for a
// live game (T25) is checked by hand (docs/verification.md) and by the unit tests: Chromium
// cannot be given a new worker version mid-test reliably.
const sysopPassword = process.env.CD_E2E_SYSOP_PASSWORD;
const builtImage = process.env.CD_E2E_GAMES === "1";

test.describe("the installable app", () => {
  test.skip(
    !builtImage || !sysopPassword,
    "Needs the built web image: set CD_E2E_GAMES=1 and CD_E2E_SYSOP_PASSWORD.",
  );

  test("the manifest, icons and worker are served for an installable app", async ({
    request,
  }) => {
    const manifest = await request.get("/manifest.webmanifest");
    expect(manifest.status()).toBe(200);
    expect(manifest.headers()["content-type"]).toContain(
      "application/manifest+json",
    );
    const body = (await manifest.json()) as {
      id: string;
      start_url: string;
      display: string;
      icons: { src: string; type: string; purpose: string }[];
      screenshots: { src: string; form_factor: string }[];
      launch_handler: { client_mode: string[] };
    };
    expect(body).toMatchObject({
      id: "/",
      start_url: "/#home",
      display: "standalone",
      launch_handler: { client_mode: ["navigate-existing", "auto"] },
    });
    expect(body.icons.map((icon) => icon.purpose).sort()).toEqual([
      "any",
      "any",
      "maskable",
      "maskable",
    ]);
    for (const asset of [...body.icons, ...body.screenshots]) {
      const response = await request.get(asset.src);
      expect(response.status(), asset.src).toBe(200);
      expect(response.headers()["content-type"]).toMatch(/^image\/(png|webp)/);
    }
    expect(body.screenshots.every((s) => s.form_factor === "wide")).toBe(true);

    const worker = await request.get("/sw.js");
    expect(worker.status()).toBe(200);
    expect(worker.headers()["cache-control"]).toContain("no-cache");
    expect(worker.headers()["content-type"]).toContain("javascript");
    // A missing file is a 404, never the app's page.
    expect((await request.get("/brand/no-such-icon.png")).status()).toBe(404);
  });

  test("the worker controls the page and never answers the API", async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    const api = page.waitForResponse((response) =>
      response.url().includes("/api/v1/bootstrap"),
    );
    await page.reload();
    expect(
      await page.evaluate(() => navigator.serviceWorker.controller !== null),
    ).toBe(true);
    expect((await api).fromServiceWorker()).toBe(false);
  });

  test("a signed-in tab offers the install once, and Not now hides it", async ({
    page,
  }) => {
    // Chrome on a PC, as its client hints name it, and the browser's install offer.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "userAgentData", {
        configurable: true,
        get: () => ({
          brands: [
            { brand: "Google Chrome", version: "156" },
            { brand: "Chromium", version: "156" },
          ],
          mobile: false,
          platform: "Windows",
        }),
      });
      const offer = () => {
        const event = new Event("beforeinstallprompt", { cancelable: true });
        Object.assign(event, {
          prompt: async () => undefined,
          userChoice: Promise.resolve({ outcome: "dismissed" }),
        });
        window.dispatchEvent(event);
      };
      window.addEventListener("load", () => setTimeout(offer, 200));
    });
    await signInSysop(page);
    await page.goto("/#play");
    const banner = page.getByRole("region", { name: "Install the app" });
    await expect(banner).toBeVisible();
    await expect(banner.getByRole("button", { name: "Install" })).toBeVisible();
    await banner.getByRole("button", { name: "Not now" }).click();
    await expect(banner).toBeHidden();
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await page.waitForTimeout(1_000);
    await expect(banner).toBeHidden();
    // The 30 days pass: the offer comes back.
    await page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem("cd.install.v1") ?? "{}");
      localStorage.setItem(
        "cd.install.v1",
        JSON.stringify({ ...saved, dismissedUntil: Date.now() - 1 }),
      );
    });
    await page.reload();
    await expect(banner).toBeVisible();
  });
});

async function signInSysop(page: Page) {
  await page.goto("/#sysop");
  await page.getByLabel("Password").fill(sysopPassword!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/#admin$/);
}
