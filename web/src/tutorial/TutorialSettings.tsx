import { useEffect, useRef, useState } from "react";
import type { Me } from "../api";
import shell from "../App.module.css";
import { Overview } from "./Overview";
import { DEMO_ROUTE, moveTutorial } from "./tutorial";
import styles from "./tutorial.module.css";

/** Settings › Tutorial (v0.8.4): the guided game, the overview and the main menu's tour again. */
export function TutorialSettings({
  me,
  onChange,
  className,
}: {
  me: Me;
  onChange: (me: Me) => void;
  className?: string;
}) {
  const [reading, setReading] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (reading) dialog.current?.showModal?.();
  }, [reading]);

  async function tour() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const moved = await moveTutorial({
        stage: "tour_shop",
        path: me.tutorial?.path ?? "advanced",
      });
      if ("error" in moved) return setMessage(moved.error);
      onChange(moved.me);
      window.location.hash = "#home";
    } finally {
      setBusy(false);
    }
  }

  function close() {
    dialog.current?.close?.();
    setReading(false);
  }

  return (
    <section className={className} aria-labelledby="tutorial-title">
      <h2 id="tutorial-title">Tutorial</h2>
      <p>
        Watch the guided game between two bots again, read the overview of
        the game and its rules, or take the main menu's tour to Leng's Card
        Shop and Tivit's Auction House.
      </p>
      <div className={styles.replays}>
        <a className={shell.primary} href={DEMO_ROUTE}>
          Watch the guided game
        </a>
        <button
          type="button"
          className={styles.quiet}
          onClick={() => setReading(true)}
        >
          Read the overview
        </button>
        <button
          type="button"
          className={styles.quiet}
          disabled={busy}
          onClick={() => void tour()}
        >
          Take the tour
        </button>
      </div>
      {message && <p role="alert">{message}</p>}
      <dialog
        ref={dialog}
        className={styles.replayDialog}
        aria-labelledby="overview-title"
        onClose={() => setReading(false)}
      >
        {reading && <Overview doneLabel="Close" onDone={close} />}
      </dialog>
    </section>
  );
}
