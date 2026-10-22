import { useEffect, useState } from "react";
import { currentCsrfToken, loadMe } from "../api";
import type {
  AllianceAction,
  Alliances,
  ChatLine,
  CommandEnvelope,
  EmoteName,
  Inspection,
  LogLine,
  Presence,
  Seat,
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
  /** At a human table (v0.4.0): who is away and the votes on removing them, with when this tab
   * received it (Date.now()), so away times count on. Null elsewhere. */
  presence: (Presence & { received: number }) | null;
  /** Why the server refused this tab's vote, in words. */
  voteRefusal: string | null;
  /** At a human table (v0.4.4): the chat lines this connection may see, oldest first. Null until
   * the history arrives, and in a practice game, which has no chat. */
  chat: ChatLine[] | null;
  /** The messages and emotes this tab sent that have not come back from the server yet, or that
   * it refused. */
  outbox: OutgoingChat[];
  /** At a human table: every alliance, and the offers this seat made or received. */
  alliances: Alliances | null;
  /** Why the server refused this tab's last alliance request, in words. */
  allianceRefusal: string | null;
}

/** A message or emote this tab sent, until the server sends it back with the same client_id. */
export interface OutgoingChat {
  client_id: string;
  kind: "text" | "emote";
  channel: "table" | "allies";
  /** The text, or the emote's name. */
  body: string;
  status: "pending" | "failed";
  /** Why it failed, in words. */
  error: string | null;
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
  presence: null,
  voteRefusal: null,
  chat: null,
  outbox: [],
  alliances: null,
  allianceRefusal: null,
};
/** The server's refusals of a vote: their message says why. */
const VOTE_REFUSALS = new Set([
  "not_a_player",
  "invalid_vote",
  "not_in_game",
  "not_removable",
  "removal_failed",
]);
/** The refusals only an alliance request gets. not_a_player and not_in_game answer a vote too, so
 * those go to whichever of the two this tab asked for last. */
const ALLIANCE_REFUSALS = new Set([
  "invalid_alliance",
  "already_allied",
  "no_offer",
  "not_allied",
]);
const LOG_KEPT = 400;
/** The chat lines a tab keeps: a reconnect's history holds the latest 200. */
const CHAT_KEPT = 500;
const UNSENT = "This message may not have reached the table. Try again.";

function chatRefusal(message: {
  code: string;
  message?: string;
  retry_after?: number;
}): string {
  if (message.code === "chat_limited") {
    const seconds = Math.max(1, Math.ceil(message.retry_after ?? 1));
    return `You are sending messages very fast. Wait ${seconds} ${
      seconds === 1 ? "second" : "seconds"
    }, then try again.`;
  }
  return message.message ?? "That message was not sent.";
}

/** Lines added to the chat by their IDs, in the order they were written. A line sent again (a
 * reconnect's history repeats what the tab has) replaces itself. */
function mergeChat(chat: ChatLine[], lines: ChatLine[]): ChatLine[] {
  if (lines.length === 0) return chat;
  const byId = new Map(chat.map((line) => [line.id, line]));
  for (const line of lines) byId.set(line.id, line);
  // A stable sort: lines written in the same millisecond keep the order they arrived in.
  return [...byId.values()]
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .slice(-CHAT_KEPT);
}

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
  // The sockets opened so far, and which one each waiting chat message went out on: a reconnect's
  // history settles only the messages sent before it.
  private sockets = 0;
  private readonly sentOn = new Map<string, number>();
  // A vote and an alliance request share two refusals; they answer the one asked for last.
  private asked: "vote" | "alliance" | null = null;

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

  /** At a human table: votes on removing an away player's seat (true), or to wait (false). */
  vote(seat: Seat, remove: boolean): void {
    this.asked = "vote";
    this.update({ voteRefusal: null });
    this.send({ type: "vote", seat, remove });
  }

  /** At a human table (v0.4.4): a message to the whole table, or to this seat's allies alone. It
   * waits in the outbox until the server sends it back. */
  chat(channel: OutgoingChat["channel"], text: string): void {
    this.post({ client_id: newActionId(), kind: "text", channel, body: text });
  }

  /** At a human table: an emote, to the whole table. */
  emote(emote: EmoteName): void {
    this.post({
      client_id: newActionId(),
      kind: "emote",
      channel: "table",
      body: emote,
    });
  }

  /** Sends a failed message again under its own client_id, so that it lands once. */
  retryChat(clientId: string): void {
    const entry = this.state.outbox.find(
      (each) => each.client_id === clientId && each.status === "failed",
    );
    if (entry) this.post(entry);
  }

  /** Forgets a failed message. */
  discardChat(clientId: string): void {
    this.sentOn.delete(clientId);
    this.update({
      outbox: this.state.outbox.filter((each) => each.client_id !== clientId),
    });
  }

  /** At a human table: offers, accepts, declines, withdraws or ends an alliance with a seat. */
  alliance(action: AllianceAction, seat: Seat): void {
    this.asked = "alliance";
    this.update({ allianceRefusal: null });
    this.send({ type: "alliance", action, seat });
  }

  private post(
    message: Pick<OutgoingChat, "client_id" | "kind" | "channel" | "body">,
  ): void {
    const open = this.socket?.readyState === WebSocket.OPEN;
    const entry: OutgoingChat = {
      ...message,
      status: open ? "pending" : "failed",
      error: open ? null : "Not connected. Try again once the table is back.",
    };
    const known = this.state.outbox.some(
      (each) => each.client_id === entry.client_id,
    );
    this.update({
      outbox: known
        ? this.state.outbox.map((each) =>
            each.client_id === entry.client_id ? entry : each,
          )
        : [...this.state.outbox, entry],
    });
    if (!open) return;
    this.sentOn.set(entry.client_id, this.sockets);
    this.send(
      entry.kind === "emote"
        ? { type: "emote", emote: entry.body, client_id: entry.client_id }
        : {
            type: "chat",
            channel: entry.channel,
            text: entry.body,
            client_id: entry.client_id,
          },
    );
  }

  /** The outbox without the messages these lines bring back. After a reconnect's history, a
   * message sent on an earlier socket that is not among them never reached the table. */
  private settle(lines: ChatLine[], history: boolean): OutgoingChat[] {
    const outbox = this.state.outbox;
    if (outbox.length === 0) return outbox;
    const arrived = new Set(lines.map((line) => line.client_id));
    const left = outbox.filter((each) => !arrived.has(each.client_id));
    for (const each of outbox)
      if (arrived.has(each.client_id)) this.sentOn.delete(each.client_id);
    if (!history) return left.length === outbox.length ? outbox : left;
    return left.map((each) =>
      each.status === "pending" &&
      (this.sentOn.get(each.client_id) ?? 0) < this.sockets
        ? { ...each, status: "failed", error: UNSENT }
        : each,
    );
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
    this.sockets += 1;
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
      case "presence":
        this.update({
          presence: {
            away_after: message.away_after,
            seats: message.seats,
            received: Date.now(),
          },
        });
        break;
      case "chat_history":
        this.update({
          chat: mergeChat(this.state.chat ?? [], message.messages),
          outbox: this.settle(message.messages, true),
        });
        break;
      case "chat":
        this.update({
          chat: mergeChat(this.state.chat ?? [], [message.message]),
          outbox: this.settle([message.message], false),
        });
        break;
      case "alliances":
        this.update({
          alliances: { alliances: message.alliances, offers: message.offers },
        });
        break;
      case "error": {
        // A refusal names the chat message or the seat it answers. It ends nothing: only the
        // errors before a close say why the connection stops.
        if (message.client_id !== undefined) {
          const failed = message.client_id;
          if (failed)
            this.update({
              outbox: this.state.outbox.map((each) =>
                each.client_id === failed
                  ? { ...each, status: "failed", error: chatRefusal(message) }
                  : each,
              ),
            });
          break;
        }
        const code = message.code;
        if (message.seat === undefined) this.lastError = code;
        if (
          ALLIANCE_REFUSALS.has(code) ||
          (this.asked === "alliance" &&
            (code === "not_a_player" || code === "not_in_game"))
        )
          this.update({
            allianceRefusal: message.message ?? "That was refused.",
          });
        else if (VOTE_REFUSALS.has(code))
          this.update({
            voteRefusal: message.message ?? "That vote was refused.",
          });
        break;
      }
      case "pong":
        break;
    }
  }

  private async closed(code: number): Promise<void> {
    this.socket = null;
    if (this.stopped) return;
    // A message still waiting will not come back now.
    const end = (reason: EndReason) =>
      this.update({
        phase: "ended",
        ended: reason,
        role: "observer",
        outbox: this.state.outbox.map((each) =>
          each.status === "pending"
            ? { ...each, status: "failed", error: UNSENT }
            : each,
        ),
      });
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
