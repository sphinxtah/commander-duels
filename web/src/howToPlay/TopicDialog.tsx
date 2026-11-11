import { useEffect, useId, useRef } from "react";
import shell from "../App.module.css";
import { chapterOfTopic, type Topic } from "./guide";
import { TopicBody } from "./HowToPlay";
import styles from "./HowToPlay.module.css";

/**
 * A topic of How to play in a pop-up (v0.9.8), for the first-time tutorial: its words, cards and
 * screenshots as the guide shows them, over whatever the player was looking at, with nothing in it
 * that leads elsewhere. The owner's report: the tutorial's "More in How to play" opened the guide
 * in a new tab, and for an account still in its setup a new tab opens the welcome again, a loop.
 * The whole guide waits in the account's menu once the setup is done, and the pop-up says so.
 */
export function TopicDialog({
  topic,
  onClose,
}: {
  topic: Topic;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const chapter = chapterOfTopic(topic.id);
  useEffect(() => {
    const element = dialog.current;
    if (!element || element.open) return;
    if (typeof element.showModal === "function") element.showModal();
    else element.setAttribute("open", "");
  }, []);
  // Closing goes through the dialog, whose close event tells the caller, as Escape's does.
  const close = () => {
    const element = dialog.current;
    if (element?.open && typeof element.close === "function") element.close();
    else onClose();
  };
  return (
    <dialog
      ref={dialog}
      className={styles.topicDialog}
      aria-labelledby={titleId}
      onClose={onClose}
      // A click on the backdrop, outside the box, closes it, as Escape does.
      onClick={(event) => {
        if (event.target === dialog.current) close();
      }}
    >
      <header className={styles.topicDialogHead}>
        <div>
          <span className={shell.eyebrow}>
            How to play{chapter ? ` · ${chapter.title}` : ""}
          </span>
          <h2 id={titleId}>{topic.title}</h2>
        </div>
        <button
          type="button"
          className={shell.secondary}
          onClick={close}
          autoFocus
        >
          Close
        </button>
      </header>
      <div className={`${styles.body} ${styles.topicDialogBody}`}>
        <TopicBody topic={topic} links={false} />
      </div>
      <footer className={styles.topicDialogFoot}>
        <p>
          The whole guide is under How to play in your account&rsquo;s menu,
          at the upper right, once your setup is done.
        </p>
        <button type="button" className={shell.primary} onClick={close}>
          Back to the tutorial
        </button>
      </footer>
    </dialog>
  );
}
