import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GUTTER_PROPERTY,
  MODAL_ATTRIBUTE,
  NATIVE_MODAL,
  applyScrollLock,
  isModal,
  lockScrollUnderModals,
  modalOpen,
} from "./scrollLock";

// The pop-ups' scroll lock (v0.7.2): <html> is marked while a modal dialog is open, with the
// scrollbar's width measured as the lock goes on.

/** Mutation records arrive a task later. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const html = document.documentElement;

describe("the scroll lock under pop-ups", () => {
  let stop: (() => void) | null = null;
  beforeEach(() => {
    // A 1024 px window whose document is 1007 px wide: a 17 px scrollbar, as on Windows.
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
    Object.defineProperty(html, "clientWidth", {
      configurable: true,
      get: () => (html.hasAttribute(MODAL_ATTRIBUTE) ? 1024 : 1007),
    });
  });
  afterEach(() => {
    stop?.();
    stop = null;
    document.body.replaceChildren();
    html.removeAttribute(MODAL_ATTRIBUTE);
    html.style.removeProperty(GUTTER_PROPERTY);
  });

  function dialog(): HTMLDialogElement {
    const element = document.createElement("dialog");
    document.body.append(element);
    return element;
  }

  it("locks the page as a dialog opens, keeping the scrollbar's width, and frees it as it closes", async () => {
    stop = lockScrollUnderModals();
    expect(html.hasAttribute(MODAL_ATTRIBUTE)).toBe(false);
    const popup = dialog();
    popup.setAttribute("open", "");
    await settle();
    expect(html.hasAttribute(MODAL_ATTRIBUTE)).toBe(true);
    expect(html.style.getPropertyValue(GUTTER_PROPERTY)).toBe("17px");
    popup.removeAttribute("open");
    await settle();
    expect(html.hasAttribute(MODAL_ATTRIBUTE)).toBe(false);
    expect(html.style.getPropertyValue(GUTTER_PROPERTY)).toBe("");
  });

  it("measures once: a second dialog over the first keeps the width, and the lock holds until the last closes", async () => {
    stop = lockScrollUnderModals();
    const first = dialog();
    const second = dialog();
    first.setAttribute("open", "");
    await settle();
    // With the lock on, the document is as wide as the window; a fresh measure would say 0.
    second.setAttribute("open", "");
    await settle();
    expect(html.style.getPropertyValue(GUTTER_PROPERTY)).toBe("17px");
    first.removeAttribute("open");
    await settle();
    expect(html.hasAttribute(MODAL_ATTRIBUTE)).toBe(true);
    second.removeAttribute("open");
    await settle();
    expect(html.hasAttribute(MODAL_ATTRIBUTE)).toBe(false);
  });

  it("frees the page when an open dialog leaves it (a screen unmounting)", async () => {
    stop = lockScrollUnderModals();
    const popup = dialog();
    popup.setAttribute("open", "");
    await settle();
    expect(html.hasAttribute(MODAL_ATTRIBUTE)).toBe(true);
    popup.remove();
    await settle();
    expect(html.hasAttribute(MODAL_ATTRIBUTE)).toBe(false);
  });

  it("takes in a dialog already open when it starts, and lets go when stopped", async () => {
    const popup = dialog();
    popup.setAttribute("open", "");
    stop = lockScrollUnderModals();
    expect(html.hasAttribute(MODAL_ATTRIBUTE)).toBe(true);
    stop();
    stop = null;
    expect(html.hasAttribute(MODAL_ATTRIBUTE)).toBe(false);
    popup.removeAttribute("open");
    popup.setAttribute("open", "");
    await settle();
    expect(html.hasAttribute(MODAL_ATTRIBUTE)).toBe(false);
  });

  it("counts modal dialogs only where the browser tells them apart, else every open dialog", () => {
    // jsdom knows no :modal (its selector engine answers false for every dialog), so here every
    // open dialog counts; a browser asks :modal, which says no to a table menu shown with show().
    expect(NATIVE_MODAL).toBe(false);
    const open = dialog();
    open.setAttribute("open", "");
    expect(isModal(open)).toBe(true);
    expect(modalOpen(document)).toBe(true);
    const asked: string[] = [];
    const shown = {
      matches: (selector: string) => {
        asked.push(selector);
        return false;
      },
    } as unknown as Element;
    expect(isModal(shown, true)).toBe(false);
    expect(asked).toEqual([":modal"]);
    expect(modalOpen(document, true)).toBe(false);
    open.removeAttribute("open");
    const details = document.createElement("details");
    details.setAttribute("open", "");
    document.body.append(details);
    expect(modalOpen(document)).toBe(false);
  });

  it("applies the lock once each way, whatever the measure says meanwhile", () => {
    applyScrollLock(true);
    expect(html.style.getPropertyValue(GUTTER_PROPERTY)).toBe("17px");
    applyScrollLock(true);
    expect(html.style.getPropertyValue(GUTTER_PROPERTY)).toBe("17px");
    applyScrollLock(false);
    applyScrollLock(false);
    expect(html.hasAttribute(MODAL_ATTRIBUTE)).toBe(false);
    expect(html.style.getPropertyValue(GUTTER_PROPERTY)).toBe("");
  });
});
