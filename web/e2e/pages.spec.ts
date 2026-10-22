import { test, expect, type Page } from "@playwright/test";
import { standIn } from "./accounts";

// The public pages (v0.4.1): About, Privacy and Terms, for anyone, signed in or not, with
// JavaScript or without, at their own addresses. In development Vite's dev server answers them
// (plugins/publicPages.ts); on the built image (CD_E2E_GAMES=1) nginx does, with the site's
// headers, and the installed app's worker leaves them to the network.
const builtImage = process.env.CD_E2E_GAMES === "1";

const pages = [
  {
    path: "/about",
    link: "About",
    title: "About Commander Duels",
    heading: "About Commander Duels",
  },
  {
    path: "/privacy",
    link: "Privacy",
    title: "Privacy policy · Commander Duels",
    heading: "Privacy policy",
  },
  {
    path: "/terms",
    link: "Terms",
    title: "Terms of use · Commander Duels",
    heading: "Terms of use",
  },
];

// The landing page loads Google's script for its button; the line of links does not need it.
test.beforeEach(async ({ page }) => {
  await page.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: "window.google = { accounts: { id: { initialize() {}, renderButton() {}, disableAutoSelect() {} } } };",
    }),
  );
});

/** The public page at the address, as its own page rather than the app's. */
async function expectPublicPage(page: Page, index: number) {
  const { path, link, title, heading } = pages[index]!;
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await expect(page).toHaveTitle(title);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
  // The site's stylesheet applied: its dark background, from /pages/pages.css.
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(16, 24, 25)",
  );
  await expect(page.locator('img[src="/brand/mark.webp"]')).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Commander Duels pages" });
  await expect(nav.getByRole("link")).toHaveText(["About", "Privacy", "Terms"]);
  await expect(nav.getByRole("link", { name: link })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    page.getByRole("link", { name: "Commander Duels", exact: true }),
  ).toHaveAttribute("href", "/");
  await expect(page.getByText(/unofficial Fan Content/)).toBeVisible();
  // None of the app.
  await expect(page.getByRole("button")).toHaveCount(0);
}

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("each page opens signed out, styled, and leads to the others", async ({
    page,
  }) => {
    for (const [index, { path }] of pages.entries()) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      expect(response?.headers()["content-type"]).toContain("text/html");
      await expectPublicPage(page, index);
    }
    // From one page to the next by the header's links.
    await page.goto("/about");
    await page
      .getByRole("navigation", { name: "Commander Duels pages" })
      .getByRole("link", { name: "Privacy" })
      .click();
    await expectPublicPage(page, 1);
    await page
      .getByRole("navigation", { name: "Commander Duels pages" })
      .getByRole("link", { name: "Terms" })
      .click();
    await expectPublicPage(page, 2);
    // The About page links the privacy policy in its text, as Google's branding check needs.
    await page.goto("/about");
    await page
      .getByRole("main")
      .getByRole("link", { name: "privacy policy", exact: true })
      .click();
    await expectPublicPage(page, 1);
  });
});

test("the landing page's line of links opens each page, and it fits a phone", async ({
  page,
}, testInfo) => {
  for (const [index, { link }] of pages.entries()) {
    await page.goto("/#play");
    const main = page.getByRole("main");
    const named = main.getByRole("link", { name: link, exact: true });
    await expect(named).toBeVisible();
    // Below the mark, quietly: the landing page keeps no words above its button.
    const mark = await page
      .locator('img[src="/brand/mark.webp"]')
      .boundingBox();
    const line = await named.boundingBox();
    expect(line!.y).toBeGreaterThan(mark!.y + mark!.height);
    await named.click();
    await expectPublicPage(page, index);
  }
  // Under the button, what signing in accepts (v0.4.2), with the two pages it names. It comes
  // with the Google button, so only where the server has a Google client: CI's engine job has
  // none, and its landing page says sign-in is not set up instead.
  const bootstrap = (await (
    await page.request.get("/api/v1/bootstrap")
  ).json()) as {
    auth?: { google_client_id?: string | null };
  };
  if (bootstrap.auth?.google_client_id)
    for (const [name, index] of [
      ["terms of use", 2],
      ["privacy policy", 1],
    ] as const) {
      await page.goto("/#play");
      await page
        .getByRole("main")
        .getByRole("link", { name, exact: true })
        .click();
      await expectPublicPage(page, index);
    }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const { path } of pages) {
    await page.goto(path);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`page${path.replace("/", "-")}-390.png`),
      fullPage: true,
    });
  }
});

test("the wait for approval and the app's footer carry the same links", async ({
  page,
}) => {
  const change = await standIn(page, {
    status: "pending",
    onboarding: "handle",
    handle: null,
    permissions: [],
    roles: [],
  });
  await page.goto("/#play");
  await expect(
    page.getByRole("heading", {
      name: "Your request to join the Commander Duels beta is in.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "info@thesphinx.co" }),
  ).toHaveAttribute("href", "mailto:info@thesphinx.co");
  for (const { path, link } of pages)
    await expect(
      page.getByRole("main").getByRole("link", { name: link }),
    ).toHaveAttribute("href", path);

  change({
    status: "active",
    onboarding: "complete",
    handle: "stand-in",
    roles: ["player"],
    permissions: ["profile.edit"],
  });
  await page.getByRole("button", { name: "Check again" }).click();
  const footer = page.locator("footer").filter({ hasText: "Fan Content" });
  await expect(footer.getByRole("link")).toHaveText([
    "About",
    "Privacy",
    "Terms",
  ]);
  await footer.getByRole("link", { name: "Terms" }).click();
  await expectPublicPage(page, 2);
});

test.describe("on the built image", () => {
  test.skip(!builtImage, "Needs the built web image: set CD_E2E_GAMES=1.");

  test("nginx serves the pages with the site's headers, as files and never as the app", async ({
    request,
  }) => {
    const app = await request.get("/");
    const policy = app.headers()["content-security-policy"];
    expect(policy).toContain("style-src 'self'");
    for (const { path, heading } of pages) {
      const response = await request.get(path);
      expect(response.status(), path).toBe(200);
      expect(response.headers()["content-type"]).toContain("text/html");
      expect(response.headers()["content-security-policy"]).toBe(policy);
      expect(response.headers()["cache-control"]).toContain("no-cache");
      // No redirect of nginx's own, whose absolute address would name the container's port.
      expect(response.url()).toMatch(new RegExp(`${path}$`));
      const body = await response.text();
      expect(body).toContain(`<h1>${heading}</h1>`);
      expect(body).not.toContain('id="root"');
    }
    const css = await request.get("/pages/pages.css");
    expect(css.status()).toBe(200);
    expect(css.headers()["content-type"]).toContain("text/css");
    expect((await request.get("/pages/missing.css")).status()).toBe(404);
  });

  test("the installed app's worker leaves the pages to the network, offline too", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    expect(
      await page.evaluate(() => navigator.serviceWorker.controller !== null),
    ).toBe(true);
    const response = await page.goto("/privacy");
    expect(response?.fromServiceWorker()).toBe(false);
    await expectPublicPage(page, 1);
    // Offline, the browser says so: the worker never answers with the app's kept page.
    await context.setOffline(true);
    try {
      await expect(page.goto("/terms")).rejects.toThrow();
    } finally {
      await context.setOffline(false);
    }
  });
});
