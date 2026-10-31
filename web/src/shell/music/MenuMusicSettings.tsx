import { useId } from "react";
import { useMenuMusicSettings } from "./menuMusicSettings";
import styles from "../../app/Settings.module.css";

// Settings › Menu music (v0.7.3): the same volume, mute and order the music box offers, among the
// other sound settings. The songs' ticks are the box's alone, beside the songs.

export function MenuMusicSettings() {
  const [settings, update] = useMenuMusicSettings();
  const id = useId();
  return (
    <section className={styles.panel} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Menu music</h2>
      <label>
        <span>
          <strong id={`${id}-volume-name`}>Menu music volume</strong>
          <small id={`${id}-volume-text`}>
            The playlist on every page but the table. The player at the bottom
            left of the page has the same controls, the songs and their ticks.
          </small>
        </span>
        <span className={styles.range}>
          <input
            id={`${id}-volume`}
            type="range"
            min={0}
            max={100}
            aria-labelledby={`${id}-volume-name`}
            aria-describedby={`${id}-volume-text`}
            value={settings.volume}
            onChange={(event) => update({ volume: Number(event.target.value) })}
          />
          <output htmlFor={`${id}-volume`} aria-hidden="true">
            {settings.volume}
          </output>
        </span>
      </label>
      <label>
        <span>
          <strong id={`${id}-mute-name`}>Mute the menu music</strong>
          <small id={`${id}-mute-text`}>
            Silences the playlist and keeps the menus' sounds. Mute all sound,
            above, silences it too.
          </small>
        </span>
        <input
          type="checkbox"
          aria-labelledby={`${id}-mute-name`}
          aria-describedby={`${id}-mute-text`}
          checked={settings.muted}
          onChange={(event) => update({ muted: event.target.checked })}
        />
      </label>
      <label>
        <span>
          <strong id={`${id}-shuffle-name`}>Shuffle</strong>
          <small id={`${id}-shuffle-text`}>
            Plays the ticked songs in a random order, each once before any
            repeats. Off, they play in the playlist's order.
          </small>
        </span>
        <input
          type="checkbox"
          aria-labelledby={`${id}-shuffle-name`}
          aria-describedby={`${id}-shuffle-text`}
          checked={settings.shuffle}
          onChange={(event) => update({ shuffle: event.target.checked })}
        />
      </label>
      <p role="status">
        The menu music's settings are kept on this device, not in your account.
      </p>
    </section>
  );
}
