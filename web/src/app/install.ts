import { useSyncExternalStore } from "react";
import type { Me } from "../api";

// Installing the site as an app with its own desktop icon (v0.3.0, PWA01). Only Chrome and Edge
// on a PC offer it: they fire beforeinstallprompt once the page qualifies, and its prompt() works
// once, inside a click. When they hold it back (after a refusal they may for months), the banner
// and Settings explain the browser's own menu instead. The browser makes the icon; a site cannot.
//
// States: unsupported (another browser, a phone, or no client hints: the user agent string is
// never read, since headless Chrome calls itself HeadlessChrome there); standalone (this is the
// app's own window); installed; waiting (a supported browser, no event yet, under 30 s on the
// page); available (the event came); manual (no event after 30 s, or it was used); prompting
// (the browser's install window is open).

export type InstallState =
  | "unsupported"
  | "standalone"
  | "installed"
  | "waiting"
  | "available"
  | "manual"
  | "prompting";
export type InstallBrowser = "chrome" | "edge";
export interface InstallSnapshot {
  state: InstallState;
  browser: InstallBrowser | null;
  dismissedUntil: number | null;
  /** For 6 s after the install: "Installed. Find Commander Duels on your desktop…" */
  installedNotice: boolean;
}
type InstallResult = "accepted" | "dismissed" | "unavailable";
export interface InstallController {
  get(): InstallSnapshot;
  subscribe(listener: () => void): () => void;
  install(): Promise<InstallResult>;
  notNow(): void;
  dispose(): void;
}

export const INSTALL_KEY = "cd.install.v1";
export const DISMISS_MS = 30 * 24 * 60 * 60 * 1000;
export const WAIT_MS = 30 * 1000;
export const NOTICE_MS = 6000;
/** An accepted install that never reports appinstalled still counts after this long. */
const ACCEPTED_MS = 10 * 1000;

interface PromptEvent extends Event {
  prompt(): Promise<unknown>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
interface ClientHints {
  brands?: { brand: string }[];
  mobile?: boolean;
}
export interface InstallEnv {
  /** Where beforeinstallprompt and appinstalled arrive: the window. */
  events: EventTarget;
  navigator: {
    userAgentData?: ClientHints;
    getInstalledRelatedApps?(): Promise<{ platform: string }[]>;
  };
  matchMedia?(query: string): { matches: boolean };
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  now(): number;
}

/** Edge's hints name Chromium too, never Google Chrome; HeadlessChrome names neither. */
export function installBrowser(
  hints: ClientHints | undefined,
): InstallBrowser | null {
  if (!hints || hints.mobile) return null;
  const brands = (hints.brands ?? []).map((b) => b.brand);
  if (brands.includes("Microsoft Edge")) return "edge";
  if (brands.includes("Google Chrome")) return "chrome";
  return null;
}

function standalone(env: InstallEnv): boolean {
  try {
    return ["standalone", "window-controls-overlay"].some(
      (mode) => env.matchMedia?.(`(display-mode: ${mode})`).matches === true,
    );
  } catch {
    return false;
  }
}

interface Stored {
  installedAt?: number;
  dismissedUntil?: number;
}
function readStored(env: InstallEnv): Stored {
  try {
    const value: unknown = JSON.parse(
      env.storage?.getItem(INSTALL_KEY) ?? "null",
    );
    if (typeof value !== "object" || value === null) return {};
    const record = value as Record<string, unknown>;
    const time = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;
    return {
      installedAt: time(record.installedAt),
      dismissedUntil: time(record.dismissedUntil),
    };
  } catch {
    return {};
  }
}
function writeStored(env: InstallEnv, value: Stored) {
  try {
    env.storage?.setItem(INSTALL_KEY, JSON.stringify(value));
  } catch {
    // Without storage, Not now lasts for this visit.
  }
}

export function createInstall(env: InstallEnv): InstallController {
  const stored = readStored(env);
  const browser = installBrowser(env.navigator.userAgentData);
  let snapshot: InstallSnapshot = {
    state: standalone(env)
      ? "standalone"
      : !browser
        ? "unsupported"
        : stored.installedAt !== undefined
          ? "installed"
          : "waiting",
    browser,
    dismissedUntil: stored.dismissedUntil ?? null,
    installedNotice: false,
  };
  let saved = stored;
  let deferred: PromptEvent | null = null;
  const listeners = new Set<() => void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function set(patch: Partial<InstallSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  }
  function store(patch: Stored) {
    saved = { ...saved, ...patch };
    writeStored(env, saved);
  }
  function later(ms: number, run: () => void) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timers.add(timer);
  }
  function installed() {
    deferred = null;
    store({ installedAt: env.now() });
    set({ state: "installed", installedNotice: true });
    later(NOTICE_MS, () => set({ installedNotice: false }));
  }

  // The app's own window and other browsers never offer an install: nothing to listen for.
  const offering =
    snapshot.state === "waiting" || snapshot.state === "installed";
  const onPrompt = (event: Event) => {
    if (snapshot.state === "prompting") return;
    // Keeps the browser's own prompt back until the player presses Install.
    event.preventDefault();
    deferred = event as PromptEvent;
    // The browser offers an install only when the app is not installed: one recorded earlier
    // was since uninstalled.
    if (saved.installedAt !== undefined) store({ installedAt: undefined });
    set({ state: "available" });
  };
  const onInstalled = () => installed();
  if (offering) {
    env.events.addEventListener("beforeinstallprompt", onPrompt);
    env.events.addEventListener("appinstalled", onInstalled);
  }
  if (snapshot.state === "waiting") {
    later(WAIT_MS, () => {
      if (snapshot.state === "waiting") set({ state: "manual" });
    });
    // Chrome and Edge (140 and later) can tell a tab that the app is installed already. It knows
    // only the live site's address (related_applications), so local builds never match.
    void env.navigator
      .getInstalledRelatedApps?.()
      .then((apps) => {
        const open = ["waiting", "available", "manual"];
        if (apps.length > 0 && open.includes(snapshot.state)) {
          deferred = null;
          set({ state: "installed" });
        }
      })
      .catch(() => undefined);
  }

  async function install(): Promise<InstallResult> {
    const event = deferred;
    if (snapshot.state !== "available" || !event) return "unavailable";
    // An event's prompt works once.
    deferred = null;
    set({ state: "prompting" });
    let choice: { outcome: "accepted" | "dismissed" };
    try {
      // Called before anything is awaited: the browser accepts it only inside the click.
      const shown = event.prompt();
      await shown;
      choice = await event.userChoice;
    } catch {
      set({ state: "manual" });
      return "unavailable";
    }
    if (choice.outcome === "accepted") {
      later(ACCEPTED_MS, () => {
        if (snapshot.state === "prompting") installed();
      });
      return "accepted";
    }
    notNow();
    set({ state: "manual" });
    return "dismissed";
  }

  function notNow() {
    const until = env.now() + DISMISS_MS;
    store({ dismissedUntil: until });
    set({ dismissedUntil: until });
  }

  return {
    get: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    install,
    notNow,
    dispose() {
      env.events.removeEventListener("beforeinstallprompt", onPrompt);
      env.events.removeEventListener("appinstalled", onInstalled);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      listeners.clear();
    },
  };
}

/** The drop-down banner: signed-in active accounts, shell pages, an install to offer, not dismissed. */
export function bannerVisible(
  state: InstallState,
  me: Me | null | undefined,
  onGame: boolean,
  now: number,
  dismissedUntil: number | null,
): boolean {
  return (
    me?.status === "active" &&
    !onGame &&
    (state === "available" || state === "manual") &&
    (dismissedUntil === null || now >= dismissedUntil)
  );
}

let controller: InstallController | null = null;

function localStore(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** main.tsx calls this before React renders: beforeinstallprompt can come very early. */
export function initInstall(): void {
  controller ??= createInstall({
    events: window,
    navigator: navigator as InstallEnv["navigator"],
    matchMedia:
      typeof window.matchMedia === "function"
        ? (query) => window.matchMedia(query)
        : undefined,
    storage: localStore(),
    now: () => Date.now(),
  });
}

function current(): InstallController {
  initInstall();
  return controller!;
}

export function useInstall(): InstallSnapshot & {
  install(): Promise<InstallResult>;
  notNow(): void;
} {
  const install = current();
  const snapshot = useSyncExternalStore(install.subscribe, install.get);
  return { ...snapshot, install: install.install, notNow: install.notNow };
}
