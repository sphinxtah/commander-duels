import { useCallback, useState } from "react";

// The cut scenes' settings (v0.8.0): the device's, in localStorage, as the menu music's are. The
// text speed, automatic advance and whether the opponents speak during duels (barks).

export type TextSpeed = "slow" | "normal" | "fast" | "instant";

export interface CampaignSettings {
  textSpeed: TextSpeed;
  auto: boolean;
  barks: boolean;
}

export const KEY = "cd.campaign.v1";
export const DEFAULTS: CampaignSettings = {
  textSpeed: "normal",
  auto: false,
  barks: true,
};
/** Characters a second for each text speed; instant shows the whole line at once. */
export const CHARS_PER_SECOND: Record<TextSpeed, number> = {
  slow: 28,
  normal: 52,
  fast: 110,
  instant: Infinity,
};

export function readSettings(): CampaignSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const value = JSON.parse(raw) as Partial<CampaignSettings>;
    return {
      textSpeed:
        value.textSpeed && value.textSpeed in CHARS_PER_SECOND
          ? value.textSpeed
          : DEFAULTS.textSpeed,
      auto: typeof value.auto === "boolean" ? value.auto : DEFAULTS.auto,
      barks: typeof value.barks === "boolean" ? value.barks : DEFAULTS.barks,
    };
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(settings: CampaignSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage may be unavailable: the choice lasts for this visit.
  }
}

export function useCampaignSettings(): [
  CampaignSettings,
  (change: Partial<CampaignSettings>) => void,
] {
  const [settings, setSettings] = useState(readSettings);
  const update = useCallback((change: Partial<CampaignSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...change };
      saveSettings(next);
      return next;
    });
  }, []);
  return [settings, update];
}
