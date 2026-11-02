import { useId, useState } from "react";
import type { ShotId, ShotMark } from "./guide";
import { RichText } from "./RichText";
import shots from "./shots.json";
import styles from "./HowToPlay.module.css";

// The table's screenshots (v0.8.6): taken by web/e2e/how-to-play-shots.spec.ts from the tutorial's
// guided game on the real table, with where each marked place lies on them, which
// scripts/how_to_play_shots.py writes to shots.json beside this file as it makes the pictures in
// public/how-to-play/.

interface ShotData {
  width: number;
  height: number;
  marks: Record<string, { x: number; y: number }>;
}

const SHOTS = shots as Partial<Record<ShotId, ShotData>>;

export function Shot({
  shot,
  caption,
  marks,
}: {
  shot: ShotId;
  caption: string;
  marks: ShotMark[];
}) {
  const id = useId();
  const data = SHOTS[shot];
  const [failed, setFailed] = useState(false);
  const placed = marks.map((mark) => ({ ...mark, at: data?.marks[mark.mark] }));
  return (
    <figure className={styles.shot} aria-labelledby={`${id}-caption`}>
      {data && !failed ? (
        <div
          className={styles.shotPicture}
          style={{ aspectRatio: `${data.width} / ${data.height}` }}
        >
          <img
            src={`/how-to-play/${shot}-1280.webp`}
            srcSet={`/how-to-play/${shot}-640.webp 640w, /how-to-play/${shot}-1280.webp 1280w`}
            sizes="(max-width: 760px) 100vw, 760px"
            alt={`The table: ${caption}`}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
          />
          {placed.map((mark, index) =>
            mark.at ? (
              <span
                key={mark.mark}
                className={styles.shotPin}
                style={{ left: `${mark.at.x}%`, top: `${mark.at.y}%` }}
                aria-hidden="true"
              >
                {index + 1}
              </span>
            ) : null,
          )}
        </div>
      ) : (
        <p className={styles.shotMissing}>
          The screenshot is not in this build.
        </p>
      )}
      <figcaption id={`${id}-caption`}>{caption}</figcaption>
      <ol className={styles.shotMarks}>
        {placed.map((mark, index) => (
          <li key={mark.mark} data-n={index + 1}>
            <strong>{mark.label}</strong> <RichText text={mark.text} />
          </li>
        ))}
      </ol>
    </figure>
  );
}
