import { test, expect } from "@playwright/test";

// Friends in two browsers (v0.4.3): SysOp finds the test player with the top bar's search, opens
// their profile and adds them; the player's bell counts the request, and they accept it from the
// bubble; each then sees the other on Friends, online. The player appears offline, and SysOp, an
// administrator of everything, still sees the real state. Since v0.4.4 the two also write to each
// other, and the player reports a message. It needs SysOp and a second account,
// which cannot sign in with Google: scripts/e2e_player.py makes one and prints its session token,
// as for the human table's journey.
const sysopPassword = process.env.CD_E2E_SYSOP_PASSWORD;
const playerSession = process.env.CD_E2E_PLAYER_SESSION;

test.describe("friends in two browsers", () => {
  test.skip(
    !sysopPassword || !playerSession,
    "Needs SysOp and a second account: CD_E2E_SYSOP_PASSWORD and CD_E2E_PLAYER_SESSION " +
      "(scripts/e2e_player.py).",
  );
  test.setTimeout(3 * 60_000);

  test("a search, a request, the bell, and presence", async ({
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
    const player = await playerContext.newPage();
    const errors: string[] = [];
    for (const page of [sysop, player])
      page.on("pageerror", (error) => errors.push(error.message));
    try {
      await sysop.goto("/#sysop");
      await sysop.getByLabel("Password").fill(sysopPassword!);
      await sysop.getByRole("button", { name: "Sign in" }).click();
      await expect(sysop).toHaveURL(/#admin$/);
      // A friendship left by an earlier run on the same database ends first.
      const search = sysop.getByRole("combobox", {
        name: "Find players by handle or email",
      });
      await search.fill("riv");
      const found = sysop.getByRole("option", { name: /rival/ });
      await expect(found).toBeVisible();
      await found.click();
      await expect(sysop).toHaveURL(/#player\/[0-9a-f-]{36}$/);
      const profileUrl = sysop.url();
      await expect(
        sysop.getByRole("heading", { level: 1, name: "rival" }),
      ).toBeVisible();
      const remove = sysop.getByRole("button", { name: "Remove friend" });
      if (await remove.isVisible()) {
        await remove.click();
        await sysop.getByRole("button", { name: "Remove friend" }).click();
      }
      await sysop.getByRole("button", { name: "Add friend" }).click();
      await expect(sysop.getByText("Pending", { exact: true })).toBeVisible();

      // The player's bell counts the request; they accept it from the bubble.
      await player.goto("/#play");
      const bell = player.getByRole("button", {
        name: /^Notifications, \d+ unread$/,
      });
      await expect(bell).toBeVisible({ timeout: 45_000 });
      await bell.click();
      const bubble = player.getByRole("dialog", { name: "Notifications" });
      const request = bubble
        .getByRole("listitem")
        .filter({ hasText: "sysop wants to be your friend." })
        .first();
      await request.getByRole("button", { name: "Accept" }).click();
      await expect(request).toContainText("You and sysop are friends.");
      await expect(
        player.getByRole("button", { name: "Notifications" }),
      ).toBeVisible();
      await bubble.getByRole("link", { name: /See all notifications/ }).click();
      await expect(
        player.getByRole("heading", { name: "Notifications" }),
      ).toBeVisible();

      // Each sees the other: online, as both pages check in.
      await player.goto("/#friends");
      const theirs = player.getByRole("region", { name: /^Your friends/ });
      await expect(theirs.getByRole("link", { name: /sysop/ })).toContainText(
        /Online|Idle|Playing/,
        { timeout: 45_000 },
      );
      // The same address: a reload asks again.
      expect(sysop.url()).toBe(profileUrl);
      await sysop.reload();
      await expect(
        sysop.getByRole("button", { name: "Remove friend" }),
      ).toBeVisible();
      await expect(sysop.getByText(/^(Online|Idle)$/)).toBeVisible();

      // Appearing offline hides it from everyone but administrators and SysOp.
      await player.goto("/#profile");
      await player.getByRole("checkbox", { name: /Appear offline/ }).check();
      await expect(player.getByText("Privacy settings saved.")).toBeVisible();
      await sysop.reload();
      await expect(sysop.getByText(/\(appears offline\)$/)).toBeVisible();

      await player.getByRole("checkbox", { name: /Appear offline/ }).uncheck();
      await expect(player.getByText("Privacy settings saved.")).toBeVisible();

      // Chat (v0.4.4; on the chat bar since v0.5.1): SysOp writes from the profile in a window on
      // its bar; the message pops up beside the player's bell at once and counts on the player's
      // bar, whose friends list opens the conversation; the answer reaches SysOp's window without
      // a reload. Then the player reports SysOp's message.
      const hello = `Hello, rival! ${Date.now()}`;
      await sysop.getByRole("button", { name: "Message", exact: true }).click();
      const window = sysop.getByRole("region", { name: "Chat with rival" });
      await window.getByLabel("Write to rival").fill(hello);
      await window.getByLabel("Write to rival").press("Enter");
      await expect(
        window.getByRole("list", { name: "Messages with rival" }),
      ).toContainText(hello);
      const popup = player.getByRole("button", { name: new RegExp(hello) });
      await expect(popup).toBeVisible({ timeout: 15_000 });
      const bar = player.getByRole("complementary", {
        name: "Friends and messages",
      });
      await bar
        .getByRole("button", { name: /^Friends, .*unread messages?$/ })
        .click();
      await bar.getByRole("button", { name: /^Chat with sysop/ }).click();
      const thread = bar
        .getByRole("region", { name: "Chat with sysop" })
        .getByRole("list", { name: "Messages with sysop" });
      await expect(thread).toContainText(hello);
      const answer = `Hello, SysOp. ${Date.now()}`;
      await player.getByLabel("Write to sysop").fill(answer);
      await player.getByLabel("Write to sysop").press("Enter");
      await expect(thread).toContainText(answer);
      await expect(
        window.getByRole("list", { name: "Messages with rival" }),
      ).toContainText(answer, { timeout: 15_000 });
      await thread
        .getByRole("listitem")
        .filter({ hasText: hello })
        .getByRole("button", { name: /More about the message/ })
        .click();
      await player.getByRole("button", { name: "Report", exact: true }).click();
      const report = player.getByRole("dialog", { name: "Report a message" });
      await report.getByRole("button", { name: "Report the message" }).click();
      // Sent, the dialog is named by its thanks.
      const thanks = player.getByRole("dialog", {
        name: "Thank you. The message was reported.",
      });
      await expect(thanks).toBeVisible();
      await thanks.getByRole("button", { name: "Done" }).click();
      await window
        .getByRole("button", { name: "Close the chat with rival" })
        .click();

      // Back as it was, for a later run.
      await sysop.getByRole("button", { name: "Remove friend" }).click();
      await sysop.getByRole("button", { name: "Remove friend" }).click();
      await expect(
        sysop.getByRole("button", { name: "Add friend" }),
      ).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await Promise.all([sysopContext.close(), playerContext.close()]);
    }
  });
});
