import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import {
  DISMISS_MS,
  INSTALL_KEY,
  NOTICE_MS,
  WAIT_MS,
  bannerVisible,
  createInstall,
  installBrowser,
  type InstallController,
  type InstallEnv,
} from "./install";

// Every state and transition of the install offer, with made-up browsers: client hints as
// Chrome, Edge and headless Chrome give them, display modes, and synthetic install events.

const chrome = {
  brands: [
    { brand: "Google Chrome" },
    { brand: "Chromium" },
    { brand: "Not=A?Brand" },
  ],
  mobile: false,
};
const edge = {
  brands: [{ brand: "Microsoft Edge" }, { brand: "Chromium" }],
  mobile: false,
};
const headless = {
  brands: [{ brand: "HeadlessChrome" }, { brand: "Chromium" }],
  mobile: false,
};

const NOW = Date.UTC(2026, 9, 20, 12);
let events: EventTarget;
let made: InstallController[] = [];

function setup(
  o: Partial<InstallEnv> & { hints?: unknown; modes?: string[] } = {},
) {
  const env: InstallEnv = {
    events,
    navigator: { userAgentData: (o.hints ?? chrome) as never, ...o.navigator },
    matchMedia: (query) => ({
      matches: (o.modes ?? []).some((mode) => query.includes(mode)),
    }),
    storage: o.storage === undefined ? localStorage : o.storage,
    now: () => Date.now(),
  };
  if ("hints" in o && o.hints === undefined) env.navigator = {};
  const install = createInstall(env);
  made.push(install);
  return install;
}

/** A beforeinstallprompt whose install window answers as told. */
function offer(outcome: "accepted" | "dismissed" = "accepted") {
  const event = new Event("beforeinstallprompt", { cancelable: true });
  const prompt = vi.fn(() => Promise.resolve());
  Object.assign(event, {
    prompt,
    userChoice: Promise.resolve({ outcome }),
  });
  events.dispatchEvent(event);
  return { event, prompt };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  events = new EventTarget();
});
afterEach(() => {
  for (const install of made) install.dispose();
  made = [];
  vi.useRealTimers();
});

describe("which browsers can install", () => {
  it("only Chrome and Edge on a PC, from client hints alone", () => {
    expect(installBrowser(chrome)).toBe("chrome");
    expect(installBrowser(edge)).toBe("edge");
    expect(installBrowser(headless)).toBeNull();
    expect(installBrowser({ ...chrome, mobile: true })).toBeNull();
    expect(installBrowser(undefined)).toBeNull();
    expect(
      installBrowser({ brands: [{ brand: "Brave" }], mobile: false }),
    ).toBe(null);
  });

  it("an unsupported browser never takes the browser's own offer", () => {
    for (const hints of [headless, undefined, { ...chrome, mobile: true }]) {
      const install = setup({ hints });
      expect(install.get().state).toBe("unsupported");
      const { event } = offer();
      expect(event.defaultPrevented).toBe(false);
      expect(install.get().state).toBe("unsupported");
      vi.advanceTimersByTime(WAIT_MS);
      expect(install.get().state).toBe("unsupported");
    }
  });

  it("the app's own window is standalone, in either display mode", () => {
    for (const mode of ["standalone", "window-controls-overlay"]) {
      const install = setup({ modes: [mode] });
      expect(install.get().state).toBe("standalone");
      expect(offer().event.defaultPrevented).toBe(false);
      expect(install.get().state).toBe("standalone");
    }
  });
});

describe("the install offer", () => {
  it("waits, then offers Install when the browser does", () => {
    const install = setup();
    expect(install.get()).toMatchObject({
      state: "waiting",
      browser: "chrome",
    });
    const { event } = offer();
    expect(event.defaultPrevented).toBe(true);
    expect(install.get().state).toBe("available");
  });

  it("explains the browser's menu after 30 s without an offer", () => {
    const install = setup({ hints: edge });
    vi.advanceTimersByTime(WAIT_MS - 1);
    expect(install.get().state).toBe("waiting");
    vi.advanceTimersByTime(1);
    expect(install.get()).toMatchObject({ state: "manual", browser: "edge" });
    // A later offer still makes Install possible.
    offer();
    expect(install.get().state).toBe("available");
  });

  it("prompts inside the click, then waits for the install to finish", async () => {
    const install = setup();
    const { prompt } = offer("accepted");
    const result = install.install();
    // Synchronously, as the browser requires.
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(install.get().state).toBe("prompting");
    expect(await result).toBe("accepted");
    expect(install.get().state).toBe("prompting");

    events.dispatchEvent(new Event("appinstalled"));
    expect(install.get()).toMatchObject({
      state: "installed",
      installedNotice: true,
    });
    expect(JSON.parse(localStorage.getItem(INSTALL_KEY)!)).toEqual({
      installedAt: NOW,
    });
    vi.advanceTimersByTime(NOTICE_MS);
    expect(install.get().installedNotice).toBe(false);
    // A prompt works once per event.
    expect(await install.install()).toBe("unavailable");
  });

  it("counts an accepted install that never reports itself", async () => {
    const install = setup();
    offer("accepted");
    await install.install();
    vi.advanceTimersByTime(10_000);
    expect(install.get().state).toBe("installed");
  });

  it("a refusal is Not now for 30 days, and then the menu's way", async () => {
    const install = setup();
    offer("dismissed");
    expect(await install.install()).toBe("dismissed");
    expect(install.get()).toMatchObject({
      state: "manual",
      dismissedUntil: NOW + DISMISS_MS,
    });
    expect(JSON.parse(localStorage.getItem(INSTALL_KEY)!)).toEqual({
      dismissedUntil: NOW + DISMISS_MS,
    });
  });

  it("falls back to the menu when the prompt fails", async () => {
    const install = setup();
    const { prompt } = offer();
    prompt.mockImplementationOnce(() => Promise.reject(new Error("used")));
    expect(await install.install()).toBe("unavailable");
    expect(install.get().state).toBe("manual");
  });

  it("Install does nothing without an offer", async () => {
    const install = setup();
    expect(await install.install()).toBe("unavailable");
    expect(install.get().state).toBe("waiting");
  });
});

describe("an installed app", () => {
  it("is remembered from appinstalled, whatever the state", () => {
    const install = setup();
    events.dispatchEvent(new Event("appinstalled"));
    expect(install.get().state).toBe("installed");
    install.dispose();
    expect(setup().get().state).toBe("installed");
  });

  it("is found by getInstalledRelatedApps", async () => {
    const install = setup({
      navigator: {
        getInstalledRelatedApps: () =>
          Promise.resolve([{ platform: "webapp" }]),
      },
    });
    await vi.waitFor(() => expect(install.get().state).toBe("installed"));
  });

  it("was uninstalled when the browser offers to install it again", () => {
    localStorage.setItem(INSTALL_KEY, JSON.stringify({ installedAt: 1 }));
    const install = setup();
    expect(install.get().state).toBe("installed");
    offer();
    expect(install.get().state).toBe("available");
    expect(JSON.parse(localStorage.getItem(INSTALL_KEY)!)).toEqual({});
  });

  it("survives broken or missing storage", () => {
    localStorage.setItem(INSTALL_KEY, "{broken");
    expect(setup().get()).toMatchObject({
      state: "waiting",
      dismissedUntil: null,
    });
    const install = setup({ storage: null });
    install.notNow();
    expect(install.get().dismissedUntil).toBe(NOW + DISMISS_MS);
  });
});

describe("the banner", () => {
  const me = { status: "active" } as Me;
  it("shows for a signed-in active account on shell pages while there is an install to offer", () => {
    expect(bannerVisible("available", me, false, NOW, null)).toBe(true);
    expect(bannerVisible("manual", me, false, NOW, null)).toBe(true);
    for (const state of [
      "unsupported",
      "standalone",
      "installed",
      "waiting",
      "prompting",
    ] as const)
      expect(bannerVisible(state, me, false, NOW, null)).toBe(false);
    expect(bannerVisible("available", me, true, NOW, null)).toBe(false);
    expect(bannerVisible("available", null, false, NOW, null)).toBe(false);
    expect(bannerVisible("available", undefined, false, NOW, null)).toBe(false);
    expect(
      bannerVisible("available", { status: "pending" } as Me, false, NOW, null),
    ).toBe(false);
  });

  it("stays hidden for 30 days after Not now, across reloads", () => {
    const install = setup();
    offer();
    install.notNow();
    const until = install.get().dismissedUntil;
    expect(until).toBe(NOW + DISMISS_MS);
    expect(bannerVisible("available", me, false, NOW, until)).toBe(false);
    expect(setup().get().dismissedUntil).toBe(until);
    expect(
      bannerVisible("available", me, false, NOW + DISMISS_MS - 1, until),
    ).toBe(false);
    expect(bannerVisible("available", me, false, NOW + DISMISS_MS, until)).toBe(
      true,
    );
  });
});
