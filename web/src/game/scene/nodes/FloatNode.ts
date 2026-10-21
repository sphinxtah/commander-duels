import type { Point } from "../../table/types";
import { BitmapText } from "../pixi";

// A number floating up off a card or a portrait as it changes (design §14): "+1" for a counter,
// "−3" for damage, "+4" or "−2" for life. It rises and fades, and is gone when its time is up.

export const FLOAT_COLOURS = {
  gain: 0x7ee08a,
  loss: 0xff5a5a,
  counter: 0x7fe6f0,
} as const;

export class FloatNode {
  readonly root: BitmapText;
  readonly key: string;
  private readonly start: Point;

  constructor(
    key: string,
    value: string,
    at: Point,
    colour: number,
    size = 30,
  ) {
    this.key = key;
    this.start = at;
    this.root = new BitmapText({
      text: value,
      style: { fontFamily: "cd-bold", fontSize: size },
    });
    this.root.tint = colour;
    this.root.anchor.set(0.5);
    this.root.position.set(at.x, at.y);
  }

  /** Where it is at `t` (0 to 1) of its life: rising 36 su and fading out at the end. */
  update(t: number): void {
    this.root.position.set(this.start.x, this.start.y - 36 * t);
    this.root.alpha = t < 0.6 ? 1 : Math.max(0, 1 - (t - 0.6) / 0.4);
  }

  destroy(): void {
    this.root.destroy();
  }
}
