import { useSyncExternalStore } from "react";

// Whether the browser thinks it is online (PWA04). Only a hint: a game still learns about its
// connection from its WebSocket, and the shell from the service's answers.

function subscribe(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}
