import type { Rect } from "../../table/types";
import { BitmapText, type Graphics } from "../pixi";

// What the stack adds to its cards on the band (design §8.3): the stack items are card nodes,
// the top one in the band's socket and older ones fanned to its left; an ability shows its
// source's picture a little smaller, with an "Ability" ribbon above the picture, never over it.
// The ribbon is drawn with its own card, at that card's depth, so the newer items fanned in
// front of it cover it as they cover the rest of that card; items the stack's "+N" stands for
// are not drawn, and neither are their ribbons.

/** Where an ability's ribbon goes, in stage units: in the strip its footprint keeps above the
 * picture, or null when that strip is too thin for one. */
export function ribbonRect(face: Rect, footprint: Rect): Rect | null {
  const room = face.y - footprint.y;
  if (room < 6) return null;
  const h = Math.min(room - 1, 14);
  const w = footprint.w * 0.86;
  return { x: footprint.x + (footprint.w - w) / 2, y: face.y - h - 1, w, h };
}

/** Draws the ribbon's plate at `r` into `g` and returns its label, both in the card's own
 * coordinates. */
export function drawRibbon(g: Graphics, r: Rect): BitmapText {
  g.roundRect(r.x, r.y, r.w, r.h, 3).fill({ color: 0x0b0b0c, alpha: 0.9 });
  g.roundRect(r.x, r.y, r.w, r.h, 3).stroke({
    width: 1,
    color: 0xe6c68c,
    alpha: 0.7,
  });
  const label = new BitmapText({
    text: "ABILITY",
    style: { fontFamily: "cd-bold", fontSize: r.h * 0.72 },
  });
  label.tint = 0xf2e2b0;
  label.anchor.set(0.5);
  label.position.set(r.x + r.w / 2, r.y + r.h / 2);
  return label;
}
