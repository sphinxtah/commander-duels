import { useSyncExternalStore } from "react";

// The live lobby (v0.9.4): the chat's WebSocket, which every signed-in tab holds, says when the
// tables changed ({"type": "lobby"}), and Find a game asks for its page again at once. While the
// socket is down the page polls as before; while it is up, only now and then (LIVE_POLL_MS).

/** How often Find a game asks anyway while the lobby is live: for what the socket cannot tell. */
export const LIVE_POLL_MS = 30_000;

export interface Lobby {
  /** Counts the changes heard, and each time the socket comes back (one may have been missed). */
  revision: number;
  live: boolean;
}

let lobby: Lobby = { revision: 0, live: false };
const listeners = new Set<() => void>();

function emit(next: Lobby): void {
  lobby = next;
  for (const listener of listeners) listener();
}

/** The socket heard that the tables changed. */
export function lobbyChanged(): void {
  emit({ ...lobby, revision: lobby.revision + 1 });
}

/** The socket came up or went down. */
export function setLobbyLive(live: boolean): void {
  if (live === lobby.live) return;
  emit({ revision: live ? lobby.revision + 1 : lobby.revision, live });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLobby(): Lobby {
  return useSyncExternalStore(
    subscribe,
    () => lobby,
    () => lobby,
  );
}
