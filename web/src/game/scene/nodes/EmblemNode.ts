import type { BandLayout } from "../../table/types";
import { FONT } from "../art";
import { diamondPath, drawIcon, type SceneIcon } from "../icons";
import { Container, Graphics, Text } from "../pixi";

// The phase emblem on the band (design §8.2, §14): a large black diamond at the band's centre
// with a white icon, and a caption on a black plate below it. It announces a turn ("Your Turn",
// "Bot 2's Turn"), the first attack and the first blocks of a combat ("Attack!", "Block!"), and
// the end of the game. It fades in, holds and fades out; screen readers hear the same moments
// from the DOM's live regions.

export type EmblemKind =
  "turn" | "attack" | "block" | "victory" | "defeat" | "draw" | "over";

const ICONS: Record<EmblemKind, SceneIcon> = {
  turn: "turn",
  attack: "swords",
  block: "shield",
  victory: "crown",
  defeat: "broken",
  draw: "flag",
  over: "flag",
};

export class EmblemNode {
  readonly root = new Container();
  private readonly g = new Graphics();
  private readonly caption: Text;

  constructor() {
    this.caption = new Text({
      text: "",
      style: {
        fontFamily: FONT,
        fontSize: 24,
        fontWeight: "800",
        fill: "#ffffff",
        letterSpacing: 1,
      },
    });
    this.caption.anchor.set(0.5);
    this.root.addChild(this.g, this.caption);
    this.root.visible = false;
  }

  show(kind: EmblemKind, caption: string, band: BandLayout): void {
    const { emblem, emblemCaption: plate } = band;
    const g = this.g;
    g.clear();
    diamondPath(g, emblem.cx, emblem.cy, emblem.side + 10).fill({
      color: 0x000000,
      alpha: 0.45,
    });
    diamondPath(g, emblem.cx, emblem.cy, emblem.side).fill(0x070708);
    diamondPath(g, emblem.cx, emblem.cy, emblem.side - 8).stroke({
      width: 2,
      color: 0xd9b56e,
    });
    drawIcon(
      g,
      ICONS[kind],
      emblem.cx,
      emblem.cy,
      emblem.side * 0.62,
      0xffffff,
    );
    g.roundRect(plate.x, plate.y, plate.w, plate.h, 4).fill({
      color: 0x070708,
      alpha: 0.92,
    });
    g.roundRect(plate.x, plate.y, plate.w, plate.h, 4).stroke({
      width: 1.5,
      color: 0xd9b56e,
      alpha: 0.8,
    });
    this.caption.text = caption;
    this.caption.position.set(plate.x + plate.w / 2, plate.y + plate.h / 2);
    // A long name still fits the plate.
    const room = plate.w - 16;
    this.caption.scale.set(1);
    if (this.caption.width > room)
      this.caption.scale.set(room / this.caption.width);
    this.root.visible = true;
    this.root.alpha = 0;
  }

  setAlpha(alpha: number): void {
    this.root.alpha = alpha;
    this.root.visible = alpha > 0;
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
