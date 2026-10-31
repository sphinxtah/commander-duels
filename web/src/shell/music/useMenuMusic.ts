import { useEffect, useSyncExternalStore } from "react";
import { useTableSettings } from "../../app/tableSettings";
import {
  getMenuMusic,
  type MenuMusic,
  type MenuMusicSnapshot,
} from "./menuMusic";
import {
  useMenuMusicSettings,
  type MenuMusicSettings,
} from "./menuMusicSettings";

// The menus' music (v0.7.3), wired: the device's settings (menuMusicSettings.ts) drive the player
// (menuMusic.ts), and what the player does (the song now playing) goes back into them. The hook
// runs where the box is drawn, on every page of the app; the player plays while that is mounted
// and fades out when it unmounts, which is how a game opening, or a sign-out, hands over.

export interface MenuMusicControls {
  snapshot: MenuMusicSnapshot;
  settings: MenuMusicSettings;
  /** Every sound is muted (Settings › The table): the box says so beside its own mute. */
  allMuted: boolean;
  update(patch: Partial<MenuMusicSettings>): boolean;
  play(): void;
  pause(): void;
  next(): void;
  previous(): void;
  select(file: string): void;
  tick(file: string, on: boolean): void;
}

export function useMenuMusic(player?: MenuMusic): MenuMusicControls {
  const music = player ?? getMenuMusic();
  const [settings, update] = useMenuMusicSettings();
  const [table] = useTableSettings();
  const snapshot = useSyncExternalStore(
    music.subscribe,
    () => music.snapshot,
    () => music.snapshot,
  );

  // The last visit's song is named before the manifest is read, so the first song is that one.
  useEffect(() => {
    music.remember(settings.track);
    music.load();
    // Only at the start: a later change of the remembered song is the player's own doing.
  }, [music]);

  useEffect(() => {
    music.setLevel(settings.volume, settings.muted || table.muted);
  }, [music, settings.volume, settings.muted, table.muted]);
  useEffect(() => {
    music.setShuffle(settings.shuffle);
  }, [music, settings.shuffle]);
  useEffect(() => {
    music.setExcluded(settings.excluded);
  }, [music, settings.excluded]);
  useEffect(() => {
    music.setPaused(settings.paused);
  }, [music, settings.paused]);

  // On screen while mounted: the menus. Unmounting (a game's screen, the landing page) hides it.
  useEffect(() => {
    music.show();
    return () => music.hide();
  }, [music]);

  // The song playing is remembered for the next visit.
  const current = snapshot.current?.file ?? null;
  useEffect(() => {
    if (current !== null && current !== settings.track)
      update({ track: current });
  }, [current, settings.track, update]);

  return {
    snapshot,
    settings,
    allMuted: table.muted,
    update,
    play: () => update({ paused: false }),
    pause: () => update({ paused: true }),
    next: () => music.next(),
    previous: () => music.previous(),
    select: (file) => {
      music.select(file);
      if (settings.paused) update({ paused: false });
    },
    tick: (file, on) => {
      const excluded = on
        ? settings.excluded.filter((other) => other !== file)
        : settings.excluded.includes(file)
          ? settings.excluded
          : [...settings.excluded, file];
      // The last ticked song stays: nothing would be left to play.
      const left = snapshot.tracks.filter((t) => !excluded.includes(t.file));
      if (left.length === 0) return;
      update({ excluded });
    },
  };
}
