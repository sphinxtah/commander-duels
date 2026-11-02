import { useEffect, useRef, useState } from "react";
import type { Me } from "../api";
import shell from "../App.module.css";
import { Overview } from "./Overview";
import { DEMO_ROUTE, moveTutorial } from "./tutorial";
import styles from "./tutorial.module.css";

/** Settings › Tutorial (v0.8.4): the guided game, the overview and the main menu's tour again
 * (since v0.8.5 with Decks and the Play page, or those two alone). */
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

  /** The tour again: all of it from the shop, or (v0.8.5) Decks and the Play page alone. */
  async function tour(stage: "tour_shop" | "tour_decks") {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const moved = await moveTutorial({
        stage,
        path: me.tutorial?.path ?? "advanced",
      });
      if ("error" in moved) return setMessage(moved.error);
      onChange(moved.me);
      window.location.hash = stage === "tour_shop" ? "#home" : "#decks";
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
        Watch the guided game between two bots again, read the overview of the
        game and its rules, or take the main menu's tour again: Leng's Card
        Shop, Tivit's Auction House, Decks and the practice table. The tour of
        Decks and Play alone skips the pack and the listing.
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
          onClick={() => void tour("tour_shop")}
        >
          Take the tour
        </button>
        <button
          type="button"
          className={styles.quiet}
          disabled={busy}
          onClick={() => void tour("tour_decks")}
        >
          Tour Decks and Play
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
