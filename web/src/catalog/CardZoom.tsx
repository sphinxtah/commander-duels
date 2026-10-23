import { useEffect, useRef, useState } from "react";
import { printingImage, type CardSummary, type CustomCard } from "./catalog";
import styles from "./catalog.module.css";

// A card's picture alone, as large as the screen allows, over a dimmed page (v0.5.1, the
// owner's request: "click the cards ... to make them bigger and easier to read"). A click on a
// card's picture on any tab of the Cards page opens it, the Godlike tier's custom cards
// included; a click anywhere, Escape or the close button closes it. Card details, where a card
// opened before, are a button away.

export interface Zoomed {
  name: string;
  /** The picture of a face (0 for the front), in the largest size the server keeps. */
  src: (face: number) => string;
  faces: number;
  /** Opens the card's details in their place. */
  details?: () => void;
}

/** A catalog card's picture, of a printing (the one it shows by default). */
export function zoomOf(
  card: CardSummary,
  printingId?: string | null,
  details?: () => void,
): Zoomed | undefined {
  const chosen = printingId ?? card.image?.printing_id;
  const faces = card.image?.faces ?? 0;
  if (card.custom_image)
    return {
      name: card.name,
      src: () => card.custom_image!,
      faces: 0,
      details,
    };
  if (!chosen) return undefined;
  return {
    name: card.name,
    // The png, 745 wide with its own rounded corners; the server answers with the large JPEG
    // where a printing has none.
    src: (face) => printingImage(chosen, "png", faces > 0 ? face : undefined),
    faces,
    details,
  };
}

/** A Godlike custom card's picture, as uploaded. */
export function customZoomOf(card: CustomCard): Zoomed {
  return { name: card.name, src: () => card.image_url, faces: 0 };
}

export function CardZoom({
  zoomed,
  onClose,
}: {
  zoomed: Zoomed | undefined;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [face, setFace] = useState(0);
  useEffect(() => {
    setFace(0);
    if (zoomed && !dialog.current?.open) dialog.current?.showModal();
  }, [zoomed]);
  const close = () => dialog.current?.close();
  return (
    <dialog
      ref={dialog}
      className={styles.zoom}
      aria-label={zoomed ? `${zoomed.name}, enlarged` : "Card"}
      onClose={onClose}
      onClick={close}
    >
      <button
        type="button"
        className={styles.zoomClose}
        aria-label="Close the picture"
        onClick={close}
      >
        ×
      </button>
      {zoomed && (
        <>
          <img
            key={`${zoomed.name}/${face}`}
            className={styles.zoomImage}
            src={zoomed.src(face)}
            alt={zoomed.name}
            decoding="async"
          />
          {(zoomed.faces > 1 || zoomed.details) && (
            <div
              className={styles.zoomActions}
              onClick={(event) => event.stopPropagation()}
            >
              {zoomed.faces > 1 && (
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => setFace((value) => (value + 1) % zoomed.faces)}
                >
                  Turn over
                </button>
              )}
              {zoomed.details && (
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => {
                    close();
                    zoomed.details!();
                  }}
                >
                  Card details
                </button>
              )}
            </div>
          )}
        </>
      )}
    </dialog>
  );
}
