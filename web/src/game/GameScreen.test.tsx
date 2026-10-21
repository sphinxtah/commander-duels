import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { GameScreen } from "./GameScreen";
import type {
  GameView,
  PlayerView,
  PriorityControls,
  Prompt,
  Snapshot,
} from "./types";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  client: { GET: vi.fn(async () => ({ data: undefined })) },
}));

/** The game's WebSocket, driven by the test in the server's place. */
class FakeSocket {
  static readonly OPEN = 1;
  static made: FakeSocket[] = [];
  readyState = 0;
  sent: { type: string; command?: Record<string, unknown> }[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.made.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  accept() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  deliver(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  commands() {
    return this.sent.flatMap((message) =>
      message.type === "command" && message.command ? [message.command] : [],
    );
  }
}

function player(seat: number, name: string): PlayerView {
  return {
    seat,
    name,
    life: 20,
    counters: {},
    library_count: 40,
    hand_count: 7,
    graveyard: [],
    exile: [],
    mana_pool: { white: 0, blue: 0, black: 0, red: 0, green: 0, colorless: 0 },
    lost: false,
    won: false,
    color_identity: null,
    command_zone: [],
    commanders: [],
  };
}
// Alice's seat view: what her own tab and SysOp observing her game both receive.
const view: GameView = {
  seat: 0,
  turn: 12,
  active_seat: 0,
  priority_seat: 0,
  phase: "precombat_main",
  step: null,
  you: player(0, "Alice"),
  opponents: [player(1, "Bot 2")],
  hand: [],
  battlefield: [],
  stack: [],
  combat: [],
  revealed: [],
  looked_at: [],
  messages: [],
  priority: null,
};

function priority(id: string): Prompt {
  return {
    id,
    kind: "priority",
    message: `Prompt ${id}`,
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
}

function snapshot(revision: number, prompt: Prompt | null): Snapshot {
  return {
    game_id: "g1",
    revision,
    status: prompt ? "your_prompt" : "waiting",
    seat: 0,
    settings: {
      format: "legacy",
      rules_profile: "legacy",
      seats: [],
      skill: 3,
      turn_cap: 20,
      idle_timeout_seconds: 900,
      spectator_delay_seconds: 0,
    },
    prompt,
    view,
    result: null,
    log_count: 0,
    log_from: 0,
    log: [],
  };
}

const welcome = (seat: number | null, controlled: boolean) => ({
  type: "welcome",
  game_id: "g1",
  connection_id: "c",
  seat,
  role: "observer",
  controlled,
});

beforeAll(() => {
  // jsdom may not open dialogs; the screen only needs open and close to exist.
  const dialog = HTMLDialogElement.prototype;
  dialog.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  dialog.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});
beforeEach(() => {
  FakeSocket.made = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the game screen", () => {
  it("speaks neutrally to SysOp observing another player's finished game", () => {
    render(<GameScreen gameId="g1" me={null} />);
    const socket = FakeSocket.made[0];
    act(() => {
      socket.accept();
      socket.deliver(welcome(null, true));
      socket.deliver({
        type: "snapshot",
        snapshot: {
          ...snapshot(40, null),
          status: "finished",
          result: {
            kind: "completed",
            winner_seat: 0,
            draw: false,
            conceded_seats: [],
            turns: 12,
            error: null,
          },
        },
      });
    });
    expect(screen.getAllByText("Alice won in 12 turns.")).not.toHaveLength(0);
    expect(screen.getAllByText("Game over")).not.toHaveLength(0);
    expect(screen.queryByText(/You won|Defeat|Victory/)).toBeNull();
    expect(
      screen.getByRole("region", { name: "Alice's side of the table" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /^Alice's hand/ }),
    ).toBeInTheDocument();
    // jsdom has no WebGL: the DOM paints the table.
    expect(document.querySelector("[data-renderer]")).toHaveAttribute(
      "data-renderer",
      "dom",
    );
    expect(screen.queryByText("Your hand")).toBeNull();
    expect(screen.queryByText("Your turn", { exact: false })).toBeNull();
  });

  it("P answers only the prompt on screen, never one that arrived since", async () => {
    render(<GameScreen gameId="g1" me={null} />);
    const socket = FakeSocket.made[0];
    act(() => {
      socket.accept();
      socket.deliver(welcome(0, false));
      socket.deliver({
        type: "lease",
        role: "controller",
        controlled: true,
        reason: "granted",
      });
      socket.deliver({
        type: "snapshot",
        snapshot: snapshot(5, priority("A")),
      });
    });
    expect(screen.getByText("Prompt A")).toBeInTheDocument();
    // The bots plan only on what their seat may see (AI02, v0.3.1): no notice says otherwise.
    expect(screen.queryByText(/read your hand/)).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();

    // Prompt B arrives, and P is pressed before React draws it: prompt A is still on screen.
    socket.deliver({ type: "snapshot", snapshot: snapshot(7, priority("B")) });
    fireEvent.keyDown(document.body, { key: "p" });
    expect(socket.commands()).toEqual([]);

    await waitFor(() =>
      expect(screen.getByText("Prompt B")).toBeInTheDocument(),
    );
    fireEvent.keyDown(document.body, { key: "p" });
    expect(socket.commands()).toEqual([
      expect.objectContaining({
        prompt_id: "B",
        expected_revision: 7,
        payload: { option_id: "1" },
      }),
    ]);
  });

  it("P answers a prompt the moment it is drawn, before later effects run", () => {
    // Presses P during the commit that draws a new prompt: after the page shows it, before the
    // effects React runs once the commit is done.
    let press = () => {};
    function Presser() {
      const [presses, setPresses] = useState(0);
      press = () => setPresses((count) => count + 1);
      useLayoutEffect(() => {
        if (presses > 0)
          document.body.dispatchEvent(
            new KeyboardEvent("keydown", { key: "p", bubbles: true }),
          );
      }, [presses]);
      return null;
    }
    render(
      <>
        <GameScreen gameId="g1" me={null} />
        <Presser />
      </>,
    );
    const socket = FakeSocket.made[0];
    act(() => {
      socket.accept();
      socket.deliver(welcome(0, false));
      socket.deliver({
        type: "lease",
        role: "controller",
        controlled: true,
        reason: "granted",
      });
      socket.deliver({
        type: "snapshot",
        snapshot: snapshot(5, priority("A")),
      });
    });
    act(() => {
      socket.deliver({
        type: "snapshot",
        snapshot: snapshot(7, priority("B")),
      });
      press();
    });
    expect(screen.getByText("Prompt B")).toBeInTheDocument();
    expect(socket.commands()).toEqual([
      expect.objectContaining({ prompt_id: "B", expected_revision: 7 }),
    ]);
  });

  it("says when the game is open in too many tabs", () => {
    render(<GameScreen gameId="g1" me={null} />);
    const socket = FakeSocket.made[0];
    act(() => {
      socket.accept();
      socket.deliver({ type: "error", code: "too_many_connections" });
      socket.onclose?.({ code: 4429 });
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This game is open in too many tabs.",
    );
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
  });
});

const controls: PriorityControls = {
  passing: null,
  your_turn: ["main1", "main2"],
  opponent_turn: ["end_of_turn"],
  stop_on_new_stack_objects: true,
  stop_on_attackers: true,
  stop_on_blockers: true,
  pass_after_casting: false,
  full_control: false,
};

/** Bot 2 has cast a spell in its own turn, and Alice may respond: the response timer's moment. */
const responding: GameView = {
  ...view,
  active_seat: 1,
  priority_seat: 0,
  stack: [
    {
      id: "s1",
      kind: "spell",
      controller_seat: 1,
      name: "Lightning Bolt",
      text: null,
      hidden: false,
      targets: [],
    },
  ],
  priority: controls,
};

/** The table with Alice's tab in control, showing `shown` with prompt A at revision 5. */
function playing(shown: GameView, prompt: Prompt | null = priority("A")) {
  render(<GameScreen gameId="g1" me={null} />);
  const socket = FakeSocket.made[0];
  act(() => {
    socket.accept();
    socket.deliver(welcome(0, false));
    socket.deliver({
      type: "lease",
      role: "controller",
      controlled: true,
      reason: "granted",
    });
    socket.deliver({
      type: "snapshot",
      snapshot: { ...snapshot(5, prompt), view: shown },
    });
  });
  return socket;
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("the response timer on the table", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes for the player once, for the prompt and revision on screen", () => {
    const socket = playing(responding);
    const timer = document.querySelector("[data-timer]");
    expect(timer).toHaveAttribute("role", "timer");
    expect(timer).toHaveAttribute("data-remaining", "8");
    expect(screen.getByRole("button", { name: /Stop Timer/ })).toHaveAttribute(
      "data-timer-stop",
    );
    advance(7900);
    expect(socket.commands()).toEqual([]);
    advance(300);
    expect(socket.commands()).toEqual([
      expect.objectContaining({
        type: "submit_choice",
        prompt_id: "A",
        expected_revision: 5,
        payload: { option_id: "1" },
      }),
    ]);
    advance(20_000);
    expect(socket.commands()).toHaveLength(1);
  });

  it.each([
    ["Space", { key: " " }],
    ["T", { key: "t" }],
  ])(
    "stops for good with %s, and never presses the focused Continue",
    (_, key) => {
      const socket = playing(responding);
      const first = document.querySelector<HTMLElement>("[data-first]")!;
      first.focus();
      const down = new KeyboardEvent("keydown", {
        ...key,
        bubbles: true,
        cancelable: true,
      });
      const up = new KeyboardEvent("keyup", {
        ...key,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        first.dispatchEvent(down);
        first.dispatchEvent(up);
      });
      expect(down.defaultPrevented).toBe(true);
      if (key.key === " ") expect(up.defaultPrevented).toBe(true);
      expect(document.querySelector("[data-timer]")).toHaveAttribute(
        "data-timer",
        "stopped",
      );
      expect(screen.queryByRole("button", { name: /Stop Timer/ })).toBeNull();
      advance(20_000);
      expect(socket.commands()).toEqual([]);
    },
  );

  it("stops with Stop Timer, and focus goes to Continue", () => {
    const socket = playing(responding);
    const stop = screen.getByRole("button", { name: /Stop Timer/ });
    stop.focus();
    act(() => stop.click());
    expect(screen.queryByRole("button", { name: /Stop Timer/ })).toBeNull();
    expect(document.activeElement).toBe(document.querySelector("[data-first]"));
    expect(document.activeElement).toHaveAccessibleName(
      "Continue (Pass priority)",
    );
    advance(20_000);
    expect(socket.commands()).toEqual([]);
  });

  it("never runs for a choice of the player's own, such as an empty stack in their turn", () => {
    const socket = playing({ ...view, priority: controls });
    expect(document.querySelector("[data-timer]")).toBeNull();
    advance(20_000);
    expect(socket.commands()).toEqual([]);
  });
});

describe("Escape on the table", () => {
  const passing: GameView = {
    ...view,
    priority: { ...controls, passing: "until_end_of_turn" },
  };
  const escape = () => {
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.body.dispatchEvent(event);
    });
    return event;
  };

  it("stops a pass with the Priority drawer closed", () => {
    const socket = playing(passing, null);
    expect(
      screen.getByText("Passing until the end of the turn."),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-drawer="priority"]')).toHaveAttribute(
      "hidden",
    );
    escape();
    expect(socket.commands()).toEqual([
      expect.objectContaining({
        type: "set_priority",
        payload: { cancel_passes: true },
      }),
    ]);
  });

  it("closes one layer per press before it stops a pass, and drawers are never dialogs", () => {
    const socket = playing(passing, null);
    const toggle = screen.getByRole("button", { name: "Game log" });
    fireEvent.click(toggle);
    const drawer = document.querySelector('[data-drawer="log"]')!;
    expect(drawer.tagName).not.toBe("DIALOG");
    expect(drawer).toHaveAttribute("data-open");
    fireEvent.click(screen.getByRole("button", { name: "Game menu" }));
    expect(document.getElementById("game-menu")).not.toHaveAttribute("hidden");

    expect(escape().defaultPrevented).toBe(true);
    expect(document.getElementById("game-menu")).toHaveAttribute("hidden");
    expect(escape().defaultPrevented).toBe(true);
    expect(drawer).not.toHaveAttribute("data-open");
    expect(document.activeElement).toBe(toggle);
    expect(socket.commands()).toEqual([]);

    escape();
    expect(socket.commands()).toEqual([
      expect.objectContaining({ type: "set_priority" }),
    ]);
    for (const element of document.querySelectorAll("[data-drawer]"))
      expect(element.tagName).not.toBe("DIALOG");
    // The alerts plate (N2–N4) holds the only alerts.
    expect(screen.queryAllByRole("alert")).toEqual([]);
  });
});

describe("a human table's game (v0.4.0)", () => {
  it("offers the vote on an away player, then shows what the game paid and leads to the lobby", async () => {
    const { client } = await import("../api");
    const get = vi.mocked(client.GET);
    const original = get.getMockImplementation()!;
    const result = {
      kind: "completed",
      winner_seat: 0,
      draw: false,
      conceded_seats: [1],
      turns: 12,
    };
    const human = (seat: number, handle: string) => ({
      seat,
      player: "human",
      handle,
      portrait: null,
      deck: seat === 0 ? "Red deck" : null,
      left: null,
    });
    let finished = false;
    get.mockImplementation((async () => ({
      data: {
        game: {
          id: "g1",
          kind: "table",
          format: "legacy",
          status: finished ? "finished" : "active",
          seats: [human(0, "alice"), human(1, "bob")],
          your_seat: 0,
          bot_skill: 4,
          turn_cap: 60,
          created_at: "2026-10-21T10:00:00Z",
          finished_at: finished ? "2026-10-21T10:30:00Z" : null,
          result: finished ? result : null,
          tokens: finished ? 50 : null,
        },
        snapshot: null,
      },
    })) as never);
    try {
      render(<GameScreen gameId="g1" me={null} />);
      const socket = FakeSocket.made[0];
      act(() => {
        socket.accept();
        socket.deliver(welcome(0, false));
        socket.deliver({
          type: "lease",
          role: "controller",
          controlled: true,
          reason: "granted",
        });
        socket.deliver({
          type: "snapshot",
          snapshot: snapshot(5, priority("A")),
        });
        socket.deliver({
          type: "presence",
          away_after: 120,
          seats: [
            {
              seat: 0,
              connected: true,
              away_seconds: null,
              left: null,
              removable: false,
              yes: [],
              no: [],
              needed: 1,
            },
            {
              seat: 1,
              connected: false,
              away_seconds: 150,
              left: null,
              removable: true,
              yes: [],
              no: [],
              needed: 1,
            },
          ],
        });
      });
      fireEvent.click(
        await screen.findByRole("button", { name: "Vote to remove bob" }),
      );
      expect(socket.sent.at(-1)).toEqual({
        type: "vote",
        seat: 1,
        remove: true,
      });
      expect(
        screen.getByRole("heading", { level: 1, name: /Table game/ }),
      ).toBeInTheDocument();

      finished = true;
      act(() =>
        socket.deliver({
          type: "snapshot",
          snapshot: {
            ...snapshot(6, null),
            status: "finished",
            result: { ...result, error: null },
          },
        }),
      );
      await waitFor(() =>
        expect(
          screen.getAllByText("This game paid you 50 tokens."),
        ).not.toHaveLength(0),
      );
      for (const link of screen.getAllByRole("link", {
        name: "Back to the lobby",
      }))
        expect(link).toHaveAttribute("href", "#tables");
    } finally {
      get.mockImplementation(original);
    }
  });
});
