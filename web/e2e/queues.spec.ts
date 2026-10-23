import { test, expect, type Page } from "@playwright/test";

// The public queues (v0.5.0) as SysOp, without the engine: a Legacy deck imported, "Find a game"
// waiting for players only, the wait counted on the Play page and shown on the main menu's Play
// tile, and leaving the queue. A match needs a second player and the engine; a queue's game of
// two players is a table's game, which tables.spec.ts plays. The API's tests cover the matching.
// It needs a card catalog (scripts/load_fixture_catalog.py), as the deck journeys do.
const sysopPassword = process.env.CD_E2E_SYSOP_PASSWORD;

async function signInSysop(page: Page) {
  await page.goto("/#sysop");
  await page.getByLabel("Password").fill(sysopPassword!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/#admin$/);
}

/** Leaves the queue through the API, so a journey that failed while waiting blocks no other. */
async function leaveQueue(page: Page) {
  await page.evaluate(async () => {
    const me = (await (await fetch("/api/v1/me")).json()) as {
      csrf_token?: string;
    };
    if (!me.csrf_token) return;
    await fetch("/api/v1/queue", {
      method: "DELETE",
      headers: { "X-CSRF-Token": me.csrf_token },
    });
  });
}

test.describe("the public queues", () => {
  test.skip(!sysopPassword, "Needs SysOp: set CD_E2E_SYSOP_PASSWORD.");

  test.beforeEach(async ({ page }) => {
    await signInSysop(page);
    const catalog = await page.evaluate(async () => {
      const response = await fetch("/api/v1/catalog");
      return (await response.json()) as { revision: object | null };
    });
    test.skip(
      !catalog.revision,
      "Needs a card catalog: run scripts/load_fixture_catalog.py.",
    );
  });

  test.afterEach(async ({ page }) => {
    await leaveQueue(page);
  });

  test("joining a queue, waiting with the time counted, and leaving it", async ({
    page,
  }) => {
    const title = `Queue burn ${Date.now()}`;
    await page.goto("/#decks");
    await page.getByRole("button", { name: "Import a list" }).click();
    const importer = page.getByRole("dialog", { name: "Import a deck list" });
    await importer.getByRole("radio", { name: "Legacy" }).check();
    await importer.getByLabel("Deck list").fill("60 Mountain");
    await importer.getByRole("button", { name: "Preview" }).click();
    await importer.getByLabel("Deck name").fill(title);
    await importer.getByRole("button", { name: "Create the deck" }).click();
    await expect(page).toHaveURL(/#deck\/[0-9a-f-]{36}$/);

    // Play's first section finds a game: the format, the deck, and players only.
    await page.goto("/#find");
    const finder = page.getByRole("region", { name: "Find a game" });
    await finder.getByRole("radio", { name: /Legacy/ }).check();
    await finder.getByLabel("Your deck").selectOption({ label: title });
    await finder.getByRole("checkbox", { name: /Players only/ }).check();
    await finder.getByRole("button", { name: "Find a game" }).click();
    const wait = finder.getByRole("status");
    await expect(wait).toContainText("Looking for a Legacy game…");
    await expect(wait).toContainText("You wait for players only: no bots.");
    await expect(wait).toContainText(`Playing ${title}.`);
    await expect(wait).toContainText(/Waited 0:0[2-9]/, { timeout: 10_000 });
    expect(
      await page.evaluate(async () => {
        const listed = (await (await fetch("/api/v1/queues")).json()) as {
          format: string;
          seats: number;
          waiting: number;
        }[];
        return listed.find((q) => q.format === "legacy")?.waiting;
      }),
    ).toBeGreaterThanOrEqual(1);

    // The main menu's Play tile says so, and leads back to the wait.
    await page.goto("/#home");
    const tile = page.getByRole("link", { name: /Looking for a Legacy game/ });
    await expect(tile).toHaveAttribute("href", "#find");
    await tile.click();
    const leave = finder.getByRole("button", { name: "Leave the queue" });
    await expect(leave).toBeVisible();
    await leave.click();
    await expect(
      finder.getByRole("button", { name: "Find a game" }),
    ).toBeVisible();
    // The form keeps the last wait's choices.
    await expect(
      finder.getByRole("checkbox", { name: /Players only/ }),
    ).toBeChecked();
    await expect(finder.getByLabel("Your deck")).toHaveValue(/^[0-9a-f-]{36}$/);
  });
});
