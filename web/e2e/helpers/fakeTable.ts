import { readFileSync } from "node:fs";
import type { Page, WebSocketRoute } from "@playwright/test";
import {
  tableFixture,
  type FixtureName,
  type TableFixture,
} from "../../src/game/table/fixtures";
import type { TableSettings } from "../../src/game/table/types";

// The fake table (design §24.2): the game screen on Vite's dev server with no engine. The page's
// account, the game's summary and the card images are answered here, and the game's WebSocket
// is a fake server that greets the tab, gives it the seat and sends a snapshot built from the
// table fixtures (src/game/table/fixtures.ts), recording every command the tab sends. The
// Planeswalker portraits (v0.3.1) are the real files Vite serves from web/public/portraits: the
// summary gives Alice, the fixtures' one human, Rowan's, unless a journey says otherwise.

/** A plain stand-in card picture: no card art. */
const CARD = readFileSync(new URL("./card.jpg", import.meta.url));

/** The quiet settings the table journeys start from; each test changes what it checks. */
export const QUIET: TableSettings = {
  fullscreenOnStart: false,
  responseTimerSeconds: 0,
  animationSpeed: "faster",
  effectsVolume: 0,
  muted: true,
  painter: "auto",
  // The journeys check the table's state, not its sparks (v0.7.0).
  effects: "off",
  // Nor its music (v0.7.2): the fake server has no track, and a muted player asks for none.
  musicVolume: 0,
  musicMuted: true,
};

export interface FakeTable {
  gameId: string;
  fixture: TableFixture;
  /** Every command the tab sent, in order. */
  commands: {
    type: string;
    prompt_id?: string;
    expected_revision: number;
    payload: unknown;
  }[];
  /** Sends the tab a new snapshot (a fixture's, changed by the test). */
  send(snapshot: TableFixture["snapshot"]): void;
  /** At a human table (v0.4.4): every chat, emote and alliance message the tab sent, in order. */
  chat: Record<string, unknown>[];
  /** At a human table: a line of the table's chat from another seat's player. */
  say(seat: number, body: string): void;
  /** Problems the page reported: errors, console errors and CSP violations. */
  problems(): Promise<string[]>;
}

let games = 0;

/** A game id the app's route accepts (a UUID), different for each table. */
function gameId(): string {
  games += 1;
  return `00000000-0000-4000-8000-${String(games).padStart(12, "0")}`;
}

/** The portrait the fake summary gives the fixtures' own player, Alice (seat 0). */
export const ALICE_PORTRAIT = "rowan";

/** Opens the game screen on a fixture, signed in as an active SysOp. `portraits` sets the
 * summary's portrait of each seat it names (a human's allied Planeswalker, or null for none);
 * Alice has Rowan's unless it says otherwise. `humans` makes the game a human table's (v0.4.4),
 * with the seats it names played by people with those handles: the socket then has the table's
 * chat, sending back each message as the server does and keeping the alliances. */
export async function openTable(
  page: Page,
  options: {
    fixture: FixtureName | TableFixture;
    settings?: Partial<TableSettings>;
    portraits?: Record<number, string | null>;
    humans?: Record<number, string>;
  },
): Promise<FakeTable> {
  const fixture =
    typeof options.fixture === "string"
      ? tableFixture(options.fixture)
      : options.fixture;
  const id = gameId();
  fixture.snapshot.game_id = id;
  const portraits: Record<number, string | null> = {
    0: ALICE_PORTRAIT,
    ...options.portraits,
  };
  const humans = options.humans;
  const seats = fixture.summarySeats
    .map((seat) =>
      humans && seat.seat in humans
        ? { ...seat, player: "human" as const, handle: humans[seat.seat] }
        : seat,
    )
    .map((seat) =>
      seat.player === "human" && seat.seat in portraits
        ? { ...seat, portrait: portraits[seat.seat] }
        : seat,
    );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`page error: ${error.message}`));
  page.on("console", (message) => {
    // A missing token picture is a 404 the browser logs; the table expects it.
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource")
    )
      errors.push(`console: ${message.text()}`);
  });
  await page.addInitScript(
    (settings) => {
      localStorage.setItem("cd.table.v1", JSON.stringify(settings));
      const seen: string[] = [];
      (window as unknown as { __csp: string[] }).__csp = seen;
      document.addEventListener("securitypolicyviolation", (event) =>
        seen.push(`${event.violatedDirective} ${event.blockedURI}`),
      );
    },
    { ...QUIET, ...options.settings },
  );

  // The site's own facts, as the API gives them, so the table needs no API server.
  await page.route("**/api/v1/bootstrap", (route) =>
    route.fulfill({
      json: {
        name: "Commander Duels",
        version: "0.3.0",
        protocol_version: 1,
        collection_policy: "open_collection",
        capabilities: [],
        auth: {
          google_client_id: "e2e-client.apps.googleusercontent.com",
          signup_policy: "open",
        },
      },
    }),
  );
  await page.route("**/api/v1/formats", (route) =>
    route.fulfill({
      json: [
        {
          id: "commander",
          name: "Commander",
          seats: [2, 3, 4],
          default_seats: 4,
          description: "Build around your commander.",
          available: true,
        },
        {
          id: "legacy",
          name: "Legacy",
          seats: [2],
          default_seats: 2,
          description: "Two players.",
          available: true,
        },
      ],
    }),
  );
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      json: {
        id: "00000000-0000-4000-8000-00000000a11c",
        kind: "sysop",
        status: "active",
        onboarding: "complete",
        display_name: "Alice",
        handle: fixture.selfHandle ?? "alice",
        // The account's alliance: its portrait at its own seat until the summary says.
        alliance:
          fixture.seat === null ? null : (portraits[fixture.seat] ?? null),
        email: null,
        avatar: "sigil",
        locale: "en",
        csrf_token: "fake-csrf",
        roles: ["sysop"],
        permissions: [
          "profile.edit",
          "games.play",
          "decks.edit",
          ...(fixture.sysop ? (["games.view_concealed"] as const) : []),
        ],
        preferences: { large_text: false, reduced_motion: false },
        session: {
          id: "fake-session",
          kind: "sysop",
          authenticated_at: "2026-10-20T00:00:00Z",
          idle_expires_at: "2099-01-01T00:00:00Z",
          absolute_expires_at: "2099-01-01T00:00:00Z",
        },
      },
    }),
  );
  await page.route(`**/api/v1/games/${id}`, (route) =>
    route.fulfill({
      json: {
        game: {
          id,
          ...(humans ? { kind: "table" } : {}),
          format: fixture.snapshot.settings.format,
          status: fixture.snapshot.result ? "finished" : "active",
          bot_skill: 3,
          turn_cap: 40,
          created_at: "2026-10-20T00:00:00Z",
          finished_at: null,
          result: null,
          seats,
          your_seat: fixture.seat,
        },
        snapshot: null,
      },
    }),
  );
  // The app's check-in (v0.4.3) and the friends' chat socket (v0.4.4) run on every screen, the
  // table's too: both are answered as for an account with nothing new.
  await page.route("**/api/v1/presence", (route) =>
    route.fulfill({
      json: { unread: 0, messages_unread: 0, newest: null, fresh: [] },
    }),
  );
  await page.routeWebSocket(/\/api\/v1\/chat\/events$/, (ws) => {
    ws.onMessage((raw) => {
      const parsed = JSON.parse(String(raw)) as { type?: string };
      if (parsed.type === "hello")
        ws.send(JSON.stringify({ type: "welcome", unread: 0 }));
      else if (parsed.type === "ping")
        ws.send(JSON.stringify({ type: "pong" }));
    });
  });
  await page.route("**/api/v1/card-images**", (route) => {
    const name = new URL(route.request().url()).searchParams.get("name") ?? "";
    // Tokens have no picture of their own, as on the live site.
    if (/token/i.test(name))
      return route.fulfill({
        status: 404,
        json: { code: "card_image_missing", message: "No image." },
      });
    return route.fulfill({
      body: CARD,
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
    });
  });

  const commands: FakeTable["commands"] = [];
  let socket: WebSocketRoute | null = null;
  let latest = fixture.snapshot;
  const message = (value: object) => socket?.send(JSON.stringify(value));

  // A human table's chat, as api/table_chat.py keeps it for the tab's own seat.
  const chat: FakeTable["chat"] = [];
  let lines = 0;
  const alliances: [number, number][] = [];
  let offers: { from: number; to: number }[] = [];
  const line = (fields: object) => {
    lines += 1;
    return {
      id: `00000000-0000-4000-9000-${String(lines).padStart(12, "0")}`,
      channel: "table",
      kind: "text",
      seat: fixture.seat,
      sender: {
        id: "00000000-0000-4000-8000-00000000a11c",
        handle: fixture.selfHandle ?? "alice",
      },
      body: "",
      seats: [],
      client_id: null,
      created_at: new Date().toISOString(),
      ...fields,
    };
  };
  const sendAlliances = () =>
    message({ type: "alliances", alliances, offers: [...offers] });
  const talk = (parsed: Record<string, unknown>) => {
    chat.push(parsed);
    const me = fixture.seat!;
    if (parsed.type === "chat" || parsed.type === "emote") {
      const allies = alliances.flatMap(([a, b]) =>
        a === me ? [b] : b === me ? [a] : [],
      );
      message({
        type: "chat",
        message: line({
          channel: parsed.type === "chat" ? parsed.channel : "table",
          kind: parsed.type === "chat" ? "text" : "emote",
          body: parsed.type === "chat" ? parsed.text : parsed.emote,
          seats: parsed.channel === "allies" ? allies : [],
          client_id: parsed.client_id,
        }),
      });
      return;
    }
    const other = Number(parsed.seat);
    const theirs = offers.some((o) => o.from === other && o.to === me);
    if (parsed.action === "offer" && !theirs)
      offers.push({ from: me, to: other });
    else if (parsed.action === "offer" || parsed.action === "accept") {
      offers = offers.filter((o) => !(o.from === other && o.to === me));
      alliances.push([Math.min(me, other), Math.max(me, other)]);
    } else if (parsed.action === "decline" || parsed.action === "withdraw")
      offers = offers.filter(
        (o) =>
          !(o.from === other && o.to === me) &&
          !(o.from === me && o.to === other),
      );
    else {
      const at = alliances.findIndex(
        ([a, b]) => (a === me && b === other) || (a === other && b === me),
      );
      if (at >= 0) alliances.splice(at, 1);
    }
    sendAlliances();
  };

  await page.routeWebSocket(/\/api\/v1\/games\/[^/]+\/events$/, (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      const parsed = JSON.parse(String(raw)) as {
        type: string;
        command?: FakeTable["commands"][number] & { action_id: string };
      };
      if (parsed.type === "hello") {
        message({
          type: "welcome",
          game_id: id,
          connection_id: "fake",
          seat: fixture.seat,
          role: "observer",
          controlled: fixture.seat === null,
        });
        if (fixture.role !== "controller")
          message({ type: "snapshot", snapshot: latest });
        if (humans) {
          message({ type: "chat_history", messages: [] });
          sendAlliances();
        }
      } else if (
        humans &&
        (parsed.type === "chat" ||
          parsed.type === "emote" ||
          parsed.type === "alliance")
      )
        talk(parsed as unknown as Record<string, unknown>);
      else if (parsed.type === "take_control") {
        message({
          type: "lease",
          role: "controller",
          controlled: true,
          reason: "granted",
        });
        message({ type: "snapshot", snapshot: latest });
      } else if (parsed.type === "resync")
        message({ type: "snapshot", snapshot: latest });
      else if (parsed.type === "command" && parsed.command) {
        commands.push(parsed.command);
        message({
          type: "command_result",
          action_id: parsed.command.action_id,
          status: 200,
          body: {},
        });
      }
    });
  });

  await page.goto(`/#game/${id}`);
  return {
    gameId: id,
    fixture,
    commands,
    send(snapshot) {
      latest = snapshot;
      message({ type: "snapshot", snapshot });
    },
    chat,
    say(seat, body) {
      message({
        type: "chat",
        message: line({
          seat,
          sender: {
            id: `00000000-0000-4000-8000-${String(seat).padStart(12, "0")}`,
            handle: humans?.[seat] ?? null,
          },
          body,
        }),
      });
    },
    async problems() {
      const csp = await page
        .evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])
        .catch(() => []);
      return [...errors, ...csp.map((v) => `CSP: ${v}`)];
    },
  };
}

/** The duel fixture at a response moment: Bot 2's Lightning Bolt on the stack in its own turn,
 * and Alice may respond or pass. */
export function respondingFixture(): TableFixture {
  const f = tableFixture("duel");
  const view = f.snapshot.view!;
  view.active_seat = 1;
  view.priority_seat = 0;
  view.stack = [
    {
      id: "fake-bolt",
      kind: "spell",
      controller_seat: 1,
      name: "Lightning Bolt",
      text: "Lightning Bolt deals 3 damage to any target.",
      hidden: false,
      targets: [],
    },
  ];
  f.snapshot.prompt = {
    id: "p-respond",
    kind: "priority",
    message: "Respond to Lightning Bolt?",
    detail: null,
    options: [
      {
        id: "1",
        action: "pass",
        label: null,
        object_id: null,
        seat: null,
        selected: false,
      },
    ],
    amounts: null,
    piles: null,
    xmage_query: null,
  };
  return f;
}
