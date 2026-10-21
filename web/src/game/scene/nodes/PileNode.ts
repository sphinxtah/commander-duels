import type {
  MoreNode as PlacedMore,
  Rect,
  TableModel,
  ZoneTile,
} from "../../table/types";
import { HAND } from "../../table/geometry";
import { fanHand } from "../../table/layout";
import type { SceneKit } from "../createTableScene";
import { diamondPath } from "../icons";
import { BitmapText, Container, Graphics, Sprite } from "../pixi";
import { CardNode, restPose } from "./CardNode";

// The zone tiles (design §8.4, §8.6–§8.8): each library a face-down pile on a raised stone block
// with its count cut into the front, each graveyard and exile its top card (or an empty outline),
// and an opponent's command zone its top card over a plate. The tiles' buttons and their words
// are the DOM's; this draws the pictures under them. Also the "+N" plates of piles, rows, the
// hand and the stack that hold more than the table shows.

/** The largest card that fits in a rect at a card's proportions, centred in it. */
export function fitCard(r: Rect): Rect {
  const ratio = 150 / 209.52;
  let w = r.w;
  let h = w / ratio;
  if (h > r.h) {
    h = r.h;
    w = h * ratio;
  }
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

/** The library's count cut into the block's front: pale letters over a dark cut a little lower. */
function engraved(text: string, size: number, x: number, y: number) {
  const cut = new BitmapText({
    text,
    style: { fontFamily: "cd-bold", fontSize: size },
  });
  cut.tint = 0x0b0d0d;
  cut.alpha = 0.8;
  cut.anchor.set(0.5);
  cut.position.set(x, y + Math.max(0.8, size * 0.08));
  const face = new BitmapText({
    text,
    style: { fontFamily: "cd-bold", fontSize: size },
  });
  face.tint = 0xd8d3c4;
  face.anchor.set(0.5);
  face.position.set(x, y);
  return [cut, face];
}

export class PileNode {
  readonly root = new Container();
  private readonly ground = new Graphics();
  private readonly backs = new Container();
  private readonly labels = new Container();
  private top: CardNode | null = null;
  private signature = "";
  private readonly kit: SceneKit;

  constructor(kit: SceneKit) {
    this.kit = kit;
    this.root.addChild(this.ground, this.backs, this.labels);
  }

  update(tile: ZoneTile, model: TableModel, drawTop: boolean): void {
    const card = drawTop && tile.topKey ? model.cards.get(tile.topKey) : null;
    // A tile glows when something in it can be chosen now.
    const player = [model.anchored, ...model.opponents].find(
      (p) => p?.seat === tile.seat,
    );
    const keys = tile.zone === "library" || !player ? [] : player[tile.zone];
    const offered = keys.some(
      (key) => (model.cards.get(key)?.offered.length ?? 0) > 0,
    );
    const signature = `${tile.card.x},${tile.card.y},${tile.card.w},${tile.card.h}|${tile.count}|${tile.hit?.x},${tile.hit?.y},${tile.hit?.w},${tile.hit?.h}|${card?.key ?? ""}|${offered}`;
    if (signature !== this.signature) {
      this.signature = signature;
      this.draw(tile, card !== null && card !== undefined);
    }
    if (card) {
      this.top ??= new CardNode(this.kit);
      if (!this.top.under.parent) this.root.addChild(this.top.under);
      if (!this.top.root.parent) this.root.addChild(this.top.root);
      const face = fitCard(tile.card);
      const pivot = { x: face.x + face.w / 2, y: face.y + face.h / 2 };
      const placement = {
        face,
        rotation: 0,
        pivot,
        mark: offered ? ("offered" as const) : ("none" as const),
        faceUp: !card.card.hidden && card.card.name !== null,
        tag: null,
        pips: [],
        badges: [],
        tierHeight: face.h,
        priority: 4 as const,
        yours: false,
      };
      this.top.place(card.card, placement);
      this.top.setPose(restPose(placement));
    } else if (this.top) {
      this.top.recycle();
      this.top.destroy();
      this.top = null;
    }
  }

  private draw(tile: ZoneTile, hasTop: boolean): void {
    const g = this.ground;
    g.clear();
    for (const child of this.backs.removeChildren()) child.destroy();
    for (const child of this.labels.removeChildren()) child.destroy();
    const r = tile.card;
    if (tile.zone === "library" && tile.pedestal) {
      // The block: a lit top face and a darker front with the count cut into it.
      const { top, front } = tile.pedestal;
      g.rect(front.x, front.y, front.w, front.h).fill(0x3f4342);
      g.rect(front.x, front.y, front.w, 1.2).fill({
        color: 0x000000,
        alpha: 0.35,
      });
      g.rect(front.x, front.y + front.h - 1.5, front.w, 1.5).fill({
        color: 0x000000,
        alpha: 0.5,
      });
      g.rect(top.x, top.y, top.w, top.h).fill(0x8b8f8d);
      g.rect(top.x, top.y, top.w, 1).fill({ color: 0xffffff, alpha: 0.25 });
      // A shadow on the stone in front of the block.
      g.rect(front.x + 3, front.y + front.h, front.w - 6, 4).fill({
        color: 0x000000,
        alpha: 0.25,
      });
      this.labels.addChild(
        ...engraved(
          `${tile.count}`,
          front.h * 0.7,
          front.x + front.w / 2,
          front.y + front.h / 2,
        ),
      );
      // The face-down pile: a few backs, a little higher each, as deep as the library.
      const layers =
        tile.count === 0 ? 0 : Math.min(3, 1 + Math.floor(tile.count / 20));
      const face = fitCard(r);
      for (let i = 0; i < layers; i++) {
        const back = new Sprite(this.kit.art.back);
        back.position.set(face.x, face.y - i * 2);
        back.width = face.w;
        back.height = face.h;
        this.backs.addChild(back);
      }
      if (layers === 0)
        g.rect(face.x, face.y, face.w, face.h).stroke({
          width: 1.5,
          color: 0x202323,
          alpha: 0.6,
        });
      return;
    }
    // Graveyard, exile and command: a socket in the stone under the top card.
    const face = fitCard(r);
    g.roundRect(face.x - 3, face.y - 3, face.w + 6, face.h + 6, 4).fill({
      color: 0x000000,
      alpha: 0.28,
    });
    if (!hasTop)
      g.roundRect(face.x, face.y, face.w, face.h, 4).stroke({
        width: 1.5,
        color: tile.zone === "exile" ? 0x8d7bd0 : 0xb9bdb9,
        alpha: 0.45,
      });
    if (tile.zone === "command" && tile.hit) {
      // The plate the "Command N · Tax T" words sit on.
      const hit = tile.hit;
      const plate =
        hit.y <= r.y && hit.y + hit.h > r.y + r.h
          ? {
              x: hit.x,
              y: r.y + r.h + 2,
              w: hit.w,
              h: hit.y + hit.h - r.y - r.h - 2,
            }
          : hit;
      g.roundRect(plate.x, plate.y, plate.w, plate.h, 4).fill({
        color: 0x0c0f0f,
        alpha: 0.82,
      });
      g.roundRect(plate.x, plate.y, plate.w, plate.h, 4).stroke({
        width: 1,
        color: 0xe6c68c,
        alpha: 0.6,
      });
    }
  }

  destroy(): void {
    this.top?.destroy();
    this.root.destroy({ children: true });
  }
}

/**
 * A "+N": what a pile, a row, the hand or the stack holds beyond what is drawn. The cards it
 * stands for are not drawn (so the plate never lies over a card's picture): a row's or a pile's
 * plate sits in the room the layout keeps for it, the stack's is a diamond on the band, and the
 * hand's lies on a few of our card backs in the fan's last slot.
 */
export class MoreBadge {
  readonly root = new Container();
  private readonly backs = new Container();
  private readonly g = new Graphics();
  private readonly label = new BitmapText({
    text: "",
    style: { fontFamily: "cd-bold", fontSize: 18 },
  });
  private readonly kit: SceneKit;
  private signature = "";

  constructor(kit: SceneKit) {
    this.kit = kit;
    this.label.tint = 0xffffff;
    this.label.anchor.set(0.5);
    this.root.addChild(this.backs, this.g, this.label);
  }

  update(node: PlacedMore, look: "plate" | "diamond" | "hand"): void {
    const r = node.hit;
    const signature = `${r.x},${r.y},${r.w},${r.h}|${node.count}|${look}`;
    if (signature === this.signature) return;
    this.signature = signature;
    const g = this.g;
    g.clear();
    for (const child of this.backs.removeChildren()) child.destroy();
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    if (look === "hand") {
      // The fan's last slot, turned as the fan turns it, as a small pile of backs.
      const slots = fanHand(HAND.slots);
      const slot = slots[slots.length - 1];
      const pivot = {
        x: slot.face.x + slot.face.w / 2,
        y: slot.face.y + slot.face.h,
      };
      for (let i = 2; i >= 0; i--) {
        const back = new Sprite(this.kit.art.back);
        back.anchor.set(0.5, 1);
        back.width = slot.face.w;
        back.height = slot.face.h;
        back.position.set(pivot.x + i * 5, pivot.y - i * 3);
        back.rotation = ((slot.rotation + i * 2) * Math.PI) / 180;
        this.backs.addChild(back);
      }
      const at = { x: pivot.x, y: slot.face.y + 52 };
      diamondPath(g, at.x, at.y, 40).fill({ color: 0x0b0b0c, alpha: 0.95 });
      diamondPath(g, at.x, at.y, 40).stroke({ width: 2, color: 0xe6c68c });
      this.label.text = `+${node.count}`;
      this.label.style.fontSize = 20;
      this.label.position.set(at.x, at.y);
      return;
    }
    if (look === "diamond") {
      const side = r.w / Math.SQRT2;
      diamondPath(g, cx, cy, side).fill({ color: 0x0b0b0c, alpha: 0.92 });
      diamondPath(g, cx, cy, side).stroke({ width: 1.5, color: 0xe6c68c });
    } else {
      const inset = Math.min(4, r.w * 0.08);
      g.roundRect(
        r.x + inset,
        r.y + inset,
        r.w - inset * 2,
        Math.min(r.h - inset * 2, 44),
        6,
      ).fill({
        color: 0x0b0b0c,
        alpha: 0.85,
      });
      g.roundRect(
        r.x + inset,
        r.y + inset,
        r.w - inset * 2,
        Math.min(r.h - inset * 2, 44),
        6,
      ).stroke({
        width: 1.5,
        color: 0xe6c68c,
        alpha: 0.8,
      });
    }
    this.label.text = `+${node.count}`;
    this.label.style.fontSize = Math.min(18, r.w * 0.42);
    this.label.position.set(
      cx,
      look === "diamond"
        ? cy
        : r.y + Math.min(4, r.w * 0.08) + Math.min(r.h - 8, 44) / 2,
    );
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
