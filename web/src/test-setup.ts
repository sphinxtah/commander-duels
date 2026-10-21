import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

// What one test leaves behind must not reach the next.

// The real clock's next task, whatever clock a test has faked.
const realSetImmediate = globalThis.setImmediate;

// This hook runs before each test file's own afterEach (vite.config.ts sets sequence.hooks to
// "list"), so the page unmounts while the file's mocks still answer it: a passive effect React
// had not run yet when the test ended runs now, against those mocks, and never reaches the real
// network.
afterEach(async () => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  // jsdom fires hashchange a task after the address changes. Waiting out every event this test
  // caused, the reset's own included, keeps them from reaching the next test's page, which would
  // take one for a navigation (and for leaving a game, when the old address was one). Events
  // queued on a fake clock are dropped with it, below.
  window.location.hash = "";
  await new Promise((resolve) => realSetImmediate(resolve));
});

// A teardown returned by beforeEach runs after every afterEach, so a test file's own hooks can
// still put things away on the fake clock its test used. Then the fake clock goes, with every
// timer it still held.
beforeEach(() => () => {
  vi.useRealTimers();
});
