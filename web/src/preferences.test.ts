import { describe, expect, it } from "vitest";
import { readPreferences, savePreferences } from "./preferences";

describe("device preferences", () => {
  it("recovers from corrupted or unexpected browser data", () => {
    for (const value of ["{broken", "null", "42", '{"largeText":"false"}']) {
      localStorage.setItem("cd.preferences.v1", value);
      expect(readPreferences()).toEqual({
        largeText: false,
        reducedMotion: false,
      });
    }
  });
  it("persists user choices", () => {
    expect(savePreferences({ largeText: true, reducedMotion: true })).toBe(
      true,
    );
    expect(readPreferences()).toEqual({ largeText: true, reducedMotion: true });
  });
});
