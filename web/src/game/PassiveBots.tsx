import { useState } from "react";
import { client } from "../api";
import type { components } from "../generated/api";
import styles from "./game.module.css";

type Summary = components["schemas"]["GameSummary"];

/**
 * SysOp's switch between normal and passive bots (v0.8.6), for testing cards and the campaign:
 * passive bots only draw, pass and discard to hand size, from their next decision. Shown only where
 * the server allows it (the summary's passive_bots is not null): SysOp's own practice game or
 * campaign duel with no other human seat. The game's log says each change, and once the bots
 * have been passive the game pays nothing out.
 */
export function PassiveBots({
  gameId,
  passive,
  onChange,
}: {
  gameId: string;
  passive: boolean;
  onChange: (summary: Summary) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  async function set(value: boolean) {
    setBusy(true);
    setProblem("");
    const { data, error } = await client.PUT("/api/v1/games/{game_id}/bots", {
      params: { path: { game_id: gameId } },
      body: { passive: value },
    });
    setBusy(false);
    if (data) onChange(data);
    else
      setProblem(
        error?.message ?? "The bots could not be switched. Try again.",
      );
  }
  return (
    <div className={styles.passiveBots} data-passive-bots={passive}>
      <label className={styles.switch}>
        <input
          type="checkbox"
          role="switch"
          checked={passive}
          aria-disabled={busy}
          onChange={(event) => {
            if (!busy) void set(event.target.checked);
          }}
        />
        <span>Passive bots</span>
      </label>
      <p className={styles.hint}>
        Passive bots only draw, pass and discard to hand size: no lands, spells,
        attacks or blocks. Takes effect at each bot’s next decision. A game
        played with them pays nothing out; a won campaign duel still opens the
        next ward.
      </p>
      {problem && <p role="alert">{problem}</p>}
    </div>
  );
}
