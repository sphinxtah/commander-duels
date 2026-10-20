import type { Me } from "../api";
import { bannerVisible, useInstall } from "./install";
import { InstallSteps } from "./InstallSettings";
import styles from "./InstallBanner.module.css";

/**
 * The drop-down notice offering the app to a signed-in player in a Chrome or Edge tab (v0.3.0).
 * The first thing in the workspace, above the top bar; never an alert and never a dialog, so it
 * takes no focus. Not now hides it for 30 days on this device.
 */
export function InstallBanner({
  me,
  onGame,
}: {
  me: Me | null | undefined;
  onGame: boolean;
}) {
  const install = useInstall();
  if (install.installedNotice)
    return (
      <p className={styles.installed} role="status">
        Installed. Find Commander Duels on your desktop and in the Start menu.
      </p>
    );
  if (
    !bannerVisible(
      install.state,
      me,
      onGame,
      Date.now(),
      install.dismissedUntil,
    )
  )
    return null;
  return (
    <section className={styles.banner} aria-label="Install the app">
      <p>
        {install.state === "available" ? (
          "Play Commander Duels in its own window, with a desktop icon."
        ) : (
          <>
            Play Commander Duels in its own window, with a desktop icon.{" "}
            <InstallSteps browser={install.browser} />
          </>
        )}
      </p>
      <div className={styles.actions}>
        {install.state === "available" && (
          <button
            type="button"
            className={styles.install}
            onClick={() => void install.install()}
          >
            Install
          </button>
        )}
        <button type="button" className={styles.later} onClick={install.notNow}>
          Not now
        </button>
      </div>
    </section>
  );
}
