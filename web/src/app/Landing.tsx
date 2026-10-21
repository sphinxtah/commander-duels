import type { ReactNode } from "react";
import styles from "./Landing.module.css";

/**
 * The page before the app (v0.3.0). Until an account is active, every address shows only this:
 * the owner's wordless mark in the middle of the window and, below it, the sign-in, SysOp's
 * entrance or the account's wait for approval. No sidebar, top bar, banner or footer. With
 * nothing below the mark yet, it tells screen readers that the sign-in is being checked.
 */
export function Landing({ children }: { children?: ReactNode }) {
  return (
    <main className={styles.landing}>
      {/* Decorative: the page's heading, hidden or not, says what it is for. Shown large and
          alone, it has 2x and 3x copies to stay sharp on high-density screens and phones. */}
      <img
        className={styles.mark}
        src="/brand/mark.webp"
        srcSet="/brand/mark.webp 1x, /brand/mark-256.webp 2x, /brand/mark-384.webp 3x"
        alt=""
        width={128}
        height={128}
      />
      <div className={styles.content}>
        {children ?? (
          <p className={styles.visuallyHidden} role="status">
            Checking your sign-in…
          </p>
        )}
      </div>
    </main>
  );
}
