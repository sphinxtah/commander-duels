import { useEffect, useMemo, useRef, useState } from "react";
import { useMotionLevel } from "../app/motion";
import { useTableSettings } from "../app/tableSettings";
import type { GameState } from "../game/connection";
import { GameScreen } from "../game/GameScreen";
import { buildDemo } from "./demoScript";
import { autoWaitMs, frameHolds } from "./pacing";
import shell from "../App.module.css";
import styles from "./tutorial.module.css";
import { LearnMore } from "./LearnMore";

// The Beginner's watched game (v0.8.4): the scripted game of demoScript.ts on the real table,
// with its narration in a panel over it. Next goes on a lesson; "Play on its own" goes on by
// itself once the words have had time to be read; the frames inside a lesson play as the table's
// own animation. Since v0.8.5 each frame stays as long as its animation takes, at the table's
// animation speed (still pictures with motion reduced), and the reading time grows with the
// lesson's words (pacing.ts).

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
  const [settings] = useTableSettings();
  const motion = useMotionLevel(settings.animationSpeed);
  const holds = useMemo(() => frameHolds(beats, motion), [beats, motion]);
  const next = useRef<HTMLButtonElement>(null);
  /** When the lesson on screen opened, for its reading time. */
  const opened = useRef(Date.now());
  const lesson = beats[beat]!;
  const last = beat === beats.length - 1;
  const framesDone = frame >= lesson.frames.length - 1;

  // The frames inside a lesson play one after another, each once its animation has finished.
  useEffect(() => {
    if (framesDone) return;
    const timer = window.setTimeout(
      () => setFrame((n) => n + 1),
      holds[beat]![frame]!,
    );
    return () => window.clearTimeout(timer);
  }, [beat, frame, framesDone, holds]);
  // On its own: the next lesson once the last frame has settled and the words have been read.
  useEffect(() => {
    if (!auto || !framesDone || last) return;
    const wait = autoWaitMs(
      lesson.text,
      holds[beat]![frame]!,
      Date.now() - opened.current,
    );
    const timer = window.setTimeout(() => go(beat + 1), wait);
    return () => window.clearTimeout(timer);
  }, [auto, framesDone, last, beat, frame, holds, lesson.text]);
  // The narration takes the keyboard once the table has drawn, and keeps it from lesson to lesson.
  useEffect(() => {
    const timer = window.setTimeout(() => next.current?.focus(), 50);
    return () => window.clearTimeout(timer);
  }, []);

  function go(to: number) {
    opened.current = Date.now();
    setBeat(Math.max(0, Math.min(to, beats.length - 1)));
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
      <LearnMore title={lesson.title} />
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
