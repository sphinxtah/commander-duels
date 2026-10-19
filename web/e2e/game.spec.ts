import { readFileSync } from "node:fs";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import type {
  GameView,
  Prompt,
  PromptOption,
  Snapshot,
} from "../src/game/types";

// Practice games played through the game screen against the real engine: by mouse, by keyboard,
// from a second tab and across a dropped connection. They need the engine, the API and SysOp
// (CI's engine job runs them against Compose with CD_E2E_GAMES=1).
const sysopPassword = process.env.CD_E2E_SYSOP_PASSWORD;
const gamesOn = process.env.CD_E2E_GAMES === "1";

function deckNames(deck: string): Set<string> {
  const text = readFileSync(
    new URL(`../../engine/decks/${deck}.txt`, import.meta.url),
    "utf8",
  );
  return new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("//"))
      .map((line) => line.replace(/^SB:\s*/, "").replace(/^\d+\s+/, "")),
  );
}

/** Watches one page's game WebSockets: every snapshot, and a leak check on each frame. */
class Table {
  latest: Snapshot | null = null;
  snapshots = 0;
  frames = 0;
  problems: string[] = [];
  results: { action_id: string; status: number; body: unknown }[] = [];
  readonly publicNames = new Set<string>();

  /** Without a page, frames are fed to receive() by the test (a proxied socket). */
  constructor(
    page: Page | null,
    private readonly mine: Set<string>,
    private readonly concealed: Set<string>,
  ) {
    page?.on("websocket", (socket) => {
      if (!socket.url().includes("/events")) return;
      socket.on("framereceived", ({ payload }) =>
        this.receive(String(payload)),
      );
    });
  }

  receive(frame: string) {
    this.frames += 1;
    for (const word of ["seat_token", "service_token", "X-Service-Token"])
      if (frame.includes(word)) this.problems.push(`a frame carries ${word}`);
    const message = JSON.parse(frame) as {
      type: string;
      snapshot?: Snapshot;
      action_id?: string;
      status?: number;
      body?: unknown;
    };
    if (message.type === "command_result")
      this.results.push({
        action_id: message.action_id ?? "",
        status: message.status ?? 0,
        body: message.body,
      });
    if (message.type !== "snapshot" || !message.snapshot) return;
    const snapshot = message.snapshot;
    this.snapshots += 1;
    const view = snapshot.view;
    if (view) {
      // Everything public in this snapshot may be named from now on.
      for (const permanent of view.battlefield)
        if (permanent.card.name) this.publicNames.add(permanent.card.name);
      for (const item of view.stack)
        if (item.name) this.publicNames.add(item.name);
      for (const player of [...(view.you ? [view.you] : []), ...view.opponents])
        for (const card of [
          ...player.graveyard,
          ...player.exile,
          ...player.command_zone,
        ])
          if (card.name) this.publicNames.add(card.name);
      for (const group of view.revealed)
        for (const card of group.cards)
          if (card.name) this.publicNames.add(card.name);
      // T13 in the browser: the seat's hand is its own, opponents carry counts only, and no
      // card only another seat's deck holds is named before it has been public.
      for (const card of view.hand)
        if (card.name && !this.mine.has(card.name))
          this.problems.push(
            `hand holds ${card.name}, not in this seat's deck`,
          );
      for (const opponent of view.opponents)
        for (const key of ["hand", "library"])
          if (key in opponent) this.problems.push(`an opponent carries ${key}`);
    }
    // As the engine's own check: a concealed name may not be a card's or an option's name, nor a
    // phrase in the log or the prompt, before it has been public. Type lines and rules text are
    // not checked, because a subtype can equal a card name.
    for (const [key, text] of strings(snapshot)) {
      for (const name of this.concealed) {
        if (this.publicNames.has(name)) continue;
        const named =
          key === "name" || key === "label"
            ? text === name
            : ["text", "message", "detail", "messages"].includes(key) &&
              new RegExp(`\\b${escapeRegExp(name)}\\b`).test(text);
        if (named)
          this.problems.push(
            `${name} was named in ${key} before it was public (r${snapshot.revision})`,
          );
      }
    }
    if (
      !this.latest ||
      snapshot.revision >= this.latest.revision ||
      snapshot.result
    )
      this.latest = snapshot;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every string in a value, with the key it sits under (array items keep their array's key). */
function strings(
  value: unknown,
  key = "",
  out: [string, string][] = [],
): [string, string][] {
  if (typeof value === "string") out.push([key, value]);
  else if (Array.isArray(value))
    for (const item of value) strings(item, key, out);
  else if (value && typeof value === "object")
    for (const [name, item] of Object.entries(value)) {
      // Only an object option's label names a card; other labels are XMage's button words
      // ("Cancel" is also a card).
      if (name === "label" && "object_id" in value && !value.object_id)
        continue;
      strings(item, name, out);
    }
  return out;
}

async function signInSysop(page: Page) {
  await page.goto("/#sysop");
  await page.getByLabel("Password").fill(sysopPassword!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/#admin$/);
}

async function startGame(
  page: Page,
  options: {
    format: "Legacy" | "Commander";
    deck: string;
    bots?: number;
    turnCap: number;
  },
): Promise<string> {
  await page.goto("/#play");
  const table = page.getByRole("region", { name: "Sit down against the bots" });
  await table.getByRole("radio", { name: new RegExp(options.format) }).check();
  await table.getByLabel("Your deck").selectOption(options.deck);
  if (options.bots)
    await table
      .getByLabel("Bots", { exact: true })
      .selectOption(String(options.bots));
  await table.getByLabel(/Bot skill/).fill("1");
  await table.getByLabel("Turn limit").fill(String(options.turnCap));
  await table.getByRole("button", { name: "Start the game" }).click();
  await expect(page).toHaveURL(/#game\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  return page.url().split("#game/")[1];
}

/** A simple player: keep, play lands, cast what it can at the opponents, attack with everything
 * once, never block, and accept the engine's suggestions. Like a person, it does not cast a spell
 * again in the same turn after cancelling its payment, and it passes, finishes or cancels a prompt
 * that keeps coming back unchanged. */
class Player {
  private avoid = new Set<string>();
  private turn = -1;
  private casting: string | null = null;
  private lastKey = "";
  private repeats = 0;
  /** The last answers, for a failure's message. */
  readonly recent: string[] = [];

  choose(
    prompt: Prompt,
    view: GameView | null,
    seat: number,
  ): PromptOption | "amounts" {
    const turn = view?.turn ?? 0;
    if (turn !== this.turn) {
      this.turn = turn;
      this.avoid.clear();
    }
    const key = `${prompt.kind}|${prompt.message}|${prompt.options
      .map((o) => `${o.action}:${o.object_id ?? o.seat ?? ""}`)
      .join(",")}`;
    this.repeats = key === this.lastKey ? this.repeats + 1 : 0;
    this.lastKey = key;
    let choice = this.pick(prompt, seat);
    if (this.repeats >= 8)
      choice = firstOf(prompt, "pass", "done", "cancel", "no") ?? choice;
    if (choice !== "amounts") {
      if (choice.action === "cast" || choice.action === "activate")
        this.casting = choice.object_id;
      if (choice.action === "cancel" && this.casting)
        this.avoid.add(this.casting);
    }
    this.recent.push(
      `T${turn} ${prompt.kind} "${prompt.message}" -> ${
        choice === "amounts"
          ? "amounts"
          : `${choice.action} ${choice.label ?? choice.object_id ?? ""}`
      }`,
    );
    if (this.recent.length > 12) this.recent.shift();
    return choice;
  }

  private pick(prompt: Prompt, seat: number): PromptOption | "amounts" {
    const by = (action: PromptOption["action"]) =>
      prompt.options.filter((option) => option.action === action);
    const first = (...actions: PromptOption["action"][]) =>
      firstOf(prompt, ...actions);
    switch (prompt.kind) {
      case "mulligan":
        return first("keep")!;
      case "priority":
        return (
          first("play_land") ??
          by("cast").find((o) => !this.avoid.has(o.object_id ?? "")) ??
          first("pass") ??
          prompt.options[0]
        );
      case "choose_target":
      case "choose_defender": {
        const choices = by("choose").filter((o) => !o.selected);
        const theirs = choices.find((o) => o.seat !== null && o.seat !== seat);
        return theirs ?? choices[0] ?? first("done") ?? prompt.options[0];
      }
      case "pay_mana":
        return first("tap_source", "use_pool") ?? prompt.options[0];
      case "declare_attackers":
        return prompt.options.some((o) => o.selected)
          ? (first("done") ?? prompt.options[0])
          : (first("all_attack", "done") ?? prompt.options[0]);
      case "declare_blockers":
        return first("done") ?? prompt.options[0];
      case "assign_amounts":
      case "choose_amount":
        return "amounts";
      case "yes_no":
        return first("yes") ?? prompt.options[0];
      default:
        return (
          prompt.options.find((o) => o.action !== "cancel") ?? prompt.options[0]
        );
    }
  }
}

function firstOf(
  prompt: Prompt,
  ...actions: PromptOption["action"][]
): PromptOption | undefined {
  for (const action of actions) {
    const found = prompt.options.find((option) => option.action === action);
    if (found) return found;
  }
  return undefined;
}

/** Plays the seat until the game ends. Mouse: cards on the board and buttons. Keyboard: focus and
 * Enter, and P for the primary option. Returns the last snapshot and the prompts answered. */
async function play(
  page: Page,
  table: Table,
  mode: "mouse" | "keyboard",
  beforeAnswer?: (snapshot: Snapshot) => Promise<void>,
) {
  const kinds: Record<string, number> = {};
  const player = new Player();
  let answered = 0;
  for (let step = 0; step < 600; step += 1) {
    await expect
      .poll(() => Boolean(table.latest?.prompt || table.latest?.result), {
        timeout: 120_000,
      })
      .toBe(true);
    const snapshot = table.latest!;
    if (snapshot.result) return { snapshot, answered, kinds };
    await beforeAnswer?.(snapshot);
    const prompt = snapshot.prompt!;
    kinds[prompt.kind] = (kinds[prompt.kind] ?? 0) + 1;
    if (prompt.kind === "unsupported") {
      await page.getByRole("button", { name: "Concede" }).first().click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Concede" })
        .click();
    } else {
      const choice = player.choose(prompt, snapshot.view, snapshot.seat ?? 0);
      if (choice === "amounts") {
        const confirm = page.locator("[data-amounts]");
        if (mode === "keyboard") {
          await confirm.focus();
          await page.keyboard.press("Enter");
        } else await confirm.click();
      } else {
        const primary = ["pass", "done", "keep", "yes"].includes(choice.action);
        const card = choice.object_id
          ? page.locator(`[data-card="${choice.object_id}"]`).first()
          : null;
        const onBoard =
          card &&
          (await card.count()) > 0 &&
          prompt.options.filter((o) => o.object_id === choice.object_id)
            .length === 1;
        const button = page.locator(`[data-option="${choice.id}"]`).first();
        if (mode === "keyboard") {
          if (primary && (await button.getAttribute("data-first")) !== null) {
            await page
              .locator("main, body")
              .first()
              .focus()
              .catch(() => undefined);
            await expect(button).toBeEnabled();
            await page.keyboard.press("p");
          } else if (onBoard) {
            await expect(card!).toBeVisible();
            await card!.focus();
            await page.keyboard.press("Enter");
          } else {
            await expect(button).toBeEnabled();
            await button.focus();
            await page.keyboard.press("Enter");
          }
        } else if (onBoard) {
          await card!.click();
        } else {
          await button.click();
        }
      }
    }
    answered += 1;
    // The next prompt is a new revision; a refusal leaves the old one open and is retried.
    const revision = snapshot.revision;
    await expect
      .poll(
        () =>
          (table.latest?.revision ?? 0) > revision ||
          Boolean(table.latest?.result) ||
          table.results.some((r) => r.status !== 200),
        { timeout: 120_000 },
      )
      .toBe(true);
    table.results = table.results.filter((r) => r.status === 200);
  }
  throw new Error(
    `The game did not end within 600 prompts (${JSON.stringify(kinds)}). Last answers: ${player.recent.join(" | ")}`,
  );
}

function note(
  testInfo: { annotations: { type: string; description?: string }[] },
  text: string,
) {
  testInfo.annotations.push({ type: "game", description: text });
  console.log(`[game] ${text}`);
}

async function noHorizontalScroll(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

test.describe("practice games in the browser", () => {
  test.skip(
    !gamesOn || !sysopPassword,
    "Needs the engine: set CD_E2E_GAMES=1 and CD_E2E_SYSOP_PASSWORD.",
  );
  test.setTimeout(15 * 60_000);
  // A missing control fails the step instead of waiting out the whole game's time.
  test.use({ actionTimeout: 30_000 });

  test("a Legacy game played to the end by mouse, with no concealed card in any payload", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    const mine = deckNames("legacy-mono-red-burn");
    const theirs = deckNames("legacy-mono-green-creatures");
    const table = new Table(
      page,
      mine,
      new Set([...theirs].filter((n) => !mine.has(n))),
    );
    await signInSysop(page);
    await startGame(page, {
      format: "Legacy",
      deck: "legacy-mono-red-burn",
      turnCap: 20,
    });
    await expect(page.getByRole("note")).toContainText(
      "bots still read your hand",
    );
    // On the third turn, the board at each size the scope names, between two answers.
    let shot = false;
    const { snapshot, answered, kinds } = await play(
      page,
      table,
      "mouse",
      async (now) => {
        if (shot || (now.view?.turn ?? 0) < 3) return;
        shot = true;
        for (const [width, height] of [
          [1920, 1080],
          [1366, 768],
          [390, 844],
        ]) {
          await page.setViewportSize({ width, height });
          await noHorizontalScroll(page);
          await page.screenshot({
            path: testInfo.outputPath(`game-${width}.png`),
          });
        }
        await page.setViewportSize({ width: 1920, height: 1080 });
      },
    );
    note(
      testInfo,
      `${snapshot.result!.kind} after ${snapshot.result!.turns} turns; ${answered} prompts by mouse (${JSON.stringify(kinds)}); ${table.snapshots} snapshots in ${table.frames} frames`,
    );
    expect(table.problems).toEqual([]);
    expect(answered).toBeGreaterThan(5);
    await expect(
      page.getByRole("dialog", { name: /Victory|Defeat|draw|Game over/ }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("game-result.png") });
    expect(shot || snapshot.result!.turns <= 2).toBe(true);
  });

  test("a Legacy game played to the end by keyboard alone", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const mine = deckNames("legacy-mono-green-creatures");
    const theirs = deckNames("legacy-mono-red-burn");
    const table = new Table(
      page,
      mine,
      new Set([...theirs].filter((n) => !mine.has(n))),
    );
    await signInSysop(page);
    await startGame(page, {
      format: "Legacy",
      deck: "legacy-mono-green-creatures",
      turnCap: 8,
    });
    const { snapshot, answered, kinds } = await play(page, table, "keyboard");
    note(
      testInfo,
      `${snapshot.result!.kind} after ${snapshot.result!.turns} turns; ${answered} prompts by keyboard (${JSON.stringify(kinds)})`,
    );
    expect(table.problems).toEqual([]);
    expect(answered).toBeGreaterThan(5);
  });

  test("a four-player Commander table, with each bot's deck kept concealed", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    const mine = deckNames("commander-mono-red-raiders");
    const concealed = new Set(
      [
        "commander-mono-white-soldiers",
        "commander-mono-blue-flyers",
        "commander-mono-green-stompers",
      ]
        .flatMap((deck) => [...deckNames(deck)])
        .filter((name) => !mine.has(name)),
    );
    // The commanders themselves are public from the start.
    const table = new Table(page, mine, concealed);
    await signInSysop(page);
    await startGame(page, {
      format: "Commander",
      deck: "commander-mono-red-raiders",
      bots: 3,
      turnCap: 4,
    });
    await expect(page.getByRole("article")).toHaveCount(3);
    const { snapshot, answered, kinds } = await play(page, table, "mouse");
    note(
      testInfo,
      `${snapshot.result!.kind} after ${snapshot.result!.turns} turns; ${answered} prompts (${JSON.stringify(kinds)})`,
    );
    expect(table.problems).toEqual([]);
    for (const [width, height] of [
      [1920, 1080],
      [1366, 768],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await noHorizontalScroll(page);
      await page.screenshot({
        path: testInfo.outputPath(`commander-${width}.png`),
        fullPage: true,
      });
    }
  });

  test("a second tab watches until it takes control, and a lost reply is resent once", async ({
    context,
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    const mine = deckNames("legacy-mono-red-burn");
    const first = new Table(page, mine, new Set());
    await signInSysop(page);
    const id = await startGame(page, {
      format: "Legacy",
      deck: "legacy-mono-red-burn",
      turnCap: 6,
    });
    await expect.poll(() => Boolean(first.latest?.prompt)).toBe(true);

    // The second tab's game socket runs through a proxy that can lose a reply on purpose.
    const second = await context.newPage();
    const table = new Table(null, mine, new Set());
    const lost: { action_id: string; body: unknown }[] = [];
    const resent: string[] = [];
    let loseNextReply = false;
    await second.routeWebSocket(/\/events$/, (client) => {
      const server = client.connectToServer();
      client.onMessage((message) => {
        const parsed = JSON.parse(String(message)) as {
          type: string;
          command?: { action_id: string };
        };
        if (parsed.type === "command" && parsed.command)
          resent.push(parsed.command.action_id);
        server.send(message);
      });
      server.onMessage((message) => {
        const parsed = JSON.parse(String(message)) as {
          type: string;
          action_id?: string;
          body?: unknown;
        };
        if (loseNextReply && parsed.type === "command_result") {
          loseNextReply = false;
          lost.push({ action_id: parsed.action_id ?? "", body: parsed.body });
          client.close({ code: 4000, reason: "test drop" });
          server.close();
          return;
        }
        table.receive(String(message));
        client.send(message);
      });
      client.onClose(() => server.close());
    });
    await second.goto(`/#game/${id}`);
    await expect(
      second.getByText("Another tab is playing this seat."),
    ).toBeVisible();
    const answer = second.locator("[data-option]").first();
    await expect(answer).toBeDisabled();

    // Play here moves the lease; the first tab now watches.
    await second.getByRole("button", { name: "Play here" }).click();
    await expect(
      page.getByText("Another tab is playing this seat."),
    ).toBeVisible();
    await expect(answer).toBeEnabled();

    // The reply to the next answer is lost with the connection. The tab reconnects, takes the
    // lease again and resends the same action, which returns the first result.
    loseNextReply = true;
    const revision = table.latest!.revision;
    await answer.click();
    await expect.poll(() => lost.length, { timeout: 30_000 }).toBe(1);
    await expect
      .poll(
        () => table.results.find((r) => r.action_id === lost[0].action_id),
        {
          timeout: 30_000,
        },
      )
      .toBeTruthy();
    const again = table.results.find((r) => r.action_id === lost[0].action_id)!;
    expect(again.status).toBe(200);
    expect(again.body).toEqual(lost[0].body);
    expect(
      resent.filter((action) => action === lost[0].action_id),
    ).toHaveLength(2);
    await expect.poll(() => table.latest!.revision).toBeGreaterThan(revision);
    expect([...first.problems, ...table.problems]).toEqual([]);

    // Close the game for everyone.
    await second.getByRole("button", { name: "Concede" }).click();
    await second
      .getByRole("dialog")
      .getByRole("button", { name: "Concede" })
      .click();
    await expect
      .poll(() => Boolean(table.latest?.result), { timeout: 60_000 })
      .toBe(true);
    await closeContext(context);
  });
});

async function closeContext(context: BrowserContext) {
  for (const page of context.pages()) await page.close();
}
