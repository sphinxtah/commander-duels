import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FADE_IN_MS,
  FADE_OUT_MS,
  FADE_STEP_MS,
  createMenuMusic,
  getMenuMusic,
  resetMenuMusic,
  type MenuMusic,
  type MenuMusicElement,
  type MenuMusicOptions,
} from "./menuMusic";
import { DEFAULT_MENU_MUSIC } from "./menuMusicSettings";
import { PLAYLIST_URL } from "./playlist";

// The menus' player (v0.7.3) on a stand-in <audio> and a stand-in manifest.

class FakeAudio implements MenuMusicElement {
  src = "";
  preload = "auto";
  volume = 1;
  currentTime = 0;
  paused = true;
  plays = 0;
  pauses = 0;
  /** The sources set, in order. */
  sources: string[] = [];
  /** What play() does: allowed, or refused until a gesture. */
  answer: "allowed" | "refused" = "allowed";
  /** Sources the folder lacks: play() fails on them as the browser does on a 404. */
  failing = new Set<string>();
  private listeners = new Map<string, Set<() => void>>();

  play(): Promise<void> {
    this.plays += 1;
    if (this.answer === "refused")
      return Promise.reject(
        Object.assign(new Error("gesture first"), { name: "NotAllowedError" }),
      );
    if (this.failing.has(this.src)) {
      // The browser's failure steps: the error event first, then the rejection.
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
  /** The song ran out. */
  end(): void {
    this.paused = true;
    this.fire("ended");
  }
}

// The source is tracked by Object.defineProperty so a cue is counted even when it names the same
// song again (the player sets currentTime back to 0 then).
function trackSources(audio: FakeAudio) {
  let value = "";
  Object.defineProperty(audio, "src", {
    get: () => value,
    set: (next: string) => {
      value = next;
      audio.sources.push(next);
    },
  });
}

const manifest = {
  tracks: [
    { file: "01-a.mp3", title: "Alpha", artist: "A" },
    { file: "02-b.mp3", title: "Beta", artist: "B" },
    { file: "03-c.mp3", title: "Gamma", artist: "C" },
  ],
};

function answering(value: unknown, ok = true) {
  return vi.fn(async (url: string) => {
    expect(url).toBe(PLAYLIST_URL);
    return { ok, json: async () => value };
  });
}

/** Lets the promises settle. */
async function settle() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const level = (DEFAULT_MENU_MUSIC.volume / 100) ** 2;

describe("the menu music", () => {
  let audio: FakeAudio;
  let music: MenuMusic;
  let changes: number;

  function make(options: MenuMusicOptions = {}): MenuMusic {
    music = createMenuMusic({
      element: () => audio,
      fetch: answering(manifest),
      random: () => 0.999,
      ...options,
    });
    music.subscribe(() => {
      changes += 1;
    });
    return music;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    audio = new FakeAudio();
    trackSources(audio);
    changes = 0;
  });
  afterEach(() => {
    music?.dispose();
  });

  it("reads the manifest once and plays the first song as the menus show, fading in", async () => {
    make();
    expect(music.snapshot.state).toBe("loading");
    music.setShuffle(false);
    music.load();
    music.load();
    music.show();
    await settle();
    expect(music.snapshot.state).toBe("playing");
    expect(music.snapshot.tracks.map((t) => t.title)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
    expect(music.snapshot.current?.file).toBe("01-a.mp3");
    expect(audio.sources).toEqual(["/music/01-a.mp3"]);
    expect(audio.preload).toBe("none");
    expect(audio.plays).toBe(1);
    expect(audio.paused).toBe(false);
    expect(audio.volume).toBe(0);
    vi.advanceTimersByTime(FADE_IN_MS / 2);
    expect(audio.volume).toBeGreaterThan(0);
    expect(audio.volume).toBeLessThan(level);
    vi.advanceTimersByTime(FADE_IN_MS);
    expect(audio.volume).toBeCloseTo(level);
    expect(changes).toBeGreaterThan(0);
  });

  it("is unavailable without a manifest, with an empty one, or with something else at the address", async () => {
    for (const read of [
      answering(null, false),
      answering({ tracks: [] }),
      answering({ id: "abc", status: "active" }),
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    ]) {
      const player = createMenuMusic({ element: () => audio, fetch: read });
      player.show();
      player.load();
      await settle();
      expect(player.snapshot.state).toBe("unavailable");
      expect(read).toHaveBeenCalledTimes(1);
      player.dispose();
    }
    expect(audio.plays).toBe(0);
    // No audio in this browser at all.
    const silent = createMenuMusic({
      element: () => null,
      fetch: answering(manifest),
    });
    silent.load();
    silent.show();
    await settle();
    expect(silent.snapshot.state).toBe("unavailable");
    silent.dispose();
  });

  it("begins with the remembered song when it is still there and ticked", async () => {
    make();
    music.setShuffle(false);
    music.remember("02-b.mp3");
    music.load();
    music.show();
    await settle();
    expect(music.snapshot.current?.file).toBe("02-b.mp3");
    // Then on in order.
    music.next();
    expect(music.snapshot.current?.file).toBe("03-c.mp3");
    music.dispose();

    // A remembered song no longer listed, or unticked, is passed over.
    audio = new FakeAudio();
    make();
    music.setShuffle(false);
    music.remember("09-z.mp3");
    music.load();
    music.show();
    await settle();
    expect(music.snapshot.current?.file).toBe("01-a.mp3");
    music.dispose();

    audio = new FakeAudio();
    make();
    music.setShuffle(false);
    music.setExcluded(["02-b.mp3"]);
    music.remember("02-b.mp3");
    music.load();
    music.show();
    await settle();
    expect(music.snapshot.current?.file).toBe("01-a.mp3");
  });

  it("plays the next song when one ends, and skips a song that fails", async () => {
    make();
    music.setShuffle(false);
    music.load();
    music.show();
    await settle();
    vi.advanceTimersByTime(FADE_IN_MS + FADE_STEP_MS);
    audio.end();
    await settle();
    expect(music.snapshot.current?.file).toBe("02-b.mp3");
    expect(audio.sources).toEqual(["/music/01-a.mp3", "/music/02-b.mp3"]);
    expect(audio.paused).toBe(false);
    expect(audio.volume).toBeCloseTo(level);
    // Gamma is missing from the folder: the player moves on and does not come back to it.
    audio.failing.add("/music/03-c.mp3");
    audio.end();
    await settle();
    expect(audio.sources.slice(-2)).toEqual([
      "/music/03-c.mp3",
      "/music/01-a.mp3",
    ]);
    expect(music.snapshot.current?.file).toBe("01-a.mp3");
    expect(music.snapshot.state).toBe("playing");
    audio.end();
    await settle();
    expect(music.snapshot.current?.file).toBe("02-b.mp3");
    audio.end();
    await settle();
    expect(music.snapshot.current?.file).toBe("01-a.mp3");
    // Chosen by hand, a failed song is tried again.
    audio.failing.clear();
    music.select("03-c.mp3");
    await settle();
    expect(music.snapshot.current?.file).toBe("03-c.mp3");
    expect(audio.paused).toBe(false);
  });

  it("goes away when every song fails", async () => {
    for (const file of ["01-a.mp3", "02-b.mp3", "03-c.mp3"])
      audio.failing.add(`/music/${file}`);
    make();
    music.load();
    music.show();
    await settle();
    await settle();
    expect(music.snapshot.state).toBe("unavailable");
    expect(audio.paused).toBe(true);
  });

  it("fades out and holds its place as the menus go, and resumes from there", async () => {
    make();
    music.setShuffle(false);
    music.load();
    music.show();
    await settle();
    vi.advanceTimersByTime(FADE_IN_MS + FADE_STEP_MS);
    audio.currentTime = 42;
    music.hide();
    expect(music.snapshot.state).toBe("idle");
    expect(audio.paused).toBe(false);
    vi.advanceTimersByTime(FADE_OUT_MS / 2);
    expect(audio.volume).toBeLessThan(level);
    expect(audio.volume).toBeGreaterThan(0);
    vi.advanceTimersByTime(FADE_OUT_MS);
    expect(audio.paused).toBe(true);
    expect(audio.volume).toBe(0);
    // Back: the same song, from the same second, fading in again.
    music.show();
    await settle();
    expect(music.snapshot.state).toBe("playing");
    expect(audio.currentTime).toBe(42);
    expect(audio.sources).toEqual(["/music/01-a.mp3"]);
    expect(audio.paused).toBe(false);
    vi.advanceTimersByTime(FADE_IN_MS + FADE_STEP_MS);
    expect(audio.volume).toBeCloseTo(level);
    // Shown again while still fading out: the fade turns round, with no pause.
    music.hide();
    vi.advanceTimersByTime(FADE_OUT_MS / 2);
    const pausesBefore = audio.pauses;
    music.show();
    vi.advanceTimersByTime(FADE_IN_MS + FADE_STEP_MS);
    expect(audio.pauses).toBe(pausesBefore);
    expect(audio.volume).toBeCloseTo(level);
  });

  it("pauses by hand and plays again, at the level", async () => {
    make();
    music.load();
    music.show();
    await settle();
    vi.advanceTimersByTime(FADE_IN_MS + FADE_STEP_MS);
    music.setPaused(true);
    expect(music.snapshot.state).toBe("paused");
    expect(audio.paused).toBe(true);
    // Paused, a hide and show stream nothing.
    music.hide();
    music.show();
    await settle();
    expect(audio.paused).toBe(true);
    expect(music.snapshot.state).toBe("paused");
    music.setPaused(false);
    await settle();
    expect(music.snapshot.state).toBe("playing");
    expect(audio.paused).toBe(false);
    expect(audio.volume).toBeCloseTo(level);
    // Paused before the manifest arrives: nothing plays when it does.
    audio = new FakeAudio();
    const player = make();
    player.setPaused(true);
    player.load();
    player.show();
    await settle();
    expect(player.snapshot.state).toBe("paused");
    expect(player.snapshot.current).not.toBeNull();
    expect(audio.plays).toBe(0);
  });

  it("follows the level as (volume/100)², and a mute pauses the stream", async () => {
    make();
    music.load();
    music.show();
    await settle();
    vi.advanceTimersByTime(FADE_IN_MS + FADE_STEP_MS);
    music.setLevel(100, false);
    expect(audio.volume).toBe(1);
    music.setLevel(20, false);
    expect(audio.volume).toBeCloseTo(0.04);
    music.setLevel(150, false);
    expect(audio.volume).toBe(1);
    music.setLevel(Number.NaN, false);
    expect(audio.volume).toBe(1);
    music.setLevel(80, true);
    expect(audio.volume).toBe(0);
    expect(audio.paused).toBe(true);
    // Muted, it still counts as playing: unmuting plays on from the same place.
    expect(music.snapshot.state).toBe("playing");
    audio.currentTime = 10;
    const plays = audio.plays;
    music.setLevel(80, false);
    await settle();
    expect(audio.plays).toBe(plays + 1);
    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBe(10);
    expect(audio.volume).toBeCloseTo(0.64);
    // Muted before the menus show: the manifest is read, the song cued, nothing streamed.
    audio = new FakeAudio();
    const quiet = make();
    quiet.setLevel(50, true);
    quiet.load();
    quiet.show();
    await settle();
    expect(audio.plays).toBe(0);
    expect(quiet.snapshot.current).not.toBeNull();
  });

  it("waits for a click or key press when the browser refuses, then plays", async () => {
    audio.answer = "refused";
    make();
    music.load();
    music.show();
    await settle();
    expect(music.snapshot.state).toBe("waiting");
    expect(audio.plays).toBe(1);
    // Another press while still refused asks again, once per press.
    window.dispatchEvent(new Event("keydown"));
    await settle();
    expect(audio.plays).toBe(2);
    expect(music.snapshot.state).toBe("waiting");
    audio.answer = "allowed";
    window.dispatchEvent(new Event("pointerdown"));
    await settle();
    expect(audio.plays).toBe(3);
    expect(music.snapshot.state).toBe("playing");
    // Once playing, presses do nothing.
    window.dispatchEvent(new Event("pointerdown"));
    await settle();
    expect(audio.plays).toBe(3);
  });

  it("stops waiting when the menus go, and asks again when they come back", async () => {
    audio.answer = "refused";
    make();
    music.load();
    music.show();
    await settle();
    music.hide();
    window.dispatchEvent(new Event("keydown"));
    await settle();
    expect(audio.plays).toBe(1);
    music.show();
    await settle();
    expect(audio.plays).toBe(2);
    expect(music.snapshot.state).toBe("waiting");
  });

  it("moves to the next song when the one playing is unticked, and leaves a chosen one alone", async () => {
    make();
    music.setShuffle(false);
    music.load();
    music.show();
    await settle();
    expect(music.snapshot.current?.file).toBe("01-a.mp3");
    music.setExcluded(["01-a.mp3"]);
    await settle();
    expect(music.snapshot.current?.file).toBe("02-b.mp3");
    expect([...music.snapshot.ticked]).toEqual(["02-b.mp3", "03-c.mp3"]);
    // Chosen by hand while unticked, Alpha plays, and another tick's change leaves it playing.
    music.select("01-a.mp3");
    await settle();
    expect(music.snapshot.current?.file).toBe("01-a.mp3");
    music.setExcluded(["01-a.mp3", "03-c.mp3"]);
    await settle();
    expect(music.snapshot.current?.file).toBe("01-a.mp3");
    // Its end goes to the ticked song.
    audio.end();
    await settle();
    expect(music.snapshot.current?.file).toBe("02-b.mp3");
    // Every song unticked keeps the first.
    music.setExcluded(["01-a.mp3", "02-b.mp3", "03-c.mp3"]);
    await settle();
    expect([...music.snapshot.ticked]).toEqual(["01-a.mp3"]);
  });

  it("walks forward and back, shuffled or in order", async () => {
    make();
    music.setShuffle(false);
    music.load();
    music.show();
    await settle();
    music.next();
    music.next();
    expect(music.snapshot.current?.file).toBe("03-c.mp3");
    music.previous();
    expect(music.snapshot.current?.file).toBe("02-b.mp3");
    music.setShuffle(true);
    expect(music.snapshot.shuffled).toBe(true);
    const heard = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      music.next();
      heard.add(music.snapshot.current!.file);
    }
    expect(heard.size).toBe(3);
    // Each change of song starts it from the beginning.
    expect(audio.currentTime).toBe(0);
    expect(audio.paused).toBe(false);
  });

  it("does nothing before the manifest, and releases the element when disposed", async () => {
    make();
    music.next();
    music.previous();
    music.select("01-a.mp3");
    music.setExcluded(["01-a.mp3"]);
    expect(audio.sources).toEqual([]);
    music.load();
    music.show();
    await settle();
    expect(audio.paused).toBe(false);
    music.dispose();
    expect(audio.paused).toBe(true);
    expect(audio.src).toBe("");
    // Nothing after: an answer arriving late changes nothing.
    audio.end();
    expect(audio.sources.at(-1)).toBe("");
  });

  it("is one player for the page", () => {
    resetMenuMusic();
    const player = getMenuMusic();
    expect(getMenuMusic()).toBe(player);
    resetMenuMusic();
    expect(getMenuMusic()).not.toBe(player);
    resetMenuMusic();
  });
});
