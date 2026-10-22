import { test, expect, type Page } from "@playwright/test";

// The deck builder and the card catalog (M1) as SysOp, who may build decks: a list imported,
// fixed in the editor, saved, shared and taken to the practice table, and the catalog searched.
// They need a card catalog; CI loads Scryfall's test slice with scripts/load_fixture_catalog.py,
// and the journeys use only cards in it.
const sysopPassword = process.env.CD_E2E_SYSOP_PASSWORD;

async function signInSysop(page: Page) {
  await page.goto("/#sysop");
  await page.getByLabel("Password").fill(sysopPassword!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/#admin$/);
}

test.describe("decks and the card catalog", () => {
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

  test("a list imported, fixed, saved, shared and taken to the practice table", async ({
    page,
    context,
  }, testInfo) => {
    const title = `Journey burn ${Date.now()}`;
    await page.goto("/#decks");
    await page.getByRole("button", { name: "Import a list" }).click();
    const importer = page.getByRole("dialog", { name: "Import a deck list" });
    await importer.getByRole("radio", { name: "Legacy" }).check();
    await importer
      .getByLabel("Deck list")
      .fill("5 Lightning Bolt\n4 Hill Giant\n52 Mountain");
    await importer.getByRole("button", { name: "Preview" }).click();
    await expect(
      importer.getByRole("heading", {
        name: "3 lines · 0 not found · 0 with several matches",
      }),
    ).toBeVisible();
    // The preview validates before anything is saved: five bolts are one too many.
    await expect(importer).toContainText(
      "5 copies of Lightning Bolt: Legacy allows 4 copies.",
    );
    await importer.getByLabel("Deck name").fill(title);
    await importer.getByRole("button", { name: "Create the deck" }).click();
    await expect(page).toHaveURL(/#deck\/[0-9a-f-]{36}$/);
    const deckId = page.url().split("#deck/")[1];

    // The editor shows the same problem, with its remedy; one fewer bolt fixes it.
    await expect(page.getByText("1 problem to fix")).toBeVisible();
    await expect(page.getByText("Remove 1.")).toBeVisible();
    await page
      .getByRole("button", { name: "One fewer Lightning Bolt" })
      .click();
    await expect(page.getByText("All changes saved")).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByText("Ready to play: legal, and every card is playable here."),
    ).toBeVisible();

    // A card found and added, kept within the deck's format and playable cards.
    const finder = page.getByRole("region", { name: "Add cards" });
    await finder.getByLabel("Search cards").fill("Counterspell");
    const found = finder.getByRole("listitem").filter({
      has: page.getByRole("button", { name: /^Counterspell/ }),
    });
    await found.getByRole("button", { name: "Add" }).click();
    await expect(
      page.getByText("Added Counterspell to the main deck."),
    ).toBeVisible();
    await expect(page.getByText("All changes saved")).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole("button", { name: "Remove Counterspell" }).click();
    await expect(page.getByText("All changes saved")).toBeVisible({
      timeout: 10_000,
    });

    // Statistics, open beside the list, describe the main deck.
    const totals = page.locator("dl").filter({ hasText: "Lands" });
    await expect(totals).toContainText("Lands52");
    await expect(page.getByText(/Two to four lands: \d+%/)).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("deck-editor.png") });

    await page.getByRole("button", { name: "Save a version" }).click();
    await expect(page.getByText("Saved as version 1.")).toBeVisible();

    // Notes stay private; the link shows the cards to any signed-in player.
    await page.getByLabel("Notes (only you see these)").fill("Secret plan");
    // The box shows the server's answer, so it ticks once the deck is shared.
    const sharing = page.getByLabel(/Share by link/);
    await sharing.click();
    await expect(sharing).toBeChecked();
    const link = page.getByLabel("Share link");
    await expect(link).toHaveValue(/#shared\/[A-Za-z0-9_-]+$/);
    const shared = await context.newPage();
    await shared.goto(await link.inputValue());
    await expect(shared.getByRole("heading", { name: title })).toBeVisible();
    await expect(
      shared.getByRole("region", { name: "Main deck" }),
    ).toContainText("Lightning Bolt");
    await expect(shared.getByText("Secret plan")).toHaveCount(0);
    await expect(
      shared.getByRole("button", { name: "Copy it to your decks" }),
    ).toBeVisible();
    await shared.close();

    // "Play it" opens the practice table with the deck chosen.
    await page
      .getByRole("link", { name: "Play it at the practice table" })
      .click();
    await expect(page).toHaveURL(/#play\?deck=/);
    await expect(page.getByLabel("Your deck")).toHaveValue(`own:${deckId}`);

    // From the list: archived, then back.
    await page.goto("/#decks");
    const row = page
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: title }) });
    await expect(row).toContainText("Ready to play");
    await row.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByText(`${title} is archived.`)).toBeVisible();
    await page.getByRole("tab", { name: "Archived" }).click();
    await page
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: title }) })
      .getByRole("button", { name: "Unarchive" })
      .click();
    await expect(
      page.getByText(`${title} is back with your decks.`),
    ).toBeVisible();
  });

  test("a Commander deck goes to the practice table in its own format", async ({
    page,
  }) => {
    await page.goto("/#decks");
    await page.getByRole("button", { name: "Import a list" }).click();
    const importer = page.getByRole("dialog", { name: "Import a deck list" });
    await importer.getByRole("radio", { name: "Commander" }).check();
    await importer
      .getByLabel("Deck list")
      .fill(
        [
          "Commander",
          "1 Kenrith, the Returned King",
          "",
          "Deck",
          "20 Plains",
          "20 Island",
          "20 Swamp",
          "20 Mountain",
          "19 Forest",
        ].join("\n"),
      );
    await importer.getByRole("button", { name: "Preview" }).click();
    await expect(
      importer.getByText(
        "Ready to play: legal, and every card is playable here.",
      ),
    ).toBeVisible();
    await importer
      .getByLabel("Deck name")
      .fill(`Journey Kenrith ${Date.now()}`);
    await importer.getByRole("button", { name: "Create the deck" }).click();
    await expect(page).toHaveURL(/#deck\/[0-9a-f-]{36}$/);
    const deckId = page.url().split("#deck/")[1];
    await expect(page.getByRole("region", { name: "Commander" })).toContainText(
      "Kenrith, the Returned King",
    );
    // The table opens on Legacy; the link switches it to Commander, then picks the deck.
    await page
      .getByRole("link", { name: "Play it at the practice table" })
      .click();
    await expect(page.getByRole("radio", { name: /Commander/ })).toBeChecked();
    await expect(page.getByLabel("Your deck")).toHaveValue(`own:${deckId}`);
  });

  test("the card catalog: search syntax, a card's details and the administrators' view", async ({
    page,
  }) => {
    await page.goto("/#cards");
    await expect(page.getByRole("main")).toContainText(
      / cards · catalog revision /,
    );
    await page.getByLabel("Search cards").fill("t:instant o:damage");
    const bolt = page.getByRole("button", { name: "Lightning Bolt, Instant" });
    await expect(bolt).toBeVisible();
    await expect(
      page.getByRole("button", { name: /^Counterspell,/ }),
    ).toHaveCount(0);
    await bolt.click();
    const details = page.getByRole("dialog");
    await expect(details).toContainText(
      "Lightning Bolt deals 3 damage to any target.",
    );
    await page.keyboard.press("Escape");

    // A card the game engine cannot play is not in the game (v0.4.5): no search finds it, and
    // no term or filter names playability any more. Temple of Khonshu is in the test slice, and
    // the engine has no implementation of it.
    await page.getByLabel("Search cards").fill('!"Temple of Khonshu"');
    await expect(page.getByText("0 cards", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /not playable yet/ }),
    ).toHaveCount(0);
    await page.getByLabel("Search cards").fill("is:unsupported");
    await expect(page.getByRole("alert")).toBeVisible();

    // A query the parser refuses says why.
    await page.getByLabel("Search cards").fill("mv>=");
    await expect(page.getByRole("alert")).toBeVisible();

    await page.goto("/#admin");
    await page.getByRole("tab", { name: "Card catalog" }).click();
    await expect(
      page.getByRole("table", { name: "Legacy coverage" }),
    ).toContainText("Playable");
    await expect(
      page.getByRole("table", { name: "Recent catalog runs" }),
    ).toBeVisible();
  });
});
