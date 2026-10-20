import { useEffect, useRef } from "react";
import type { TableDiff, UseTableSound } from "../table/types";
import { attackOnce, cuesFor } from "./cues";
import { getSoundEngine } from "./engine";

// The game screen's sound (design §17): the cues of each committed diff, a refusal, and the
// response timer's last three seconds, at the table settings' volume. Sound starts only after the
// player's first click or key press, as browsers require; the Start and Resume clicks unlock it
// already, and until it runs every press in the game tries again.

/** The timer ticks at these many ms left. */
const TICKS_AT = [3000, 2000, 1000];

export const useTableSound: UseTableSound = ({
  diff,
  layout,
  settings,
  viewSeat,
  refusal,
  timer,
}) => {
  const engine = getSoundEngine();

  useEffect(() => {
    engine.setVolume(settings.effectsVolume);
    engine.setMuted(settings.muted);
  }, [engine, settings.effectsVolume, settings.muted]);

  useEffect(() => {
    if (engine.state !== "locked") return;
    function stop() {
      window.removeEventListener("pointerdown", wake, true);
      window.removeEventListener("keydown", wake, true);
    }
    function wake() {
      if (engine.state === "locked") engine.unlock();
      if (engine.state !== "locked") stop();
    }
    window.addEventListener("pointerdown", wake, true);
    window.addEventListener("keydown", wake, true);
    return stop;
  }, [engine]);

  // Each diff sounds once, however often the screen re-renders with it (StrictMode included).
  const played = useRef<TableDiff | null>(null);
  const attacked = useRef(false);
  useEffect(() => {
    if (!diff || played.current === diff) return;
    played.current = diff;
    const once = attackOnce(
      cuesFor(diff, layout, viewSeat),
      diff,
      attacked.current,
    );
    attacked.current = once.sounded;
    for (const { cue, ...options } of once.cues) engine.play(cue, options);
  }, [engine, diff, layout, viewSeat]);

  // A new refusal buzzes; the one on screen when the table opened does not.
  const refused = useRef(refusal);
  useEffect(() => {
    if (refusal && refusal !== refused.current) engine.play("refused");
    refused.current = refusal;
  }, [engine, refusal]);

  // The timer's view changes only with its phase, so a running view says how long was left when it
  // started (or resumed): the ticks are scheduled from it and cancelled by the next phase.
  useEffect(() => {
    if (!timer || timer.phase !== "running") return;
    const left = timer.remainingMs;
    const ids = TICKS_AT.filter((at) => left >= at).map((at) =>
      window.setTimeout(() => engine.play("tick"), left - at),
    );
    return () => ids.forEach((id) => window.clearTimeout(id));
  }, [engine, timer]);
};
