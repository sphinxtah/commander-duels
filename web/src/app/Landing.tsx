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
      {/* Decorative: the page's heading, hidden or not, says what it is for. */}
      <img
        className={styles.mark}
        src="/brand/mark.webp"
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
