import { useSyncExternalStore } from "react";
import {
  DEFAULT_TABLE_SETTINGS,
  TABLE_SETTINGS_KEY,
  type TableSettings,
} from "../game/table/types";

// The table's settings (v0.3.0) belong to the device, not the account: full screen, the response
// timer, animation speed, the painter and sound suit one PC and not another. They live in
// localStorage only, so no contract changes and changeMe never overwrites them; the account's
// Larger text and Reduce motion stay in preferences.ts.

export const TIMER_SECONDS = [0, 5, 8, 15, 30, 90] as const;
export const ANIMATION_SPEEDS = ["normal", "fast", "faster"] as const;
export const EFFECTS_LEVELS = ["full", "subtle", "off"] as const;

/** The allowed timer length closest to any number, so an old or edited value still means something. */
function nearestSeconds(value: number): TableSettings["responseTimerSeconds"] {
  return TIMER_SECONDS.reduce((best, seconds) =>
    Math.abs(seconds - value) < Math.abs(best - value) ? seconds : best,
  );
}

/** Each field on its own: one bad value falls back to its default and keeps the others. */
export function sanitizeTableSettings(value: unknown): TableSettings {
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const d = DEFAULT_TABLE_SETTINGS;
  const number = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const seconds = number(record.responseTimerSeconds);
  const volume = number(record.effectsVolume);
  return {
    fullscreenOnStart:
      typeof record.fullscreenOnStart === "boolean"
        ? record.fullscreenOnStart
        : d.fullscreenOnStart,
    responseTimerSeconds:
      seconds === null ? d.responseTimerSeconds : nearestSeconds(seconds),
    animationSpeed: ANIMATION_SPEEDS.find((s) => s === record.animationSpeed)
      ? (record.animationSpeed as TableSettings["animationSpeed"])
      : d.animationSpeed,
    effectsVolume:
      volume === null
        ? d.effectsVolume
        : Math.min(100, Math.max(0, Math.round(volume))),
    muted: typeof record.muted === "boolean" ? record.muted : d.muted,
    painter:
      record.painter === "auto" || record.painter === "dom"
        ? record.painter
        : d.painter,
    effects: EFFECTS_LEVELS.find((level) => level === record.effects)
      ? (record.effects as TableSettings["effects"])
      : d.effects,
  };
}

// The store: the stored text last seen and what it means. Reading compares the text, so another
// tab's change, a cleared storage or this tab's own save all show without a reload, and the same
// object comes back while nothing changed (useSyncExternalStore needs that). When storage refuses
// a write, the choice lasts for this visit in memory.
const unseen = Symbol("unseen");
let seen: string | null | typeof unseen = unseen;
let current: TableSettings = DEFAULT_TABLE_SETTINGS;
const listeners = new Set<() => void>();

function parse(raw: string | null): TableSettings {
  if (raw === null) return DEFAULT_TABLE_SETTINGS;
  try {
    return sanitizeTableSettings(JSON.parse(raw));
  } catch {
    return DEFAULT_TABLE_SETTINGS;
  }
}

export function readTableSettings(): TableSettings {
  let raw: string | null;
  try {
    raw = localStorage.getItem(TABLE_SETTINGS_KEY);
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
export function saveTableSettings(settings: TableSettings): boolean {
  const next = sanitizeTableSettings(settings);
  const raw = JSON.stringify(next);
  // Takes in the stored text first, so a refused write is not mistaken later for a change.
  readTableSettings();
  let stored = true;
  try {
    localStorage.setItem(TABLE_SETTINGS_KEY, raw);
    seen = raw;
  } catch {
    stored = false;
  }
  current = next;
  for (const listener of listeners) listener();
  return stored;
}

function subscribe(listener: () => void): () => void {
  // Another tab's save arrives as a storage event; this tab's own saves call the listeners.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === TABLE_SETTINGS_KEY) listener();
  };
  listeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function update(patch: Partial<TableSettings>): boolean {
  return saveTableSettings({ ...readTableSettings(), ...patch });
}

/** The settings and a change that saves at once; true when the change was stored. */
export function useTableSettings(): [
  TableSettings,
  (patch: Partial<TableSettings>) => boolean,
] {
  const settings = useSyncExternalStore(
    subscribe,
    readTableSettings,
    () => DEFAULT_TABLE_SETTINGS,
  );
  return [settings, update];
}
