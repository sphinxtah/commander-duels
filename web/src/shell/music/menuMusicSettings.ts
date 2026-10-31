import { useSyncExternalStore } from "react";

// The menu music's settings (v0.7.3) belong to the device, like the table's (app/tableSettings.ts):
// its volume and mute (its own, apart from the game track's), shuffle or in order, the songs
// unticked, the song that was playing, whether the player was paused, and whether its box is open.
// They live in localStorage only; another tab's change shows at once through the storage event.

export const MENU_MUSIC_KEY = "cd.menuMusic.v1";

export interface MenuMusicSettings {
  volume: number; // 0–100
  muted: boolean;
  shuffle: boolean;
  /** The songs unticked, by file name. */
  excluded: string[];
  /** The song playing (or paused) when the page was last seen, by file name. */
  track: string | null;
  /** The player was paused by hand; it stays paused until Play. */
  paused: boolean;
  /** The box shows its controls and list, not the folded pill. */
  open: boolean;
}

export const DEFAULT_MENU_MUSIC: MenuMusicSettings = {
  volume: 50,
  muted: false,
  shuffle: true,
  excluded: [],
  track: null,
  paused: false,
  open: false,
};

/** Each field on its own: one bad value falls back to its default and keeps the others. */
export function sanitizeMenuMusic(value: unknown): MenuMusicSettings {
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const d = DEFAULT_MENU_MUSIC;
  const bool = (v: unknown, fallback: boolean) =>
    typeof v === "boolean" ? v : fallback;
  const volume =
    typeof record.volume === "number" && Number.isFinite(record.volume)
      ? Math.min(100, Math.max(0, Math.round(record.volume)))
      : d.volume;
  const excluded = Array.isArray(record.excluded)
    ? [
        ...new Set(
          record.excluded.filter(
            (file): file is string => typeof file === "string" && file !== "",
          ),
        ),
      ].slice(0, 500)
    : d.excluded;
  return {
    volume,
    muted: bool(record.muted, d.muted),
    shuffle: bool(record.shuffle, d.shuffle),
    excluded,
    track:
      typeof record.track === "string" && record.track !== ""
        ? record.track
        : null,
    paused: bool(record.paused, d.paused),
    open: bool(record.open, d.open),
  };
}

// The store: the stored text last seen and what it means, as app/tableSettings.ts keeps the
// table's. The same object comes back while nothing changed (useSyncExternalStore needs that),
// and a refused write lasts for this visit in memory.
const unseen = Symbol("unseen");
let seen: string | null | typeof unseen = unseen;
let current: MenuMusicSettings = DEFAULT_MENU_MUSIC;
const listeners = new Set<() => void>();

function parse(raw: string | null): MenuMusicSettings {
  if (raw === null) return DEFAULT_MENU_MUSIC;
  try {
    return sanitizeMenuMusic(JSON.parse(raw));
  } catch {
    return DEFAULT_MENU_MUSIC;
  }
}

export function readMenuMusic(): MenuMusicSettings {
  let raw: string | null;
  try {
    raw = localStorage.getItem(MENU_MUSIC_KEY);
  } catch {
    return current;
  }
  if (raw !== seen) {
    seen = raw;
    current = parse(raw);
  }
  return current;
}

/** False when the browser would not store it; the settings still apply until the page closes. */
export function saveMenuMusic(settings: MenuMusicSettings): boolean {
  const next = sanitizeMenuMusic(settings);
  const raw = JSON.stringify(next);
  readMenuMusic();
  let stored = true;
  try {
    localStorage.setItem(MENU_MUSIC_KEY, raw);
    seen = raw;
  } catch {
    stored = false;
  }
  current = next;
  for (const listener of listeners) listener();
  return stored;
}

export function updateMenuMusic(patch: Partial<MenuMusicSettings>): boolean {
  return saveMenuMusic({ ...readMenuMusic(), ...patch });
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === MENU_MUSIC_KEY) listener();
  };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The settings and a change that saves at once; true when the change was stored. */
export function useMenuMusicSettings(): [
  MenuMusicSettings,
  (patch: Partial<MenuMusicSettings>) => boolean,
] {
  const settings = useSyncExternalStore(
    subscribe,
    readMenuMusic,
    () => DEFAULT_MENU_MUSIC,
  );
  return [settings, updateMenuMusic];
}
