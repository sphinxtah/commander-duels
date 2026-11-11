import { test, expect, type Page } from "@playwright/test";
import { standIn } from "./accounts";

// Deck packs at Leng's shop (v0.9.8, the owner's request): a pack that is a deck asks, once its
// cards are revealed, whether to keep them together. A Starter Deck is saved as a Legacy deck; one
// of the ten starter decks, whose box tears open as a pack does, is built into a Commander deck;
// either may be kept as individual cards instead. A stand-in account and a shop that page.route
// answers, so no SysOp, no catalog and no tokens: the journey is the page's own.
const sizes = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

const PRODUCT = {
  id: "00000000-0000-4000-8000-00000000a001",
  set_code: "TMP",
  set_name: "Tempest",
  name: "Tempest Starter Deck",
  kind: "starter",
  released: "1997-10-14",
  booster: "starter",
  era: "oldborder",
  art: null,
  symbol: null,
};
const OPENING = "00000000-0000-4000-8000-00000000b001";
const DECK = "00000000-0000-4000-8000-00000000c001";

function card(position: number, name: string, rarity: string, extra = {}) {
  return {
    position,
    card_id: `00000000-0000-4000-8000-0000000d${String(position).padStart(4, "0")}`,
    printing_id: `00000000-0000-4000-8000-0000000e${String(position).padStart(4, "0")}`,
    name,
    mana_cost: rarity === "land" ? null : "{1}{R}",
    type_line:
      rarity === "land" ? "Basic Land — Mountain" : "Creature — Goblin",
    rarity: rarity === "land" ? "common" : rarity,
    set_code: "TMP",
    set_name: "Tempest",
    released_at: "1997-10-14",
    collector_number: String(position + 1),
    finish: "nonfoil",
    sheet: rarity,
    new: position % 3 === 0,
    faces: 0,
    stand_in: false,
    extra: false,
    ...extra,
  };
}

/** Sixty cards: lands, commons, uncommons and two rares, as a Starter Deck held. */
function sixty() {
  return Array.from({ length: 60 }, (_, index) =>
    index < 22
      ? card(index, "Mountain", "land")
      : index < 45
        ? card(index, `Goblin Recruit ${index}`, "common")
        : index < 58
          ? card(index, `Goblin Veteran ${index}`, "uncommon")
          : card(index, `Goblin Warlord ${index}`, "rare"),
  );
}

async function shop(page: Page) {
  const calls: string[] = [];
  let saved: { deck: string; title: string } | null = null;
  const opening = () => ({
    id: OPENING,
    pack: "00000000-0000-4000-8000-00000000f001",
    product: PRODUCT,
    collation_revision: 1,
    mtgjson_version: "5.3.0",
    opened_at: "2026-11-11T19:00:00Z",
    cards: sixty(),
    deck: {
      format: "legacy",
      deck: saved?.deck ?? null,
      deck_title: saved?.title ?? null,
    },
  });
  const starter = (id: string, title: string, owned: boolean) => ({
    id,
    title,
    commander: `${title}'s Commander`,
    colors: "R",
    color_names: "Red",
    guild: "Mono-red",
    description: `${title} wins with small creatures and burn.`,
    commander_card_id: null,
    commander_printing_id: null,
    price: owned ? 600 : 900,
    owned,
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, json: body });
    if (pathname === "/api/v1/me") return route.fallback();
    if (pathname.startsWith("/api/v1/card-images/"))
      return route.fulfill({ status: 404, body: "" });
    calls.push(`${method} ${pathname}`);
    if (pathname === "/api/v1/shop" && method === "GET")
      return json({
        balance: 1_000,
        products: [
          {
            ...PRODUCT,
            price: 700,
            price_basis: "market",
            pack_size: 60,
            sale_price: null,
            sold_out: false,
          },
        ],
        eras: [
          { id: "oldborder", name: "The old border", since: "1997-01-01" },
        ],
        inventory: [
          {
            product: PRODUCT,
            count: 1,
            next_pack: "00000000-0000-4000-8000-00000000f001",
            openable: true,
          },
        ],
        data: {
          mtgjson_version: "5.3.0",
          prices_as_of: "2026-10-21",
          checked_at: "2026-10-21T11:00:00Z",
        },
        decks: [
          starter("starter_first", "First Flames", true),
          starter("starter_goblins", "Goblin Uprising", false),
        ],
        free_decks: false,
        sale: null,
      });
    if (pathname === "/api/v1/shop/openings" && method === "GET")
      return json([
        {
          id: OPENING,
          product: PRODUCT,
          opened_at: "2026-11-11T19:00:00Z",
          cards: 60,
          new_cards: 20,
          foils: 0,
          best: "rare",
        },
      ]);
    if (/\/shop\/packs\/[^/]+\/open$/.test(pathname)) return json(opening());
    if (pathname === `/api/v1/shop/openings/${OPENING}` && method === "GET")
      return json(opening());
    if (pathname === `/api/v1/shop/openings/${OPENING}/deck`) {
      saved = { deck: DECK, title: "Tempest Starter Deck" };
      return json({ ...saved, format: "legacy", repeated: false }, 201);
    }
    if (pathname === "/api/v1/shop/decks" && method === "POST")
      return json(
        {
          deck: null,
          starter: "starter_goblins",
          tokens: 900,
          balance: 100,
          repeated: false,
          cards: [
            ...sixty().slice(0, 59),
            {
              ...card(59, "Goblin Uprising's Commander", "mythic"),
              commander: true,
              new: true,
            },
          ],
        },
        201,
      );
    if (pathname === "/api/v1/decks" && method === "POST")
      return json({ id: DECK, title: "Goblin Uprising" }, 201);
    return route.fallback();
  });
  return calls;
}

for (const size of sizes) {
  test(`a Starter Deck is saved as a Legacy deck at ${size.width}×${size.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await standIn(page, {
      permissions: ["profile.edit", "decks.edit"],
      preferences: { large_text: false, reduced_motion: true },
    });
    const calls = await shop(page);
    await page.goto("/#shop");
    await page
      .getByRole("button", { name: "Open a pack of Tempest Starter Deck" })
      .click();
    await page
      .getByRole("button", { name: "Tear open the Tempest Starter Deck" })
      .click();
    // Nothing is asked before the cards are revealed.
    await expect(page.getByText("Keep this deck together?")).toHaveCount(0);
    await page.getByRole("button", { name: "Reveal all" }).click();
    const choice = page.getByRole("region", {
      name: "Keep this deck together?",
    });
    await expect(choice).toBeVisible();
    await expect(
      page
        .getByRole("list", { name: "Cards in the pack" })
        .getByRole("listitem"),
    ).toHaveCount(60);
    const fits = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    expect(await fits()).toBe(true);
    await page.screenshot({
      path: `test-results/deck-packs/legacy-choice-${size.width}.png`,
    });
    await choice.getByRole("button", { name: "Save as a Legacy deck" }).click();
    const kept = page.getByRole("region", {
      name: "Kept together as a Legacy deck",
    });
    await expect(kept).toContainText(
      "Saved as “Tempest Starter Deck”, among your decks.",
    );
    await expect(
      kept.getByRole("link", { name: "Open the deck" }),
    ).toHaveAttribute("href", `#deck/${DECK}`);
    await expect(kept.getByRole("button")).toHaveCount(0);
    expect(await fits()).toBe(true);
    await page.screenshot({
      path: `test-results/deck-packs/legacy-saved-${size.width}.png`,
    });
    expect(calls).toContain(`POST /api/v1/shop/openings/${OPENING}/deck`);
    // Opened again from the history, the pack names its deck.
    await page.getByRole("button", { name: "Back to the shop" }).click();
    await page
      .getByRole("button", { name: /See its cards/ })
      .first()
      .click();
    await expect(
      page.getByRole("region", { name: "Kept together as a Legacy deck" }),
    ).toBeVisible();
  });

  test(`a starter deck is revealed, then built into a Commander deck at ${size.width}×${size.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await standIn(page, {
      permissions: ["profile.edit", "decks.edit"],
      preferences: { large_text: false, reduced_motion: true },
    });
    const calls = await shop(page);
    await page.goto("/#shop");
    await page.getByRole("tab", { name: "Starter decks" }).click();
    const shelf = page.getByRole("list", { name: "Starter decks" });
    await expect(
      shelf.getByRole("listitem", { name: "First Flames" }),
    ).toContainText("Yours");
    await shelf.getByRole("button", { name: "Buy Goblin Uprising" }).click();
    await page
      .getByRole("dialog", { name: "Buy Goblin Uprising?" })
      .getByRole("button", { name: "Buy for 900 tokens" })
      .click();
    // The deck's box, its commander on it, tears open as a pack does.
    const box = page.getByRole("button", {
      name: "Tear open the Goblin Uprising",
    });
    await expect(box).toBeVisible();
    await page.screenshot({
      path: `test-results/deck-packs/commander-box-${size.width}.png`,
    });
    await box.click();
    await page.getByRole("button", { name: "Reveal all" }).click();
    const choice = page.getByRole("region", {
      name: "Keep this deck together?",
    });
    await expect(choice).toContainText(
      "Build them into a Commander deck to play it as it came, or keep them as individual cards",
    );
    await choice
      .getByRole("button", { name: "Keep as individual cards" })
      .click();
    const loose = page.getByRole("region", {
      name: "Kept as individual cards",
    });
    await expect(loose).toContainText("no deck was made");
    expect(calls).not.toContain("POST /api/v1/decks");
    await page.screenshot({
      path: `test-results/deck-packs/commander-loose-${size.width}.png`,
    });
    await loose
      .getByRole("button", { name: "Build it into a Commander deck after all" })
      .click();
    const built = page.getByRole("region", {
      name: "Kept together as a Commander deck",
    });
    await expect(built).toContainText(
      "Built as “Goblin Uprising”, among your decks.",
    );
    expect(calls).toContain("POST /api/v1/decks");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Back to the shop" }).click();
    await expect(
      page.getByText(
        "You bought Goblin Uprising for 900 tokens. Its cards are in your library.",
      ),
    ).toBeVisible();
  });
}
