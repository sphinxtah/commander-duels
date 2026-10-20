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
import type { GameView, PlayerView, Prompt, Snapshot } from "./types";

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
