import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// What test-setup.ts promises every test file: nothing one test leaves behind reaches the next.

// A file's own afterEach, at the top of the file as where the test files restore their mocks,
// runs once the page has unmounted, and still on the clock its test used.
let seen: { mounted: boolean; fake: boolean }[] = [];
afterEach(() => {
  seen.push({
    mounted: document.body.childElementCount > 0,
    fake: vi.isFakeTimers(),
  });
});

// The order matters here, so these two never shuffle.
describe("the shared test setup", { shuffle: false }, () => {
  it("is left a page, a fake clock, storage and an address", () => {
    seen = [];
    // jsdom fires this one's hashchange a task later (on the real clock), after the test ends.
    window.location.hash = "#game/00000000-0000-4000-8000-0000000000aa";
    vi.useFakeTimers();
    localStorage.setItem("cd.test", "1");
    sessionStorage.setItem("cd.test", "1");
    render(<main>The page</main>);
    expect(document.body).toHaveTextContent("The page");
  });

  // Soft, so a failure names every leak at once.
  it("finds none of them in the next test", async () => {
    expect.soft(seen).toEqual([{ mounted: false, fake: true }]);
    expect.soft(document.body).toBeEmptyDOMElement();
    expect.soft(vi.isFakeTimers()).toBe(false);
    expect.soft(localStorage.length).toBe(0);
    expect.soft(sessionStorage.length).toBe(0);
    expect.soft(window.location.hash).toBe("");
    // No hashchange from the last test, nor from the reset after it, is still on its way.
    const late = vi.fn();
    window.addEventListener("hashchange", late);
    await new Promise((resolve) => setImmediate(resolve));
    window.removeEventListener("hashchange", late);
    expect.soft(late).not.toHaveBeenCalled();
  });
});
