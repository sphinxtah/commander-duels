import { readFileSync } from "node:fs";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { occluded, sizeChecks } from "./helpers/checks";
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
  /** Every pass in progress a view reported (UI07). */
  readonly passing = new Set<string>();
  readonly publicNames = new Set<string>();
  /** Concealed names the log mentioned before any view showed them, by revision. */
  readonly pending = new Map<string, number>();
  /** Log lines that ran ahead of the board and were confirmed public by a later view. */
  readonly aheadOfView: string[] = [];
  /** CSP violations the page has reported and this check has seen. */
  private cspSeen = 0;
  /** Every command the page sent, in order. */
  readonly sent: {
    type: string;
    prompt_id?: string;
    expected_revision: number;
    payload: Record<string, unknown>;
  }[] = [];

  /** Without a page, frames are fed to receive() by the test (a proxied socket). */
  constructor(
    page: Page | null,
    private readonly mine: Set<string>,
    private readonly concealed: Set<string>,
  ) {
    page?.on("websocket", (socket) => {
      // The game's socket; the chat's (v0.4.4) carries no game.
      if (!/\/games\/[^/]+\/events$/.test(socket.url())) return;
      socket.on("framereceived", ({ payload }) =>
        this.receive(String(payload)),
      );
      socket.on("framesent", ({ payload }) => {
        const message = JSON.parse(String(payload)) as {
          type: string;
          command?: Table["sent"][number];
        };
        if (message.type === "command" && message.command)
          this.sent.push(message.command);
      });
    });
    // The page itself: no error, and no request breaks the content security policy.
    page?.on("pageerror", (error) =>
      this.problems.push(`page error: ${error.message}`),
    );
    page?.on("console", (message) => {
      if (
        message.type() === "error" &&
        !message.text().startsWith("Failed to load resource")
      )
        this.problems.push(`console: ${message.text()}`);
    });
    // T13 for pictures (v0.3.0): the table asks for a card's image only once it is public.
    page?.on("request", (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith("/api/v1/card-images")) return;
      const name = url.searchParams.get("name");
      if (name && this.concealed.has(name) && !this.publicNames.has(name))
        this.problems.push(
          `the image of ${name} was asked for before it was public`,
        );
    });
  }

  /** T13 on the screen (v0.3.0): no text the table shows or names (every text node, every
   * aria-label and title under the table, the log aside) says a concealed card before it has
   * been public. Pictures and log lines have their own checks. */
  async checkScreen(page: Page) {
    const { texts, csp } = await page.evaluate(() => {
      const root = document.querySelector("[data-screen]");
      const found: { text: string; option: string | null }[] = [];
      const add = (element: Element | null, text: string) =>
        found.push({
          text,
          option:
            element?.closest("[data-option]")?.getAttribute("data-option") ??
            null,
        });
      if (root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode())
          if (
            !node.parentElement?.closest("[role=log]") &&
            node.textContent?.trim()
          )
            add(node.parentElement, node.textContent);
        for (const element of root.querySelectorAll("[aria-label], [title]"))
          if (!element.closest("[role=log]"))
            for (const name of ["aria-label", "title"]) {
              const value = element.getAttribute(name);
              if (value) add(element, value);
            }
      }
      return {
        texts: found,
        csp: (window as unknown as { __csp?: string[] }).__csp ?? [],
      };
    });
    for (const violation of csp.slice(this.cspSeen))
      this.problems.push(`content security policy: ${violation}`);
    this.cspSeen = csp.length;
    // As in the frames' check, only an object option's words name a card: the others are
    // XMage's button words ("Cancel" is also a card) or players.
    const buttonWords = new Set(
      (this.latest?.prompt?.options ?? [])
        .filter((option) => !option.object_id)
        .map((option) => option.id),
    );
    for (const { text, option } of texts) {
      if (option !== null && buttonWords.has(option)) continue;
      for (const name of this.concealed)
        if (!this.publicNames.has(name) && phrase(name).test(text))
          this.problems.push(
            `the screen says ${name} before it was public: "${text.slice(0, 80)}"`,
          );
    }
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
    if (view?.priority?.passing) this.passing.add(view.priority.passing);
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
    // phrase in a prompt, before it has been public. Type lines and rules text are not checked,
    // because a subtype can equal a card name.
    const { log, ...rest } = snapshot;
    for (const [key, text] of strings(rest)) {
      for (const name of this.concealed) {
        if (this.publicNames.has(name)) continue;
        const named =
          key === "name" || key === "label"
            ? text === name
            : ["text", "message", "detail", "messages"].includes(key) &&
              phrase(name).test(text);
        if (named)
          this.problems.push(
            `${name} was named in ${key} before it was public (r${snapshot.revision})`,
          );
      }
    }
    // Since v0.1.1 each snapshot's log stops where its view was built, but a line can still name a
    // bot's card one view before the board shows it (CI run #30). As in the engine's check, a
    // logged name must become public; here, by a later view or the end.
    for (const [name, revision] of this.pending)
      if (this.publicNames.has(name)) {
        this.pending.delete(name);
        this.aheadOfView.push(
          `${name} (logged r${revision}, public r${snapshot.revision})`,
        );
      }
    for (const line of log)
      for (const name of this.concealed) {
        if (this.publicNames.has(name) || !phrase(name).test(line.text))
          continue;
        // A card the log says was revealed is public by the rules: XMage reveals to every player
        // (what one player alone sees, it logs as "looks at"). No view may show it, though, when
        // none is published while XMage keeps it in its revealed list, as when Goblin Guide's
        // trigger reveals the top of a library mid-combat (a local run in v0.3.1). The engine's
        // own check counts XMage's revealed list as public.
        if (/\breveals\b/.test(line.text)) {
          this.publicNames.add(name);
          this.pending.delete(name);
        } else if (!this.pending.has(name))
          this.pending.set(name, snapshot.revision);
      }
    if (snapshot.result)
      for (const [name, revision] of this.pending)
        this.problems.push(
          `${name} was named in the log (r${revision}) and never became public`,
        );
    if (
      !this.latest ||
      snapshot.revision >= this.latest.revision ||
      snapshot.result
    )
      this.latest = snapshot;
  }
}

function phrase(name: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(name)}\\b`);
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
    format: "Legacy" | "Commander" | "Two-Headed Giant";
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

/** The newest snapshot with a prompt or a result, once the page shows it. The page answers only
 * the prompt and revision on screen, so an answer given before it draws a newer frame (one this
 * test already saw) would send nothing. A result needs no answer and is returned at once. */
async function drawn(page: Page, table: Table): Promise<Snapshot> {
  const panel = page.locator('section[aria-labelledby="prompt-title"]');
  let shown = null as Snapshot | null;
  await expect
    .poll(
      async () => {
        const latest = table.latest;
        if (!latest?.prompt && !latest?.result) return false;
        if (!latest.result) {
          const [prompt, revision] = await Promise.all([
            panel.getAttribute("data-prompt"),
            panel.getAttribute("data-revision"),
          ]);
          if (
            prompt !== latest.prompt!.id ||
            revision !== String(latest.revision)
          )
            return false;
        }
        shown = latest;
        return true;
      },
      { timeout: 120_000 },
    )
    .toBe(true);
  return shown!;
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
    const snapshot = await drawn(page, table);
    await table.checkScreen(page);
    if (snapshot.result) return { snapshot, answered, kinds };
    await beforeAnswer?.(snapshot);
    const prompt = snapshot.prompt!;
    kinds[prompt.kind] = (kinds[prompt.kind] ?? 0) + 1;
    if (prompt.kind === "unsupported") {
      await page.getByRole("button", { name: "Concede this game" }).click();
      await page
        .getByRole("dialog", { name: "Concede this game?" })
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
          (await card.isVisible()) &&
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

/** The table at one size (design §24.2): its scale, nothing that scrolls, the canvas at the
 * screen's pixels, and every card and option in reach where it is drawn. */
async function atSize(
  page: Page,
  table: Table,
  width: number,
  height: number,
  path: string,
) {
  await page.setViewportSize({ width, height });
  await expect(page.locator("[data-screen]")).toHaveAttribute(
    "data-scale",
    Math.min(width / 1920, height / 1080).toFixed(3),
  );
  await sizeChecks(page, { width, height, dpr: 1 });
  table.problems.push(
    ...(await occluded(page)).map(
      (problem) => `${width}x${height}: ${problem}`,
    ),
  );
  await page.screenshot({ path, type: "jpeg", quality: 80 });
}

/** Opens the Game menu and concedes, through the named dialog. */
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

test.describe("practice games in the browser", () => {
  test.skip(
    !gamesOn || !sysopPassword,
    "Needs the engine: set CD_E2E_GAMES=1 and CD_E2E_SYSOP_PASSWORD.",
  );
  test.setTimeout(15 * 60_000);
  // A missing control fails the step instead of waiting out the whole game's time.
  test.use({ actionTimeout: 30_000 });
  // Whole games play in a window: Start would otherwise fill the screen (v0.3.0), and a window
  // in full screen cannot be resized for the size checks. No response timer passes for the
  // journeys' player, animation runs at its fastest, and the table is silent. Every tab of the
  // context (the second tab's too) starts with these settings.
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      const csp: string[] = [];
      (window as unknown as { __csp: string[] }).__csp = csp;
      document.addEventListener("securitypolicyviolation", (event) =>
        csp.push(`${event.violatedDirective} ${event.blockedURI}`),
      );
      localStorage.setItem(
        "cd.table.v1",
        JSON.stringify({
          fullscreenOnStart: false,
          responseTimerSeconds: 0,
          animationSpeed: "faster",
          effectsVolume: 0,
          muted: true,
          painter: "auto",
        }),
      );
    });
  });

  // A failed journey leaves its game running: it is closed, so the next journeys find a table.
  test.afterEach(async ({ page }, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) return;
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
  });

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
    await expect(page.locator("[data-screen]")).toHaveAttribute(
      "data-renderer",
      "webgl",
      { timeout: 30_000 },
    );
    // The bots plan only on what their seat may see (AI02, v0.3.1): the practice table no longer
    // warns that they read your hand.
    await expect(page.getByText(/read your hand/)).toHaveCount(0);
    // On the third turn, the table at each size the scope names, between two answers.
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
          [1280, 720],
          [1366, 768],
          [2560, 1440],
          [3840, 2160],
        ])
          await atSize(
            page,
            table,
            width,
            height,
            testInfo.outputPath(`game-${width}.jpg`),
          );
        await page.setViewportSize({ width: 1920, height: 1080 });
      },
    );
    note(
      testInfo,
      `${snapshot.result!.kind} after ${snapshot.result!.turns} turns; ${answered} prompts by mouse (${JSON.stringify(kinds)}); ${table.snapshots} snapshots in ${table.frames} frames; log ahead of the board, then public: ${table.aheadOfView.join(", ") || "none"}`,
    );
    expect(table.problems).toEqual([]);
    expect(answered).toBeGreaterThan(5);
    await expect(
      page.getByRole("dialog", { name: /Victory|Defeat|draw|Game over/ }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("game-result.jpg"),
      type: "jpeg",
      quality: 80,
    });
    expect(shot || snapshot.result!.turns <= 2).toBe(true);
  });

  test("a Legacy game played to the end by keyboard alone", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.emulateMedia({ reducedMotion: "reduce" });
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
    await sizeChecks(page, { width: 1366, height: 768, dpr: 1 });
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
    await page.setViewportSize({ width: 2560, height: 1440 });
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
    await sizeChecks(page, { width: 2560, height: 1440, dpr: 1 });
    const { snapshot, answered, kinds } = await play(page, table, "mouse");
    note(
      testInfo,
      `${snapshot.result!.kind} after ${snapshot.result!.turns} turns; ${answered} prompts (${JSON.stringify(kinds)})`,
    );
    // The ended table, reviewed: the result dialog closed, every control reachable at each size.
    await page
      .getByRole("dialog", { name: /Victory|Defeat|draw|Game over/ })
      .getByRole("button", { name: "Review the board" })
      .click();
    for (const [width, height] of [
      [2560, 1440],
      [1920, 1080],
      [1280, 720],
    ])
      await atSize(
        page,
        table,
        width,
        height,
        testInfo.outputPath(`commander-${width}.jpg`),
      );
    expect(table.problems).toEqual([]);
  });

  test("a Two-Headed Giant table: a bot teammate against two bots, one life a team (v0.5.0)", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    // The teammate's hand is the player's to see (810.5); the opponents' decks stay concealed.
    const mine = deckNames("legacy-mono-red-burn");
    const teammate = deckNames("legacy-mono-green-creatures");
    const concealed = new Set(
      ["legacy-mono-white-weenie", "legacy-mono-blue-skies"]
        .flatMap((deck) => [...deckNames(deck)])
        .filter((name) => !mine.has(name) && !teammate.has(name)),
    );
    const table = new Table(page, new Set([...mine, ...teammate]), concealed);
    await signInSysop(page);
    await startGame(page, {
      format: "Two-Headed Giant",
      deck: "legacy-mono-red-burn",
      turnCap: 4,
    });
    await expect(page.getByRole("article")).toHaveCount(3);
    await expect(page.getByText("Teammate · shared life")).toBeVisible();
    await expect(
      page.getByRole("article", { name: /seat 2, your teammate$/ }),
    ).toBeVisible();
    const { snapshot, answered } = await play(page, table, "mouse");
    note(
      testInfo,
      `${snapshot.result!.kind} after ${snapshot.result!.turns} turns; ${answered} prompts`,
    );
    const view = snapshot.view!;
    // One life total a team: teammates always show the same.
    expect(view.opponents[0].life).toBe(view.you!.life);
    expect(view.opponents[1].life).toBe(view.opponents[2].life);
    expect(table.problems).toEqual([]);
  });

  test("a second tab watches until it takes control, and a lost reply is resent once", async ({
    context,
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
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
    await second.routeWebSocket(/\/games\/[^/]+\/events$/, (client) => {
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
    const revision = (await drawn(second, table)).revision;
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
    await concede(second);
    await expect
      .poll(() => Boolean(table.latest?.result), { timeout: 60_000 })
      .toBe(true);
    await closeContext(context);
  });

  test("a deck of your own, with full control and a pass until your next turn", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 3840, height: 2160 });
    const mine = new Set(["Lightning Bolt", "Hill Giant", "Mountain"]);
    const fixtures = new Set([
      ...deckNames("legacy-mono-red-burn"),
      ...deckNames("legacy-mono-green-creatures"),
    ]);
    const table = new Table(
      page,
      mine,
      new Set([...fixtures].filter((n) => !mine.has(n))),
    );
    await signInSysop(page);
    const catalog = await page.evaluate(async () => {
      const response = await fetch("/api/v1/catalog");
      return (await response.json()) as { revision: object | null };
    });
    test.skip(
      !catalog.revision,
      "Needs a card catalog: run scripts/load_fixture_catalog.py.",
    );

    // A deck of the player's own, from the deck builder to the table (DECK01).
    await page.goto("/#decks");
    await page.getByRole("button", { name: "Import a list" }).click();
    const importer = page.getByRole("dialog", { name: "Import a deck list" });
    await importer.getByRole("radio", { name: "Legacy" }).check();
    await importer
      .getByLabel("Deck list")
      .fill(["4 Lightning Bolt", "4 Hill Giant", "52 Mountain"].join("\n"));
    await importer.getByRole("button", { name: "Preview" }).click();
    await importer.getByLabel("Deck name").fill(`Game journey ${Date.now()}`);
    await importer.getByRole("button", { name: "Create the deck" }).click();
    await expect(page).toHaveURL(/#deck\/[0-9a-f-]{36}$/);
    await page
      .getByRole("link", { name: "Play it at the practice table" })
      .click();
    const practice = page.getByRole("region", {
      name: "Sit down against the bots",
    });
    await expect(practice.getByLabel("Your deck")).toHaveValue(/^own:/);
    await practice.getByLabel(/Bot skill/).fill("1");
    await practice.getByLabel("Turn limit").fill("8");
    await practice.getByRole("button", { name: "Start the game" }).click();
    await expect(page).toHaveURL(/#game\/[0-9a-f-]{36}$/, { timeout: 30_000 });

    // Play up to the first priority prompt that offers to pass until the next turn.
    class Reached extends Error {}
    const reached = await play(page, table, "mouse", async (now) => {
      if (now.prompt?.options.some((o) => o.action === "pass_until_my_turn"))
        throw new Reached();
    }).then(
      () => false,
      (error: unknown) => {
        if (error instanceof Reached) return true;
        throw error;
      },
    );
    expect(reached, "no priority prompt offered the pass modes").toBe(true);

    // Full control stops everywhere; turned off, the stops are the defaults again. The controls
    // are in their drawer, opened from the band (v0.3.0).
    await sizeChecks(page, { width: 3840, height: 2160, dpr: 1 });
    await page.getByRole("button", { name: "Priority controls" }).click();
    const priority = page.getByRole("region", {
      name: "Priority",
      exact: true,
    });
    const full = priority.getByRole("checkbox", { name: /Full control/ });
    await expect(full).not.toBeChecked();
    await full.click();
    await expect(full).toBeChecked();
    expect(table.results.at(-1)).toMatchObject({
      status: 200,
      body: { priority: { full_control: true } },
    });
    await full.click();
    await expect(full).not.toBeChecked();
    await page.screenshot({
      path: testInfo.outputPath("priority.jpg"),
      type: "jpeg",
      quality: 80,
    });
    await page.getByRole("button", { name: "Close Priority controls" }).click();
    await expect(priority).toBeHidden();

    // The engine passes for the seat until its next turn, unless something stops it.
    const shown = await drawn(page, table);
    const turn = shown.view?.turn ?? 0;
    await page
      .getByRole("button", { name: "Pass until your next turn" })
      .click();
    await expect
      .poll(() => (table.latest?.revision ?? 0) > shown.revision, {
        timeout: 60_000,
      })
      .toBe(true);
    const next = await drawn(page, table);
    note(
      testInfo,
      `passed on turn ${turn}; next prompt on turn ${next.view?.turn ?? "-"} (${next.prompt?.kind ?? next.result?.kind}); passes the views reported: ${[...table.passing].join(", ") || "none"}`,
    );
    expect(
      table.passing.has("until_my_turn") ||
        (next.view?.turn ?? 0) > turn ||
        Boolean(next.result),
    ).toBe(true);

    const { snapshot } = await play(page, table, "mouse");
    note(
      testInfo,
      `${snapshot.result!.kind} after ${snapshot.result!.turns} turns with an own deck`,
    );
    expect(table.problems).toEqual([]);
  });

  test("the response timer passes at a response moment, and Space stops it", async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => {
      const settings = JSON.parse(localStorage.getItem("cd.table.v1") ?? "{}");
      localStorage.setItem(
        "cd.table.v1",
        JSON.stringify({ ...settings, responseTimerSeconds: 5 }),
      );
    });
    await page.setViewportSize({ width: 1920, height: 1080 });
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
      turnCap: 12,
    });

    // A response moment: the bot's object on top of the stack, or its attack, and a pass to give.
    const moment = (now: Snapshot) => {
      const view = now.view;
      const prompt = now.prompt;
      if (!view || prompt?.kind !== "priority" || now.status !== "your_prompt")
        return false;
      if (!prompt.options.some((o) => o.action === "pass")) return false;
      if (view.priority?.passing || view.priority?.full_control) return false;
      const top = view.stack[0];
      if (top) return top.controller_seat !== view.seat;
      return (
        view.active_seat !== view.seat &&
        (view.step === "declare_attackers" ||
          view.step === "declare_blockers") &&
        view.combat.some((group) => group.attackers.length > 0)
      );
    };
    class Reached extends Error {}
    const until = (after: number) =>
      play(page, table, "mouse", async (now) => {
        if (now.revision > after && moment(now)) throw new Reached();
      }).then(
        () => null,
        (error: unknown) => {
          if (error instanceof Reached) return table.latest;
          throw error;
        },
      );

    // The first moment: nothing is pressed, and the table passes once, for that prompt and
    // revision, when the timer runs out.
    const first = await until(-1);
    test.skip(!first, "The bot gave no response moment before the game ended.");
    const pass = first!.prompt!.options.find((o) => o.action === "pass")!;
    const before = table.sent.length;
    await expect(page.locator("[data-timer]")).toHaveAttribute(
      "data-timer",
      /arming|running/,
    );
    await page.screenshot({
      path: testInfo.outputPath("timer.jpg"),
      type: "jpeg",
      quality: 80,
    });
    await expect
      .poll(() => table.sent.length - before, { timeout: 12_000 })
      .toBe(1);
    expect(table.sent.at(-1)).toMatchObject({
      type: "submit_choice",
      prompt_id: first!.prompt!.id,
      expected_revision: first!.revision,
      payload: { option_id: pass.id },
    });

    // The next moment: Space stops the timer, and nothing is sent for it.
    const next = await until(first!.revision);
    test.skip(!next, "The bot gave no second response moment.");
    await expect(page.locator("[data-timer]")).toHaveAttribute(
      "data-timer",
      /arming|running/,
    );
    const sent = table.sent.length;
    await page.keyboard.press("Space");
    await expect(page.locator("[data-timer]")).toHaveAttribute(
      "data-timer",
      "stopped",
    );
    await page.waitForTimeout(7_000);
    expect(table.sent.length).toBe(sent);
    await concede(page);
    await expect
      .poll(() => Boolean(table.latest?.result), { timeout: 60_000 })
      .toBe(true);
    expect(table.problems).toEqual([]);
  });

  test("a game starts in full screen, F leaves and returns, and the Game menu goes back", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const settings = JSON.parse(localStorage.getItem("cd.table.v1") ?? "{}");
      localStorage.setItem(
        "cd.table.v1",
        JSON.stringify({ ...settings, fullscreenOnStart: true }),
      );
    });
    await page.setViewportSize({ width: 1920, height: 1080 });
    const table = new Table(page, deckNames("legacy-mono-red-burn"), new Set());
    await signInSysop(page);
    await startGame(page, {
      format: "Legacy",
      deck: "legacy-mono-red-burn",
      turnCap: 4,
    });
    const full = () => page.evaluate(() => document.fullscreenElement !== null);
    const entered = await expect
      .poll(full, { timeout: 10_000 })
      .toBe(true)
      .then(
        () => true,
        () => false,
      );
    if (!entered) await concede(page);
    test.skip(!entered, "This browser refused full screen on Start.");
    const root = page.locator("[data-screen]");
    const locked = (await root.getAttribute("data-keyboard-lock")) === "true";
    note(test.info(), `Escape locked in full screen: ${locked}`);

    // The Game menu opens over the table; Escape closes it and the table stays in full screen.
    await page.getByRole("button", { name: "Game menu" }).click();
    const menu = page.getByRole("group", { name: "Game menu" });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    if (locked) expect(await full()).toBe(true);

    // F leaves full screen and returns to it.
    if (await full()) {
      await page.keyboard.press("f");
      await expect.poll(full).toBe(false);
    }
    await page.keyboard.press("f");
    await expect.poll(full).toBe(true);

    // Conceding, then the Game menu's Table, leaves the game and its full screen.
    await concede(page);
    await expect
      .poll(() => Boolean(table.latest?.result), { timeout: 60_000 })
      .toBe(true);
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Review the board" })
      .click();
    await page.getByRole("button", { name: "Game menu" }).click();
    await page
      .getByRole("group", { name: "Game menu" })
      .getByRole("link", { name: "Table", exact: true })
      .click();
    await expect(page).toHaveURL(/#play$/);
    await expect.poll(full).toBe(false);
    expect(table.problems).toEqual([]);
  });
});

async function closeContext(context: BrowserContext) {
  for (const page of context.pages()) await page.close();
}
