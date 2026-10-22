import { useEffect, useState } from "react";
import { client, describe } from "../api";
import type { BlockedPlayer, PrivacySettings as Settings } from "./social";
import { playerLink } from "./social";
import styles from "./social.module.css";

// Privacy settings on Profile (v0.4.3): who sees whether you are online, idle or in a game
// (friends, the default, or everyone); appearing offline, which hides it from everyone but
// administrators and SysOp; being found by your email address typed in full; and the players
// you have blocked, each with Unblock. Each change saves at once.

type Key = keyof Settings;

export function PrivacySettings() {
  const [settings, setSettings] = useState<Settings>();
  const [blocks, setBlocks] = useState<BlockedPlayer[]>([]);
  const [said, setSaid] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all([
      client.GET("/api/v1/me/privacy"),
      client.GET("/api/v1/me/blocks"),
    ])
      .then(([privacy, blocked]) => {
        if (!active) return;
        if (privacy.data) setSettings(privacy.data);
        else setError(describe(privacy.error));
        if (blocked.data) setBlocks(blocked.data);
      })
      .catch(() => {
        if (active) setError("Your privacy settings could not load.");
      });
    return () => {
      active = false;
    };
  }, []);

  // The choice shows at once, and goes back if the server refuses it.
  async function change<K extends Key>(key: K, value: Settings[K]) {
    const before = settings;
    if (!before) return;
    setSettings({ ...before, [key]: value });
    setBusy(true);
    setSaid("");
    setError("");
    const { data, error } = await client.PATCH("/api/v1/me/privacy", {
      body: { [key]: value },
    });
    setBusy(false);
    if (!data) {
      setSettings(before);
      return setError(describe(error));
    }
    setSettings(data);
    setSaid("Privacy settings saved.");
  }

  async function unblock(entry: BlockedPlayer) {
    setBusy(true);
    setSaid("");
    const { data, error } = await client.DELETE("/api/v1/blocks/{player_id}", {
      params: { path: { player_id: entry.player.id } },
    });
    setBusy(false);
    if (!data) return setError(describe(error));
    setBlocks((before) =>
      before.filter((found) => found.player.id !== entry.player.id),
    );
    setSaid(`${entry.player.handle} is no longer blocked.`);
  }

  return (
    <section className={styles.panel} aria-labelledby="privacy-title">
      <h2 id="privacy-title">Privacy</h2>
      {!settings && !error && <p className={styles.quiet}>Loading…</p>}
      {settings && (
        <>
          <fieldset className={styles.choices} disabled={busy}>
            <legend>Who sees whether you are online, idle or in a game</legend>
            <label>
              <input
                type="radio"
                name="presence-visibility"
                checked={settings.presence_visibility === "friends"}
                onChange={() => void change("presence_visibility", "friends")}
              />
              Your friends
            </label>
            <label>
              <input
                type="radio"
                name="presence-visibility"
                checked={settings.presence_visibility === "everyone"}
                onChange={() => void change("presence_visibility", "everyone")}
              />
              Every player
            </label>
          </fieldset>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={settings.appear_offline}
              disabled={busy}
              onChange={(event) =>
                void change("appear_offline", event.target.checked)
              }
            />
            <span>
              Appear offline
              <small>
                Everyone sees you offline, friends included, and they are not
                told when you come online. Administrators can still see your
                real status.
              </small>
            </span>
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={settings.email_searchable}
              disabled={busy}
              onChange={(event) =>
                void change("email_searchable", event.target.checked)
              }
            />
            <span>
              Let players find me by my email address
              <small>
                Only someone who types your whole address finds you, and they
                never see it. Your handle can always be searched.
              </small>
            </span>
          </label>
        </>
      )}
      <h3 className={styles.subTitle}>Blocked players</h3>
      {blocks.length === 0 ? (
        <p className={styles.quiet}>
          You have blocked no one. Block a player from their profile.
        </p>
      ) : (
        <ul className={styles.blocks}>
          {blocks.map((entry) => (
            <li key={entry.player.id}>
              <a href={playerLink(entry.player.id)}>{entry.player.handle}</a>
              <button
                type="button"
                className={styles.smallQuiet}
                disabled={busy}
                onClick={() => void unblock(entry)}
                aria-label={`Unblock ${entry.player.handle}`}
              >
                Unblock
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className={styles.rowError} role="alert">
          {error}
        </p>
      )}
      <p className={styles.said} role="status">
        {said}
      </p>
    </section>
  );
}
