import { guideHref, topicById, TUTORIAL_TOPICS } from "../howToPlay/guide";
import styles from "./tutorial.module.css";

/**
 * The tutorial's way into How to play (v0.8.6): under a refresher page or a lesson of the guided
 * game, its topic in the guide, in a tab of its own so the tutorial stays where it is.
 */
export function LearnMore({ title }: { title: string }) {
  const topic = topicById(TUTORIAL_TOPICS[title] ?? "");
  if (!topic) return null;
  return (
    <p className={styles.learnMore}>
      <a
        href={`/${guideHref(topic.id)}`}
        target="_blank"
        rel="noopener"
        aria-label={`More in How to play: ${topic.title} (opens a new tab)`}
      >
        More in How to play: {topic.title} <span aria-hidden="true">↗</span>
      </a>
    </p>
  );
}
