import { useEffect, useState } from "react";
import { currentCsrfToken, loadMe } from "../api";
import type {
  CommandEnvelope,
  Inspection,
  LogLine,
  ServerMessage,
  Snapshot,
  PriorityControls,
  PrioritySettings,
} from "./types";

// One game's WebSocket (docs/games.md): the hello with the CSRF token, the controller lease,
// commands with action IDs, resynchronising by revision, and resending after a reconnect. A resend
// keeps its action ID, so the engine applies it at most once (T14).

export interface GameState {
  phase: "connecting" | "open" | "reconnecting" | "ended";
  /** Why the connection stopped for good. */
  ended: EndReason | null;
  /** The seat this account owns, or null when observing someone else's game (SysOp). */
  seat: number | null;
  role: "controller" | "observer";
  /** Whether any tab holds the seat's lease. */
  controlled: boolean;
  /** This tab lost control to another tab and waits for "Play here". */
  takenOver: boolean;
  snapshot: Snapshot | null;
  log: LogLine[];
  inspection: Inspection | null;
  /** The command sent and not yet answered. */
  pending: CommandEnvelope | null;
  /** The engine's or the API's last refusal, in words. */
  refusal: string | null;
  interrupted: boolean;
  /** The server refused this tab: the account has the game open in too many tabs already. */
  crowded: boolean;
  /** The priority controls a set_priority reply reported, until the next view shows them. */
  priority: PriorityControls | null;
}

export type EndReason =
  "finished" | "not_live" | "signed_out" | "forbidden" | "not_found";

/** The prompt an answer was chosen from, as the screen drew it. */
export interface Seen {
  promptId: string;
  revision: number;
}

const initial: GameState = {
  phase: "connecting",
  ended: null,
  seat: null,
  role: "observer",
  controlled: false,
  takenOver: false,
  snapshot: null,
  log: [],
  inspection: null,
  pending: null,
  refusal: null,
  interrupted: false,
  crowded: false,
  priority: null,
};
const LOG_KEPT = 400;

/** crypto.randomUUID needs a secure context; plain-HTTP test hosts get the same from bytes. */
export function newActionId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function mergeLog(log: LogLine[], lines: LogLine[]): LogLine[] {
  if (lines.length === 0) return log;
  const byIndex = new Map(log.map((line) => [line.index, line]));
  for (const line of lines) byIndex.set(line.index, line);
  return [...byIndex.values()]
    .sort((a, b) => a.index - b.index)
    .slice(-LOG_KEPT);
}

const refusals: Record<string, string> = {
  invalid_option: "That option is no longer offered.",
  invalid_amounts: "Those amounts are not allowed.",
  game_over: "The game is over.",
  unsupported_prompt: "This choice is not supported yet.",
  engine_unavailable: "The rules engine did not answer. Try again.",
  invalid_command: "The command was malformed.",
};

export class GameConnection {
  private state: GameState = initial;
  private socket: WebSocket | null = null;
  private attempts = 0;
  private timer: number | undefined;
  private stopped = false;
  private lastError: string | null = null;
  // After another tab takes the lease, this tab never takes it back by itself.
  private yielded = false;
  // A session refresh since the last welcome: another one waits out the backoff.
  private refreshed = false;

  constructor(
    private readonly gameId: string,
    private readonly inspect: boolean,
    private readonly publish: (state: GameState) => void,
  ) {}

  start(): void {
    window.addEventListener("online", this.online);
    this.open();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener("online", this.online);
    window.clearTimeout(this.timer);
    this.socket?.close(1000);
    this.socket = null;
  }

  /** Answers the prompt the player saw; false when this tab cannot answer now, or when a newer
   * prompt or revision arrived after that one was drawn. Option IDs count from 1 in every prompt,
   * so an option taken from an older prompt would otherwise answer the new one. */
  answer(seen: Seen, payload: CommandEnvelope["payload"]): boolean {
    const { snapshot, pending, role } = this.state;
    if (!snapshot?.prompt || pending || role !== "controller") return false;
    if (
      snapshot.prompt.id !== seen.promptId ||
      snapshot.revision !== seen.revision
    )
      return false;
    return this.command({
      v: 1,
      game_id: snapshot.game_id,
      action_id: newActionId(),
      expected_revision: seen.revision,
      prompt_id: seen.promptId,
      type: "submit_choice",
      payload,
    });
  }

  concede(): boolean {
    const { snapshot, pending, role } = this.state;
    if (!snapshot || pending || role !== "controller") return false;
    return this.command({
      v: 1,
      game_id: snapshot.game_id,
      action_id: newActionId(),
      expected_revision: snapshot.revision,
      type: "concede",
      payload: {},
    });
  }

  /** Changes the seat's priority controls. It needs no prompt: a pass can be cancelled while the
   * engine is passing. */
  setPriority(settings: PrioritySettings): boolean {
    const { snapshot, pending, role } = this.state;
    if (!snapshot || pending || role !== "controller") return false;
    return this.command({
      v: 1,
      game_id: snapshot.game_id,
      action_id: newActionId(),
      expected_revision: snapshot.revision,
      type: "set_priority",
      payload: settings,
    });
  }

  /** "Play here": moves the lease to this tab. */
  takeControl(): void {
    this.yielded = false;
    this.send({ type: "take_control" });
  }

  private command(envelope: CommandEnvelope): boolean {
    this.update({ pending: envelope, refusal: null });
    this.send({ type: "command", command: envelope });
    return true;
  }

  private update(change: Partial<GameState>): void {
    this.state = { ...this.state, ...change };
    this.publish(this.state);
  }

  private send(message: object): void {
    if (this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(JSON.stringify(message));
  }

  // Back online: a reconnect still waiting out its backoff starts now. One whose socket is already
  // opening is left to finish, so the tab never holds two sockets.
  private readonly online = () => {
    if (this.state.phase === "reconnecting" && this.socket === null) {
      window.clearTimeout(this.timer);
      this.open();
    }
  };

  private open(): void {
    if (this.stopped) return;
    const previous = this.socket;
    if (previous) {
      previous.onopen = previous.onmessage = previous.onclose = null;
      previous.close(1000);
    }
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${scheme}//${window.location.host}/api/v1/games/${this.gameId}/events`,
    );
    this.socket = socket;
    this.lastError = null;
    // A replaced socket says nothing more: its welcome or lease would overwrite this one's.
    socket.onopen = () => {
      if (this.socket !== socket) return;
      socket.send(
        JSON.stringify({
          type: "hello",
          csrf_token: currentCsrfToken() ?? "",
          since: this.state.snapshot?.revision ?? -1,
          // The lease is taken after the welcome, once it says no other tab plays.
          control: false,
          inspect: this.inspect,
        }),
      );
    };
    socket.onmessage = (event: MessageEvent<string>) => {
      if (this.socket !== socket) return;
      try {
        this.receive(JSON.parse(event.data) as ServerMessage);
      } catch {
        // A malformed message is ignored; the next snapshot resynchronises.
      }
    };
    socket.onclose = (event) => {
      if (this.socket === socket) void this.closed(event.code);
    };
  }

  private receive(message: ServerMessage): void {
    switch (message.type) {
      case "welcome":
        this.attempts = 0;
        this.refreshed = false;
        this.update({
          phase: "open",
          seat: message.seat,
          role: "observer",
          controlled: message.controlled,
          crowded: false,
        });
        if (message.seat !== null && !message.controlled && !this.yielded)
          this.send({ type: "take_control" });
        break;
      case "lease": {
        const controller = message.role === "controller";
        if (controller) this.yielded = false;
        else if (message.reason === "taken_over") this.yielded = true;
        this.update({
          role: message.role,
          controlled: message.controlled,
          takenOver: !controller && this.yielded,
        });
        // A command whose reply was lost goes again with the same action ID.
        if (controller && this.state.pending)
          this.send({ type: "command", command: this.state.pending });
        // The lease came free. After a drop the server noticed late, the tab that held it saw
        // its own dead connection as another tab; it takes the seat back unless it gave it up.
        if (
          !controller &&
          !message.controlled &&
          !this.yielded &&
          this.state.seat !== null &&
          this.state.phase === "open"
        )
          this.send({ type: "take_control" });
        break;
      }
      case "snapshot": {
        const current = this.state.snapshot;
        const next = message.snapshot;
        if (
          current &&
          next.revision <= current.revision &&
          next.result === null &&
          current.game_id === next.game_id
        )
          break;
        // A command still unanswered is dropped only when another tab holds the lease and moved
        // the game on. After a reconnect the snapshot comes before the lease: nobody controls the
        // seat yet, and the command is resent once this tab takes control again.
        const pending =
          this.state.pending &&
          this.state.role !== "controller" &&
          this.state.controlled &&
          next.revision > this.state.pending.expected_revision
            ? null
            : this.state.pending;
        this.update({
          snapshot: next,
          log: mergeLog(this.state.log, next.log),
          pending,
          priority: null,
        });
        break;
      }
      case "command_result": {
        if (message.action_id !== this.state.pending?.action_id) break;
        const code = message.body.code ?? "";
        let refusal: string | null = null;
        if (message.status !== 200) {
          if (code === "stale_revision" || code === "stale_prompt")
            this.send({
              type: "resync",
              since: this.state.snapshot?.revision ?? -1,
            });
          else if (code === "not_controller")
            refusal = "Another tab is playing this seat.";
          else
            refusal =
              refusals[code] ?? message.body.message ?? "That was refused.";
        }
        const controls = (message.body as { priority?: PriorityControls })
          .priority;
        this.update({
          pending: null,
          refusal,
          ...(controls ? { priority: controls } : {}),
        });
        break;
      }
      case "inspection":
        this.update({ inspection: message.inspection });
        break;
      case "interrupted":
        this.update({ interrupted: true });
        break;
      case "error":
        this.lastError = message.code;
        break;
      case "pong":
        break;
    }
  }

  private async closed(code: number): Promise<void> {
    this.socket = null;
    if (this.stopped) return;
    const end = (reason: EndReason) =>
      this.update({ phase: "ended", ended: reason, role: "observer" });
    if (code === 4401 && this.lastError === "session_refresh") {
      // The account's roles changed: any request rotates the cookie, then reconnect, at once the
      // first time since a welcome. A cookie rotated a moment ago stands for its successor for a
      // minute and is not rotated again meanwhile, so the server may keep asking that long; later
      // refreshes wait out the backoff instead of looping.
      const refresh = async () => {
        await loadMe().catch(() => null);
        this.open();
      };
      if (this.refreshed) return this.reconnect(() => void refresh());
      this.refreshed = true;
      return refresh();
    }
    if (code === 4401) return end("signed_out");
    if (code === 4403) {
      if (this.lastError === "csrf_failed" && this.attempts === 0) {
        this.attempts += 1;
        await loadMe().catch(() => null);
        this.open();
        return;
      }
      return end("forbidden");
    }
    if (code === 4404) return end("not_found");
    if (code === 4410) return end("not_live");
    if (code === 1000 && this.state.snapshot?.result) return end("finished");
    // Anything else (a dropped network, a restart, 4408) reconnects with backoff. A tab refused
    // because the account has the game open in too many (4429) says so, and connects once
    // another tab closes or the server drops a dead connection.
    this.reconnect(() => this.open(), {
      crowded: code === 4429 && this.lastError === "too_many_connections",
    });
  }

  /** Tries again after a delay that grows with each attempt since the last welcome. */
  private reconnect(
    attempt: () => void,
    change: Partial<GameState> = {},
  ): void {
    const delay =
      Math.min(15000, 500 * 2 ** Math.min(this.attempts, 5)) +
      Math.random() * 300;
    this.attempts += 1;
    this.update({ phase: "reconnecting", role: "observer", ...change });
    this.timer = window.setTimeout(attempt, delay);
  }
}

/** The game's live state, and the connection to act on it. */
export function useGame(
  gameId: string,
  inspect: boolean,
): [GameState, GameConnection | null] {
  const [state, setState] = useState<GameState>(initial);
  const [connection, setConnection] = useState<GameConnection | null>(null);
  useEffect(() => {
    setState(initial);
    const current = new GameConnection(gameId, inspect, setState);
    setConnection(current);
    current.start();
    return () => current.stop();
  }, [gameId, inspect]);
  return [state, connection];
}
