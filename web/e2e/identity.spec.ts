import { test, expect, type Page } from "@playwright/test";

// SysOp's password, set before the run with `python -m api.cli sysop-password --stdin`.
const sysopPassword = process.env.CD_E2E_SYSOP_PASSWORD;

// Google's script, replaced: the button it renders hands the page a credential the server
// cannot verify, so the page's whole sign-in path runs without a Google account.
const fakeGoogle = `
window.google = { accounts: { id: {
  initialize(config) { window.__gis = config; window.__gisNonces = [...(window.__gisNonces || []), config.nonce]; },
  renderButton(parent) {
    const button = document.createElement("button");
    button.textContent = "Sign in with Google";
    button.onclick = () => window.__gis.callback({ credential: "header.payload.signature", select_by: "btn" });
    parent.replaceChildren(button);
  },
  disableAutoSelect() {},
} } };`;

async function nav(page: Page) {
  return page.getByRole("navigation").getByRole("link").allTextContents();
}

test("signed-out visitors see sign-in, and administration stays closed", async ({
  page,
}) => {
  await page.route("https://accounts.google.com/gsi/client", (route) =>
    route.fulfill({ contentType: "text/javascript", body: fakeGoogle }),
  );
  await page.goto("/#admin");
  await expect(
    page.getByRole("heading", { name: "Sign in to continue." }),
  ).toBeVisible();
  expect((await nav(page)).some((name) => name.includes("Admin"))).toBe(false);

  // The link remembers this screen, so a successful sign-in comes back here (T01).
  await page.getByRole("main").getByRole("link", { name: "Sign in" }).click();
  expect(await page.evaluate(() => sessionStorage.getItem("cd.returnTo"))).toBe(
    "#admin",
  );
  await expect(
    page.getByRole("heading", { name: "Your place at the table." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign in with Google" }).click();
  // The server refuses the unverifiable credential; the page says so and asks Google again
  // with a fresh challenge.
  await expect(page.getByRole("alert")).toContainText(/Google/);
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
  await expect(
    page.getByRole("heading", { name: "Commander", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("COMMANDER DUELS / PLAY")).toBeVisible();
  await expect(page.getByText(/sysop/i)).toHaveCount(0);
});

test("SysOp signs in, administers and sees its own audit trail", async ({
  page,
}, testInfo) => {
  test.skip(!sysopPassword, "Set CD_E2E_SYSOP_PASSWORD after creating SysOp.");
  await page.goto("/#sysop");
  await expect(
    page.getByRole("heading", { name: "SysOp sign-in" }),
  ).toBeVisible();
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

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect((await nav(page)).some((name) => name.includes("Admin"))).toBe(false);
});
