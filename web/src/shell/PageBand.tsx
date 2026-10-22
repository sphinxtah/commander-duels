import { backSound } from "./menuSound";
import { Icon, pageNames, type Page } from "./pages";
import styles from "./shell.module.css";

/**
 * The band above every page but the main menu (v0.4.5), as in Magic Duels: the way back to the
 * main menu, and the page's name large across the band. The page's own heading follows it.
 */
export function PageBand({ page }: { page: Page }) {
  return (
    <div className={styles.band}>
      <a href="#home" className={styles.back} onClick={backSound}>
        <Icon name="back" />
        Main menu
      </a>
      <span className={styles.bandTitle} aria-hidden="true">
        {pageNames[page]}
      </span>
    </div>
  );
}
