import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import type { Snapshot } from "../src/game/types";

// Team tables in several browsers against the real engine (v0.9.3), the journeys v0.5.1 and
// v0.8.7 left: a Two-Headed Giant table of four people, two teams of two, and a King's Table of two
// people and four bots. Each player opens the game in a browser of their own, plays a few turns,
// and sees what its seat may: a teammate's hand, a shared life total, the Kings and Generals; one
// side concedes and the other wins as a team. Every game frame is checked for the hands no seat may
// see. SysOp hosts; the others are made by scripts/e2e_player.py, whose session tokens come in
// CD_E2E_PLAYER_SESSION (rival) and CD_E2E_TEAM_SESSIONS (two more, comma-separated, CI's ogre and troll).
const sysopPassword = process.env.CD_E2E_SYSOP_PASSWORD;
const playerSession = process.env.CD_E2E_PLAYER_SESSION;
const teamSessions = (process.env.CD_E2E_TEAM_SESSIONS ?? "")
  .split(",")
  .map((token) => token.trim())
  .filter(Boolean);
const gamesOn = process.env.CD_E2E_GAMES === "1";

const SETTINGS = {
  fullscreenOnStart: false,
  responseTimerSeconds: 0,
  animationSpeed: "faster",
  effectsVolume: 0,
  muted: true,
  painter: "auto",
};

/** One browser's game frames: the latest snapshot, and anything its seat must not see. */
class Seat {
  latest: Snapshot | null = null;
  frames = 0;
  problems: string[] = [];
  /** Seats whose hand this seat saw (its teammate's, at Two-Headed Giant). */
  handsSeen = new Set<number>();

  constructor(
    readonly page: Page,
    readonly name: string,
    /** The seats whose hand this seat may see besides its own. */
    private readonly maySee: (seat: number) => boolean,
  ) {
    page.on("websocket", (socket) => {
      if (!/\/games\/[^/]+\/events$/.test(socket.url())) return;
      socket.on("framereceived", ({ payload }) =>
        this.receive(String(payload)),
      );
    });
    page.on("pageerror", (error) =>
      this.problems.push(`${name}: page error: ${error.message}`),
    );
  }

  receive(frame: string) {
    this.frames += 1;
    for (const word of ["seat_token", "service_token", "X-Service-Token"])
      if (frame.includes(word))
        this.problems.push(`${this.name}: a frame carries ${word}`);
    const message = JSON.parse(frame) as { type: string; snapshot?: Snapshot };
    if (message.type !== "snapshot" || !message.snapshot) return;
    const snapshot = message.snapshot;
    for (const other of snapshot.view?.opponents ?? []) {
      const raw = other as unknown as Record<string, unknown>;
      if (raw.library != null)
        this.problems.push(`${this.name}: seat ${other.seat}'s library`);
      if (other.hand == null) continue;
      const controlled =
        other.controlled_by != null &&
        other.controlled_by === snapshot.view?.seat;
      if (this.maySee(other.seat) || controlled) this.handsSeen.add(other.seat);
      else this.problems.push(`${this.name}: seat ${other.seat}'s hand`);
    }
    if (!this.latest || snapshot.revision >= this.latest.revision)
      this.latest = snapshot;
  }
}

async function contexts(browser: Browser, count: number) {
  const made: BrowserContext[] = [];
  for (let i = 0; i < count; i++) {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
    });
    await context.addInitScript((value) => {
      localStorage.setItem("cd.table.v1", value);
    }, JSON.stringify(SETTINGS));
    made.push(context);
  }
  return made;
}

/** Signs a generated player in by its session cookie. */
async function signIn(context: BrowserContext, token: string, base: string) {
  await context.addCookies([
    {
      name: "__Host-cd_session",
      value: token,
      domain: new URL(base).hostname,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
}

async function signInSysop(page: Page) {
  await page.goto("/#sysop");
  await page.getByLabel("Password").fill(sysopPassword!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/#admin$/);
}

/** A Legacy deck of the account's own, through the deck builder's import. */
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
  return page.url().split("#deck/")[1];
}

/** Answers this seat's prompts as a simple player until the game reaches the turn or ends. */
async function playUntil(seat: Seat, turn: number) {
  const panel = seat.page.locator('section[aria-labelledby="prompt-title"]');
  const deadline = Date.now() + 6 * 60_000;
  while (Date.now() < deadline) {
    const latest = seat.latest;
    if (latest?.result || (latest?.view?.turn ?? 0) >= turn) return;
    const prompt = latest?.status === "your_prompt" ? latest.prompt : null;
    const shown =
      prompt &&
      (await panel.getAttribute("data-prompt").catch(() => null)) ===
        prompt.id &&
      (await panel.getAttribute("data-revision").catch(() => null)) ===
        String(latest!.revision);
    if (!prompt || !shown) {
      await seat.page.waitForTimeout(200);
      continue;
    }
    const pick =
      prompt.options.find((o) => o.action === "keep") ??
      prompt.options.find((o) => o.action === "play_land") ??
      prompt.options.find((o) => ["pass", "done", "yes"].includes(o.action)) ??
      prompt.options.find((o) => o.action !== "cancel") ??
      prompt.options[0];
    await seat.page.locator(`[data-option="${pick.id}"]`).first().click();
    const revision = latest!.revision;
    await expect
      .poll(
        () =>
          (seat.latest?.revision ?? 0) > revision ||
          Boolean(seat.latest?.result),
        { timeout: 120_000 },
      )
      .toBe(true);
  }
  throw new Error(`${seat.name}: the game did not reach turn ${turn}.`);
}

async function concede(page: Page) {
  await page.getByRole("button", { name: "Game menu" }).click();
  await page
    .getByRole("group", { name: "Game menu" })
    .getByRole("button", { name: "Concede" })
    .click();
  await page
    .getByRole("dialog", { name: "Concede this game?" })
    .getByRole("button", { name: "Concede" })
    .click();
}

/** Closes a failed journey's game, so the next journeys find a free engine. */
async function closeGame(page: Page) {
  await page
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
}

test.describe("team tables in several browsers", () => {
  test.setTimeout(15 * 60_000);
  test.use({ actionTimeout: 30_000 });

  test("Two-Headed Giant with four people: one life a team, the teammate's hand, a concession for the team", async ({
    browser,
  }, testInfo) => {
    test.skip(
      !gamesOn || !sysopPassword || !playerSession || teamSessions.length < 2,
      "Needs the engine, SysOp and three more accounts: CD_E2E_GAMES=1, CD_E2E_SYSOP_PASSWORD, " +
        "CD_E2E_PLAYER_SESSION and CD_E2E_TEAM_SESSIONS (scripts/e2e_player.py).",
    );
    const base = testInfo.project.use.baseURL!;
    const made = await contexts(browser, 4);
    const [hostContext, mateContext, leftContext, rightContext] = made;
    await signIn(mateContext, playerSession!, base);
    await signIn(leftContext, teamSessions[0], base);
    await signIn(rightContext, teamSessions[1], base);
    const pages = await Promise.all(made.map((context) => context.newPage()));
    const [host, mate, left, right] = pages;
    const stamp = Date.now();
    // Each team's decks share only basic lands (810.2b): every deck is one basic land.
    const decks: [Page, string, string][] = [
      [host, `2HG host ${stamp}`, "60 Mountain"],
      [mate, `2HG mate ${stamp}`, "60 Plains"],
      [left, `2HG left ${stamp}`, "60 Forest"],
      [right, `2HG right ${stamp}`, "60 Island"],
    ];
    try {
      await signInSysop(host);
      for (const [page, title, line] of decks)
        await importDeck(page, title, [line]);

      // SysOp opens a Two-Headed Giant table for four people, and sits in Team 1.
      await host.goto("/#tables");
      await host
        .getByRole("button", { name: "Open a table", exact: true })
        .click();
      const form = host.getByRole("region", { name: "Open a table" });
      await form.getByRole("radio", { name: /^Two-Headed Giant/ }).check();
      await form
        .getByLabel("Your deck")
        .selectOption({ label: `2HG host ${stamp}` });
      await form.getByRole("button", { name: "Open the table" }).click();
      await expect(host).toHaveURL(/#tables\/[A-Za-z0-9_-]{8,32}$/);
      const invite = await host.getByLabel("Invite link").inputValue();

      // The teammate joins Team 1; the other two, Team 2. Each gets ready.
      for (const [page, team, title] of [
        [mate, "Team 1", `2HG mate ${stamp}`],
        [left, "Team 2", `2HG left ${stamp}`],
        [right, "Team 2", `2HG right ${stamp}`],
      ] as const) {
        await page.goto(invite);
        await expect(
          page.getByRole("heading", { name: "Two-Headed Giant table" }),
        ).toBeVisible();
        await page.getByLabel("Your deck").selectOption({ label: title });
        await page.getByRole("button", { name: `Join ${team}` }).click();
        await expect(
          page
            .getByRole("region", { name: new RegExp(`^${team}`) })
            .getByText("Your team"),
        ).toBeVisible();
        await page.getByRole("button", { name: "Ready" }).click();
        await expect(
          page.getByRole("button", { name: "Not ready" }),
        ).toBeVisible();
      }

      const start = host.getByRole("button", { name: "Start the game" });
      await expect(start).toBeEnabled({ timeout: 20_000 });
      await start.click();
      await expect(host).toHaveURL(/#game\/[0-9a-f-]{36}$/, {
        timeout: 30_000,
      });
      const gameId = host.url().split("#game/")[1];
      for (const page of [mate, left, right])
        await expect(page).toHaveURL(new RegExp(`#game/${gameId}$`), {
          timeout: 20_000,
        });

      // Seats 0 and 1 are Team 1, 2 and 3 Team 2: a teammate's hand is the only other one seen.
      const teammate = (seat: number) => (seat < 2 ? 1 - seat : 5 - seat);
      const seats = [host, mate, left, right].map(
        (page, index) =>
          new Seat(
            page,
            ["host", "mate", "left", "right"][index],
            (other) => other === teammate(index),
          ),
      );
      for (const seat of seats) await seat.page.reload();
      await Promise.all(seats.map((seat) => playUntil(seat, 3)));
      for (const [index, seat] of seats.entries()) {
        const view = seat.latest!.view!;
        expect(view.seat).toBe(index);
        const mateView = view.opponents.find(
          (other) => other.seat === teammate(index),
        )!;
        // One life total a team (810.4); the teammate's hand is open to its team (810.5).
        expect(mateView.life).toBe(view.you!.life);
        expect(seat.handsSeen.has(teammate(index))).toBe(true);
      }
      await host.screenshot({
        path: testInfo.outputPath("two-headed-giant.jpg"),
        type: "jpeg",
        quality: 80,
      });

      // One player of Team 2 concedes: their team leaves the game (810.8b), and Team 1 wins
      // together at once, though neither winner answers anything.
      await concede(left);
      for (const page of [host, mate])
        await expect(page.getByRole("dialog", { name: "Victory" })).toBeVisible(
          { timeout: 90_000 },
        );
      for (const page of [left, right])
        await expect(page.getByRole("dialog", { name: "Defeat" })).toBeVisible({
          timeout: 90_000,
        });
      console.log(
        `[2hg] game ${gameId}: ${seats.map((s) => `${s.name} ${s.frames}`).join(", ")} frames, ` +
          `turn ${seats[0].latest?.view?.turn}, result ${seats[0].latest?.result?.kind}`,
      );
      expect(seats.flatMap((seat) => seat.problems)).toEqual([]);
    } finally {
      await closeGame(host);
      for (const context of made) await context.close();
    }
  });

  test("King's Table with two people and four bots: the Kings and Generals, a King's concession", async ({
    browser,
  }, testInfo) => {
    test.skip(
      !gamesOn || !sysopPassword || !playerSession,
      "Needs the engine, SysOp and a second account: CD_E2E_GAMES=1, CD_E2E_SYSOP_PASSWORD and " +
        "CD_E2E_PLAYER_SESSION (scripts/e2e_player.py).",
    );
    const base = testInfo.project.use.baseURL!;
    const made = await contexts(browser, 2);
    const [hostContext, guestContext] = made;
    await signIn(guestContext, playerSession!, base);
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    const stamp = Date.now();
    try {
      await signInSysop(host);
      const hostDeck = await importDeck(host, `King A ${stamp}`, [
        "60 Mountain",
      ]);
      await importDeck(guest, `King B ${stamp}`, ["60 Forest"]);

      // SysOp opens a King's Table of Legacy decks as Team A's King (seat 1), bots in four seats,
      // leaving Team B's King (seat 4) for the player.
      const code = await host.evaluate(async (deckId) => {
        const me = (await (await fetch("/api/v1/me")).json()) as {
          csrf_token: string;
        };
        const answer = await fetch("/api/v1/tables", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": me.csrf_token,
          },
          body: JSON.stringify({
            format: "kings_table",
            seats: 6,
            bots: 4,
            bot_skill: 1,
            turn_cap: 60,
            visibility: "private",
            deck_id: deckId,
            seat: 1,
            bot_seats: [0, 2, 3, 5],
            kings_table: {
              deck_format: "legacy",
              life: "all_40",
              king_attacks_anyone: true,
            },
          }),
        });
        const body = (await answer.json()) as { code?: string };
        if (!answer.ok) throw new Error(JSON.stringify(body));
        return body.code!;
      }, hostDeck);
      await host.goto(`/#tables/${code}`);
      await expect(
        host.getByRole("heading", { name: "King's Table table" }),
      ).toBeVisible();

      await guest.goto(`/#tables/${code}`);
      await guest
        .getByLabel("Your deck")
        .selectOption({ label: `King B ${stamp}` });
      await guest
        .getByRole("button", { name: "Take the first open seat" })
        .click();
      await guest.getByRole("button", { name: "Ready" }).click();
      await expect(
        guest.getByRole("button", { name: "Not ready" }),
      ).toBeVisible();
      const start = host.getByRole("button", { name: "Start the game" });
      await expect(start).toBeEnabled({ timeout: 20_000 });
      await start.click();
      await expect(host).toHaveURL(/#game\/[0-9a-f-]{36}$/, {
        timeout: 30_000,
      });
      const gameId = host.url().split("#game/")[1];
      await expect(guest).toHaveURL(new RegExp(`#game/${gameId}$`), {
        timeout: 20_000,
      });
      // Teammates may look at each other's hands (King's Table's rules): seats 0 to 2 are Team A,
      // 3 to 5 Team B; no other hand reaches either King.
      const team = (seat: number) => (seat < 3 ? 0 : 1);
      const seats = [
        new Seat(host, "King A", (other) => team(other) === 0),
        new Seat(guest, "King B", (other) => team(other) === 1),
      ];
      for (const seat of seats) await seat.page.reload();
      await Promise.all(seats.map((seat) => playUntil(seat, 3)));
      expect(seats[0].latest!.view!.seat).toBe(1);
      expect(seats[1].latest!.view!.seat).toBe(4);
      expect([...seats[0].handsSeen].sort()).toEqual([0, 2]);
      expect([...seats[1].handsSeen].sort()).toEqual([3, 5]);
      await host.screenshot({
        path: testInfo.outputPath("kings-table.jpg"),
        type: "jpeg",
        quality: 80,
      });

      // Team B's King concedes: Team A wins at once, its bots with it.
      await concede(guest);
      await expect(host.getByRole("dialog", { name: "Victory" })).toBeVisible({
        timeout: 120_000,
      });
      await expect(guest.getByRole("dialog", { name: "Defeat" })).toBeVisible({
        timeout: 120_000,
      });
      const result = seats[0].latest?.result as
        | { winner_team?: number | null }
        | undefined;
      expect(result?.winner_team).toBe(0);
      console.log(
        `[kings] game ${gameId}: ${seats.map((s) => `${s.name} ${s.frames}`).join(", ")} frames, ` +
          `turn ${seats[0].latest?.view?.turn}`,
      );
      expect(seats.flatMap((seat) => seat.problems)).toEqual([]);
    } finally {
      await closeGame(host);
      for (const context of made) await context.close();
    }
  });
});
