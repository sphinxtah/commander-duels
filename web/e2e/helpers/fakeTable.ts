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
// table fixtures (src/game/table/fixtures.ts), recording every command the tab sends.

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
  /** Problems the page reported: errors, console errors and CSP violations. */
  problems(): Promise<string[]>;
}

let games = 0;

/** A game id the app's route accepts (a UUID), different for each table. */
function gameId(): string {
  games += 1;
  return `00000000-0000-4000-8000-${String(games).padStart(12, "0")}`;
}

/** Opens the game screen on a fixture, signed in as an active SysOp. */
export async function openTable(
  page: Page,
  options: {
    fixture: FixtureName | TableFixture;
    settings?: Partial<TableSettings>;
  },
): Promise<FakeTable> {
  const fixture =
    typeof options.fixture === "string"
      ? tableFixture(options.fixture)
      : options.fixture;
  const id = gameId();
  fixture.snapshot.game_id = id;
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
      sessionStorage.setItem("cd.ai-notice", "1");
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
          format: fixture.snapshot.settings.format,
          status: fixture.snapshot.result ? "finished" : "active",
          bot_skill: 3,
          turn_cap: 40,
          created_at: "2026-10-20T00:00:00Z",
          finished_at: null,
          result: null,
          seats: fixture.summarySeats,
          your_seat: fixture.seat,
        },
        snapshot: null,
      },
    }),
  );
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
      } else if (parsed.type === "take_control") {
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
