import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { lockScrollUnderModals, MODAL_ATTRIBUTE } from "../app/scrollLock";
import { OpeningWindow } from "./OpeningWindow";

// jsdom has no showModal: as the browser does, opening marks the dialog open.
beforeAll(() => {
  const dialog = HTMLDialogElement.prototype;
  dialog.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  dialog.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});
afterEach(() => vi.restoreAllMocks());

/** The lock's observer answers in a microtask. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the window a pack opens in (v0.9.9)", () => {
  it("opens as a modal pop-up with its name and its tone", () => {
    const shown = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    render(
      <OpeningWindow label="Tempest Booster: your pack" onClose={vi.fn()}>
        <p>Cards</p>
      </OpeningWindow>,
    );
    const window_ = screen.getByRole("dialog", {
      name: "Tempest Booster: your pack",
    });
    expect(shown).toHaveBeenCalledTimes(1);
    expect(window_).toHaveAttribute("open");
    expect(window_).toHaveAttribute("data-opening-window", "shop");
    expect(window_).toHaveTextContent("Cards");
  });

  it("locks the page under it while it is up, and lets it go when it closes", async () => {
    const stop = lockScrollUnderModals();
    const html = document.documentElement;
    expect(html).not.toHaveAttribute(MODAL_ATTRIBUTE);
    const { unmount } = render(
      <OpeningWindow label="A pack" onClose={vi.fn()}>
        <p>Cards</p>
      </OpeningWindow>,
    );
    await settled();
    expect(html).toHaveAttribute(MODAL_ATTRIBUTE);
    unmount();
    await settled();
    expect(html).not.toHaveAttribute(MODAL_ATTRIBUTE);
    stop();
  });

  it("asks to be closed on Escape, and leaves the closing to its owner", () => {
    const close = vi.fn();
    render(
      <OpeningWindow label="A pack" onClose={close} tone="campaign">
        <p>Cards</p>
      </OpeningWindow>,
    );
    const window_ = screen.getByRole("dialog", { name: "A pack" });
    expect(window_).toHaveAttribute("data-opening-window", "campaign");
    // The browser's Escape is a cancel event; unanswered, it would close the dialog itself.
    const cancel = new Event("cancel", { cancelable: true });
    fireEvent(window_, cancel);
    expect(close).toHaveBeenCalledTimes(1);
    expect(cancel.defaultPrevented).toBe(true);
    expect(window_).toHaveAttribute("open");
  });

  it("closes the dialog itself as it leaves the page", () => {
    const closed = vi.spyOn(HTMLDialogElement.prototype, "close");
    const { unmount } = render(
      <OpeningWindow label="A pack" onClose={vi.fn()}>
        <p>Cards</p>
      </OpeningWindow>,
    );
    unmount();
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
