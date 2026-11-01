import { useEffect, useMemo, useRef, useState } from "react";
import { useMotionLevel } from "../app/motion";
import type { GameState } from "../game/connection";
import { GameScreen } from "../game/GameScreen";
import { buildDemo } from "./demoScript";
import shell from "../App.module.css";
import styles from "./tutorial.module.css";

// The Beginner's watched game (v0.8.4): the scripted game of demoScript.ts on the real table,
// with its narration in a panel over it. Next goes on a lesson; "Play on its own" goes on by
// itself after time to read; the frames inside a lesson play as the table's own animation.

/** How long a frame stays before the next inside one lesson. */
const FRAME_MS = 1100;

/** Time to read a lesson's words before "Play on its own" goes on. */
function readingMs(text: string): number {
  return Math.min(18_000, Math.max(6_000, text.length * 55));
}

const BASE: Omit<GameState, "snapshot" | "log"> = {
  phase: "open",
  ended: null,
  seat: null,
  role: "observer",
  controlled: true,
  takenOver: false,
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

export function DemoGame({
  finishLabel,
  onFinish,
  onSkip,
}: {
  /** The last lesson's button: on to the setup, or back to Settings. */
  finishLabel: string;
  onFinish: () => void;
  /** Leaves the game before its end. */
  onSkip: () => void;
}) {
  const beats = useMemo(buildDemo, []);
  const [beat, setBeat] = useState(0);
  const [frame, setFrame] = useState(0);
  const [auto, setAuto] = useState(false);
  const instant = useMotionLevel("normal") === "none";
  const next = useRef<HTMLButtonElement>(null);
  const lesson = beats[beat]!;
  const last = beat === beats.length - 1;
  const framesDone = frame >= lesson.frames.length - 1;

  // The frames inside a lesson play one after another.
  useEffect(() => {
    if (framesDone) return;
    const timer = window.setTimeout(
      () => setFrame((n) => n + 1),
      instant ? 0 : FRAME_MS,
    );
    return () => window.clearTimeout(timer);
  }, [beat, frame, framesDone, instant]);
  // On its own: the next lesson once this one has been read.
  useEffect(() => {
    if (!auto || !framesDone || last) return;
    const timer = window.setTimeout(() => go(beat + 1), readingMs(lesson.text));
    return () => window.clearTimeout(timer);
  }, [auto, framesDone, last, beat, lesson.text]);
  // The narration takes the keyboard once the table has drawn, and keeps it from lesson to lesson.
  useEffect(() => {
    const timer = window.setTimeout(() => next.current?.focus(), 50);
    return () => window.clearTimeout(timer);
  }, []);

  function go(to: number) {
    setBeat(Math.min(to, beats.length - 1));
    setFrame(0);
  }

  const snapshot = lesson.frames[Math.min(frame, lesson.frames.length - 1)]!;
  const state = useMemo<GameState>(
    () => ({ ...BASE, snapshot, log: snapshot.log }),
    [snapshot],
  );

  const overlay = (
    <section
      className={styles.narration}
      aria-labelledby="demo-title"
      data-tutorial="narration"
    >
      <p className={styles.narrationCount}>
        Guided game · {beat + 1} of {beats.length}
      </p>
      <h2 id="demo-title">{lesson.title}</h2>
      <p aria-live="polite" className={styles.narrationText}>
        {lesson.text}
      </p>
      <div className={styles.narrationActions}>
        {last ? (
          <button
            ref={next}
            type="button"
            className={shell.primary}
            onClick={onFinish}
          >
            {finishLabel}
          </button>
        ) : (
          <button
            ref={next}
            type="button"
            className={shell.primary}
            onClick={() => go(beat + 1)}
          >
            Next <span aria-hidden="true">▸</span>
          </button>
        )}
        {!last && (
          <label className={styles.auto}>
            <input
              type="checkbox"
              checked={auto}
              onChange={(event) => setAuto(event.target.checked)}
            />
            Play on its own
          </label>
        )}
        {beat > 0 && (
          <button
            type="button"
            className={styles.quiet}
            onClick={() => go(beat - 1)}
          >
            Back
          </button>
        )}
        {!last && (
          <button type="button" className={styles.quiet} onClick={onSkip}>
            Skip the game
          </button>
        )}
      </div>
    </section>
  );

  return (
    <GameScreen
      gameId="tutorial-demo"
      me={null}
      scripted={state}
      overlay={overlay}
    />
  );
}
