import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TABLE_SETTINGS } from "../table/types";
import {
  FADE_IN_MS,
  FADE_OUT_MS,
  FADE_STEP_MS,
  GAME_MUSIC_URL,
  createGameMusic,
  getGameMusic,
  type GameMusic,
  type MusicElement,
} from "./gameMusic";
import { useGameMusic } from "./useGameMusic";

// A stand-in for the <audio> element: play() answers as the browser would (allowed, refused until
// a gesture, or no such track), and the test reads what the player did to it.
class FakeAudio implements MusicElement {
  src = "";
  loop = false;
  preload = "auto";
  volume = 1;
  currentTime = 0;
  paused = true;
  plays = 0;
  pauses = 0;
  /** What the next play() does. */
  answer: "allowed" | "refused" | "missing" = "allowed";
  private listeners = new Map<string, Set<() => void>>();

  play(): Promise<void> {
    this.plays += 1;
    if (this.answer === "refused")
      return Promise.reject(
        Object.assign(new Error("gesture first"), { name: "NotAllowedError" }),
      );
    if (this.answer === "missing") {
      // The browser reports the failed load through the error event and rejects play().
      queueMicrotask(() => this.fire("error"));
      return Promise.reject(
        Object.assign(new Error("no source"), { name: "NotSupportedError" }),
      );
    }
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.pauses += 1;
    this.paused = true;
  }
  addEventListener(type: string, listener: () => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

/** Lets the play() promise settle. */
const settle = () => Promise.resolve().then(() => Promise.resolve());

const defaultLevel = (DEFAULT_TABLE_SETTINGS.musicVolume / 100) ** 2;

describe("the gameplay music", () => {
  let audio: FakeAudio;
  let made: number;
  let music: GameMusic;
  beforeEach(() => {
    vi.useFakeTimers();
    audio = new FakeAudio();
    made = 0;
    music = createGameMusic({
      element: () => {
        made += 1;
        return audio;
      },
    });
  });
  afterEach(() => {
    music.dispose();
  });

  it("makes no element until a game starts, then streams the track, looping, from the start", async () => {
    expect(music.state).toBe("idle");
    expect(made).toBe(0);
    audio.currentTime = 812;
    music.start();
    await settle();
    expect(made).toBe(1);
    expect(audio.src).toBe(GAME_MUSIC_URL);
    expect(audio.loop).toBe(true);
    expect(audio.preload).toBe("none");
    expect(audio.currentTime).toBe(0);
    expect(audio.paused).toBe(false);
    expect(music.state).toBe("playing");
  });

  it("fades in to the settings' level and fades out to a pause when the game ends", async () => {
    music.start();
    await settle();
    expect(audio.volume).toBe(0);
    vi.advanceTimersByTime(FADE_IN_MS / 2);
    expect(audio.volume).toBeGreaterThan(0);
    expect(audio.volume).toBeLessThan(defaultLevel);
    vi.advanceTimersByTime(FADE_IN_MS / 2 + FADE_STEP_MS);
    expect(audio.volume).toBeCloseTo(defaultLevel, 5);

    music.stop();
    expect(music.state).toBe("fading");
    expect(audio.paused).toBe(false);
    vi.advanceTimersByTime(FADE_OUT_MS + FADE_STEP_MS);
    expect(audio.volume).toBe(0);
    expect(audio.paused).toBe(true);
    expect(music.state).toBe("idle");
  });

  it("begins again at the start of the track for the next game, even mid fade-out", async () => {
    music.start();
    await settle();
    vi.advanceTimersByTime(FADE_IN_MS + FADE_STEP_MS);
    audio.currentTime = 300;
    music.stop();
    vi.advanceTimersByTime(FADE_OUT_MS / 2);
    const midway = audio.volume;
    expect(midway).toBeGreaterThan(0);
    music.start();
    await settle();
    expect(audio.currentTime).toBe(0);
    expect(audio.paused).toBe(false);
    // Back up from where the fade was, not from silence.
    expect(audio.volume).toBeGreaterThanOrEqual(midway);
    vi.advanceTimersByTime(FADE_IN_MS + FADE_STEP_MS);
    expect(audio.volume).toBeCloseTo(defaultLevel, 5);
  });

  it("starting again during a game changes nothing (an effect run twice)", async () => {
    music.start();
    await settle();
    vi.advanceTimersByTime(FADE_IN_MS + FADE_STEP_MS);
    audio.currentTime = 42;
    music.start();
    await settle();
    expect(audio.currentTime).toBe(42);
    expect(audio.plays).toBe(1);
    expect(audio.volume).toBeCloseTo(defaultLevel, 5);
  });

  it("follows the volume as (v/100)², and a mute pauses the stream until the unmute", async () => {
    music.start();
    await settle();
    vi.advanceTimersByTime(FADE_IN_MS + FADE_STEP_MS);
    music.setLevel(100, false);
    expect(audio.volume).toBe(1);
    music.setLevel(50, false);
    expect(audio.volume).toBeCloseTo(0.25, 5);
    music.setLevel(50, true);
    expect(audio.volume).toBe(0);
    expect(audio.paused).toBe(true);
    expect(music.state).toBe("playing");
    audio.currentTime = 77;
    music.setLevel(50, false);
    await settle();
    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBe(77);
    expect(audio.volume).toBeCloseTo(0.25, 5);
    // Volume 0 is a mute too.
    music.setLevel(0, false);
    expect(audio.paused).toBe(true);
  });

  it("a game that starts muted streams nothing, and plays from the unmute", async () => {
    music.setLevel(60, true);
    music.start();
    await settle();
    expect(audio.plays).toBe(0);
    expect(music.state).toBe("playing");
    music.setLevel(60, false);
    await settle();
    expect(audio.plays).toBe(1);
    expect(audio.paused).toBe(false);
  });

  it("waits for a click or key press when the browser refuses to play, then plays", async () => {
    audio.answer = "refused";
    music.start();
    await settle();
    expect(music.state).toBe("waiting");
    expect(audio.paused).toBe(true);
    audio.answer = "allowed";
    window.dispatchEvent(new Event("keydown"));
    await settle();
    expect(audio.paused).toBe(false);
    expect(music.state).toBe("playing");
    // The listeners are gone: another press plays nothing more.
    window.dispatchEvent(new Event("pointerdown"));
    await settle();
    expect(audio.plays).toBe(2);
  });

  it("a game that ends while waiting stops listening", async () => {
    audio.answer = "refused";
    music.start();
    await settle();
    music.stop();
    expect(music.state).toBe("idle");
    audio.answer = "allowed";
    window.dispatchEvent(new Event("pointerdown"));
    await settle();
    expect(audio.plays).toBe(1);
    expect(audio.paused).toBe(true);
  });

  it("stays quiet, with no retries, when there is no track at the address", async () => {
    audio.answer = "missing";
    music.start();
    await settle();
    await settle();
    expect(music.state).toBe("unavailable");
    expect(audio.plays).toBe(1);
    music.start();
    music.setLevel(100, false);
    await settle();
    expect(audio.plays).toBe(1);
    expect(made).toBe(1);
  });

  it("is unavailable without audio at all", () => {
    const none = createGameMusic({ element: () => null });
    none.start();
    expect(none.state).toBe("unavailable");
    none.dispose();
  });

  it("pauses a track that the browser started only after the game was over", async () => {
    let allow: () => void = () => {};
    audio.play = () => {
      audio.plays += 1;
      return new Promise<void>((resolve) => {
        allow = () => {
          audio.paused = false;
          resolve();
        };
      });
    };
    music.start();
    music.stop();
    expect(music.state).toBe("idle");
    allow();
    await settle();
    expect(audio.paused).toBe(true);
  });

  it("dispose releases the stream, and the page has one player", () => {
    music.start();
    music.dispose();
    expect(audio.src).toBe("");
    expect(audio.paused).toBe(true);
    expect(getGameMusic()).toBe(getGameMusic());
  });
});

describe("useGameMusic", () => {
  let audio: FakeAudio;
  let player: GameMusic;
  beforeEach(() => {
    vi.useFakeTimers();
    audio = new FakeAudio();
    player = createGameMusic({ element: () => audio });
  });
  afterEach(() => {
    player.dispose();
  });

  it("plays while the game is live at the settings' level, and stops as it ends or the table closes", async () => {
    const settings = { ...DEFAULT_TABLE_SETTINGS, musicVolume: 100 };
    const hook = renderHook(
      ({ live, s }: { live: boolean; s: typeof settings }) =>
        useGameMusic({ live, settings: s, player }),
      { initialProps: { live: false, s: settings } },
    );
    await settle();
    expect(audio.plays).toBe(0);
    hook.rerender({ live: true, s: settings });
    await settle();
    expect(audio.paused).toBe(false);
    vi.advanceTimersByTime(FADE_IN_MS + FADE_STEP_MS);
    expect(audio.volume).toBe(1);
    // Mute all sound silences the music too; the music's own mute as well.
    hook.rerender({ live: true, s: { ...settings, muted: true } });
    expect(audio.paused).toBe(true);
    hook.rerender({ live: true, s: settings });
    await settle();
    expect(audio.paused).toBe(false);
    hook.rerender({ live: true, s: { ...settings, musicMuted: true } });
    expect(audio.paused).toBe(true);
    hook.rerender({ live: true, s: settings });
    await settle();
    expect(audio.paused).toBe(false);
    // The result: the track fades out.
    hook.rerender({ live: false, s: settings });
    vi.advanceTimersByTime(FADE_OUT_MS + FADE_STEP_MS);
    expect(audio.paused).toBe(true);
    // Leaving the table mid-game stops it too.
    hook.rerender({ live: true, s: settings });
    await settle();
    expect(audio.paused).toBe(false);
    hook.unmount();
    vi.advanceTimersByTime(FADE_OUT_MS + FADE_STEP_MS);
    expect(audio.paused).toBe(true);
  });

  it("uses the page's player by default", () => {
    const hook = renderHook(() =>
      useGameMusic({ live: false, settings: DEFAULT_TABLE_SETTINGS }),
    );
    expect(getGameMusic().state).toBe("idle");
    hook.unmount();
  });
});
