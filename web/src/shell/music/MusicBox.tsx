import { useId, type ReactNode } from "react";
import type { MenuMusic } from "./menuMusic";
import { trackLabel } from "./playlist";
import { useMenuMusic } from "./useMenuMusic";
import styles from "./MusicBox.module.css";

// The music box (v0.7.3): a small floating player in the lower left corner of every page of the
// app but a game's, over the page and under nothing. Folded, it is a pill with the song's name
// and Play or Pause; open, it adds Previous and Next, shuffle or in order, the volume and its
// mute, and the list of songs with a tick each, to leave out the ones the player does not care
// for (the last ticked song stays). Its state lives in the device's settings
// (menuMusicSettings.ts), so a reload finds the same song, volume and ticks. Without a manifest
// (the public images), or with no song that plays, nothing is drawn.

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const glyphs = {
  note: (
    <Glyph>
      <path d="M9 3v12.1A3.5 3.5 0 1 0 11 18V7.2l8-1.8V12.1a3.5 3.5 0 1 0 2 2.9V3l-12 2.7z" />
    </Glyph>
  ),
  play: (
    <Glyph>
      <path d="M7 4.5v15l12-7.5z" />
    </Glyph>
  ),
  pause: (
    <Glyph>
      <path d="M6 4.5h4.5v15H6zm7.5 0H18v15h-4.5z" />
    </Glyph>
  ),
  previous: (
    <Glyph>
      <path d="M5 5h2.5v14H5zm14 0v14L8.5 12z" />
    </Glyph>
  ),
  next: (
    <Glyph>
      <path d="M16.5 5H19v14h-2.5zM5 5l10.5 7L5 19z" />
    </Glyph>
  ),
  shuffle: (
    <Glyph>
      <path d="M17 4l4 3.5L17 11V8.5h-1.6c-.9 0-1.6.4-2.1 1.1L12 12l1.3 1.9c.5.7 1.2 1.1 2.1 1.1H17V12.5l4 3.5-4 3.5V17h-1.6a4.6 4.6 0 0 1-3.9-2.1L10.4 12 9.3 10.4A2.6 2.6 0 0 0 7.1 9.3H3V6.7h4.1c1.6 0 3 .8 3.9 2.1l.4.5.4-.5A4.6 4.6 0 0 1 15.4 6.7H17z" />
    </Glyph>
  ),
  order: (
    <Glyph>
      <path d="M3 6.5h13V4l5 3.5L16 11V8.5H3zm0 7h13V11l5 3.5L16 18v-2.5H3z" />
    </Glyph>
  ),
  sound: (
    <Glyph>
      <path d="M4 9h3.5L12 5v14l-4.5-4H4zm11-1.6a4.5 4.5 0 0 1 0 9.2V14.7a2.6 2.6 0 0 0 0-5.4z" />
    </Glyph>
  ),
  mutedSound: (
    <Glyph>
      <path d="M4 9h3.5L12 5v14l-4.5-4H4zm12.3 0 1.9 1.9 1.9-1.9 1.4 1.4-1.9 1.9 1.9 1.9-1.4 1.4-1.9-1.9-1.9 1.9-1.4-1.4 1.9-1.9-1.9-1.9z" />
    </Glyph>
  ),
  fold: (
    <Glyph>
      <path d="M6 9.5l6 6 6-6-1.4-1.4L12 12.7 7.4 8.1z" />
    </Glyph>
  ),
};

export function MusicBox({ player }: { player?: MenuMusic }) {
  const music = useMenuMusic(player);
  const { snapshot, settings, allMuted } = music;
  const id = useId();
  if (snapshot.state === "loading" || snapshot.state === "unavailable")
    return null;
  const { current, tracks, ticked } = snapshot;
  const muted = settings.muted || allMuted;
  const playing = snapshot.state === "playing";
  const paused = snapshot.state === "paused";
  const playLabel = paused ? "Play" : "Pause";
  const onPlay = () => (paused ? music.play() : music.pause());
  const word =
    snapshot.state === "waiting"
      ? "Click anywhere to start the music"
      : paused
        ? "Paused"
        : allMuted
          ? "All sound is muted in Settings"
          : settings.muted
            ? "Muted"
            : "Now playing";
  const name = current ? trackLabel(current) : "The menu music";

  if (!settings.open)
    return (
      <aside className={styles.box} aria-label="Music player">
        <div className={styles.pill}>
          <button
            type="button"
            className={styles.pillName}
            onClick={() => music.update({ open: true })}
            aria-label={`Music: ${name}. Open the player`}
            title="Open the music player"
          >
            {glyphs.note}
            <span>{name}</span>
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={onPlay}
            aria-label={playLabel}
            title={playLabel}
          >
            {paused ? glyphs.play : glyphs.pause}
          </button>
        </div>
      </aside>
    );

  return (
    <aside className={styles.box} data-open="" aria-label="Music player">
      <div className={styles.panel}>
        <div className={styles.head}>
          <div className={styles.now} role="status">
            <span className={styles.word}>{word}</span>
            <strong>{current ? current.title : "The menu music"}</strong>
            {current?.artist && <small>{current.artist}</small>}
          </div>
          <button
            type="button"
            className={styles.button}
            onClick={() => music.update({ open: false })}
            aria-label="Fold the music player"
            title="Fold"
          >
            {glyphs.fold}
          </button>
        </div>
        <div className={styles.transport}>
          <button
            type="button"
            className={styles.button}
            onClick={music.previous}
            aria-label="Previous song"
            title="Previous song"
          >
            {glyphs.previous}
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.main}`}
            onClick={onPlay}
            aria-label={playLabel}
            title={playLabel}
          >
            {paused ? glyphs.play : glyphs.pause}
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={music.next}
            aria-label="Next song"
            title="Next song"
          >
            {glyphs.next}
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.toggle}`}
            onClick={() => music.update({ shuffle: !settings.shuffle })}
            aria-pressed={settings.shuffle}
            aria-label="Shuffle"
            title={settings.shuffle ? "Shuffle: on" : "In order"}
          >
            {settings.shuffle ? glyphs.shuffle : glyphs.order}
            <span>{settings.shuffle ? "Shuffle" : "In order"}</span>
          </button>
        </div>
        <div className={styles.volume}>
          <button
            type="button"
            className={`${styles.button} ${styles.toggle}`}
            onClick={() => music.update({ muted: !settings.muted })}
            aria-pressed={settings.muted}
            aria-label="Mute the music"
            title={settings.muted ? "Unmute" : "Mute"}
          >
            {muted ? glyphs.mutedSound : glyphs.sound}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            value={settings.volume}
            onChange={(event) =>
              music.update({ volume: Number(event.target.value) })
            }
            aria-label="Music volume"
          />
          <output aria-hidden="true">{settings.volume}</output>
        </div>
        <ol className={styles.list} aria-label="Songs">
          {tracks.map((track) => {
            const on = ticked.has(track.file);
            const isCurrent = current?.file === track.file;
            const tickId = `${id}-${track.file}`;
            return (
              <li
                key={track.file}
                aria-current={isCurrent ? "true" : undefined}
              >
                <input
                  id={tickId}
                  type="checkbox"
                  checked={on}
                  // The last ticked song stays: nothing would be left to play.
                  disabled={on && ticked.size <= 1}
                  onChange={(event) =>
                    music.tick(track.file, event.target.checked)
                  }
                  aria-label={`Include ${track.title}`}
                  title={
                    on && ticked.size <= 1
                      ? "The last song stays in the playlist"
                      : on
                        ? "Skip this song"
                        : "Play this song too"
                  }
                />
                <button
                  type="button"
                  className={styles.song}
                  onClick={() => music.select(track.file)}
                  aria-label={`Play ${trackLabel(track)}`}
                >
                  <span className={styles.mark} aria-hidden="true">
                    {isCurrent ? (playing && !muted ? "♪" : "▸") : ""}
                  </span>
                  <span className={styles.title}>{track.title}</span>
                  {track.artist && (
                    <small className={styles.artist}>{track.artist}</small>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </aside>
  );
}
