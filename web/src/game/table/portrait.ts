import type { Diamond, Rect } from "./types";

// The Planeswalker portraits at the table (v0.3.1). A human player allied with a Planeswalker
// shows its portrait in their diamond instead of the generated sigil, in both painters; bots and
// players with no alliance keep the sigil. The files are the owner's, `<id>-<size>.webp` in
// web/public/portraits, with transparent backgrounds, and they come with rules (docs/plans/0.3.1.md):
// - the portrait stands upright in front of the diamond's frame, scaled to fit whole: never
//   cropped, to a circle or to the diamond, so horns, hoods and hair may rise past the frame;
// - the life badge is drawn over its foot, and stays the player's life, never loyalty;
// - opponents' are grey and yours is in colour, as Magic Duels drew its portraits (the owner's
//   v0.3.0 brief; the portraits are the owner's art, not card images, so greying them is ours);
// - a portrait that is missing (an unknown ID, or one with no image yet) or does not load keeps
//   the sigil.

export type PortraitSize = 128 | 256 | 512;

/** A roster ID as the API gives it ("rowan", "ajani-goldmane"); anything else is never asked for. */
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isPortraitId(id: string | null | undefined): id is string {
  return typeof id === "string" && id.length <= 64 && ID.test(id);
}

export function portraitUrl(id: string, size: PortraitSize): string {
  return `/portraits/${id}-${size}.webp`;
}

/** The file for a box `px` device pixels wide: the 256 up to a little past its own size, the 512
 * beyond (1440p and 4K). */
export function portraitSize(px: number): 256 | 512 {
  return px <= 288 ? 256 : 512;
}

/** Names whose punctuation the ID drops. */
const NAMES: Record<string, string> = {
  "b-o-b": "B.O.B.",
  "mr-monopoly": "Mr. Monopoly",
};

/** The Planeswalker's name, from its roster ID: "ajani-goldmane" is "Ajani Goldmane". */
export function portraitName(id: string): string {
  return (
    NAMES[id] ??
    id
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  );
}

/** The portrait's box against its diamond's bounding box: a little smaller, and raised. */
export const PORTRAIT_FIT = { scale: 0.92, lift: 0.05 } as const;

/** Where a portrait stands over its diamond: a square nearly as wide as the diamond, raised a
 * little, so the head fills the frame's upper half and the shoulders rest behind the life badge.
 * The picture is fitted whole inside it. */
export function portraitBox(d: Diamond): Rect {
  const span = d.side * Math.SQRT2;
  const w = span * PORTRAIT_FIT.scale;
  return {
    x: d.cx - w / 2,
    y: d.cy - w / 2 - span * PORTRAIT_FIT.lift,
    w,
    h: w,
  };
}

/** A picture `width` × `height` fitted whole in `box`, centred: its own rectangle. */
export function containFit(box: Rect, width: number, height: number): Rect {
  if (width <= 0 || height <= 0) return { ...box };
  const scale = Math.min(box.w / width, box.h / height);
  const w = width * scale;
  const h = height * scale;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}
