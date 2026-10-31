import { DEFAULT_TABLE_SETTINGS } from "../table/types";

// The gameplay music (v0.7.2): one track, streamed from /music/game.mp3 and played by one <audio>
// element during a game only. It starts from the beginning with each game, loops while the game
// lasts, fades in as the table opens and out as the game ends or the player leaves, and follows the
// table settings' music volume and its mutes (the music's own, and Mute all sound). A mute pauses
// the stream rather than silencing it, so a muted player costs the site nothing; unmuting goes on
// from where it stopped. The track is not in the public repository: the owner's private web image
// carries it, and the public image answers 404, which leaves the table quiet. Browsers allow
// play() only after a gesture: the click that started or resumed the game is one, remembered by the
// page, and a table opened by a reload waits for the first click or key press.

export const GAME_MUSIC_URL = "/music/game.mp3";
/** The track rises to its level over this long as a game opens. */
export const FADE_IN_MS = 2500;
/** And falls to silence over this long as the game ends or the player leaves. */
export const FADE_OUT_MS = 1500;
/** The fades move in steps this far apart. */
export const FADE_STEP_MS = 50;

/**
 * "idle": no game. "waiting": a game is on, but the browser wants a click or key press first.
 * "playing": heard (or paused by a mute, to go on when unmuted). "fading": the game is over and
 * the track is falling to silence. "unavailable": no track at the address, or no audio at all.
 */
export type MusicState =
  "idle" | "waiting" | "playing" | "fading" | "unavailable";

/** The part of HTMLAudioElement the player uses; tests pass a fake. */
export interface MusicElement {
  src: string;
  loop: boolean;
  preload: string;
  volume: number;
  currentTime: number;
  readonly paused: boolean;
  /** jsdom's returns nothing: treated as allowed. */
  play(): Promise<void> | undefined;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface GameMusic {
  readonly state: MusicState;
  /** A game is on: from the beginning of the track, fading in. Again while playing: nothing. */
  start(): void;
  /** The game is over, or the player left: fades out and stops. */
  stop(): void;
  /** The music volume, 0–100, and whether either mute is on. */
  setLevel(volume: number, muted: boolean): void;
  dispose(): void;
}

export interface GameMusicOptions {
  /** Makes the element; null when the browser has no audio. Defaults to `new Audio()`. */
  element?: () => MusicElement | null;
  src?: string;
}

/** The presses that may start audio (the sound engine listens for the same). */
const WAKE_EVENTS = ["pointerdown", "pointerup", "touchend", "keydown"];

function windowAudio(): MusicElement | null {
  const scope = globalThis as { Audio?: new () => HTMLAudioElement };
  if (typeof scope.Audio !== "function") return null;
  try {
    return new scope.Audio();
  } catch {
    return null;
  }
}

export function createGameMusic(options: GameMusicOptions = {}): GameMusic {
  const make = options.element ?? windowAudio;
  const src = options.src ?? GAME_MUSIC_URL;
  let element: MusicElement | null = null;
  let unavailable = false;
  /** A game is on: start() was called and stop() not yet. */
  let wanted = false;
  /** The browser refused play() until a gesture; the next one tries again. */
  let waiting = false;
  /** The settings' level: (volume/100)², or 0 when muted. */
  let level = (DEFAULT_TABLE_SETTINGS.musicVolume / 100) ** 2;
  /** The fade, 0 (silent) to 1 (at the level), and where it is going. */
  let fade = 0;
  let fadeTo = 0;
  let fadeTimer: ReturnType<typeof setInterval> | null = null;
  let listening = false;

  const silent = () => level <= 0;

  function apply() {
    if (element) element.volume = Math.min(1, Math.max(0, level * fade));
  }

  function onError() {
    // 404 and the like: MEDIA_ERR_SRC_NOT_SUPPORTED. Nothing else is tried; the table stays quiet.
    unavailable = true;
    wanted = false;
    stopListening();
    stopFade();
    element?.pause();
  }

  function ensure(): MusicElement | null {
    if (element || unavailable) return element;
    const made = make();
    if (!made) {
      unavailable = true;
      return null;
    }
    made.preload = "none";
    made.loop = true;
    made.src = src;
    made.addEventListener("error", onError);
    element = made;
    apply();
    return element;
  }

  function wake() {
    if (!waiting) return stopListening();
    tryPlay();
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

  /** Plays when a game is on and nothing silences it; a refusal waits for a gesture. */
  function tryPlay() {
    const audio = ensure();
    if (!audio || !wanted || silent()) return;
    if (!audio.paused) return;
    let result: Promise<void> | undefined;
    try {
      result = audio.play();
    } catch {
      result = undefined;
    }
    Promise.resolve(result).then(
      () => {
        waiting = false;
        stopListening();
        // The game ended, or a mute came, while the browser was still starting the track.
        if (!wanted || silent()) audio.pause();
      },
      (error: unknown) => {
        if (!wanted) return;
        const name = error instanceof Error ? error.name : "";
        if (name === "NotAllowedError") {
          waiting = true;
          listen();
        } else if (name === "NotSupportedError") onError();
        // AbortError: a pause() came first; the next start or unmute plays again.
      },
    );
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

  return {
    get state(): MusicState {
      if (unavailable) return "unavailable";
      if (!wanted) return fadeTimer !== null ? "fading" : "idle";
      return waiting ? "waiting" : "playing";
    },

    start() {
      if (unavailable) return;
      const audio = ensure();
      if (!audio) return;
      const resumed = wanted;
      wanted = true;
      waiting = false;
      // A new game begins the track again, even one that opens while the last game's fade-out is
      // still falling (the next game of a match); a start while a game is on (React running an
      // effect twice) changes nothing.
      if (!resumed) {
        try {
          audio.currentTime = 0;
        } catch {
          // Nothing loaded yet: it starts at 0 anyway.
        }
        if (audio.paused) fade = 0;
      }
      runFade(1, FADE_IN_MS);
      tryPlay();
    },

    stop() {
      if (!wanted) return;
      wanted = false;
      waiting = false;
      stopListening();
      const audio = element;
      if (!audio || audio.paused) {
        stopFade();
        fade = 0;
        apply();
        return;
      }
      runFade(0, FADE_OUT_MS, () => audio.pause());
    },

    setLevel(volume, muted) {
      if (!Number.isFinite(volume)) return;
      const clamped = Math.min(100, Math.max(0, volume));
      level = muted ? 0 : (clamped / 100) ** 2;
      apply();
      const audio = element;
      if (!audio) return;
      // A mute pauses the stream; the player's unmute (a click) plays it again from there.
      if (silent()) {
        if (!audio.paused) audio.pause();
        stopListening();
        waiting = false;
      } else if (wanted && audio.paused) tryPlay();
    },

    dispose() {
      wanted = false;
      waiting = false;
      stopListening();
      stopFade();
      if (element) {
        element.pause();
        element.removeEventListener("error", onError);
        // Releases the stream.
        element.src = "";
      }
      element = null;
      fade = 0;
      fadeTo = 0;
      unavailable = false;
    },
  };
}

let music: GameMusic | null = null;

/** The page's one player. Asking for it makes no element; start() does. */
export function getGameMusic(): GameMusic {
  return (music ??= createGameMusic());
}
