import styles from "./shop.module.css";

// Leng behind his counter: the owner's painting (supplied 2026-10-22, v0.4.3), which replaced the
// SVG placeholder of v0.4.0. Three sizes in web/public/shop/, outside the installed app's
// precache like the portraits; recorded in docs/asset-provenance.csv.

const FILES = [640, 960, 1448] as const;
const src = (width: number) => `/shop/leng-${width}.webp`;

export const LENG_ALT =
  "Leng, an old shopkeeper in a hooded grey robe, smiling behind his wooden counter by candlelight, with shelves of booster packs, old books and curios behind him";

/** Leng at his counter, at the top of the shop. */
export function Leng({ className }: { className?: string }) {
  return (
    <img
      className={`${styles.leng} ${className ?? ""}`}
      src={src(960)}
      srcSet={FILES.map((width) => `${src(width)} ${width}w`).join(", ")}
      sizes="(max-width: 860px) 94vw, 620px"
      width={1448}
      height={1086}
      alt={LENG_ALT}
      decoding="async"
    />
  );
}

/** The same counter, dimmed and blurred behind a pack being opened: decorative. */
export function LengBackdrop() {
  return (
    <img
      className={styles.backdrop}
      src={src(640)}
      width={640}
      height={480}
      alt=""
      aria-hidden="true"
      decoding="async"
      data-backdrop="leng"
    />
  );
}
