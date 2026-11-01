import { useLayoutEffect, useRef, useState } from "react";
import { TIER_NAMES, type CampaignState } from "./campaign";
import { castOf } from "./cast";
import { STORY, type Scene } from "./script";
import styles from "./campaign.module.css";

// The journal (v0.8.0): the transcript of every scene seen, so a scene skipped or missed can be
// read again, what each victory revealed, the advice for each ward reached, and the tutorial's
// lessons. Nothing of a ward not yet reached shows.

const PLAYER = { name: "You", alliance: null };

export function Journal({
  state,
  onClose,
}: {
  state: CampaignState;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<"story" | "wards" | "lessons">("story");
  useLayoutEffect(() => {
    const element = dialog.current;
    if (element && !element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    }
  }, []);
  const seen = new Set(state.progress.scenes_seen);
  const scenes: { title: string; scene: Scene }[] = [];
  const add = (title: string, scene: Scene | undefined) => {
    if (scene && seen.has(scene.id)) scenes.push({ title, scene });
  };
  add("The first lamp", STORY.opening);
  add("The refuge", STORY.refugeIntro);
  add("Kaya", STORY.allianceKaya);
  add("An incarnation of your ally", STORY.allianceMatch);
  for (const encounter of state.encounters) {
    const story = STORY.encounters[encounter.number];
    if (!story) continue;
    const number = String(encounter.number).padStart(2, "0");
    add(`${number} · ${story.title}: before the duel`, story.pre);
    add(`${number} · ${story.title}: victory`, story.post);
    add(`${number} · ${story.title}: retreat`, story.loss);
  }
  add("The Sphinx's sign", STORY.allianceSphinx);
  add("The claim ends", STORY.endings.win);
  add("The bond breaks", STORY.endings.early);
  add("Replay", STORY.replay);
  const reached = state.encounters.filter((e) => e.status !== "locked");
  return (
    <dialog
      ref={dialog}
      className={styles.journal}
      aria-labelledby="journal-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header className={styles.journalHead}>
        <h2 id="journal-title">Journal</h2>
        <div role="tablist" className={styles.tabs}>
          {(
            [
              ["story", "The story"],
              ["wards", "The wards"],
              ["lessons", "Lessons"],
            ] as const
          ).map(([id, name]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={styles.tab}
              onClick={() => setTab(id)}
            >
              {name}
            </button>
          ))}
        </div>
        <button type="button" className={styles.secondary} onClick={onClose}>
          Close
        </button>
      </header>
      <div className={styles.journalBody}>
        {tab === "story" &&
          (scenes.length === 0 ? (
            <p className={styles.quiet}>No scene seen yet.</p>
          ) : (
            scenes.map(({ title, scene }) => (
              <article key={scene.id} className={styles.entry}>
                <h3>{title}</h3>
                {scene.intro && (
                  <p className={styles.entryNarration}>{scene.intro}</p>
                )}
                {scene.lines.map((line) => {
                  const who =
                    line.speaker === "NARRATOR"
                      ? null
                      : castOf(line.speaker, scene.id, PLAYER).name;
                  return (
                    <p
                      key={line.id}
                      className={who ? styles.entryLine : styles.entryNarration}
                    >
                      {who && <strong>{who}: </strong>}
                      {line.text}
                    </p>
                  );
                })}
                {scene.outro && (
                  <p className={styles.entryNarration}>{scene.outro}</p>
                )}
              </article>
            ))
          ))}
        {tab === "wards" &&
          reached.map((encounter) => {
            const story = STORY.encounters[encounter.number];
            if (!story) return null;
            return (
              <article key={encounter.number} className={styles.entry}>
                <h3>
                  {String(encounter.number).padStart(2, "0")} · {story.title}{" "}
                  <span className={styles.quiet}>
                    {TIER_NAMES[encounter.tier]} · {encounter.location}
                  </span>
                </h3>
                {encounter.status === "won" && story.story && (
                  <p>
                    <strong>What the seal revealed:</strong> {story.story}
                  </p>
                )}
                {story.counterplay && (
                  <p>
                    <strong>Kaya&rsquo;s advice:</strong> {story.counterplay}
                  </p>
                )}
              </article>
            );
          })}
        {tab === "lessons" && (
          <>
            <p className={styles.quiet}>
              The first duel&rsquo;s lessons, each shown when the board calls
              for it. A lesson the duel never reached stays here to read.
            </p>
            {STORY.tutorial.map((lesson) => (
              <article key={lesson.id} className={styles.entry}>
                <h3>
                  {lesson.id}{" "}
                  {state.progress.tutorial.lessons.includes(lesson.id) && (
                    <span className={styles.chip}>Seen</span>
                  )}
                </h3>
                <p>{lesson.text}</p>
              </article>
            ))}
            {STORY.tutorialHelp.map((line) => (
              <p key={line.id} className={styles.entryLine}>
                <strong>Kaya: </strong>
                {line.text}
              </p>
            ))}
          </>
        )}
      </div>
    </dialog>
  );
}
