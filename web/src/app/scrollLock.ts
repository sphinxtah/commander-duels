// Pop-ups lock the page behind them (v0.7.2, the owner: "When there's a pop up window … the
// background scrolls too"). Every pop-up in the app is a <dialog> opened with showModal(), and
// the browser lets the wheel scroll the document under its backdrop. This watches the page for
// dialogs opening and closing and, while a modal one is open, marks <html> with data-modal:
// global.css then hides the document's overflow and keeps the room its scrollbar took as padding
// (--cd-gutter, measured here before the scrollbar goes), so nothing behind the dialog shifts
// when it opens or closes. The table's own non-modal menus (dialog.show()) are not pop-ups and
// never lock, though the game route hides the document's overflow anyway.

export const MODAL_ATTRIBUTE = "data-modal";
export const GUTTER_PROPERTY = "--cd-gutter";

/** Whether the browser tells a modal dialog from one shown with show(): every browser the site
 * supports does; jsdom (and its selector engine, which answers false for every dialog) does not. */
export const NATIVE_MODAL: boolean =
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("selector(:modal)");

/** Whether an open dialog is a modal one. Where :modal is unknown, every open dialog counts:
 * the only non-modal ones are the table's menus, on a route that does not scroll anyway. */
export function isModal(dialog: Element, native = NATIVE_MODAL): boolean {
  return native ? dialog.matches(":modal") : true;
}

/** True while any modal dialog is open under `root`. */
export function modalOpen(root: ParentNode, native = NATIVE_MODAL): boolean {
  for (const dialog of root.querySelectorAll("dialog[open]"))
    if (isModal(dialog, native)) return true;
  return false;
}

/** The document scrollbar's width: 0 with overlay scrollbars, or none to show. */
export function scrollbarWidth(win: Window): number {
  return Math.max(0, win.innerWidth - win.document.documentElement.clientWidth);
}

/** Marks or clears the lock on <html>; the width is measured as the lock goes on, while the
 * scrollbar is still there to measure. */
export function applyScrollLock(locked: boolean, win: Window = window): void {
  const html = win.document.documentElement;
  if (locked === html.hasAttribute(MODAL_ATTRIBUTE)) return;
  if (locked) {
    html.style.setProperty(GUTTER_PROPERTY, `${scrollbarWidth(win)}px`);
    html.setAttribute(MODAL_ATTRIBUTE, "");
  } else {
    html.removeAttribute(MODAL_ATTRIBUTE);
    html.style.removeProperty(GUTTER_PROPERTY);
  }
}

/**
 * Watches the page for dialogs opening (their `open` attribute), closing, and leaving the page
 * while open (React unmounting a screen), and keeps the lock in step. Returns the stop.
 */
export function lockScrollUnderModals(win: Window = window): () => void {
  const root = win.document.documentElement;
  const update = () => applyScrollLock(modalOpen(root), win);
  const observer = new MutationObserver(update);
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["open"],
  });
  update();
  return () => {
    observer.disconnect();
    applyScrollLock(false, win);
  };
}
