import { useRef } from "react";
import styles from "../App.module.css";
import { page, useAppUpdate } from "./serviceWorker";

const shellText = {
  available: "Update available",
  deferred:
    "A game is running in another window. The update applies when it ends.",
  applying: "Updating…",
  applied: "Updated. Reload to use the new version.",
} as const;

/**
 * The new version's notice (PWA04). In the shell's top bar it offers Update, or says why it
 * waits; on the game screen it only says when the update applies, with nothing to press, so a
 * game is never reloaded from under the player.
 */
export function UpdateNotice({
  inGame = false,
  className,
}: {
  inGame?: boolean;
  className?: string;
}) {
  const { state, apply } = useAppUpdate();
  const status = useRef<HTMLSpanElement>(null);
  if (state === "none") return null;
  if (inGame)
    return (
      <span role="status" className={className} data-update={state}>
        Update ready: it applies when you leave the table.
      </span>
    );
  return (
    <span className={className ?? styles.update} data-update={state}>
      <span role="status" ref={status} tabIndex={-1}>
        {shellText[state]}
      </span>
      {state === "available" && (
        <button
          type="button"
          onClick={() => {
            void apply();
            // The button goes as soon as the update waits or starts: focus stays on the notice
            // that says which, rather than falling to the page's body.
            status.current?.focus();
          }}
        >
          Update
        </button>
      )}
      {state === "applied" && (
        <button type="button" onClick={() => page.reload()}>
          Reload
        </button>
      )}
    </span>
  );
}
