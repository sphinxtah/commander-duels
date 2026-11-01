import { test, expect, type Page } from "@playwright/test";

// The setup wizard's four welcome screenshots (v0.8.4), taken from the game as it is: the table
// (the tutorial's guided game, every hidden card showing the real card back), the deck builder, a
// pack half turned over at Leng's counter, and the Alliance. Only on demand
// (CD_E2E_WELCOME_SHOTS=1, with SysOp and the test catalog); each is saved at 1280 x 800 under
// test-results/welcome, from which scripts/welcome_shots.py makes web/public/welcome's pictures.
const sysopPassword = process.env.CD_E2E_SYSOP_PASSWORD;
const wanted = process.env.CD_E2E_WELCOME_SHOTS === "1";
const OUT = "test-results/welcome";

async function signInSysop(page: Page) {
  await page.goto("/#sysop");
  await page.getByLabel("Password").fill(sysopPassword!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/#admin$/);
}

/** The friends' chat bar folds into a corner of every page: out of the pictures. */
async function hideChatBar(page: Page) {
  await page.addStyleTag({
    content: "[data-chat-bar] { visibility: hidden !important; }",
  });
}

/** Waits until every card picture on the page has loaded (or failed for good). */
async function picturesSettled(page: Page) {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          [...document.images].every((image) => image.complete),
        ),
      { timeout: 30_000 },
    )
    .toBe(true);
}

test.describe("the welcome's screenshots", () => {
  test.skip(
    !wanted || !sysopPassword,
    "On demand: CD_E2E_WELCOME_SHOTS=1 and CD_E2E_SYSOP_PASSWORD.",
  );
  test.use({ viewport: { width: 1280, height: 800 } });
  test.setTimeout(180_000);

  test.beforeEach(async ({ page }) => {
    await signInSysop(page);
  });

  test("the table", async ({ page }) => {
    await page.goto("/#tutorial/demo");
    const narration = page.locator('[data-tutorial="narration"]');
    await expect(narration).toBeVisible();
    // On to the lesson on commander damage: a full board, both libraries and Vok's hand face down.
    for (let n = 0; n < 40; n += 1) {
      const title = await narration.getByRole("heading").textContent();
      if (title === "Commander damage") break;
      await narration.getByRole("button", { name: /Next/ }).click();
      await page.waitForTimeout(150);
    }
    await expect(narration.getByRole("heading")).toHaveText("Commander damage");
    // Its frames play through, and the cards' pictures arrive from the API.
    await page.waitForTimeout(9_000);
    await narration.evaluate((node) => {
      (node as HTMLElement).style.display = "none";
    });
    await hideChatBar(page);
    await page.waitForTimeout(1_000);
    await page.screenshot({ path: `${OUT}/table.png` });
  });

  test("the deck builder", async ({ page }) => {
    const catalog = await page.evaluate(async () => {
      const response = await fetch("/api/v1/catalog");
      return (await response.json()) as { revision: object | null };
    });
    test.skip(!catalog.revision, "Needs the test catalog.");
    await page.goto("/#decks");
    await page.getByRole("button", { name: "Import a list" }).click();
    const importer = page.getByRole("dialog", { name: "Import a deck list" });
    await importer.getByRole("radio", { name: "Commander" }).check();
    await importer
      .getByLabel("Deck list")
      .fill(
        [
          "1 Kenrith, the Returned King [Commander]",
          "1 Sol Ring",
          "1 Llanowar Elves",
          "1 Birds of Paradise",
          "1 Grizzly Bears",
          "1 Hill Giant",
          "1 Lightning Bolt",
          "1 Swords to Plowshares",
          "1 Counterspell",
          "1 Brainstorm",
          "1 Dark Ritual",
          "1 Wrath of God",
          "1 Thoughtseize",
          "7 Seven Dwarves",
          "32 Relentless Rats",
          "12 Forest",
          "12 Mountain",
          "8 Plains",
          "8 Island",
          "8 Swamp",
        ].join("\n"),
      );
    await importer.getByRole("button", { name: "Preview" }).click();
    await importer.getByLabel("Deck name").fill("The Returned King");
    await importer.getByRole("button", { name: "Create the deck" }).click();
    await expect(page).toHaveURL(/#deck\/[0-9a-f-]{36}$/);
    await hideChatBar(page);
    // The commander and the first of the deck's pictures, under the deck's name.
    await page.evaluate(() => window.scrollTo(0, 150));
    await picturesSettled(page);
    await page.waitForTimeout(2_500);
    await page.screenshot({ path: `${OUT}/decks.png` });
  });

  test("a pack at Leng's counter", async ({ page }) => {
    const product = await page.evaluate(async () => {
      const shop = (await (await fetch("/api/v1/shop")).json()) as {
        products: { id: string; name: string; kind: string }[];
      };
      return (
        shop.products.find((item) => item.name.startsWith("Zendikar Rising")) ??
        null
      );
    });
    test.skip(!product, "Needs the test collation.");
    // SysOp gives itself the tokens, and buys the pack through the API.
    const bought = await page.evaluate(async (id) => {
      const me = (await (await fetch("/api/v1/me")).json()) as {
        id: string;
        csrf_token: string;
      };
      const headers = {
        "Content-Type": "application/json",
        "X-CSRF-Token": me.csrf_token,
      };
      await fetch(`/api/v1/admin/users/${me.id}/tokens`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          amount: 1000,
          reason: "The welcome's screenshots",
        }),
      });
      const response = await fetch("/api/v1/shop/purchases", {
        method: "POST",
        headers,
        body: JSON.stringify({ product: id, key: crypto.randomUUID() }),
      });
      return response.status;
    }, product!.id);
    expect(bought).toBe(201);
    await page.goto("/#shop");
    await page
      .getByRole("button", { name: /^Open a pack of Zendikar Rising/ })
      .first()
      .click();
    await page.locator('[data-tour="pack-tear"]').click();
    const board = page.locator('[data-stage="revealing"]');
    await expect(board).toBeVisible({ timeout: 15_000 });
    // About half turned over: the rest show the card back.
    const cards = board.locator("ol button");
    const count = await cards.count();
    for (let n = 0; n < Math.ceil(count / 2); n += 1) {
      await cards.nth(n).click();
      await page.waitForTimeout(250);
    }
    await hideChatBar(page);
    await page
      .locator('[data-tour="pack-opening"]')
      .evaluate((node) => node.scrollIntoView({ block: "start" }));
    await page.evaluate(() => window.scrollBy(0, -80));
    await page.waitForTimeout(2_000);
    await picturesSettled(page);
    await page.screenshot({ path: `${OUT}/shop.png` });
  });

  test("the Alliance", async ({ page }) => {
    await page.goto("/#profile");
    await page.getByRole("tab", { name: "Alliance" }).click();
    const alliance = page.locator("#alliance-title");
    await expect(alliance).toBeVisible();
    await hideChatBar(page);
    await alliance.evaluate((node) => node.scrollIntoView({ block: "start" }));
    await page.evaluate(() => window.scrollBy(0, -90));
    await picturesSettled(page);
    await page.waitForTimeout(1_500);
    await page.screenshot({ path: `${OUT}/alliance.png` });
  });
});
