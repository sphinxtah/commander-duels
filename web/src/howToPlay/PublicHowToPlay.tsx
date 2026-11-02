import type { RefObject } from "react";
import shell from "../App.module.css";
import { SiteLinks } from "../app/SiteLinks";
import { HowToPlay } from "./HowToPlay";
import styles from "./HowToPlay.module.css";

/**
 * How to play for anyone not signed in (v0.8.6): the same guide on a page of its own, with the
 * mark that leads back to the sign-in, the Fan Content notice and the public pages' links. Nothing
 * here asks the API for anything but the guide's own card pictures.
 */
export function PublicHowToPlay({
  rest,
  heading,
}: {
  rest: string;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <div className={styles.public}>
      <header className={styles.publicBar}>
        <a href="#home" aria-label="Commander Duels: sign in">
          <img src="/brand/mark.webp" alt="" width={36} height={36} />
          <span aria-hidden="true">COMMANDER DUELS</span>
        </a>
        <a href="#home" className={`${shell.secondary} ${styles.signIn}`}>
          Sign in
        </a>
      </header>
      <main id="main" tabIndex={-1}>
        <HowToPlay rest={rest} heading={heading} />
      </main>
      <footer className={shell.footer}>
        <p className={shell.legal}>
          Commander Duels is unofficial Fan Content permitted under the Fan
          Content Policy. Not approved/endorsed by Wizards. Portions of the
          materials used are property of Wizards of the Coast. ©Wizards of the
          Coast LLC. Card images from Scryfall.
        </p>
        <SiteLinks />
      </footer>
    </div>
  );
}
