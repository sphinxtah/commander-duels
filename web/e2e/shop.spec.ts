import { test, expect, type Page } from "@playwright/test";

// Leng's card shop (v0.4.0) as SysOp: a pack bought with tokens, opened at the counter (torn
// open, a card turned over with Space, the rest revealed), its summary and a card's details, the
// history, and the Card shop tab in Administration; since v0.4.3 the pack's own picture on the
// shelf and at the counter. It needs the test catalog and the test
// collation, which scripts/load_fixture_catalog.py loads: a Zendikar Rising draft booster drawn
// from the test catalog's cards. MTGJSON is never fetched.
const sysopPassword = process.env.CD_E2E_SYSOP_PASSWORD;
const PRODUCT = "Zendikar Rising Draft Booster";

async function signInSysop(page: Page) {
  await page.goto("/#sysop");
  await page.getByLabel("Password").fill(sysopPassword!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/#admin$/);
}

test.describe("Leng's card shop", () => {
  test.skip(!sysopPassword, "Needs SysOp: set CD_E2E_SYSOP_PASSWORD.");

  test.beforeEach(async ({ page }) => {
    await signInSysop(page);
    const ready = await page.evaluate(async (name) => {
      const response = await fetch("/api/v1/shop");
      const shop = (await response.json()) as { products: { name: string }[] };
      return shop.products.some((product) => product.name === name);
    }, PRODUCT);
    test.skip(
      !ready,
      "Needs the test collation: run scripts/load_fixture_catalog.py.",
    );
    // SysOp gives itself the tokens for a pack, so the journey runs again and again.
    const given = await page.evaluate(async () => {
      const me = (await (await fetch("/api/v1/me")).json()) as {
        id: string;
        csrf_token: string;
      };
      const response = await fetch(`/api/v1/admin/users/${me.id}/tokens`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": me.csrf_token,
        },
        body: JSON.stringify({ amount: 1000, reason: "The shop's journey" }),
      });
      return response.status;
    });
    expect(given).toBe(200);
  });

  test("a pack bought, opened at the counter and summed up", async ({
    page,
  }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/#shop");
    await expect(
      page.getByRole("heading", { level: 1, name: "Leng's card shop" }),
    ).toBeVisible();
    await expect(
      page.getByRole("img", { name: /Leng, an old shopkeeper/ }),
    ).toBeVisible();
    const shelves = page.getByRole("region", { name: "On the shelves" });
    await shelves.getByLabel("Search by set name or code").fill("znr");
    const product = shelves.getByRole("listitem", { name: PRODUCT });
    await expect(product).toContainText("380 tokens");
    // Its pack's picture (v0.4.3), from this site's own copy, loaded and shown.
    const picture = product.locator('[data-pack-art="picture"]');
    await expect(picture).toBeVisible();
    await expect(picture).toHaveAttribute(
      "src",
      /^\/packs\/znr-draft-160\.webp$/,
    );
    await expect
      .poll(() =>
        picture.evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect(
      shelves.getByRole("region", { name: "Set and Collector Boosters" }),
    ).toBeVisible();
    // Players see tokens only, never dollars.
    expect(await page.locator("main").innerText()).not.toMatch(/\$|USD/);
    await page.screenshot({
      path: testInfo.outputPath("shop.png"),
      fullPage: true,
    });

    // The weekly sale (v0.4.3): the test catalog's one product on the shelf is always among the
    // week's five, at 20% off, at the counter and on the shelf alike.
    const sale = page.getByRole("region", { name: /This week's sale/ });
    await expect(sale.getByRole("listitem", { name: PRODUCT })).toContainText(
      "380 tokens 304 tokens",
    );
    await expect(page.getByText(/Wins earn tokens/)).toHaveCount(0);
    await expect(product).toContainText("Weekly sale");

    await product.getByRole("button", { name: `Buy ${PRODUCT}` }).click();
    const dialog = page.getByRole("dialog", { name: `Buy a ${PRODUCT}?` });
    await expect(dialog).toContainText(
      "It costs 304 tokens in this week's sale (380 tokens otherwise).",
    );
    await dialog.getByRole("button", { name: "Buy for 304 tokens" }).click();
    await expect(
      page.getByText(new RegExp(`You bought a ${PRODUCT} for 304 tokens`)),
    ).toBeVisible();

    await page
      .getByRole("button", { name: `Open a pack of ${PRODUCT}` })
      .click();
    const sealed = page.getByRole("button", {
      name: `Tear open the ${PRODUCT}`,
    });
    // The pack at the counter is the product's own picture: the strip that tears off, and the
    // rest of it.
    await expect(sealed.locator("[data-pack-art]")).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath("shop-sealed.png") });
    await sealed.click();
    const board = page.getByRole("group", { name: "The pack's cards" });
    await expect(board.getByRole("button", { name: /face down/ })).toHaveCount(
      15,
    );
    await expect(board).toBeFocused();
    await page.keyboard.press("Space");
    await expect(board.getByRole("button", { name: /face down/ })).toHaveCount(
      14,
    );
    await page.screenshot({ path: testInfo.outputPath("shop-revealing.png") });
    await page.getByRole("button", { name: "Reveal all" }).click();
    const summary = page.getByRole("list", { name: "Cards in the pack" });
    await expect(summary.getByRole("listitem")).toHaveCount(15);
    await expect(
      page.getByText(/15 cards · \d+ new to your library/),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("shop-opened.png"),
      fullPage: true,
    });
    const first = summary.getByRole("listitem").first();
    // The last name in the item is the summary's; the first is the card frame's, under its image.
    const name = (await first.locator("strong").last().innerText()).trim();
    await first.getByRole("button", { name: `Details of ${name}` }).click();
    const details = page.getByRole("dialog", { name: `${name}, card details` });
    await expect(details.getByRole("heading", { level: 2 })).toContainText(
      name,
    );
    await details
      .getByRole("button", { name: "Close the card's details" })
      .click();

    await page.getByRole("button", { name: "Back to the shop" }).click();
    const history = page.getByRole("list", { name: "Packs you opened" });
    await expect(history.getByRole("listitem").first()).toContainText(PRODUCT);
    await expect(history.getByRole("listitem").first()).toContainText(
      "15 cards",
    );
    // A phone: nothing scrolls sideways, the opened pack's summary included.
    await page.setViewportSize({ width: 390, height: 844 });
    const fits = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    expect(await fits()).toBe(true);
    await history
      .getByRole("button", { name: /See its cards/ })
      .first()
      .click();
    await expect(summary.getByRole("listitem")).toHaveCount(15);
    expect(await fits()).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath("shop-summary-390.png"),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });

  test("the Card shop tab lists the prices and the booster data", async ({
    page,
  }) => {
    await page.goto("/#admin");
    await page.getByRole("tab", { name: "Card shop" }).click();
    await page
      .getByLabel("Search by name, set or code")
      .fill("zendikar rising draft");
    const prices = page.getByRole("table", { name: "Products and prices" });
    const row = prices.getByRole("row").filter({ hasText: PRODUCT });
    await expect(row).toContainText("380 tokens");
    await expect(row).toContainText("$4.97");
    await expect(row).toContainText("On sale");
    await row.getByRole("button", { name: `Change ${PRODUCT}` }).click();
    await expect(
      page.getByRole("region", { name: `${PRODUCT}: price and sale` }),
    ).toContainText("revision 1");
    await expect(
      page.getByRole("heading", { name: "Give packs" }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
});
