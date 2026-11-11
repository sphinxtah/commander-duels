import { useState } from "react";
import { topicById, TUTORIAL_TOPICS } from "../howToPlay/guide";
import { TopicDialog } from "../howToPlay/TopicDialog";
import styles from "./tutorial.module.css";

/**
 * The tutorial's way into How to play (v0.8.6): under a refresher page or a lesson of the guided
 * game, its topic in the guide. Since v0.9.8 the topic opens in a pop-up over the tutorial (the
 * owner's report): it used to open the guide in a tab of its own, and a new tab of an account
 * still in its setup shows the welcome again, so the link led the player in a loop.
 */
export function LearnMore({
  title,
  onOpenChange,
}: {
  title: string;
  /** Told when the pop-up opens and closes, so a lesson playing on its own can wait. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const topic = topicById(TUTORIAL_TOPICS[title] ?? "");
  if (!topic) return null;
  const change = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <>
      <p className={styles.learnMore}>
        <button
          type="button"
          aria-haspopup="dialog"
          onClick={() => change(true)}
        >
          More in How to play: {topic.title}
        </button>
      </p>
      {open && <TopicDialog topic={topic} onClose={() => change(false)} />}
    </>
  );
}
