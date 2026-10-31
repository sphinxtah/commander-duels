import { DEFAULT_MENU_MUSIC } from "./menuMusicSettings";
import {
  PLAYLIST_URL,
  Queue,
  parsePlaylist,
  trackUrl,
  type Track,
} from "./playlist";

// The menu music's player (v0.7.3): one <audio> element that plays the manifest's songs one after
// another on every page of the app but a game's. Like the gameplay track's player
// (game/music/gameMusic.ts) it streams (preload="none", Range requests), pauses the stream under a
// mute so a muted player costs the site nothing, fades in as the menus show and out as they go
// (a game opening, a sign-out), and waits for the click or key press browsers want before the
// first sound. Unlike it, it remembers its place: a game pauses the song and the menus resume it
// from the same second; a reload resumes the same song from its start. The hook (useMenuMusic.ts)
// gives it the settings and keeps the song and the ticks in them; this file knows nothing of
// React or storage.

/** The songs rise to their level over this long as the menus show. */
export const FADE_IN_MS = 1200;
/** And fall to silence over this long as a game opens or the player signs out. */
export const FADE_OUT_MS = 800;
/** The fades move in steps this far apart. */
export const FADE_STEP_MS = 50;

/**
 * "loading": the manifest is not read yet. "unavailable": no manifest (the public images), no
 * audio, or every song failed to play; the box stays off the screen. "idle": the songs are known
 * and the menus are not on screen. "waiting": the menus are on and the browser wants a gesture
 * first. "playing": heard, or silent under a mute and going on when unmuted. "paused": stopped by
 * hand, until Play.
 */
export type MenuMusicState =
  "loading" | "unavailable" | "idle" | "waiting" | "playing" | "paused";

/** The part of HTMLAudioElement the player uses; tests pass a fake. */
export interface MenuMusicElement {
  src: string;
  preload: string;
  volume: number;
  currentTime: number;
  readonly paused: boolean;
  play(): Promise<void> | undefined;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** What the box draws; a new object on every change, for useSyncExternalStore. */
export interface MenuMusicSnapshot {
  state: MenuMusicState;
  tracks: readonly Track[];
  current: Track | null;
  shuffled: boolean;
  /** The songs ticked, by file. */
  ticked: ReadonlySet<string>;
}

export interface MenuMusic {
  readonly snapshot: MenuMusicSnapshot;
  subscribe(listener: () => void): () => void;
  /** Reads the manifest once; nothing happens twice. */
  load(): void;
  /** The song to begin with when nothing has played yet (the last visit's), by file. */
  remember(file: string | null): void;
  /** The menus are on screen: play, unless paused by hand. */
  show(): void;
  /** The menus left the screen: fade out and hold the place. */
  hide(): void;
  setPaused(paused: boolean): void;
  /** The music volume, 0–100, and whether any mute is on. */
  setLevel(volume: number, muted: boolean): void;
  setShuffle(on: boolean): void;
  /** The songs left out, by file. */
  setExcluded(files: readonly string[]): void;
  /** This song, now. */
  select(file: string): void;
  next(): void;
  previous(): void;
  dispose(): void;
}

export interface MenuMusicOptions {
  /** Makes the element; null when the browser has no audio. Defaults to `new Audio()`. */
  element?: () => MenuMusicElement | null;
  /** Reads the manifest. Defaults to the page's fetch. */
  fetch?: (url: string) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  url?: string;
  random?: () => number;
}

/** The presses that may start audio (the sound engine and the game's music listen for the same). */
const WAKE_EVENTS = ["pointerdown", "pointerup", "touchend", "keydown"];

function windowAudio(): MenuMusicElement | null {
  const scope = globalThis as { Audio?: new () => HTMLAudioElement };
  if (typeof scope.Audio !== "function") return null;
  try {
    return new scope.Audio();
  } catch {
    return null;
  }
}

function windowFetch(url: string) {
  return fetch(url, { cache: "no-cache" });
}

export function createMenuMusic(options: MenuMusicOptions = {}): MenuMusic {
  const make = options.element ?? windowAudio;
  const read = options.fetch ?? windowFetch;
  const url = options.url ?? PLAYLIST_URL;
  const queue = new Queue(options.random);
  let tracks: Track[] = [];
  const byFile = new Map<string, Track>();
  /** Songs whose stream failed this visit: skipped, their ticks untouched. */
  const failed = new Set<string>();
  let loading: "no" | "yes" | "done" = "no";
  let unavailable = false;
  let element: MenuMusicElement | null = null;
  /** The menus are on screen. */
  let shown = false;
  /** Stopped by hand. */
  let paused = false;
  /** The browser refused play() until a gesture; the next one tries again. */
  let waiting = false;
  let remembered: string | null = null;
  /** The song the element is pointed at, by file, and a count of the cues: a play() that was
   * refused for an earlier song (the browser rejects it as the error event comes, after the error
   * event moved the player on) is nothing to act on. */
  let cued: string | null = null;
  let cues = 0;
  /** The settings' level: (volume/100)², or 0 when muted. */
  let level = (DEFAULT_MENU_MUSIC.volume / 100) ** 2;
  /** The fade, 0 (silent) to 1 (at the level), and where it is going. */
  let fade = 0;
  let fadeTo = 0;
  let fadeTimer: ReturnType<typeof setInterval> | null = null;
  let listening = false;
  let disposed = false;
  const listeners = new Set<() => void>();
  let snapshot: MenuMusicSnapshot = {
    state: "loading",
    tracks: [],
    current: null,
    shuffled: queue.shuffled,
    ticked: new Set(),
  };

  function state(): MenuMusicState {
    if (unavailable) return "unavailable";
    if (loading !== "done") return "loading";
    if (paused) return "paused";
    if (!shown) return "idle";
    return waiting ? "waiting" : "playing";
  }

  function notify() {
    const now = queue.now;
    snapshot = {
      state: state(),
      tracks,
      current: now === null ? null : (byFile.get(now) ?? null),
      shuffled: queue.shuffled,
      ticked: new Set(
        tracks.filter((t) => queue.isTicked(t.file)).map((t) => t.file),
      ),
    };
    for (const listener of listeners) listener();
  }

  const silent = () => level <= 0;
  /** Sound is wanted: the menus are on, nothing stopped it, and a song is there to play. */
  const wanted = () => shown && !paused && !unavailable && queue.now !== null;

  function apply() {
    if (element) element.volume = Math.min(1, Math.max(0, level * fade));
  }

  function stopFade() {
    if (fadeTimer !== null) clearInterval(fadeTimer);
    fadeTimer = null;
  }

  /** Moves the fade toward its target in FADE_STEP_MS steps, then does what the end asks. */
  function runFade(to: number, ms: number, atEnd?: () => void) {
    fadeTo = to;
    stopFade();
    const step = FADE_STEP_MS / Math.max(FADE_STEP_MS, ms);
    const tick = () => {
      fade =
        fade < fadeTo
          ? Math.min(fadeTo, fade + step)
          : Math.max(fadeTo, fade - step);
      apply();
      if (fade === fadeTo) {
        stopFade();
        atEnd?.();
      }
    };
    fadeTimer = setInterval(tick, FADE_STEP_MS);
  }

  function listen() {
    if (listening || typeof window === "undefined") return;
    listening = true;
    for (const type of WAKE_EVENTS) window.addEventListener(type, wake, true);
  }

  function stopListening() {
    if (!listening) return;
    listening = false;
    for (const type of WAKE_EVENTS)
      window.removeEventListener(type, wake, true);
  }

  function wake() {
    if (!waiting) return stopListening();
    tryPlay();
  }

  function onEnded() {
    // The song ran out: the next one, at once.
    if (disposed) return;
    advance(() => queue.next());
  }

  function onError() {
    // 404 and the like. The song is skipped for this visit; when every song fails, the manifest
    // named nothing the folder serves and the box goes away.
    if (disposed) return;
    const now = queue.now;
    if (now !== null) failed.add(now);
    if (failed.size >= tracks.length) {
      unavailable = true;
      stopListening();
      stopFade();
      element?.pause();
      notify();
      return;
    }
    advance(() => queue.next());
  }

  function ensure(): MenuMusicElement | null {
    if (element || unavailable) return element;
    const made = make();
    if (!made) {
      unavailable = true;
      return null;
    }
    made.preload = "none";
    made.addEventListener("ended", onEnded);
    made.addEventListener("error", onError);
    element = made;
    apply();
    return element;
  }

  /** Points the element at a song, from its start (the same song again starts over too). */
  function cue(file: string) {
    const audio = ensure();
    if (!audio) return;
    if (cued !== file) {
      audio.pause();
      audio.src = trackUrl(file);
      cued = file;
    }
    cues += 1;
    try {
      audio.currentTime = 0;
    } catch {
      // Nothing loaded yet: it starts at 0 anyway.
    }
  }

  /** Plays when sound is wanted and nothing silences it; a refusal waits for a gesture. */
  function tryPlay() {
    const audio = ensure();
    if (!audio || !wanted() || silent()) return;
    if (!audio.paused) return;
    const at = cues;
    let result: Promise<void> | undefined;
    try {
      result = audio.play();
    } catch {
      result = undefined;
    }
    Promise.resolve(result).then(
      () => {
        const was = waiting;
        waiting = false;
        stopListening();
        // The menus left, or a mute or Pause came, while the browser was still starting it.
        if (!wanted() || silent()) audio.pause();
        if (was) notify();
      },
      (error: unknown) => {
        if (!wanted() || at !== cues) return;
        const name = error instanceof Error ? error.name : "";
        if (name === "NotAllowedError") {
          if (!waiting) {
            waiting = true;
            notify();
          }
          listen();
        } else if (name === "NotSupportedError") onError();
        // AbortError: a pause() came first; the next show or unmute plays again.
      },
    );
  }

  /** Moves to the song `choose` names (skipping failed ones), cues it and plays if wanted. */
  function advance(choose: () => string | null) {
    let file: string | null = null;
    for (let tries = 0; tries <= tracks.length; tries += 1) {
      file = choose();
      if (file === null || !failed.has(file)) break;
    }
    if (file === null || failed.has(file)) {
      notify();
      return;
    }
    cue(file);
    // A song changed by hand or by its end starts at the level, unless a fade is on its way.
    if (fadeTimer === null) {
      fade = wanted() ? 1 : 0;
      apply();
    }
    tryPlay();
    notify();
  }

  /** The first song of the visit, once the manifest is known and the menus ask for it. */
  function begin() {
    if (queue.now !== null || tracks.length === 0) return;
    const last = remembered;
    remembered = null;
    // The last visit's song, when the manifest still has it and it is still ticked.
    const file =
      last !== null &&
      byFile.has(last) &&
      queue.isTicked(last) &&
      queue.select(last)
        ? last
        : queue.start();
    if (file !== null) cue(file);
  }

  return {
    get snapshot() {
      return snapshot;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    load() {
      if (loading !== "no") return;
      loading = "yes";
      Promise.resolve()
        .then(() => read(url))
        .then((response) => (response.ok ? response.json() : null))
        .then(
          (value) => {
            if (disposed) return;
            const list = value === null ? null : parsePlaylist(value);
            loading = "done";
            if (!list || list.length === 0) {
              unavailable = true;
              notify();
              return;
            }
            tracks = list;
            byFile.clear();
            for (const track of list) byFile.set(track.file, track);
            queue.setTracks(list.map((track) => track.file));
            if (shown) {
              begin();
              if (wanted()) {
                fade = 0;
                runFade(1, FADE_IN_MS);
                tryPlay();
              }
            }
            notify();
          },
          () => {
            if (disposed) return;
            // The manifest could not be read: as if there were none.
            loading = "done";
            unavailable = true;
            notify();
          },
        );
    },

    remember(file) {
      remembered = file;
    },

    show() {
      if (shown) return;
      shown = true;
      if (unavailable || loading !== "done") {
        notify();
        return;
      }
      begin();
      if (wanted()) {
        if (element?.paused !== false) fade = 0;
        runFade(1, FADE_IN_MS);
        tryPlay();
      }
      notify();
    },

    hide() {
      if (!shown) return;
      shown = false;
      waiting = false;
      stopListening();
      const audio = element;
      if (!audio || audio.paused) {
        stopFade();
        fade = 0;
        apply();
      } else runFade(0, FADE_OUT_MS, () => audio.pause());
      notify();
    },

    setPaused(value) {
      if (paused === value) return;
      paused = value;
      const audio = element;
      if (paused) {
        waiting = false;
        stopListening();
        stopFade();
        audio?.pause();
      } else if (shown && loading === "done" && !unavailable) {
        begin();
        if (fadeTimer === null) {
          fade = 1;
          apply();
        }
        tryPlay();
      }
      notify();
    },

    setLevel(volume, muted) {
      if (!Number.isFinite(volume)) return;
      const clamped = Math.min(100, Math.max(0, volume));
      level = muted ? 0 : (clamped / 100) ** 2;
      apply();
      const audio = element;
      if (!audio) return;
      // A mute pauses the stream; the unmute (a click) plays it again from there.
      if (silent()) {
        if (!audio.paused) audio.pause();
        stopListening();
        waiting = false;
      } else if (wanted() && audio.paused) tryPlay();
    },

    setShuffle(on) {
      if (queue.shuffled === on) return;
      queue.setShuffle(on);
      notify();
    },

    setExcluded(files) {
      const now = queue.now;
      const was = now !== null && queue.isTicked(now);
      queue.setExcluded(files);
      // The song playing was unticked just now: the next one takes over. One chosen by hand
      // while unticked plays on.
      if (was && now !== null && !queue.isTicked(now) && loading === "done")
        advance(() => queue.next());
      else notify();
    },

    select(file) {
      if (!byFile.has(file) || loading !== "done") return;
      failed.delete(file);
      advance(() => (queue.select(file) ? file : null));
    },

    next() {
      if (loading !== "done" || tracks.length === 0) return;
      advance(() => queue.next());
    },

    previous() {
      if (loading !== "done" || tracks.length === 0) return;
      advance(() => queue.previous());
    },

    dispose() {
      disposed = true;
      shown = false;
      waiting = false;
      stopListening();
      stopFade();
      if (element) {
        element.pause();
        element.removeEventListener("ended", onEnded);
        element.removeEventListener("error", onError);
        // Releases the stream.
        element.src = "";
      }
      element = null;
      cued = null;
      listeners.clear();
    },
  };
}

let music: MenuMusic | null = null;

/** The page's one player. Asking for it reads nothing; load() does. */
export function getMenuMusic(): MenuMusic {
  return (music ??= createMenuMusic());
}

/** Tests: the next getMenuMusic() makes a fresh player. */
export function resetMenuMusic(): void {
  music?.dispose();
  music = null;
}
