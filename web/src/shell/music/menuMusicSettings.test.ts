import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MENU_MUSIC,
  MENU_MUSIC_KEY,
  readMenuMusic,
  sanitizeMenuMusic,
  saveMenuMusic,
  updateMenuMusic,
  useMenuMusicSettings,
} from "./menuMusicSettings";

// The menu music's device-local settings (v0.7.3), kept as the table's are.

const stored = () => JSON.parse(localStorage.getItem(MENU_MUSIC_KEY)!);

describe("the menu music settings", () => {
  it("fall back field by field", () => {
    expect(sanitizeMenuMusic(undefined)).toEqual(DEFAULT_MENU_MUSIC);
    expect(sanitizeMenuMusic("volume")).toEqual(DEFAULT_MENU_MUSIC);
    expect(
      sanitizeMenuMusic({
        volume: 33.4,
        muted: "yes",
        shuffle: false,
        excluded: ["02-b.mp3", 7, "", "02-b.mp3", "03-c.mp3"],
        track: "",
        paused: true,
        open: 1,
      }),
    ).toEqual({
      volume: 33,
      muted: false,
      shuffle: false,
      excluded: ["02-b.mp3", "03-c.mp3"],
      track: null,
      paused: true,
      open: false,
    });
    expect(sanitizeMenuMusic({ volume: 140 }).volume).toBe(100);
    expect(sanitizeMenuMusic({ volume: -5 }).volume).toBe(0);
    expect(sanitizeMenuMusic({ volume: Number.NaN }).volume).toBe(50);
    expect(sanitizeMenuMusic({ excluded: "all" }).excluded).toEqual([]);
    expect(sanitizeMenuMusic({ track: "01-a.mp3" }).track).toBe("01-a.mp3");
  });

  it("read what is stored, and store what is saved", () => {
    expect(readMenuMusic()).toEqual(DEFAULT_MENU_MUSIC);
    localStorage.setItem(MENU_MUSIC_KEY, "not json");
    expect(readMenuMusic()).toEqual(DEFAULT_MENU_MUSIC);
    expect(saveMenuMusic({ ...DEFAULT_MENU_MUSIC, volume: 70 })).toBe(true);
    expect(stored().volume).toBe(70);
    expect(readMenuMusic().volume).toBe(70);
    expect(updateMenuMusic({ excluded: ["01-a.mp3"], track: "02-b.mp3" })).toBe(
      true,
    );
    expect(readMenuMusic()).toEqual({
      ...DEFAULT_MENU_MUSIC,
      volume: 70,
      excluded: ["01-a.mp3"],
      track: "02-b.mp3",
    });
    // The same object while nothing changed.
    expect(readMenuMusic()).toBe(readMenuMusic());
  });

  it("follow a change from the hook, and another tab's", () => {
    const { result } = renderHook(() => useMenuMusicSettings());
    expect(result.current[0]).toEqual(DEFAULT_MENU_MUSIC);
    act(() => {
      result.current[1]({ shuffle: false, open: true });
    });
    expect(result.current[0].shuffle).toBe(false);
    expect(result.current[0].open).toBe(true);
    expect(stored().shuffle).toBe(false);
    act(() => {
      localStorage.setItem(
        MENU_MUSIC_KEY,
        JSON.stringify({ ...DEFAULT_MENU_MUSIC, muted: true }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: MENU_MUSIC_KEY }),
      );
    });
    expect(result.current[0].muted).toBe(true);
    expect(result.current[0].open).toBe(false);
  });
});
