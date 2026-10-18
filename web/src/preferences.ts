export type Preferences = { reducedMotion: boolean; largeText: boolean };
export const defaultPreferences: Preferences = {
  reducedMotion: false,
  largeText: false,
};
export function readPreferences(): Preferences {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem("cd.preferences.v1") ?? "null",
    );
    if (typeof value !== "object" || value === null) return defaultPreferences;
    const record = value as Record<string, unknown>;
    return {
      reducedMotion: record.reducedMotion === true,
      largeText: record.largeText === true,
    };
  } catch {
    return defaultPreferences;
  }
}
export function savePreferences(value: Preferences): boolean {
  try {
    localStorage.setItem("cd.preferences.v1", JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
