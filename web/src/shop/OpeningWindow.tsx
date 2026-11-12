import { useLayoutEffect, useRef, type ReactNode } from "react";
import styles from "./shop.module.css";

// The window a pack opens in (v0.9.9, the owner: "when you're opening a pack and scroll up and
// down to see the new cards … it doesn't also scroll the Leng's shop area underneath, too. That
// layer should lock while the new card view window is up"). Until v0.9.8 an opened pack was a
// panel in the shop's page: the page scrolled, and Leng's counter behind the cards with it. Now
// the pack opens in a pop-up that fills the screen. It does not scroll itself: the pack's title
// and its buttons stay where they are and only the cards scroll, inside it (PackOpening), over a
// backdrop that holds still. Being a modal dialog, it locks the page under it like every other
// pop-up (app/scrollLock.ts), and the tutorial's coach is drawn into it (tutorial/Coach.tsx).
// A warden's deck opens in the same window (campaign/WardenOpening.tsx).

export function OpeningWindow({
  label,
  onClose,
  tone = "shop",
  children,
}: {
  /** The window's name for assistive technology. */
  label: string;
  /** Escape closes the window: whatever was opened is already the player's. */
  onClose: () => void;
  /** The campaign's window keeps its own colours. */
  tone?: "shop" | "campaign";
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  // A layout effect, so that on the way out the dialog closes while it is still in the page: the
  // browser then gives the focus back to what opened it.
  useLayoutEffect(() => {
    const element = dialog.current;
    if (element && !element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    }
    return () => {
      if (element?.open && typeof element.close === "function") element.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={styles.window}
      data-opening-window={tone}
      aria-label={label}
      onCancel={(event) => {
        // Only this window's own Escape: a card's details, open over it, closes itself.
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}
