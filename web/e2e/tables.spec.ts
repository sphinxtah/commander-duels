import { test, expect, type Page } from "@playwright/test";
import type { Snapshot } from "../src/game/types";

// A human table (v0.4.0) played in two browsers against the real engine: SysOp hosts a Legacy
// table, a player joins it by its invite link, both play a few turns, the player concedes, and both
// see the result, the winner with the tokens the win paid. Every WebSocket frame of each browser is
// checked for the other's concealed cards. It needs the engine, SysOp and a second account, which
// cannot sign in with Google: scripts/e2e_player.py makes one and prints its session token.
const sysopPassword = process.env.CD_E2E_SYSOP_PASSWORD;
const playerSession = process.env.CD_E2E_PLAYER_SESSION;
const gamesOn = process.env.CD_E2E_GAMES === "1";

const HOST_DECK = ["4 Lightning Bolt", "4 Hill Giant", "52 Mountain"];
const GUEST_DECK = ["60 Forest"];

/** One browser's game frames: the latest snapshot, and what no frame may carry. */
class Frames {
  latest: Snapshot | null = null;
  frames = 0;
  problems: string[] = [];
  readonly publicNames = new Set<string>();
  private readonly seen: { revision: number; text: string }[] = [];

  constructor(
    page: Page,
    private readonly mine: Set<string>,
    private readonly concealed: Set<string>,
  ) {
    page.on("websocket", (socket) => {
      // The game's socket; the chat's (v0.4.4) carries no game.
      if (!/\/games\/[^/]+\/events$/.test(socket.url())) return;
      socket.on("framereceived", ({ payload }) =>
        this.receive(String(payload)),
      );
    });
    page.on("pageerror", (error) =>
      this.problems.push(`page error: ${error.message}`),
    );
  }

  receive(frame: string) {
    this.frames += 1;
    for (const word of ["seat_token", "service_token", "X-Service-Token"])
      if (frame.includes(word)) this.problems.push(`a frame carries ${word}`);
    const message = JSON.parse(frame) as { type: string; snapshot?: Snapshot };
    if (message.type !== "snapshot" || !message.snapshot) return;
    const snapshot = message.snapshot;
    const view = snapshot.view;
    if (view) {
      for (const permanent of view.battlefield)
        if (permanent.card.name) this.publicNames.add(permanent.card.name);
      for (const item of view.stack)
        if (item.name) this.publicNames.add(item.name);
      for (const player of [...(view.you ? [view.you] : []), ...view.opponents])
        for (const card of [...player.graveyard, ...player.exile])
          if (card.name) this.publicNames.add(card.name);
      for (const group of view.revealed)
        for (const card of group.cards)
          if (card.name) this.publicNames.add(card.name);
      for (const card of view.hand)
        if (card.name && !this.mine.has(card.name))
          this.problems.push(`hand holds ${card.name}, not this seat's card`);
      // Since v0.5.0 every player carries `hand`, null at a human table but (v0.5.1) for a player
      // whose turn this seat controls, while the control lasts (rule 723.4): their entry names
      // this seat in controlled_by, and what the seat sees there it may name.
      for (const opponent of view.opponents) {
        const controlled =
          opponent.controlled_by != null &&
          opponent.controlled_by === view.seat;
        for (const key of ["hand", "library"])
          if (
            (opponent as unknown as Record<string, unknown>)[key] != null &&
            !(key === "hand" && controlled)
          )
            this.problems.push(`an opponent carries ${key}`);
        if (controlled)
          for (const card of opponent.hand ?? [])
            if (card.name) this.publicNames.add(card.name);
      }
    }
    // Checked at the end against every name that became public by then.
    this.seen.push({ revision: snapshot.revision, text: frame });
    if (!this.latest || snapshot.revision >= this.latest.revision)
      this.latest = snapshot;
  }

  /** No frame named a card only the other player held that never became public. */
  check(): string[] {
    const hidden = [...this.concealed].filter((n) => !this.publicNames.has(n));
    for (const { revision, text } of this.seen)
      for (const name of hidden)
        if (text.includes(`"${name}"`) || text.includes(` ${name} `))
          this.problems.push(`r${revision} names ${name}, never public`);
    return this.problems;
  }
}

async function signInSysop(page: Page) {
  await page.goto("/#sysop");
  await page.getByLabel("Password").fill(sysopPassword!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/#admin$/);
}

/** A deck of the account's own, through the deck builder's import. */
async function importDeck(page: Page, title: string, lines: string[]) {
  await page.goto("/#decks");
  await page.getByRole("button", { name: "Import a list" }).click();
  const importer = page.getByRole("dialog", { name: "Import a deck list" });
  await importer.getByRole("radio", { name: "Legacy" }).check();
  await importer.getByLabel("Deck list").fill(lines.join("\n"));
  await importer.getByRole("button", { name: "Preview" }).click();
  await importer.getByLabel("Deck name").fill(title);
  await importer.getByRole("button", { name: "Create the deck" }).click();
  await expect(page).toHaveURL(/#deck\/[0-9a-f-]{36}$/);
}

/** Answers this seat's prompts as a simple player (keep, play a land, pass, finish) until the
 * game reaches the turn or ends. */
async function playUntil(page: Page, frames: Frames, turn: number) {
  const panel = page.locator('section[aria-labelledby="prompt-title"]');
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const latest = frames.latest;
    if (latest?.result || (latest?.view?.turn ?? 0) >= turn) return;
    const prompt = latest?.status === "your_prompt" ? latest.prompt : null;
    const shown =
      prompt &&
      (await panel.getAttribute("data-prompt").catch(() => null)) ===
        prompt.id &&
      (await panel.getAttribute("data-revision").catch(() => null)) ===
        String(latest!.revision);
    if (!prompt || !shown) {
      await page.waitForTimeout(200);
      continue;
    }
    const pick =
      prompt.options.find((o) => o.action === "keep") ??
      prompt.options.find((o) => o.action === "play_land") ??
      prompt.options.find((o) => ["pass", "done", "yes"].includes(o.action)) ??
      prompt.options.find((o) => o.action !== "cancel") ??
      prompt.options[0];
    await page.locator(`[data-option="${pick.id}"]`).first().click();
    const revision = latest!.revision;
    await expect
      .poll(
        () =>
          (frames.latest?.revision ?? 0) > revision ||
          Boolean(frames.latest?.result),
        { timeout: 120_000 },
      )
      .toBe(true);
  }
  throw new Error(`The game did not reach turn ${turn}.`);
}

test.describe("a human table in two browsers", () => {
  test.skip(
    !gamesOn || !sysopPassword || !playerSession,
    "Needs the engine, SysOp and a second account: CD_E2E_GAMES=1, CD_E2E_SYSOP_PASSWORD and " +
      "CD_E2E_PLAYER_SESSION (scripts/e2e_player.py).",
  );
  test.setTimeout(10 * 60_000);
  test.use({ actionTimeout: 30_000 });

  test("two players open, join and play a Legacy table until one concedes", async ({
    browser,
  }, testInfo) => {
    const settings = {
      fullscreenOnStart: false,
      responseTimerSeconds: 0,
      animationSpeed: "faster",
      effectsVolume: 0,
      muted: true,
      painter: "auto",
    };
    const contexts = await Promise.all([
      browser.newContext({ viewport: { width: 1600, height: 900 } }),
      browser.newContext({ viewport: { width: 1600, height: 900 } }),
    ]);
    for (const context of contexts)
      await context.addInitScript((value) => {
        localStorage.setItem("cd.table.v1", value);
      }, JSON.stringify(settings));
    const [hostContext, guestContext] = contexts;
    const origin = new URL(testInfo.project.use.baseURL!).hostname;
    await guestContext.addCookies([
      {
        name: "cd_session",
        value: playerSession!,
        domain: origin,
        path: "/api",
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ]);
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const hostNames = new Set(["Lightning Bolt", "Hill Giant", "Mountain"]);
    const guestNames = new Set(["Forest"]);
    const hostFrames = new Frames(host, hostNames, guestNames);
    const guestFrames = new Frames(guest, guestNames, hostNames);
    const stamp = Date.now();
    try {
      // Each player brings a deck of their own: SysOp's from the catalog, the player's basic
      // lands, which every library holds without limit.
      await signInSysop(host);
      await importDeck(host, `Table host ${stamp}`, HOST_DECK);
      await importDeck(guest, `Table guest ${stamp}`, GUEST_DECK);

      // SysOp opens a public Legacy table and has its invite link.
      await host.goto("/#tables");
      await expect(
        host.getByRole("heading", { name: "Sit down with other players." }),
      ).toBeVisible();
      const form = host.getByRole("region", { name: "Open a table" });
      await form.getByRole("radio", { name: /^Legacy/ }).check();
      await form.getByLabel("Your deck").selectOption({
        label: `Table host ${stamp}`,
      });
      await form.getByRole("button", { name: "Open the table" }).click();
      await expect(host).toHaveURL(/#tables\/[A-Za-z0-9_-]{8,32}$/);
      const invite = await host.getByLabel("Invite link").inputValue();
      expect(invite).toMatch(/#tables\/[A-Za-z0-9_-]{8,32}$/);

      // The player finds it in the lobby, then follows the link and sits down.
      await guest.goto("/#tables");
      await expect(
        guest
          .getByRole("region", { name: "Open tables" })
          .getByRole("link", { name: "Join sysop's Legacy table" }),
      ).toBeVisible({ timeout: 15_000 });
      await guest.goto(invite);
      await expect(
        guest.getByRole("heading", { name: "Legacy table" }),
      ).toBeVisible();
      // Others see SysOp's handle, never its deck.
      await expect(guest.getByText(`Table host ${stamp}`)).toHaveCount(0);
      await guest.getByRole("button", { name: "Take a seat" }).click();
      await expect(
        guest.getByText(`Playing Table guest ${stamp}`),
      ).toBeVisible();
      await guest.getByRole("button", { name: "Ready" }).click();
      await expect(
        guest.getByRole("button", { name: "Not ready" }),
      ).toBeVisible();

      // The host starts when the player is ready; both go to the game.
      const start = host.getByRole("button", { name: "Start the game" });
      await expect(start).toBeEnabled({ timeout: 15_000 });
      await start.click();
      await expect(host).toHaveURL(/#game\/[0-9a-f-]{36}$/, {
        timeout: 30_000,
      });
      const gameId = host.url().split("#game/")[1];
      await expect(guest).toHaveURL(new RegExp(`#game/${gameId}$`), {
        timeout: 15_000,
      });
      for (const page of [host, guest])
        await expect(
          page.getByRole("heading", { level: 1, name: /Table game/ }),
        ).toBeAttached();

      // Each plays their own seat for a few turns.
      await Promise.all([
        playUntil(host, hostFrames, 3),
        playUntil(guest, guestFrames, 3),
      ]);
      expect(hostFrames.latest?.seat).toBe(0);
      expect(guestFrames.latest?.seat).toBe(1);
      // The player sees SysOp by handle at the table (the canvas paints it; the DOM layer names
      // it), and never its deck.
      await expect(
        guest
          .getByRole("region", { name: "Opponents" })
          .getByRole("article", { name: "sysop, seat 1" }),
      ).toBeAttached();
      await expect(guest.getByText(`Table host ${stamp}`)).toHaveCount(0);
      await host.screenshot({
        path: testInfo.outputPath("host.jpg"),
        type: "jpeg",
        quality: 80,
      });

      // The table's chat (v0.4.4): SysOp greets the table; the two make an alliance from the
      // plates; the player writes to their ally alone. Every frame stays under the leak check.
      const greeting = `Good luck! ${stamp}`;
      await host.getByRole("button", { name: /^Table chat/ }).click();
      const hostBox = host.getByRole("textbox", {
        name: "Message to the table",
      });
      await hostBox.fill(greeting);
      await hostBox.press("Enter");
      await expect(
        host.getByRole("list", { name: "Messages to the table" }),
      ).toContainText(greeting);
      await host.keyboard.press("Escape");
      await expect(
        guest.getByRole("button", { name: /^Table chat, 1 unread/ }),
      ).toBeVisible({ timeout: 15_000 });
      await host.getByRole("button", { name: "Alliance with rival" }).click();
      await host.getByRole("menuitem", { name: "Offer an alliance" }).click();
      await guest.getByRole("button", { name: "Alliance with sysop" }).click();
      await guest
        .getByRole("menuitem", { name: "Accept the alliance" })
        .click();
      await guest.getByRole("button", { name: /^Table chat/ }).click();
      const guestTable = guest.getByRole("list", {
        name: "Messages to the table",
      });
      await expect(guestTable).toContainText(greeting);
      await expect(guestTable).toContainText(/now allies/);
      const secret = `Just between us ${stamp}`;
      await guest.getByRole("tab", { name: /Allies/ }).click();
      const allyBox = guest.getByRole("textbox", {
        name: "Message to your allies",
      });
      await allyBox.fill(secret);
      await allyBox.press("Enter");
      await host.getByRole("button", { name: /^Table chat/ }).click();
      await host.getByRole("tab", { name: /Allies/ }).click();
      await expect(
        host.getByRole("list", { name: "Messages to allies" }),
      ).toContainText(secret, { timeout: 15_000 });
      await host.keyboard.press("Escape");
      await guest.keyboard.press("Escape");

      // The player concedes; both see the result at once (the engine does not wait for the
      // winner's next answer), and the winner what the win paid.
      await guest.getByRole("button", { name: "Game menu" }).click();
      await guest
        .getByRole("group", { name: "Game menu" })
        .getByRole("button", { name: "Concede" })
        .click();
      await expect(
        guest.getByRole("dialog", { name: "Concede this game?" }),
      ).toContainText("The other players play on without you.");
      await guest
        .getByRole("dialog", { name: "Concede this game?" })
        .getByRole("button", { name: "Concede" })
        .click();
      const won = host.getByRole("dialog", { name: "Victory" });
      await expect(won).toBeVisible({ timeout: 60_000 });
      await expect(won).toContainText("This game paid you 50 tokens.", {
        timeout: 30_000,
      });
      const lost = guest.getByRole("dialog", { name: "Defeat" });
      await expect(lost).toBeVisible({ timeout: 60_000 });
      await expect(lost).toContainText("sysop won in");
      await expect(lost).not.toContainText("tokens");
      await host.screenshot({
        path: testInfo.outputPath("result.jpg"),
        type: "jpeg",
        quality: 80,
      });
      const tokens = (await host.evaluate(async () =>
        (await fetch("/api/v1/me/tokens")).json(),
      )) as { entries: { kind: string; amount: number; opponent: string }[] };
      // Since v0.5.0 the win may also complete a quest or earn an achievement, entered after it.
      expect(
        tokens.entries.find((entry) => entry.kind === "human_win"),
      ).toMatchObject({
        kind: "human_win",
        amount: 50,
        opponent: "rival",
      });
      await expect(
        lost.getByRole("link", { name: "Back to the lobby" }),
      ).toHaveAttribute("href", "#tables");

      console.log(
        `[tables] game ${gameId}: host ${hostFrames.frames} frames, guest ${guestFrames.frames} frames, ` +
          `turn ${hostFrames.latest?.view?.turn}, result ${hostFrames.latest?.result?.kind}`,
      );
      expect(hostFrames.check()).toEqual([]);
      expect(guestFrames.check()).toEqual([]);
    } finally {
      // A failed journey's game is closed, so the next journeys find a table.
      await host
        .evaluate(async () => {
          const id = /#game\/([0-9a-f-]{36})/.exec(location.hash)?.[1];
          if (!id) return;
          const me = (await (await fetch("/api/v1/me")).json()) as {
            csrf_token: string;
          };
          await fetch(`/api/v1/games/${id}/close`, {
            method: "POST",
            headers: { "X-CSRF-Token": me.csrf_token },
          });
        })
        .catch(() => undefined);
      for (const context of contexts) await context.close();
    }
  });
});
