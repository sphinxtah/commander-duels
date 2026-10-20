import { useInstall, type InstallBrowser } from "./install";
import styles from "./InstallBanner.module.css";

/** The browser's own menu path, for when it does not offer its install window. */
export function InstallSteps({ browser }: { browser: InstallBrowser | null }) {
  return browser === "edge" ? (
    <>
      In Edge, open the menu: <kbd>…</kbd> › Apps › Install this site as an app.
    </>
  ) : (
    <>
      In Chrome, open the menu: <kbd>⋮</kbd> › Cast, save, and share › Install
      page as app.
    </>
  );
}

const said = {
  unsupported: "Install works in Chrome or Edge on a PC.",
  standalone: "You are using the installed app.",
  installed: "Installed on this PC: open it from its desktop icon.",
  waiting: "Checking whether your browser can install…",
} as const;

/** Settings › Install the app: what this browser can do, and the Install button when it can. */
export function InstallSettings() {
  const install = useInstall();
  const { state } = install;
  return (
    <div className={styles.settings} data-install={state}>
      <p>
        Play Commander Duels in its own window, with a desktop icon and the
        Start menu entry your browser makes for it.
      </p>
      {state === "available" ? (
        <button
          type="button"
          className={styles.install}
          onClick={() => void install.install()}
        >
          Install
        </button>
      ) : state === "manual" ? (
        <p role="status">
          <InstallSteps browser={install.browser} />
        </p>
      ) : state === "prompting" ? null : (
        <p role="status">{said[state]}</p>
      )}
    </div>
  );
}
