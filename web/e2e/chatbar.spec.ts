import { test, expect, type Page, type WebSocketRoute } from "@playwright/test";
import type { components } from "../src/generated/api";
import { standIn } from "./accounts";

// The chat bar (v0.5.1, the owner's request): friends and their conversations along the bottom of
// every page, which replaced the Messages page. It runs on Vite's dev server with the API answered
// here (page.route) and the chat's socket a fake server (page.routeWebSocket), so it needs no
// database and no second account; social.spec.ts writes between two real accounts. The
// screenshots of the bar and its list, at a desktop's and a phone's width, are the journey's
// evidence (test-results).

type Summary = components["schemas"]["PlayerSummary"];
type Message = components["schemas"]["ChatMessage"];
type Presence = components["schemas"]["Presence"];

/** The stand-in account's ID (accounts.ts). */
const ME = "00000000-0000-4000-8000-0000000000e2";
const ADA = "00000000-0000-4000-8000-0000000000a1";
const BOB = "00000000-0000-4000-8000-0000000000b2";
const CAL = "00000000-0000-4000-8000-0000000000c3";
const EVE = "00000000-0000-4000-8000-0000000000e5";
const DEE = "00000000-0000-4000-8000-0000000000d4";

function person(
  id: string,
  handle: string,
  alliance: string | null,
  presence: Presence | null,
  friendship: Summary["friendship"] = "friends",
): Summary {
  return {
    id,
    handle,
    alliance,
    avatar: "moon",
    tier: { id: "silver", name: "Silver", wins: 12 },
    presence,
    friendship,
  };
}
function state(
  name: Presence["state"],
  more: Partial<Presence> = {},
): Presence {
  return {
    state: name,
    game_kind: null,
    game_format: null,
    appears_offline: false,
    ...more,
  };
}

const FRIENDS = [
  person(ADA, "ada", "jaya", state("online")),
  person(BOB, "bob", "teferi", state("offline")),
  person(
    CAL,
    "cal",
    "chandra",
    state("in_game", { game_kind: "table", game_format: "commander" }),
  ),
  person(EVE, "eve", "nissa", state("in_queue", { game_format: "legacy" })),
];
/** A player who ended the friendship: the conversation stays readable. */
const DEE_SUMMARY = person(DEE, "dee", null, null, "none");

interface FakeChat {
  /** A friend's message: stored, and told to the tab over the socket. */
  say(from: string, body: string): void;
  /** What the tab sent, in order. */
  sent: { to: string; text: string }[];
}

/** Answers the API for the stand-in account: two conversations (one unread message from Ada, an
 * old one with Dee), its friends, and the chat's socket. Anything else is not found. */
async function fakeChat(page: Page): Promise<FakeChat> {
  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60_000).toISOString();
  let next = 0;
  const message = (from: string, body: string, at = minutesAgo(0)) => {
    next += 1;
    return {
      id: `00000000-0000-4000-9000-${String(next).padStart(12, "0")}`,
      sender_id: from,
      body,
      created_at: at,
      client_id: `00000000-0000-4000-a000-${String(next).padStart(12, "0")}`,
    } satisfies Message;
  };
  const threads = new Map<string, Message[]>([
    [
      ADA,
      [
        message(ME, "Rematch tonight?", minutesAgo(90)),
        message(ADA, "Good game yesterday! Same time?", minutesAgo(3)),
      ],
    ],
    [DEE, [message(DEE, "See you around.", minutesAgo(60 * 50))]],
  ]);
  const unread = new Map<string, number>([[ADA, 1]]);
  const total = () => [...unread.values()].reduce((a, b) => a + b, 0);
  const summary = (id: string) =>
    id === DEE ? DEE_SUMMARY : FRIENDS.find((each) => each.id === id)!;
  let socket: WebSocketRoute | undefined;
  const tell = (event: object) => socket?.send(JSON.stringify(event));
  const sent: FakeChat["sent"] = [];

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, json: body });
    if (pathname === "/api/v1/bootstrap")
      return json({
        name: "Commander Duels",
        version: "0.5.1",
        protocol_version: 1,
        collection_policy: "open_collection",
        capabilities: [],
        auth: { google_client_id: null, signup_policy: "open" },
      });
    if (pathname === "/api/v1/formats") return json([]);
    if (pathname === "/api/v1/presence")
      return json({
        unread: 0,
        messages_unread: total(),
        newest: null,
        fresh: [],
      });
    if (pathname === "/api/v1/friends")
      return json({ friends: FRIENDS, incoming: [], outgoing: [] });
    if (pathname === "/api/v1/conversations")
      return json({
        conversations: [...threads].map(([id, messages]) => ({
          player: summary(id),
          friends: id !== DEE,
          last_message: messages.at(-1) ?? null,
          unread: unread.get(id) ?? 0,
        })),
        unread: total(),
      });
    const one =
      /^\/api\/v1\/conversations\/([0-9a-f-]{36})(\/messages|\/read)?$/.exec(
        pathname,
      );
    if (one) {
      const id = one[1]!;
      const messages = threads.get(id) ?? [];
      if (one[2] === "/messages" && method === "POST") {
        const body = request.postDataJSON() as {
          text: string;
          client_id: string;
        };
        sent.push({ to: id, text: body.text });
        const stored = { ...message(ME, body.text), client_id: body.client_id };
        threads.set(id, [...messages, stored]);
        // As the server does, to the sender's tabs too.
        tell({
          type: "message",
          player_id: id,
          player: summary(id),
          message: stored,
          unread: total(),
        });
        return json(stored, 201);
      }
      if (one[2] === "/read" && method === "POST") {
        unread.set(id, 0);
        tell({ type: "read", player_id: id, unread: total() });
        return json({ unread: 0 });
      }
      if (!one[2] && method === "GET")
        return json({
          player: summary(id),
          friends: id !== DEE,
          messages,
          next: null,
          unread: unread.get(id) ?? 0,
        });
    }
    return json({ code: "not_found", message: "Not in this journey." }, 404);
  });
  // After the catch-all: the routes registered last answer first.
  await standIn(page, { alliance: "rowan" });
  await page.routeWebSocket(/\/api\/v1\/chat\/events$/, (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      const parsed = JSON.parse(String(raw)) as { type?: string };
      if (parsed.type === "hello")
        ws.send(JSON.stringify({ type: "welcome", unread: total() }));
      else if (parsed.type === "ping")
        ws.send(JSON.stringify({ type: "pong" }));
    });
  });
  return {
    say(from, body) {
      const said = message(from, body);
      threads.set(from, [...(threads.get(from) ?? []), said]);
      unread.set(from, (unread.get(from) ?? 0) + 1);
      tell({
        type: "message",
        player_id: from,
        player: summary(from),
        message: said,
        unread: total(),
      });
    },
    sent,
  };
}

/** What went wrong on the page: errors, and console errors other than the API's 404s here. */
function problems(page: Page): string[] {
  const found: string[] = [];
  page.on("pageerror", (error) => found.push(error.message));
  page.on("console", (entry) => {
    if (entry.type() !== "error") return;
    if (/Failed to load resource.*404/.test(entry.text())) return;
    found.push(entry.text());
  });
  return found;
}

test("the chat bar: friends online, their conversations from page to page, and old Messages links", async ({
  page,
}, testInfo) => {
  const errors = problems(page);
  const chat = await fakeChat(page);
  await page.goto("/#settings");
  await expect(
    page.getByRole("heading", { name: "Make yourself at home." }),
  ).toBeVisible();
  const bar = page.getByRole("complementary", {
    name: "Friends and messages",
  });
  // The top bar no longer has Messages: its count is on the bar's Friends button.
  await expect(
    page.getByRole("banner").getByRole("link", { name: /Messages/ }),
  ).toHaveCount(0);
  const toggle = bar.getByRole("button", { name: /^Friends/ });
  await expect(toggle).toHaveAccessibleName(
    "Friends, 3 online, 1 unread message",
  );
  await expect(toggle).toHaveText(/Friends\s*·\s*3 online\s*1/);

  // The list: friends online first, each with what is unread; Dee's conversation under its own
  // heading, readable.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const list = bar.getByRole("list", { name: "Your friends" });
  await expect(list.getByRole("button")).toHaveText([
    /cal\s*Playing Commander at a table/,
    /eve\s*Looking for a Legacy game/,
    /ada\s*Online\s*1/,
    /bob\s*Offline/,
  ]);
  await expect(
    bar
      .getByRole("list", { name: "Earlier conversations" })
      .getByRole("button", { name: "Chat with dee, No longer friends" }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("chatbar-panel.png") });

  // Ada's conversation opens on the bar, with focus in its box; it is read, and the count goes.
  await list.getByRole("button", { name: /^Chat with ada/ }).click();
  const ada = bar.getByRole("region", { name: "Chat with ada" });
  await expect(ada.getByLabel("Write to ada")).toBeFocused();
  await expect(
    ada.getByRole("list", { name: "Messages with ada" }),
  ).toContainText("Good game yesterday! Same time?");
  await expect(toggle).toHaveAccessibleName("Friends, 3 online");
  await ada.getByLabel("Write to ada").fill("Yes! 8 pm.");
  await ada.getByLabel("Write to ada").press("Enter");
  await expect(
    ada.getByRole("list", { name: "Messages with ada" }),
  ).toContainText("Yes! 8 pm.");
  expect(chat.sent).toEqual([{ to: ADA, text: "Yes! 8 pm." }]);
  // Her answer arrives in the window at once; it does not pop up beside the bell.
  chat.say(ADA, "Deal. Bring the dragons.");
  await expect(
    ada.getByRole("list", { name: "Messages with ada" }),
  ).toContainText("Deal. Bring the dragons.");
  await expect(
    page.getByRole("button", { name: /Deal\. Bring the dragons\./ }),
  ).toHaveCount(0);
  // Bob's conversation beside it. The list stays open until its title bar folds it, a click
  // elsewhere on the page included.
  await bar
    .getByRole("list", { name: "Your friends" })
    .getByRole("button", { name: /^Chat with bob/ })
    .click();
  await expect(
    bar.getByRole("region", { name: "Chat with bob" }),
  ).toBeVisible();
  await page.getByRole("heading", { name: "Make yourself at home." }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.screenshot({
    path: testInfo.outputPath("chatbar-desktop-open.png"),
  });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({ path: testInfo.outputPath("chatbar-desktop.png") });

  // From page to page, and after a reload: the same windows, Bob's folded, and the list folded.
  await bar
    .getByRole("region", { name: "Chat with bob" })
    .getByRole("button", { expanded: true })
    .click();
  await page.getByRole("link", { name: "Friends", exact: true }).click();
  await expect(page).toHaveURL(/#friends$/);
  await expect(ada).toBeVisible();
  await page.reload();
  await expect(
    ada.getByRole("list", { name: "Messages with ada" }),
  ).toContainText("Deal. Bring the dragons.");
  await expect(
    bar
      .getByRole("region", { name: "Chat with bob" })
      .getByRole("button", { expanded: false }),
  ).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  // A message to a folded window pops up beside the bell and counts on the bar.
  chat.say(BOB, "Are you around?");
  await expect(
    page.getByRole("button", { name: /Are you around\?/ }),
  ).toBeVisible();
  await expect(
    bar.getByRole("region", { name: "Chat with bob" }).getByLabel("1 unread"),
  ).toBeVisible();

  // Closed, a conversation opens again from the list; focus goes back to the Friends button.
  await ada.getByRole("button", { name: "Close the chat with ada" }).click();
  await expect(ada).toHaveCount(0);
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(
    bar.getByRole("button", { name: /^Chat with cal/ }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toBeFocused();

  // The Messages page's old addresses open the bar: followed in the app, over the page shown;
  // opened afresh, over the main menu.
  await page.evaluate((id) => {
    window.location.hash = `#messages/${id}`;
  }, ADA);
  await expect(ada).toBeVisible();
  await expect(page).toHaveURL(/#friends$/);
  await page.goto("about:blank");
  await page.goto("/#messages");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page).toHaveURL(/#home$/);
  await expect(
    page.getByRole("heading", { name: "Welcome back, stand-in" }),
  ).toBeVisible();
  // Left open, the list is open again after a reload.
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(errors).toEqual([]);
});

test("the chat bar on a phone: one button, then the list or one conversation, the whole width", async ({
  page,
}, testInfo) => {
  const errors = problems(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await fakeChat(page);
  await page.goto("/#settings");
  const bar = page.getByRole("complementary", {
    name: "Friends and messages",
  });
  const toggle = bar.getByRole("button", { name: /^Friends/ });
  await expect(toggle).toHaveAccessibleName(
    "Friends, 3 online, 1 unread message",
  );
  // A round button above the bar of pages, at the right.
  const button = (await toggle.boundingBox())!;
  const pages = (await page
    .getByRole("navigation", { name: "Main navigation on a phone" })
    .boundingBox())!;
  expect(button.width).toBeLessThan(60);
  expect(button.y + button.height).toBeLessThanOrEqual(pages.y);
  expect(button.x + button.width).toBeGreaterThan(390 - 24);
  await page.screenshot({
    path: testInfo.outputPath("chatbar-phone-button.png"),
  });

  await toggle.click();
  const list = bar.getByRole("list", { name: "Your friends" });
  await expect(list).toBeVisible();
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  const sheet = (await bar
    .getByRole("region", { name: "Friends" })
    .boundingBox())!;
  expect(sheet.x).toBe(0);
  expect(sheet.width).toBe(width);
  await page.screenshot({
    path: testInfo.outputPath("chatbar-phone-panel.png"),
  });

  // A friend's conversation takes the list's place, the whole width.
  await list.getByRole("button", { name: /^Chat with ada/ }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const ada = bar.getByRole("region", { name: "Chat with ada" });
  await expect(ada.getByLabel("Write to ada")).toBeFocused();
  const window = (await ada.boundingBox())!;
  expect(window.x).toBe(0);
  expect(window.width).toBe(width);
  await expect(
    ada.getByRole("list", { name: "Messages with ada" }),
  ).toContainText("Good game yesterday! Same time?");
  await page.screenshot({
    path: testInfo.outputPath("chatbar-phone-window.png"),
  });
  // Folded, it sits beside the button, above the bar of pages; Bob's, opened after, shows alone.
  await ada.getByRole("button", { expanded: true }).click();
  await expect(toggle).toBeVisible();
  const tab = (await ada.boundingBox())!;
  expect(tab.y + tab.height).toBeLessThanOrEqual(pages.y);
  expect(tab.x + tab.width).toBeLessThanOrEqual(
    (await toggle.boundingBox())!.x,
  );
  await page.screenshot({
    path: testInfo.outputPath("chatbar-phone-folded.png"),
  });
  await toggle.click();
  await list.getByRole("button", { name: /^Chat with bob/ }).click();
  await expect(bar.getByRole("region", { name: /^Chat with/ })).toHaveCount(1);
  await expect(
    bar.getByRole("region", { name: "Chat with bob" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
