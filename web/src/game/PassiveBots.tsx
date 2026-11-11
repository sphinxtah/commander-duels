import { useState } from "react";
import { client } from "../api";
import type { components } from "../generated/api";
import styles from "./game.module.css";

type Summary = components["schemas"]["GameSummary"];

/**
 * The switch between normal and passive bots, SysOp's (v0.8.6, in the Inspection drawer) and
 * since v0.8.7 an administrator's (in the Priority controls drawer), for testing cards and the
 * campaign: passive bots only draw, pass and discard to hand size, from their next decision.
 * Shown only where the server allows it (the summary's passive_bots is not null): the viewer's
 * own practice game or campaign duel with no other human seat. The game's log says each change.
 * Since v0.9.7 (the owner: "Administrators should not have this restriction") the game counts as
 * any other, and the switch says so; from v0.8.6 until then a game whose bots had been passive
 * counted for nothing.
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
        attacks or blocks. Takes effect at each bot’s next decision.
      </p>
      <p className={styles.hint}>
        The game counts as any other: its win, tokens, quests and achievements,
        and in the campaign the ward’s spoils and rewards.
      </p>
      {problem && <p role="alert">{problem}</p>}
    </div>
  );
}
