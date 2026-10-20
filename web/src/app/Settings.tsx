import type { RefObject } from "react";
import type { Bootstrap } from "../api";
import type { Preferences } from "../preferences";
import app from "../App.module.css";
import { InstallSettings } from "./InstallSettings";
import { AnimationSpeedField, TableSettingsForm } from "./TableSettingsForm";
import styles from "./Settings.module.css";

/**
 * The Settings page (moved out of App in v0.3.0). Larger text and Reduce motion follow the
 * account, so App keeps them; the table, sound and install sections belong to this device.
 */
export function Settings({
  preferences,
  onPreference,
  saveMessage,
  bootstrap,
  heading,
}: {
  preferences: Preferences;
  onPreference(key: keyof Preferences, value: boolean): void;
  saveMessage: string;
  bootstrap: Bootstrap | undefined;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <>
      <h1 ref={heading} tabIndex={-1}>
        Make yourself at home.
      </h1>
      <p className={app.lead}>A few preferences for your side of the table.</p>
      <section className={styles.panel} aria-labelledby="preferences-title">
        <h2 id="preferences-title">Display & accessibility</h2>
        <label>
          <span>
            <strong>Larger text</strong>
            <small>Increase the interface text size.</small>
          </span>
          <input
            type="checkbox"
            checked={preferences.largeText}
            onChange={(event) =>
              onPreference("largeText", event.target.checked)
            }
          />
        </label>
        <label>
          <span>
            <strong>Reduce motion</strong>
            <small>
              Keep transitions and movement to a minimum. System preferences are
              also respected.
            </small>
          </span>
          <input
            type="checkbox"
            checked={preferences.reducedMotion}
            onChange={(event) =>
              onPreference("reducedMotion", event.target.checked)
            }
          />
        </label>
        <AnimationSpeedField />
        <p role="status">
          {saveMessage || "Preferences are stored on this device."}
        </p>
      </section>
      <TableSettingsForm />
      <section className={styles.panel} aria-labelledby="install-title">
        <h2 id="install-title">Install the app</h2>
        <InstallSettings />
      </section>
      <section className={styles.release}>
        <h2>
          Release status{" "}
          <span className={app.tag}>v{__APP_VERSION__} · TESTING PREVIEW</span>
        </h2>
        <p>
          Practice games against the bots are open for testing. Here is where
          each part of Commander Duels stands.
        </p>
        {bootstrap ? (
          <ul>
            {bootstrap.capabilities.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <p>{item.reason}</p>
                </div>
                <span data-available={item.available}>
                  {item.available ? "Available" : item.milestone}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>Connect to the application service to load the feature roadmap.</p>
        )}
      </section>
    </>
  );
}
