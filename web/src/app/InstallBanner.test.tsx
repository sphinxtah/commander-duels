import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { InstallBanner } from "./InstallBanner";

// The install offer is one per page, made on the first render: Edge on a PC, so it can come.
Object.defineProperty(navigator, "userAgentData", {
  configurable: true,
  value: { brands: [{ brand: "Microsoft Edge" }], mobile: false },
});

const alice: Me = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "player",
  status: "active",
  onboarding: "complete",
  handle: "alice",
  display_name: "Alice",
  email: "alice@example.com",
  avatar: "sigil",
  locale: "en",
  csrf_token: "token-1",
  permissions: ["profile.edit", "games.play"],
  roles: ["player"],
  preferences: { large_text: false, reduced_motion: false },
  session: {
    id: "session-1",
    kind: "google",
    authenticated_at: "2026-10-19T10:00:00Z",
    idle_expires_at: "2026-11-02T10:00:00Z",
    absolute_expires_at: "2026-11-18T10:00:00Z",
  },
};

describe("the install banner", () => {
  it("moves focus on to the content when Install hides it, after the browser's prompt", () => {
    render(
      <>
        <InstallBanner me={alice} onGame={false} />
        <main id="main" tabIndex={-1} />
      </>,
    );
    const offer = Object.assign(
      new Event("beforeinstallprompt", { cancelable: true }),
      {
        prompt: vi.fn(() => Promise.resolve()),
        // The browser's install window stays open.
        userChoice: new Promise(() => {}),
      },
    );
    act(() => void window.dispatchEvent(offer));
    const banner = screen.getByRole("region", { name: "Install the app" });
    const install = within(banner).getByRole("button", { name: "Install" });
    install.focus();
    const moved = vi.spyOn(screen.getByRole("main"), "focus");
    fireEvent.click(install);
    expect(offer.prompt).toHaveBeenCalledTimes(1);
    // The browser accepts prompt() only inside the click, so it comes first.
    expect(offer.prompt.mock.invocationCallOrder[0]!).toBeLessThan(
      moved.mock.invocationCallOrder[0]!,
    );
    expect(
      screen.queryByRole("region", { name: "Install the app" }),
    ).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("main"));
  });
});
