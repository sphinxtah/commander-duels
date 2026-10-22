import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GameConnection, type GameState } from "./connection";
import type { Prompt, Snapshot } from "./types";

const api = vi.hoisted(() => ({ loadMe: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  loadMe: api.loadMe,
}));

/** A WebSocket the test drives: it records what the page sends and plays the server's part. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static made: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: ({ type: string; command?: Record<string, unknown> } & Record<
    string,
    unknown
  >)[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.made.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.closedWith = code;
    this.readyState = FakeSocket.CLOSED;
  }
  accept() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  deliver(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code = 1006) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code });
  }
  count(type: string) {
    return this.sent.filter((message) => message.type === type).length;
  }
  commands() {
    return this.sent.flatMap((message) =>
      message.type === "command" && message.command ? [message.command] : [],
    );
  }
}

function prompt(id: string, action: "pass" | "toggle_blocker"): Prompt {
  return {
    id,
    kind: action === "pass" ? "priority" : "declare_blockers",
    message: "Choose",
    detail: null,
    options: [
      {
        id: "1",
        action,
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

function snapshot(revision: number, open: Prompt | null): Snapshot {
  return {
    game_id: "g1",
    revision,
    status: open ? "your_prompt" : "waiting",
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
    prompt: open,
    view: null,
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
const lease = (
  role: "controller" | "observer",
  controlled: boolean,
  reason: string,
) => ({ type: "lease", role, controlled, reason });

let connection: GameConnection;
let state: GameState;

/** Starts a connection whose first socket is open and holds the seat's lease at revision 5. */
function playing(): FakeSocket {
  connection = new GameConnection("g1", false, (next) => (state = next));
  connection.start();
  const socket = FakeSocket.made[0];
  socket.accept();
  socket.deliver(welcome(0, false));
  socket.deliver(lease("controller", true, "granted"));
  socket.deliver({
    type: "snapshot",
    snapshot: snapshot(5, prompt("A", "pass")),
  });
  return socket;
}

beforeEach(() => {
  FakeSocket.made = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.useFakeTimers();
  api.loadMe.mockReset();
});
afterEach(() => {
  connection?.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("answers name the prompt the player saw", () => {
  it("refuses an option drawn from an older prompt once a newer one has arrived", () => {
    const socket = playing();
    socket.deliver({ type: "snapshot", snapshot: snapshot(6, null) });
    socket.deliver({
      type: "snapshot",
      snapshot: snapshot(7, prompt("B", "toggle_blocker")),
    });
    // The screen still shows prompt A: its "Pass priority" is option 1, and so is B's first blocker.
    expect(
      connection.answer({ promptId: "A", revision: 5 }, { option_id: "1" }),
    ).toBe(false);
    expect(socket.commands()).toEqual([]);
    expect(state.pending).toBeNull();

    expect(
      connection.answer({ promptId: "B", revision: 7 }, { option_id: "1" }),
    ).toBe(true);
    expect(socket.commands()).toEqual([
      expect.objectContaining({
        prompt_id: "B",
        expected_revision: 7,
        payload: { option_id: "1" },
      }),
    ]);
  });

  it("refuses a newer revision of the same prompt until it is drawn", () => {
    const socket = playing();
    socket.deliver({
      type: "snapshot",
      snapshot: snapshot(6, prompt("A", "pass")),
    });
    expect(
      connection.answer({ promptId: "A", revision: 5 }, { option_id: "1" }),
    ).toBe(false);
    expect(socket.commands()).toEqual([]);
  });
});

describe("the controller lease after a dropped connection", () => {
  it("takes the lease back when the server frees its dead connection, and resends", () => {
    const first = playing();
    connection.answer({ promptId: "A", revision: 5 }, { option_id: "1" });
    const [command] = first.commands();

    // The network changes: the browser closes at once, the server keeps the dead connection.
    first.drop(1006);
    expect(state.phase).toBe("reconnecting");
    vi.advanceTimersByTime(1000);
    const second = FakeSocket.made[1];
    second.accept();
    second.deliver(welcome(0, true));
    second.deliver({
      type: "snapshot",
      snapshot: snapshot(5, prompt("A", "pass")),
    });
    expect(second.count("take_control")).toBe(0);
    expect(state.pending).toEqual(command);

    // The server reaps the dead connection: nobody holds the lease, so this tab takes it.
    second.deliver(lease("observer", false, "disconnected"));
    expect(second.count("take_control")).toBe(1);
    second.deliver(lease("controller", true, "granted"));
    expect(state.role).toBe("controller");
    expect(second.commands()).toEqual([command]);
  });

  it("leaves the lease alone after giving it to another tab, and when observing", () => {
    const socket = playing();
    socket.deliver(lease("observer", true, "taken_over"));
    socket.deliver(lease("observer", false, "disconnected"));
    expect(socket.count("take_control")).toBe(1);
    expect(state.takenOver).toBe(true);
    connection.stop();

    // SysOp observing another player's game owns no seat and never asks for its lease.
    connection = new GameConnection("g1", false, (next) => (state = next));
    connection.start();
    const observer = FakeSocket.made[1];
    observer.accept();
    observer.deliver(welcome(null, true));
    observer.deliver(lease("observer", false, "disconnected"));
    expect(observer.count("take_control")).toBe(0);
  });
});

describe("a session refresh", () => {
  it("reconnects at once the first time, then waits out the backoff until a welcome", async () => {
    api.loadMe.mockResolvedValue(null);
    const first = playing();
    first.deliver({ type: "error", code: "session_refresh" });
    first.drop(4401);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.loadMe).toHaveBeenCalledTimes(1);
    expect(FakeSocket.made).toHaveLength(2);

    // The cookie was not renewed (a token rotated a moment ago stands for its successor and is
    // not rotated again), so the server asks again. The page now waits before it asks.
    const second = FakeSocket.made[1];
    second.accept();
    second.deliver({ type: "error", code: "session_refresh" });
    second.drop(4401);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.made).toHaveLength(2);
    expect(api.loadMe).toHaveBeenCalledTimes(1);
    expect(state.phase).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.loadMe).toHaveBeenCalledTimes(2);
    expect(FakeSocket.made).toHaveLength(3);

    // A welcome ends it: the next change of roles reconnects at once again.
    const third = FakeSocket.made[2];
    third.accept();
    third.deliver(welcome(0, true));
    third.deliver({ type: "error", code: "session_refresh" });
    third.drop(4401);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.made).toHaveLength(4);
  });
});

describe("too many tabs", () => {
  it("says why the tab waits, and connects once a slot is free", () => {
    connection = new GameConnection("g1", false, (next) => (state = next));
    connection.start();
    const first = FakeSocket.made[0];
    first.accept();
    first.deliver({ type: "error", code: "too_many_connections" });
    first.drop(4429);
    expect(state).toMatchObject({ phase: "reconnecting", crowded: true });

    vi.advanceTimersByTime(1000);
    const second = FakeSocket.made[1];
    second.accept();
    second.deliver(welcome(0, true));
    expect(state).toMatchObject({ phase: "open", crowded: false });
  });
});

describe("one socket at a time", () => {
  it("coming back online while a reconnect is opening opens no second socket", () => {
    const first = playing();
    first.drop(1006);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.made).toHaveLength(2);
    window.dispatchEvent(new Event("online"));
    expect(FakeSocket.made).toHaveLength(2);

    // While the backoff is still waiting, coming back online reconnects at once.
    FakeSocket.made[1].drop(1006);
    window.dispatchEvent(new Event("online"));
    expect(FakeSocket.made).toHaveLength(3);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.made).toHaveLength(3);
  });

  it("a replaced socket is closed and its frames are ignored", async () => {
    let renewed = () => {};
    api.loadMe.mockReturnValue(
      new Promise((resolve) => (renewed = () => resolve(null))),
    );
    const first = playing();
    first.drop(1006);
    vi.advanceTimersByTime(1000);
    // The roles changed: the server asks for a renewed session, which takes a moment.
    const second = FakeSocket.made[1];
    second.accept();
    second.deliver({ type: "error", code: "session_refresh" });
    second.drop(4401);
    window.dispatchEvent(new Event("online"));
    const third = FakeSocket.made[2];
    const staleFrames = third.onmessage;
    renewed();
    await vi.waitFor(() => expect(FakeSocket.made).toHaveLength(4));
    expect(third.closedWith).toBe(1000);

    const fourth = FakeSocket.made[3];
    fourth.accept();
    fourth.deliver(welcome(0, false));
    fourth.deliver(lease("controller", true, "granted"));
    staleFrames?.({ data: JSON.stringify(lease("observer", true, "granted")) });
    expect(state.role).toBe("controller");

    connection.stop();
    expect(fourth.closedWith).toBe(1000);
  });
});

describe("priority controls", () => {
  const controls = {
    passing: "until_end_of_turn",
    your_turn: ["main1"],
    opponent_turn: [],
    stop_on_new_stack_objects: true,
    stop_on_attackers: true,
    stop_on_blockers: true,
    pass_after_casting: false,
    full_control: false,
  };

  it("sends a setting without a prompt and keeps the reply's controls until the next view", () => {
    const socket = playing();
    socket.deliver({ type: "snapshot", snapshot: snapshot(6, null) });
    expect(connection.setPriority({ full_control: true })).toBe(true);
    const [command] = socket.commands();
    expect(command).toEqual(
      expect.objectContaining({
        type: "set_priority",
        expected_revision: 6,
        payload: { full_control: true },
      }),
    );
    expect(command).not.toHaveProperty("prompt_id");
    // One command at a time.
    expect(connection.setPriority({ cancel_passes: true })).toBe(false);

    socket.deliver({
      type: "command_result",
      action_id: command.action_id,
      status: 200,
      body: { priority: controls },
    });
    expect(state.pending).toBeNull();
    expect(state.priority).toEqual(controls);
    socket.deliver({ type: "snapshot", snapshot: snapshot(7, null) });
    expect(state.priority).toBeNull();
  });

  it("is not sent by a tab that observes", () => {
    const socket = playing();
    socket.deliver(lease("observer", true, "taken_over"));
    expect(connection.setPriority({ full_control: true })).toBe(false);
    expect(socket.commands()).toEqual([]);
  });
});

describe("away players at a human table (v0.4.0)", () => {
  it("keeps who is away, sends votes and says why one was refused", () => {
    const socket = playing();
    expect(state.presence).toBeNull();
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    const away = {
      seat: 1,
      connected: false,
      away_seconds: 130,
      left: null,
      removable: true,
      yes: [],
      no: [],
      needed: 1,
    };
    socket.deliver({ type: "presence", away_after: 120, seats: [away] });
    expect(state.presence).toEqual({
      away_after: 120,
      seats: [away],
      received: Date.parse("2026-10-21T12:00:00Z"),
    });

    connection.vote(1, true);
    expect(socket.sent.at(-1)).toEqual({ type: "vote", seat: 1, remove: true });
    socket.deliver({
      type: "error",
      code: "not_removable",
      message: "That player is not away.",
      seat: 1,
    });
    expect(state.voteRefusal).toBe("That player is not away.");
    // Voting again clears it; another error is no vote's refusal.
    connection.vote(1, false);
    expect(state.voteRefusal).toBeNull();
    socket.deliver({ type: "error", code: "invalid_message" });
    expect(state.voteRefusal).toBeNull();
  });
});

describe("the table's chat and alliances (v0.4.4)", () => {
  const line = (id: string, fields: Record<string, unknown> = {}) => ({
    id,
    channel: "table",
    kind: "text",
    seat: 1,
    sender: { id: "u-bob", handle: "bob" },
    body: `line ${id}`,
    seats: [],
    client_id: null,
    created_at: `2026-10-22T10:00:0${id}+00:00`,
    ...fields,
  });
  const echo = (id: string, sent: Record<string, unknown>) =>
    line(id, {
      seat: 0,
      sender: { id: "u-ada", handle: "ada" },
      body: sent.text,
      client_id: sent.client_id,
    });

  it("keeps the history and each new line, once each, in the order written", () => {
    const socket = playing();
    expect(state.chat).toBeNull();
    socket.deliver({ type: "chat_history", messages: [line("1"), line("2")] });
    socket.deliver({ type: "chat", message: line("3") });
    // A reconnect's history repeats what the tab has.
    socket.deliver({ type: "chat_history", messages: [line("2"), line("3")] });
    expect(state.chat?.map((each) => each.id)).toEqual(["1", "2", "3"]);
    socket.deliver({
      type: "alliances",
      alliances: [[0, 1]],
      offers: [{ from: 2, to: 0 }],
    });
    expect(state.alliances).toEqual({
      alliances: [[0, 1]],
      offers: [{ from: 2, to: 0 }],
    });
  });

  it("sends a message with a fresh client_id, which waits until the server sends it back", () => {
    const socket = playing();
    socket.deliver({ type: "chat_history", messages: [] });
    connection.chat("allies", "Attack Cara next");
    const sent = socket.sent.at(-1)!;
    expect(sent).toEqual({
      type: "chat",
      channel: "allies",
      text: "Attack Cara next",
      client_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(state.outbox).toEqual([
      expect.objectContaining({
        client_id: sent.client_id,
        status: "pending",
        body: "Attack Cara next",
      }),
    ]);
    connection.emote("good_game");
    expect(socket.sent.at(-1)).toEqual({
      type: "emote",
      emote: "good_game",
      client_id: expect.any(String),
    });
    expect(socket.sent.at(-1)!.client_id).not.toBe(sent.client_id);

    socket.deliver({ type: "chat", message: echo("1", sent) });
    expect(state.outbox.map((each) => each.body)).toEqual(["good_game"]);
    expect(state.chat?.map((each) => each.client_id)).toEqual([sent.client_id]);
  });

  it("marks a refused message failed without ending anything, and tries it again under its client_id", () => {
    const socket = playing();
    connection.chat("table", "Hello");
    const sent = socket.sent.at(-1)!;
    socket.deliver({
      type: "error",
      code: "chat_limited",
      message: "You are sending messages very fast. Wait a moment.",
      client_id: sent.client_id,
      retry_after: 3,
    });
    expect(state.outbox[0]).toMatchObject({
      status: "failed",
      error:
        "You are sending messages very fast. Wait 3 seconds, then try again.",
    });
    expect(state.phase).toBe("open");

    connection.retryChat(String(sent.client_id));
    expect(socket.sent.at(-1)).toEqual(sent);
    expect(state.outbox).toEqual([
      expect.objectContaining({ status: "pending", error: null }),
    ]);
    socket.deliver({
      type: "error",
      code: "no_allies",
      message: "You have no allies at this table.",
      client_id: sent.client_id,
    });
    expect(state.outbox[0].error).toBe("You have no allies at this table.");
    connection.discardChat(String(sent.client_id));
    expect(state.outbox).toEqual([]);

    // A chat refusal just before a close is not why the connection closed.
    socket.deliver({ type: "error", code: "session_refresh" });
    socket.deliver({
      type: "error",
      code: "invalid_message",
      client_id: null,
    });
    api.loadMe.mockResolvedValue(null);
    socket.drop(4401);
    expect(state.phase).not.toBe("ended");
  });

  it("after a reconnect, fails a message the history does not hold, but not one sent since", () => {
    const first = playing();
    first.deliver({ type: "chat_history", messages: [] });
    connection.chat("table", "Lost in the drop");
    const lost = first.sent.at(-1)!;
    first.drop(1006);
    vi.advanceTimersByTime(1000);
    const second = FakeSocket.made[1];
    second.accept();
    second.deliver(welcome(0, true));
    connection.chat("table", "Sent after the welcome");
    const fresh = second.sent.at(-1)!;
    second.deliver({ type: "chat_history", messages: [] });
    expect(state.outbox.map((each) => [each.client_id, each.status])).toEqual([
      [lost.client_id, "failed"],
      [fresh.client_id, "pending"],
    ]);
  });

  it("sends alliance requests, and says why one was refused apart from votes", () => {
    const socket = playing();
    connection.alliance("offer", 2);
    expect(socket.sent.at(-1)).toEqual({
      type: "alliance",
      action: "offer",
      seat: 2,
    });
    socket.deliver({
      type: "error",
      code: "not_in_game",
      message: "That player is out of the game.",
      seat: 2,
    });
    expect(state.allianceRefusal).toBe("That player is out of the game.");
    expect(state.voteRefusal).toBeNull();

    // The same code after a vote is the vote's.
    connection.vote(1, true);
    socket.deliver({
      type: "error",
      code: "not_in_game",
      message: "You are out of this game.",
      seat: 1,
    });
    expect(state.voteRefusal).toBe("You are out of this game.");
    connection.alliance("end", 1);
    expect(state.allianceRefusal).toBeNull();
    socket.deliver({
      type: "error",
      code: "not_allied",
      message: "You are not allies.",
      seat: 1,
    });
    expect(state.allianceRefusal).toBe("You are not allies.");
  });
});
