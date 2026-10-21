import { HAND } from "../../table/geometry";
import { fanHand } from "../../table/layout";
import type { Rect, TableLayout } from "../../table/types";
import type { SceneKit } from "../createTableScene";
import { Container, Sprite } from "../pixi";
import type { Pose } from "../timeline";

// The hand along the bottom edge (design §8.5). Its cards are card nodes; this works out how the
// pointer or keyboard focus changes them: the card under it rises ×1.5, upright, its bottom at
// the stage's foot, and its neighbours lean away (visual only: the DOM's slices never move). It
// also draws a spectator's view of the anchored player's hand, as backs with no buttons.

/** How far the risen card's neighbours step aside, by distance in the hand. */
const SPREAD = [0, 48, 24];

export class HandNode {
  readonly root = new Container();
  private readonly kit: SceneKit;
  private backs = -1;

  constructor(kit: SceneKit) {
    this.kit = kit;
  }

  /** A spectator sees the anchored player's hand as backs fanned along the edge. */
  setBacks(count: number): void {
    if (count === this.backs) return;
    this.backs = count;
    for (const child of this.root.removeChildren()) child.destroy();
    for (const slot of fanHand(count)) {
      const back = new Sprite(this.kit.art.back);
      back.anchor.set(0.5, 1);
      back.position.set(
        slot.face.x + slot.face.w / 2,
        slot.face.y + slot.face.h,
      );
      back.width = slot.face.w;
      back.height = slot.face.h;
      back.rotation = (slot.rotation * Math.PI) / 180;
      this.root.addChild(back);
    }
  }

  /**
   * The pose the ui gives a hand card: risen when it is the risen card, leaning aside when it is
   * a neighbour, otherwise its rest. `rest` is the layout's pose (pivot at the bottom centre).
   */
  static pose(
    key: string,
    rest: Pose,
    face: Rect,
    hand: string[],
    layout: TableLayout,
    risen: string | null,
  ): Pose {
    if (!risen || !hand.includes(risen)) return rest;
    if (key === risen) {
      const r = layout.risen.get(key);
      if (!r) return rest;
      return {
        x: r.x + r.w / 2,
        y: r.y + r.h,
        rotation: 0,
        scale: r.h / face.h || HAND.rise.scale,
        alpha: rest.alpha,
      };
    }
    const distance = hand.indexOf(key) - hand.indexOf(risen);
    const step = SPREAD[Math.abs(distance)] ?? 0;
    return step === 0
      ? rest
      : { ...rest, x: rest.x + Math.sign(distance) * step };
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
