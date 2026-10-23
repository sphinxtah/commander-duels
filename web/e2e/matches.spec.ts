import { test, expect, type Page } from "@playwright/test";
import type { Snapshot } from "../src/game/types";

// A best-of-three Legacy match (v0.5.0) against the bot, with the real engine: SysOp starts a
// match with a deck that has a sideboard, concedes the first game, follows the game screen on to
// sideboarding, swaps a card in, chooses to play first as the loser and is ready; the second game
// starts with SysOp's seat taking the first turn, nobody asked who starts. Then SysOp concedes
// the match from the Game menu, and the match page says how it ended. It needs the engine and
// SysOp, as the practice game journeys do.
const sysopPassword = process.env.CD_E2E_SYSOP_PASSWORD;
const gamesOn = process.env.CD_E2E_GAMES === "1";

const DECK = [
  "4 Lightning Bolt",
  "4 Hill Giant",
  "52 Mountain",
  "",
  "Sideboard",
  "3 Grizzly Bears",
];

/** The game's frames: every snapshot, and the prompts the seat was asked. */
class Frames {
  latest: Snapshot | null = null;
  prompts: string[] = [];
  problems: string[] = [];

  constructor(page: Page) {
    page.on("websocket", (socket) => {
      if (!/\/games\/[^/]+\/events$/.test(socket.url())) return;
      socket.on("framereceived", ({ payload }) => {
        const text = String(payload);
        for (const word of ["seat_token", "service_token", "X-Service-Token"])
          if (text.includes(word))
            this.problems.push(`a frame carries ${word}`);
        const message = JSON.parse(text) as {
          type: string;
          snapshot?: Snapshot;
        };
        if (message.type !== "snapshot" || !message.snapshot) return;
        const snapshot = message.snapshot;
        if (snapshot.prompt)
          this.prompts.push(
            `${snapshot.prompt.kind}: ${snapshot.prompt.message}`,
          );
        if (!this.latest || snapshot.revision >= this.latest.revision)
          this.latest = snapshot;
      });
    });
    page.on("pageerror", (error) =>
      this.problems.push(`page error: ${error.message}`),
    );
  }

  reset() {
    this.latest = null;
    this.prompts = [];
  }
}

async function concedeFromMenu(page: Page, item: string) {
  await page.getByRole("button", { name: "Game menu" }).click();
  await page
    .getByRole("group", { name: "Game menu" })
    .getByRole("button", { name: item })
    .click();
}

test.describe("a best-of-three match in the browser", () => {
  test.skip(
    !gamesOn || !sysopPassword,
    "Needs the engine and SysOp: CD_E2E_GAMES=1 and CD_E2E_SYSOP_PASSWORD.",
  );
  test.setTimeout(8 * 60_000);
  test.use({ actionTimeout: 30_000, viewport: { width: 1600, height: 900 } });

  test("concedes a game, sideboards, plays first as the loser and concedes the match", async ({
    page,
  }, testInfo) => {
    await page.addInitScript(
      (value) => {
        localStorage.setItem("cd.table.v1", value);
      },
      JSON.stringify({
        fullscreenOnStart: false,
        responseTimerSeconds: 0,
        animationSpeed: "faster",
        effectsVolume: 0,
        muted: true,
        painter: "auto",
      }),
    );
    const frames = new Frames(page);
    const stamp = Date.now();
    try {
      await page.goto("/#sysop");
      await page.getByLabel("Password").fill(sysopPassword!);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page).toHaveURL(/#admin$/);

      // A Legacy deck with a sideboard, through the deck builder's import.
      await page.goto("/#decks");
      await page.getByRole("button", { name: "Import a list" }).click();
      const importer = page.getByRole("dialog", { name: "Import a deck list" });
      await importer.getByRole("radio", { name: "Legacy" }).check();
      await importer.getByLabel("Deck list").fill(DECK.join("\n"));
      await importer.getByRole("button", { name: "Preview" }).click();
      await importer.getByLabel("Deck name").fill(`Match ${stamp}`);
      await importer.getByRole("button", { name: "Create the deck" }).click();
      await expect(page).toHaveURL(/#deck\/[0-9a-f-]{36}$/);
      await expect(
        page.getByRole("region", { name: "Sideboard" }),
      ).toContainText("Grizzly Bears");

      // Best of three at the practice table.
      await page.goto("/#play");
      const table = page.getByRole("region", {
        name: "Sit down against the bots",
      });
      await table.getByRole("radio", { name: /Legacy/ }).check();
      await table.getByRole("radio", { name: /^Best of three/ }).check();
      await table
        .getByLabel("Your deck")
        .selectOption({ label: `Match ${stamp}` });
      await table.getByLabel(/Bot skill/).fill("1");
      await table.getByRole("button", { name: "Start the game" }).click();
      await expect(page).toHaveURL(/#game\/[0-9a-f-]{36}$/, {
        timeout: 30_000,
      });
      const first = page.url().split("#game/")[1];
      await expect(page.getByText("Game 1 · 0–0")).toBeVisible({
        timeout: 30_000,
      });

      // Conceding the game loses it; the match goes on to sideboarding by itself.
      await expect
        .poll(() => frames.latest?.status, { timeout: 60_000 })
        .toBe("your_prompt");
      await concedeFromMenu(page, "Concede the game");
      const asked = page.getByRole("dialog", { name: "Concede this game?" });
      await expect(asked).toContainText("The match goes on to its next game.");
      await asked.getByRole("button", { name: "Concede" }).click();
      const lost = page.getByRole("dialog", { name: "Defeat" });
      await expect(lost).toBeVisible({ timeout: 60_000 });
      await expect(lost).toContainText("Match 0–1.", { timeout: 30_000 });
      await expect(page).toHaveURL(/#match\/[0-9a-f-]{36}$/, {
        timeout: 30_000,
      });
      const sideboarding = page.getByRole("region", {
        name: "Sideboard for game 2",
      });
      await expect(sideboarding).toBeVisible();

      // One Bear in for one Bolt; as the loser, SysOp plays first.
      await sideboarding
        .getByRole("button", {
          name: "Move one Lightning Bolt to the sideboard",
        })
        .click();
      await expect(sideboarding).toContainText("Legacy needs at least 60");
      await sideboarding
        .getByRole("button", {
          name: "Move one Grizzly Bears to the main deck",
        })
        .click();
      await expect(
        sideboarding.getByText("Saved", { exact: true }),
      ).toBeVisible({
        timeout: 15_000,
      });
      await sideboarding.getByRole("radio", { name: /Play first/ }).check();
      frames.reset();
      await sideboarding
        .getByRole("button", { name: "Ready for game 2" })
        .click();
      await expect(page).toHaveURL(/#game\/[0-9a-f-]{36}$/, {
        timeout: 30_000,
      });
      const second = page.url().split("#game/")[1];
      expect(second).not.toBe(first);
      await expect(page.getByText("Game 2 · 0–1")).toBeVisible({
        timeout: 30_000,
      });

      // The loser's choice: SysOp's seat takes the first turn, and nobody is asked who starts.
      await expect
        .poll(() => frames.latest?.prompt?.kind, { timeout: 60_000 })
        .toBe("mulligan");
      const keep = frames.latest!.prompt!.options.find(
        (o) => o.action === "keep",
      )!;
      await page.locator(`[data-option="${keep.id}"]`).first().click();
      await expect
        .poll(() => frames.latest?.view?.active_seat ?? null, {
          timeout: 120_000,
        })
        .not.toBeNull();
      expect(frames.latest?.view?.active_seat).toBe(0);
      expect(frames.prompts.filter((p) => /starting player/.test(p))).toEqual(
        [],
      );

      // Conceding the match concedes this game too, and the match is the bot's.
      await concedeFromMenu(page, "Concede the match");
      const conceding = page.getByRole("dialog", {
        name: "Concede the match?",
      });
      await conceding
        .getByRole("button", { name: "Concede the match" })
        .click();
      const over = page.getByRole("dialog", { name: "Defeat" });
      await expect(over).toContainText("You lost the match, 0–2.", {
        timeout: 60_000,
      });
      await over.getByRole("link", { name: "To the match" }).click();
      await expect(
        page.getByText(/The bot won the match, 0–2\. You conceded it\./),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("match.jpg"),
        type: "jpeg",
        quality: 80,
      });
      expect(frames.problems).toEqual([]);
    } finally {
      // A failed journey's match is conceded, so the next journeys find a game slot.
      await page
        .evaluate(async () => {
          const me = (await (await fetch("/api/v1/me")).json()) as {
            csrf_token: string;
          };
          const matches = (await (await fetch("/api/v1/matches")).json()) as {
            id: string;
            status: string;
          }[];
          for (const match of matches)
            if (match.status === "playing" || match.status === "sideboarding")
              await fetch(`/api/v1/matches/${match.id}/concede`, {
                method: "POST",
                headers: { "X-CSRF-Token": me.csrf_token },
              });
        })
        .catch(() => undefined);
    }
  });
});
