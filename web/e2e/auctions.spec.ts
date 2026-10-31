import { test, expect, type Page } from "@playwright/test";

// Tivit's Auction House (v0.6.0) with two real accounts: the second player lists a Plains it
// holds (scripts/e2e_player.py grants it basic lands), SysOp finds it on the market, bids, then
// buys it now; the seller's transfer list shows it sold and its tokens grew by the whole price,
// the buyer's transfer targets show it won, and Administration's log lists the sale.
const sysopPassword = process.env.CD_E2E_SYSOP_PASSWORD;
const playerSession = process.env.CD_E2E_PLAYER_SESSION;

/** The account's tokens: its balance, and what the auction house gave or took. The second
 * account also wins games in other journeys running at once, so the sale is checked on the
 * auction house's part, which nothing else moves. */
async function tokens(
  page: Page,
): Promise<{ balance: number; auctions: number }> {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/me/tokens");
    return (await response.json()) as { balance: number; auctions: number };
  });
}

test.describe("Tivit's Auction House", () => {
  test.skip(
    !sysopPassword || !playerSession,
    "Needs SysOp and a second account: CD_E2E_SYSOP_PASSWORD and CD_E2E_PLAYER_SESSION " +
      "(scripts/e2e_player.py).",
  );

  test("a card listed, bid on, bought now and paid in full", async ({
    browser,
  }, testInfo) => {
    const [sysopContext, playerContext] = await Promise.all([
      browser.newContext({ viewport: { width: 1400, height: 900 } }),
      browser.newContext({ viewport: { width: 1400, height: 900 } }),
    ]);
    await playerContext.addCookies([
      {
        name: "cd_session",
        value: playerSession!,
        domain: new URL(testInfo.project.use.baseURL!).hostname,
        path: "/api",
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ]);
    const sysop = await sysopContext.newPage();
    const seller = await playerContext.newPage();
    const errors: string[] = [];
    for (const page of [sysop, seller])
      page.on("pageerror", (error) => errors.push(error.message));
    try {
      // The seller lists one Plains, from 10 tokens, Buy Now 60, for an hour.
      await seller.goto("/#auctions");
      await expect(
        seller.getByRole("heading", { name: "Tivit's Auction House" }),
      ).toBeVisible();
      const before = (await tokens(seller)).auctions;
      await seller.getByRole("button", { name: /Sell a card/ }).click();
      const sell = seller.getByRole("dialog", { name: "List on the market" });
      await sell.getByLabel("Find a card you may sell").fill("Plains");
      await sell
        .getByRole("radiogroup", { name: "Edition and finish" })
        .getByRole("radio", { name: /^Plains/ })
        .first()
        .click();
      await sell.getByLabel("Starting bid (tokens)").fill("10");
      await sell.getByText("Set a Buy Now price").click();
      await sell.getByLabel("Buy Now (tokens)").fill("60");
      await sell
        .getByRole("radiogroup", { name: "Length of the auction" })
        .getByRole("radio", { name: "1 hour" })
        .check();
      await expect(sell.getByText("You receive 100% — no fee")).toBeVisible();
      await sell.getByRole("button", { name: "List it" }).click();
      await expect(sell).toBeHidden();
      await seller.goto("/#auctions/list");
      // The sections start folded (v0.7.0): the heading opens one.
      await seller
        .getByRole("region", { name: /Active/ })
        .getByRole("heading")
        .getByRole("button")
        .click();
      const active = seller.getByRole("list", { name: "Active" });
      await expect(active).toContainText("Plains");

      // SysOp, with tokens of its own giving, finds it, bids the least, then buys it now.
      await sysop.goto("/#sysop");
      await sysop.getByLabel("Password").fill(sysopPassword!);
      await sysop.getByRole("button", { name: "Sign in" }).click();
      await expect(sysop).toHaveURL(/#admin$/);
      const given = await sysop.evaluate(async () => {
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
          body: JSON.stringify({
            amount: 1000,
            reason: "The auction house's journey",
          }),
        });
        return response.status;
      });
      expect(given).toBe(200);
      await sysop.goto("/#auctions/search");
      const filters = sysop.getByRole("search", { name: "Search the market" });
      await filters.getByLabel("Card name").fill("Plains");
      await filters
        .getByRole("button", { name: "Search", exact: true })
        .click();
      const results = sysop.getByRole("list", { name: "Auctions" });
      await results
        .getByLabel(/^Plains.*Buy Now 60 tokens/)
        .first()
        .click();
      const panel = sysop.getByRole("dialog", { name: "Plains" });
      await expect(panel).toBeVisible();
      await panel.getByRole("button", { name: "Make bid" }).click();
      await expect(panel.getByText("You hold the highest bid.")).toBeVisible();
      await panel.getByRole("button", { name: /^Buy Now · / }).click();
      await panel
        .getByRole("group", { name: "Confirm Buy Now" })
        .getByRole("button", { name: "Buy for 60 tokens" })
        .click();
      await sysop.goto("/#auctions/targets");
      // The sections start folded (v0.7.0): the heading opens one.
      await sysop
        .getByRole("region", { name: /Won/ })
        .getByRole("heading")
        .getByRole("button")
        .click();
      await expect(sysop.getByRole("list", { name: "Won" })).toContainText(
        "Plains",
      );

      // The seller is paid the whole price: no fee.
      await seller.goto("/#auctions/list");
      await seller
        .getByRole("region", { name: /^Sold\b/ })
        .getByRole("heading")
        .getByRole("button")
        .click();
      await expect(seller.getByRole("list", { name: "Sold" })).toContainText(
        "Plains",
      );
      await expect
        .poll(async () => (await tokens(seller)).auctions)
        .toBe(before + 60);
      // The page's poll shows the balance without a reload.
      const paid = (await tokens(seller)).balance;
      await expect(
        seller
          .getByRole("definition")
          .filter({ hasText: paid.toLocaleString("en-US") }),
      ).toBeVisible({ timeout: 15000 });

      // Administration's log lists the sale.
      await sysop.goto("/#admin");
      await sysop.getByRole("tab", { name: "Auctions" }).click();
      await expect(sysop.getByRole("main")).toContainText("Plains");
      await expect(sysop.getByRole("main")).toContainText("rival");
      expect(errors).toEqual([]);
    } finally {
      await Promise.all([sysopContext.close(), playerContext.close()]);
    }
  });
});
