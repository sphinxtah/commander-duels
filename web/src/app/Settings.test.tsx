import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Bootstrap, Me } from "../api";
import {
  DEFAULT_TABLE_SETTINGS,
  TABLE_SETTINGS_KEY,
} from "../game/table/types";
import { InstallBanner } from "./InstallBanner";
import { INSTALL_KEY } from "./install";
import { Settings } from "./Settings";
import { TableSettingsForm } from "./TableSettingsForm";

const bootstrap = {
  capabilities: [
    {
      id: "authentication",
      name: "Google sign-in",
      available: true,
      milestone: "M1",
      reason: "Google sign-in is available.",
    },
  ],
} as Bootstrap;
const alice = { status: "active" } as Me;

beforeAll(() => {
  // Chrome on a PC, before anything asks whether this browser can install.
  Object.defineProperty(navigator, "userAgentData", {
    configurable: true,
    value: { brands: [{ brand: "Google Chrome" }], mobile: false },
  });
});

function settings(onPreference = vi.fn()) {
  render(
    <Settings
      preferences={{ largeText: false, reducedMotion: true }}
      onPreference={onPreference}
      saveMessage=""
      bootstrap={bootstrap}
      heading={createRef()}
    />,
  );
  return onPreference;
}
const stored = () => JSON.parse(localStorage.getItem(TABLE_SETTINGS_KEY)!);

describe("the Settings page", () => {
  it("keeps the account's display settings as they were", () => {
    const onPreference = settings();
    expect(
      screen.getByRole("heading", { level: 1, name: "Make yourself at home." }),
    ).toBeInTheDocument();
    const larger = screen.getByRole("checkbox", { name: /^Larger text/ });
    expect(larger).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /^Reduce motion/ }),
    ).toBeChecked();
    fireEvent.click(larger);
    expect(onPreference).toHaveBeenCalledWith("largeText", true);
    expect(
      screen.getByText("Preferences are stored on this device."),
    ).toBeInTheDocument();
    expect(screen.getByText("Google sign-in").closest("li")).toHaveTextContent(
      "Available",
    );
  });

  it("stores the table's settings on this device, each by its own name", () => {
    settings();
    const speed = screen.getByRole("combobox", { name: "Animation speed" });
    expect(
      within(speed)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Normal", "Fast", "Faster"]);
    fireEvent.change(speed, { target: { value: "faster" } });
    expect(stored().animationSpeed).toBe("faster");

    const fullscreen = screen.getByRole("checkbox", {
      name: "Full screen when a game starts",
    });
    expect(fullscreen).toBeChecked();
    expect(fullscreen).toHaveAccessibleDescription(/fills the screen/);
    fireEvent.click(fullscreen);
    expect(stored().fullscreenOnStart).toBe(false);

    const timer = screen.getByRole("combobox", { name: "Response timer" });
    expect(timer).toHaveValue("8");
    expect(
      within(timer)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "Off",
      "5 seconds",
      "8 seconds",
      "15 seconds",
      "30 seconds",
      "90 seconds",
    ]);
    fireEvent.change(timer, { target: { value: "0" } });
    expect(stored().responseTimerSeconds).toBe(0);

    const painter = screen.getByRole("combobox", {
      name: "Draw the table with",
    });
    expect(
      within(painter)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Automatic", "Plain table without WebGL"]);
    fireEvent.change(painter, { target: { value: "dom" } });
    expect(stored().painter).toBe("dom");

    const volume = screen.getByRole<HTMLInputElement>("slider", {
      name: "Sound effects volume",
    });
    expect(volume.value).toBe("70");
    fireEvent.change(volume, { target: { value: "35" } });
    expect(stored().effectsVolume).toBe(35);
    expect(volume.parentElement!.querySelector("output")).toHaveTextContent(
      "35",
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Mute all sound" }));
    expect(stored()).toEqual({
      ...DEFAULT_TABLE_SETTINGS,
      animationSpeed: "faster",
      fullscreenOnStart: false,
      responseTimerSeconds: 0,
      painter: "dom",
      effectsVolume: 35,
      muted: true,
    });
    expect(screen.getByText("Saved on this device.")).toBeInTheDocument();
  });

  it("offers the same controls, compact, for the game's Options drawer", () => {
    localStorage.setItem(
      TABLE_SETTINGS_KEY,
      JSON.stringify({ ...DEFAULT_TABLE_SETTINGS, muted: true }),
    );
    render(<TableSettingsForm compact />);
    expect(
      screen.getByRole("heading", { level: 3, name: "The table" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 3, name: "Sound" }),
    ).toBeInTheDocument();
    for (const [role, name] of [
      ["checkbox", "Full screen when a game starts"],
      ["combobox", "Response timer"],
      ["combobox", "Draw the table with"],
      ["slider", "Sound effects volume"],
      ["checkbox", "Mute all sound"],
    ] as const)
      expect(screen.getByRole(role, { name })).toHaveAccessibleDescription("");
    expect(
      screen.getByRole("checkbox", { name: "Mute all sound" }),
    ).toBeChecked();
  });

  it("says what this browser can do about installing, and installs from the click", async () => {
    settings();
    const section = screen.getByRole("region", { name: "Install the app" });
    expect(section).toHaveTextContent(
      "Checking whether your browser can install…",
    );
    const offer = Object.assign(
      new Event("beforeinstallprompt", { cancelable: true }),
      {
        prompt: vi.fn(() => Promise.resolve()),
        userChoice: Promise.resolve({ outcome: "dismissed" }),
      },
    );
    act(() => void window.dispatchEvent(offer));
    expect(offer.defaultPrevented).toBe(true);

    // The banner, for a signed-in player in a tab; never an alert or a dialog.
    const { unmount } = render(<InstallBanner me={alice} onGame={false} />);
    const banners = screen.getAllByRole("region", { name: "Install the app" });
    const banner = banners.find(
      (element) => element.tagName === "SECTION" && element !== section,
    )!;
    expect(banner).toHaveTextContent(
      "Play Commander Duels in its own window, with a desktop icon.",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    unmount();
    render(<InstallBanner me={alice} onGame />);
    expect(
      screen.getAllByRole("region", { name: "Install the app" }),
    ).toHaveLength(1);

    await act(async () =>
      fireEvent.click(within(section).getByRole("button", { name: "Install" })),
    );
    expect(offer.prompt).toHaveBeenCalledTimes(1);
    // Refused in the browser's window: Not now for 30 days, then the menu's way.
    expect(section).toHaveTextContent(
      "In Chrome, open the menu: ⋮ › Cast, save, and share › Install page as app.",
    );
    expect(
      JSON.parse(localStorage.getItem(INSTALL_KEY)!).dismissedUntil,
    ).toBeGreaterThan(Date.now());
  });
});
