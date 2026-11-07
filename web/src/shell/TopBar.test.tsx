import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRetracting } from "./TopBar";

// The top bar tucks away on a phone as the page scrolls down, and comes back as it scrolls up
// (v0.8.9).

function Bar() {
  const ref = useRef<HTMLElement>(null);
  const retracted = useRetracting(ref);
  return (
    <header ref={ref} data-testid="bar" data-retracted={retracted || undefined}>
      <button type="button" aria-expanded="false">
        Menu
      </button>
    </header>
  );
}

function phone(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function scrollTo(y: number) {
  act(() => {
    Object.defineProperty(window, "scrollY", { value: y, configurable: true });
    window.dispatchEvent(new Event("scroll"));
  });
}

describe("the top bar on a phone", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    scrollTo(0);
  });

  it("hides scrolling down and shows scrolling up", () => {
    phone(true);
    const { getByTestId } = render(<Bar />);
    const bar = getByTestId("bar");
    scrollTo(300);
    expect(bar).toHaveAttribute("data-retracted");
    scrollTo(296); // a jitter does nothing
    expect(bar).toHaveAttribute("data-retracted");
    scrollTo(250);
    expect(bar).not.toHaveAttribute("data-retracted");
    scrollTo(600);
    expect(bar).toHaveAttribute("data-retracted");
    scrollTo(0);
    expect(bar).not.toHaveAttribute("data-retracted");
  });

  it("stays while one of its pop-overs is open", () => {
    phone(true);
    const { getByTestId, getByRole } = render(<Bar />);
    getByRole("button").setAttribute("aria-expanded", "true");
    scrollTo(400);
    expect(getByTestId("bar")).not.toHaveAttribute("data-retracted");
  });

  it("stays on a larger screen", () => {
    phone(false);
    const { getByTestId } = render(<Bar />);
    scrollTo(400);
    expect(getByTestId("bar")).not.toHaveAttribute("data-retracted");
  });
});
