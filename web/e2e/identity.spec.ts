import { test, expect, type Locator, type Page } from "@playwright/test";
import { standIn } from "./accounts";

// SysOp's password, set before the run with `python -m api.cli sysop-password --stdin`.
const sysopPassword = process.env.CD_E2E_SYSOP_PASSWORD;
const gameId = "00000000-0000-4000-8000-0000000000aa";

// Google's script, replaced: the button it renders hands the page a credential the server
// cannot verify, so the page's whole sign-in path runs without a Google account.
const fakeGoogle = `
window.google = { accounts: { id: {
  initialize(config) { window.__gis = config; window.__gisNonces = [...(window.__gisNonces || []), config.nonce]; },
  renderButton(parent, options) {
    const button = document.createElement("button");
    button.textContent = "Sign in with Google";
    button.onclick = () => {
      options.click_listener?.();
      window.__gis.callback({ credential: "header.payload.signature", select_by: "btn" });
    };
    parent.replaceChildren(button);
  },
  disableAutoSelect() {},
} } };`;

// What a page may ask the API for before its account is active (v0.3.0): the foundation, the
// account, a sign-in challenge and SysOp's entrance. Anything else is the inside of the app.
const beforeSignIn = new Set([
  "/api/v1/bootstrap",
  "/api/v1/formats",
  "/api/v1/me",
  "/api/v1/auth/google/start",
  "/api/v1/sysop/entrance",
]);

/** The API requests from the inside of the app, and the game WebSockets, as the page makes them. */
function watchInside(page: Page) {
  const inside: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/") && !beforeSignIn.has(path)) inside.push(path);
  });
  page.on("websocket", (socket) => {
    if (socket.url().includes("/api/")) inside.push(socket.url());
  });
  return inside;
}

async function nav(page: Page) {
  return page.getByRole("navigation").getByRole("link").allTextContents();
}

function googleButton(page: Page) {
  return page.getByRole("button", { name: "Sign in with Google" });
}

/**
 * The words a sighted visitor can read above the element. Text for screen readers only sits in
 * a 1 px box, so it does not count.
 */
async function wordsAbove(target: Locator): Promise<string[]> {
  return target.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const words: string[] = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      const text = node.textContent?.trim();
      if (!parent || !text) continue;
      const box = parent.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) continue;
      if (
        !parent.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
        })
      )
        continue;
      if (box.top < top) words.push(text);
    }
    return words;
  });
}

/** The landing page and nothing else: the mark, the Google button under it, no words above it. */
async function expectLanding(page: Page) {
  const mark = page.locator('img[src="/brand/mark.webp"]');
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute("alt", "");
  await expect(page.locator("img")).toHaveCount(1);
  const button = page.getByRole("main").getByRole("button", {
    name: "Sign in with Google",
  });
  await expect(button).toBeVisible();
  expect((await mark.boundingBox())!.y).toBeLessThan(
    (await button.boundingBox())!.y,
  );
  expect(await wordsAbove(button)).toEqual([]);
  // For screen readers, the page still says what it is.
  await expect(
    page.getByRole("heading", { level: 1, name: "Sign in" }),
  ).toBeAttached();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByRole("banner")).toHaveCount(0);
  await expect(page.getByText(/Fan Content|Testing preview/)).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({ contentType: "text/javascript", body: fakeGoogle }),
  );
});

test("a signed-out visitor sees only the landing page at every address, which it keeps", async ({
  page,
}) => {
  const inside = watchInside(page);
  for (const route of [
    "#play",
    "#decks",
    "#cards",
    `#deck/${gameId}`,
    `#game/${gameId}`,
    "#admin",
    "#profile",
    "#nowhere",
  ]) {
    // A fresh load each time: a change of hash alone would not reload the page.
    await page.goto("about:blank");
    await page.goto(`/${route}`);
    await expectLanding(page);
    expect(new URL(page.url()).hash).toBe(route);
  }
  // No page of the app asked for anything, and no game's WebSocket opened.
  expect(inside).toEqual([]);
});

test("a refused sign-in says so below the button, asks Google again and keeps the address", async ({
  page,
}) => {
  await page.goto("/#admin");
  await expectLanding(page);
  await googleButton(page).click();
  // The server refuses the unverifiable credential; the page says so and asks Google again
  // with a fresh challenge.
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(/Google/);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __gisNonces: string[] }).__gisNonces,
      ),
    )
    .toHaveLength(2);
  const nonces = await page.evaluate(
    () => (window as unknown as { __gisNonces: string[] }).__gisNonces,
  );
  expect(new Set(nonces).size).toBe(2);
  expect(nonces[0]).toMatch(/^[0-9a-f]{64}$/);
  await expect(googleButton(page)).toBeVisible();
  expect((await alert.boundingBox())!.y).toBeGreaterThan(
    (await googleButton(page).boundingBox())!.y,
  );
  expect(await wordsAbove(googleButton(page))).toEqual([]);
  await expect(page).toHaveURL(/#admin$/);
});

test("the landing page fits a phone and 1080p, with Larger text and Reduce motion", async ({
  page,
}, testInfo) => {
  await page.goto("/#play");
  await expectLanding(page);
  for (const large of [false, true]) {
    if (large) {
      // The preferences a visitor set on this device before; the landing page has no Settings.
      await page.evaluate(() =>
        localStorage.setItem(
          "cd.preferences.v1",
          JSON.stringify({ largeText: true, reducedMotion: true }),
        ),
      );
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute(
        "data-large-text",
        "true",
      );
      await expect(page.locator("html")).toHaveAttribute(
        "data-reduced-motion",
        "true",
      );
    }
    for (const [width, height] of [
      [1920, 1080],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await expectLanding(page);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      // The mark and the button sit inside the window, without scrolling.
      for (const element of [
        page.locator('img[src="/brand/mark.webp"]'),
        googleButton(page),
      ]) {
        const box = (await element.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y + box.height).toBeLessThanOrEqual(height);
      }
      await page.screenshot({
        path: testInfo.outputPath(
          `landing-${width}${large ? "-large-text" : ""}.png`,
        ),
      });
    }
  }
});

test("a service that holds its answers still leaves Try again to press", async ({
  page,
}) => {
  // A proxy may hold a stalled request for an hour; the page gives up on it after 7 seconds.
  const hold = () => {};
  for (const path of ["bootstrap", "formats", "me"])
    await page.route(`**/api/v1/${path}`, hold);
  await page.goto("/#decks");
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/did not answer/)).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(retry).toBeFocused();
  // Once the service answers, Try again leads to the sign-in, at the same address.
  for (const path of ["bootstrap", "formats", "me"])
    await page.unroute(`**/api/v1/${path}`, hold);
  await retry.click();
  await expectLanding(page);
  await expect(page).toHaveURL(/#decks$/);
});

test("an account check that stalls alone still ends on the sign-in", async ({
  page,
}) => {
  await page.route("**/api/v1/me", () => {});
  await page.goto("/#play");
  await expect(googleButton(page)).toBeVisible({ timeout: 15_000 });
  await expectLanding(page);
});

test.describe("on a high-density phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });

  test("the landing page's mark stays sharp", async ({ page }) => {
    await page.goto("/#play");
    const mark = page.locator('img[src="/brand/mark.webp"]');
    await expect(mark).toBeVisible();
    // Shown at 104 CSS px, so 312 device pixels: the 3x copy, 384 px, covers them.
    await expect
      .poll(() =>
        mark.evaluate((image: HTMLImageElement) =>
          image.complete ? new URL(image.currentSrc).pathname : "",
        ),
      )
      .toBe("/brand/mark-384.webp");
  });
});

test("the SysOp address looks like any unknown address off its network", async ({
  page,
}) => {
  await page.route("**/api/v1/sysop/entrance", (route) =>
    route.fulfill({
      status: 404,
      json: { code: "http_404", message: "Not Found" },
    }),
  );
  await page.goto("/#sysop");
  await expectLanding(page);
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await expect(page.getByText(/sysop/i)).toHaveCount(0);
  await expect(page).toHaveURL(/#sysop$/);
});

test("SysOp signs in at its entrance under the mark, administers and sees its own audit trail", async ({
  page,
}, testInfo) => {
  test.skip(!sysopPassword, "Set CD_E2E_SYSOP_PASSWORD after creating SysOp.");
  await page.goto("/#sysop");
  await expect(
    page.getByRole("heading", { name: "SysOp sign-in" }),
  ).toBeVisible();
  // The landing page's mark above the form, and none of the shell.
  await expect(page.locator('img[src="/brand/mark.webp"]')).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(googleButton(page)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("sysop-sign-in.png") });
  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Unable to sign in with those credentials.",
  );
  await page.getByLabel("Password").fill(sysopPassword!);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(
    page.getByRole("heading", { name: "Keep the table running." }),
  ).toBeVisible();
  await expect(page).toHaveURL(/#admin$/);
  expect((await nav(page)).some((name) => name.includes("Admin"))).toBe(true);
  await expect(page.getByRole("tab", { name: "Accounts" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.screenshot({
    path: testInfo.outputPath("admin-accounts.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Audit log" }).click();
  const signIn = page
    .getByRole("row")
    .filter({ hasText: "auth.sysop_login" })
    .first();
  await expect(signIn).toContainText("SysOp");
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: "auth.sysop_login_failed" })
      .first(),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("admin-audit.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("admin-audit-390.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1366, height: 900 });

  // The session survives a reload: the cookie is HttpOnly and /me restores the account.
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Keep the table running." }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Profile" })
    .click();
  await expect(page.getByText("Local administrator")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "SysOp password" }),
  ).toBeVisible();
  await expect(page.getByText("This browser")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("profile-sysop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("profile-sysop-390.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1366, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);

  // Signing out leaves the app for the landing page, at the same address.
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expectLanding(page);
  await expect(page.getByText("You signed out.")).toBeVisible();
  await expect(page).toHaveURL(/#profile$/);
});

// No Google account can be made to wait in a browser test, so the account is a stand-in that
// page.route answers for; its approval is the stand-in turning active.
test("an account waiting for approval sees only its wait, and approval opens the app where it was", async ({
  page,
}, testInfo) => {
  const inside = watchInside(page);
  const change = await standIn(page, {
    status: "pending",
    onboarding: "handle",
    handle: null,
    permissions: [],
    roles: [],
  });
  await page.goto("/#settings");
  await expect(
    page.getByRole("heading", {
      name: "Your request to join the Commander Duels beta is in.",
    }),
  ).toBeVisible();
  await expect(page.locator('img[src="/brand/mark.webp"]')).toBeVisible();
  await expect(page.getByText("stand-in@example.com")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByLabel("Handle")).toHaveCount(0);
  for (const [width, height] of [
    [1920, 1080],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`waiting-${width}.png`),
    });
  }
  await page.setViewportSize({ width: 1366, height: 900 });
  expect(inside).toEqual([]);

  change({
    status: "active",
    roles: ["player"],
    permissions: ["profile.edit"],
  });
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(
    page.getByRole("heading", { name: "Make yourself at home." }),
  ).toBeVisible();
  await expect(page.getByRole("navigation")).toBeVisible();
  await expect(page).toHaveURL(/#settings$/);
  // Its handle is still to choose, and the page points the way.
  await page.getByRole("link", { name: "Choose yours on Profile" }).click();
  await expect(
    page.getByRole("heading", { name: "Choose your handle" }),
  ).toBeVisible();
});

test("a denied account sees that it was not approved, and signs out to the landing page", async ({
  page,
}) => {
  await standIn(page, { status: "denied", permissions: [], roles: [] });
  await page.route("**/api/v1/auth/logout", (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.goto("/#decks");
  await expect(
    page.getByRole("heading", {
      name: "Your request was not approved this time.",
    }),
  ).toBeVisible();
  await expect(page.getByText(/^If you think this is a mistake/)).toHaveText(
    "If you think this is a mistake, write to info@thesphinx.co. A request that is not approved is deleted 30 days after it was made.",
  );
  await expect(page.getByRole("button", { name: "Check again" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expectLanding(page);
  await expect(page.getByText("You signed out.")).toBeVisible();
  // The button went with the page: focus is on the sign-in, not lost to <body>.
  await expect(
    page.getByRole("heading", { level: 1, name: "Sign in" }),
  ).toBeFocused();
  await expect(page).toHaveURL(/#decks$/);
});
