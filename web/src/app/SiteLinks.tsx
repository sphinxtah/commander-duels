import styles from "./SiteLinks.module.css";

/**
 * About · Privacy · Terms (v0.4.1): one small line of links to the public pages, which nginx
 * serves outside the app to anyone, signed in or not. Plain links, so each opens as a page of
 * its own; the landing page shows the line below what it is for, and the app's footer beside the
 * Fan Content notice.
 */
export function SiteLinks({ className }: { className?: string }) {
  return (
    <p className={className ? `${styles.links} ${className}` : styles.links}>
      <a href="/about">About</a>
      <span aria-hidden="true"> · </span>
      <a href="/privacy">Privacy</a>
      <span aria-hidden="true"> · </span>
      <a href="/terms">Terms</a>
    </p>
  );
}
