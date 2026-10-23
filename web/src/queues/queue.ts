import { useSyncExternalStore } from "react";
import { client, describe } from "../api";
import type { components } from "../generated/api";

// The public queues (v0.5.0, docs/queues.md): the account's place in one, shared by the Play
// page's "Find a game", the main menu's Play tile and the follower in the app's shell. While the
// account waits, the place is asked for every QUEUE_POLL_MS (which also keeps it: a place nobody
// asks about goes after a while), and once the queue finds a game the page opens it. Since v0.5.1
// the same goes while the account invites a friend to the Two-Headed Giant queue, or a friend's
// invitation waits for its answer.

export type QueueStatus = components["schemas"]["QueueStatus"];
export type QueueInfo = components["schemas"]["QueueInfo"];
export type QueueRequest = components["schemas"]["QueueRequest"];
export type QueueFormat = QueueRequest["format"];
export type TeamInvite = components["schemas"]["TeamInvite"];

/** Two-Headed Giant's queue (v0.5.1): two teams of two, formed alone or with a friend. */
export const TEAM_QUEUE = "two_headed_giant";

/** How often a waiting account's place is asked for. */
export const QUEUE_POLL_MS = 2000;

/** A queue's seats as the choices say them: "2 players". */
export function players(seats: number): string {
  return `${seats} players`;
}

/** Minutes and seconds waited: "0:07", "12:40". */
export function waited(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** 1st, 2nd, 3rd, 4th… */
export function ordinal(place: number): string {
  const tens = place % 100;
  const suffix =
    tens >= 11 && tens <= 13
      ? "th"
      : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[place % 10];
  return `${place}${suffix ?? "th"}`;
}

interface QueueState {
  /** The place as last answered; null until the first answer. */
  status: QueueStatus | null;
  /** When that answer came (Date.now()), to count the time waited on from it. */
  answeredAt: number;
}

let state: QueueState = { status: null, answeredAt: 0 };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let asking = false;
// Whether this page saw the account wait (or join): only then does a game found open by itself.
let sawWaiting = false;
const followed = new Set<string>();

/** Whether the place is worth asking about again soon: waiting, inviting a friend, or answering a
 * friend's invitation. */
function pending(status: QueueStatus | null): boolean {
  return (
    status !== null &&
    (status.status === "waiting" ||
      status.status === "inviting" ||
      Boolean(status.invites?.length))
  );
}

function publish(status: QueueStatus) {
  if (status.status === "waiting" || status.status === "inviting")
    sawWaiting = true;
  state = { status, answeredAt: Date.now() };
  follow(status);
  schedule();
  for (const listener of listeners) listener();
}

/** Opens the game the queue found, once, unless the page is there already. */
function follow(status: QueueStatus) {
  const game = status.game_id;
  if (status.status !== "matched" || !game || !sawWaiting || followed.has(game))
    return;
  followed.add(game);
  sawWaiting = false;
  if (window.location.hash !== `#game/${game}`)
    window.location.hash = `#game/${game}`;
}

function schedule() {
  clearTimeout(timer);
  timer = undefined;
  if (listeners.size > 0 && pending(state.status))
    timer = setTimeout(() => void ask(), QUEUE_POLL_MS);
}

/** Asks for the place now. An answer that fails keeps the one shown, and asks again later. */
export async function ask(): Promise<void> {
  if (asking) return;
  asking = true;
  try {
    const { data } = await client.GET("/api/v1/queue");
    if (data) publish(data);
    else schedule();
  } catch {
    schedule();
  } finally {
    asking = false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) void ask();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

/** The account's place, kept up to date while anything shows it. */
export function useQueue(): QueueState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Joins a queue; the answer is the place, or the game found at once. Returns an error's words. */
export async function joinQueue(body: QueueRequest): Promise<string | null> {
  sawWaiting = true;
  const answer = await client
    .POST("/api/v1/queue", { body })
    .catch(() => undefined);
  if (answer?.data) {
    publish(answer.data);
    return null;
  }
  sawWaiting = false;
  return describe(answer?.error);
}

/** Accepts a friend's invitation to the Two-Headed Giant queue (v0.5.1) with one of your decks:
 * the two of you wait as a team. Returns an error's words. */
export async function acceptInvite(
  playerId: string,
  deckId: string,
): Promise<string | null> {
  sawWaiting = true;
  const answer = await client
    .POST("/api/v1/queue/invites/{player_id}", {
      params: { path: { player_id: playerId } },
      body: { deck_id: deckId },
    })
    .catch(() => undefined);
  if (answer?.data) {
    publish(answer.data);
    return null;
  }
  sawWaiting = false;
  return describe(answer?.error);
}

/** Declines a friend's invitation (v0.5.1); they are told. */
export async function declineInvite(playerId: string): Promise<string | null> {
  const answer = await client
    .POST("/api/v1/queue/invites/{player_id}/decline", {
      params: { path: { player_id: playerId } },
    })
    .catch(() => undefined);
  if (answer?.data) {
    publish(answer.data);
    return null;
  }
  return describe(answer?.error);
}

/** Leaves the queue. A game found a moment before still opens. */
export async function leaveQueue(): Promise<string | null> {
  const answer = await client.DELETE("/api/v1/queue").catch(() => undefined);
  if (answer?.data) {
    publish(answer.data);
    return null;
  }
  return describe(answer?.error);
}

/** Forgets everything; for tests. */
export function resetQueue() {
  clearTimeout(timer);
  timer = undefined;
  state = { status: null, answeredAt: 0 };
  listeners.clear();
  followed.clear();
  sawWaiting = false;
  asking = false;
}
