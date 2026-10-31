import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TABLE_SETTINGS,
  TABLE_SETTINGS_KEY,
} from "../game/table/types";
import {
  readTableSettings,
  sanitizeTableSettings,
  saveTableSettings,
  useTableSettings,
} from "./tableSettings";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the table's device settings", () => {
  it("start from the defaults and recover from broken data", () => {
    expect(readTableSettings()).toEqual(DEFAULT_TABLE_SETTINGS);
    for (const raw of ["{broken", "null", "42", '"text"', "[]"]) {
      localStorage.setItem(TABLE_SETTINGS_KEY, raw);
      expect(readTableSettings()).toEqual(DEFAULT_TABLE_SETTINGS);
    }
  });

  it("read each field on its own, clamping numbers to what the controls offer", () => {
    localStorage.setItem(
      TABLE_SETTINGS_KEY,
      JSON.stringify({
        fullscreenOnStart: "no",
        responseTimerSeconds: 10,
        animationSpeed: "ludicrous",
        effectsVolume: 140.6,
        muted: true,
        painter: "dom",
        effects: "loud",
        musicVolume: -12,
        musicMuted: "yes",
        somethingNew: 1,
      }),
    );
    expect(readTableSettings()).toEqual({
      ...DEFAULT_TABLE_SETTINGS,
      responseTimerSeconds: 8,
      effectsVolume: 100,
      muted: true,
      painter: "dom",
      musicVolume: 0,
    });
    // A table saved before v0.7.2 has no music fields: the music plays at its default level.
    expect(sanitizeTableSettings({ muted: true })).toEqual({
      ...DEFAULT_TABLE_SETTINGS,
      muted: true,
    });
    expect(sanitizeTableSettings({ musicVolume: 33.6 }).musicVolume).toBe(34);
    expect(sanitizeTableSettings({ musicMuted: true }).musicMuted).toBe(true);
    expect(sanitizeTableSettings({ effects: "subtle" }).effects).toBe("subtle");
    expect(sanitizeTableSettings({ effects: "off" }).effects).toBe("off");
    const timer = (value: unknown) =>
      sanitizeTableSettings({ responseTimerSeconds: value })
        .responseTimerSeconds;
    expect(timer(-3)).toBe(0);
    expect(timer(1000)).toBe(90);
    expect(timer(Number.NaN)).toBe(8);
    expect(timer("30")).toBe(8);
    expect(timer(30)).toBe(30);
    expect(sanitizeTableSettings({ effectsVolume: -5 }).effectsVolume).toBe(0);
    expect(sanitizeTableSettings({ effectsVolume: 33.4 }).effectsVolume).toBe(
      33,
    );
  });

  it("save, and keep a choice for the visit when storage refuses it", () => {
    const next = {
      ...DEFAULT_TABLE_SETTINGS,
      responseTimerSeconds: 30 as const,
    };
    expect(saveTableSettings(next)).toBe(true);
    expect(JSON.parse(localStorage.getItem(TABLE_SETTINGS_KEY)!)).toEqual(next);
    expect(readTableSettings()).toEqual(next);

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    const muted = { ...next, muted: true };
    expect(saveTableSettings(muted)).toBe(false);
    expect(readTableSettings()).toEqual(muted);
  });

  it("follow a change made in another tab, and this tab's own changes in every reader", () => {
    const first = renderHook(() => useTableSettings());
    const second = renderHook(() => useTableSettings());
    act(() => void first.result.current[1]({ effectsVolume: 20 }));
    expect(second.result.current[0].effectsVolume).toBe(20);

    act(() => {
      localStorage.setItem(
        TABLE_SETTINGS_KEY,
        JSON.stringify({ ...DEFAULT_TABLE_SETTINGS, painter: "dom" }),
      );
      window.dispatchEvent(
        new StorageEvent("storage", { key: TABLE_SETTINGS_KEY }),
      );
    });
    expect(first.result.current[0].painter).toBe("dom");
    expect(second.result.current[0].painter).toBe("dom");
    // The same object while nothing changed, so readers do not render again for nothing.
    expect(first.result.current[0]).toBe(readTableSettings());
  });
});
