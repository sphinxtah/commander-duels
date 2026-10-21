import { useState } from "react";
import { portraitSizes, portraitUrl } from "./alliance";
import styles from "./alliance.module.css";

// A Planeswalker's portrait (v0.3.1), by the owner's handoff rules: the transparency stays, the
// picture is contain-fit and never cropped to a circle, and its box is square with room for horns
// and hoods. Thumbnails take the 128 px file; larger pictures choose among the three sizes. A
// Planeswalker without a portrait yet (the Godlike tier's) shows a placeholder spark.

export function Portrait({
  id,
  name,
  description,
  portrait,
  size = 128,
  thumbnail = false,
  decorative = false,
  className,
}: {
  /** The roster ID, such as "rowan". */
  id: string;
  name?: string;
  /** The roster's description of the portrait: its alternative text. */
  description?: string | null;
  /** False when the roster says it has none; left out, the picture is tried and a missing one
   * falls back to the placeholder. */
  portrait?: boolean;
  /** Its width and height on the page, in CSS pixels. */
  size?: number;
  /** A small picture in a list or a picker: the 128 px file alone. */
  thumbnail?: boolean;
  /** Beside words that already name it (a button's, a link's), it is hidden from screen readers. */
  decorative?: boolean;
  className?: string;
}) {
  // Remembered by ID, so another Planeswalker's picture is tried afresh.
  const [failed, setFailed] = useState<string>();
  const classes = [styles.portrait, className].filter(Boolean).join(" ");
  const words = description || (name ? `Portrait of ${name}` : "Portrait");
  if (portrait === false || failed === id)
    return (
      <svg
        className={[classes, styles.placeholder].join(" ")}
        viewBox="0 0 64 64"
        width={size}
        height={size}
        data-placeholder=""
        role={decorative ? undefined : "img"}
        aria-label={
          decorative ? undefined : `${name ?? "Planeswalker"}: no portrait yet`
        }
        aria-hidden={decorative || undefined}
        focusable="false"
      >
        {/* A Planeswalker's spark over a faint halo, in the page's gold. */}
        <circle cx="32" cy="32" r="21" className={styles.placeholderHalo} />
        <path
          d="M32 6 L36.5 27.5 L58 32 L36.5 36.5 L32 58 L27.5 36.5 L6 32 L27.5 27.5 Z"
          className={styles.placeholderSpark}
        />
        <circle cx="32" cy="32" r="4" className={styles.placeholderCore} />
      </svg>
    );
  return (
    <img
      className={classes}
      src={portraitUrl(id, thumbnail ? 128 : 256)}
      srcSet={
        thumbnail
          ? undefined
          : portraitSizes
              .map((width) => `${portraitUrl(id, width)} ${width}w`)
              .join(", ")
      }
      sizes={thumbnail ? undefined : `${size}px`}
      width={size}
      height={size}
      alt={decorative ? "" : words}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(id)}
    />
  );
}
