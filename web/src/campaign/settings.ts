import { useSyncExternalStore } from "react";

// The cut scenes' settings (v0.8.0): the device's, in localStorage, as the menu music's are. The
// text speed, automatic advance, whether the opponents speak during duels (barks) and, since
// v0.8.1, whether the cut scenes play their music. Another tab's change shows at once through the
// storage event.

export type TextSpeed = "slow" | "normal" | "fast" | "instant";

export interface CampaignSettings {
  textSpeed: TextSpeed;
  auto: boolean;
  barks: boolean;
  music: boolean;
}

export const KEY = "cd.campaign.v1";
export const DEFAULTS: CampaignSettings = {
  textSpeed: "normal",
  auto: false,
  barks: true,
  music: true,
};
/** Characters a second for each text speed; instant shows the whole line at once. */
export const CHARS_PER_SECOND: Record<TextSpeed, number> = {
  slow: 28,
  normal: 52,
  fast: 110,
  instant: Infinity,
};

/** Each field on its own: one bad value falls back to its default and keeps the others. */
export function sanitizeSettings(value: unknown): CampaignSettings {
  const record =
    typeof value === "object" && value !== null
      ? (value as Partial<Record<keyof CampaignSettings, unknown>>)
      : {};
  const bool = (v: unknown, fallback: boolean) =>
    typeof v === "boolean" ? v : fallback;
  return {
    textSpeed:
      typeof record.textSpeed === "string" &&
      Object.hasOwn(CHARS_PER_SECOND, record.textSpeed)
        ? (record.textSpeed as TextSpeed)
        : DEFAULTS.textSpeed,
    auto: bool(record.auto, DEFAULTS.auto),
    barks: bool(record.barks, DEFAULTS.barks),
    music: bool(record.music, DEFAULTS.music),
  };
}

// One store for every reader, as the menu music's settings keep theirs: the cut scene and the
// map's Story settings show the same values, so a change made in one is never written back over
// by the other. The same object comes back while nothing changed (useSyncExternalStore needs
// that), and a refused write lasts for this visit in memory.
const unseen = Symbol("unseen");
let seen: string | null | typeof unseen = unseen;
let current: CampaignSettings = DEFAULTS;
const listeners = new Set<() => void>();

function parse(raw: string | null): CampaignSettings {
  if (raw === null) return DEFAULTS;
  try {
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return DEFAULTS;
  }
}

export function readSettings(): CampaignSettings {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
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
export function saveSettings(settings: CampaignSettings): boolean {
  const next = sanitizeSettings(settings);
  const raw = JSON.stringify(next);
  readSettings();
  let stored = true;
  try {
    localStorage.setItem(KEY, raw);
    seen = raw;
  } catch {
    stored = false;
  }
  current = next;
  for (const listener of listeners) listener();
  return stored;
}

/** The change on top of the settings as they are now, not as some reader last drew them. */
export function updateSettings(change: Partial<CampaignSettings>): boolean {
  return saveSettings({ ...readSettings(), ...change });
}

function subscribe(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === KEY) listener();
  };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** The settings and a change that saves at once; every component using it sees the change. */
export function useCampaignSettings(): [
  CampaignSettings,
  (change: Partial<CampaignSettings>) => void,
] {
  const settings = useSyncExternalStore(
    subscribe,
    readSettings,
    () => DEFAULTS,
  );
  return [settings, updateSettings];
}
