import type {
  BadgePlacement,
  Mark,
  PipPlacement,
  Point,
  Rect,
  TagPlacement,
} from "../../table/types";
import type { CardView } from "../../types";
import type { SceneKit } from "../createTableScene";
import { diamondPath, drawIcon, type SceneIcon } from "../icons";
import {
  BitmapText,
  Container,
  Graphics,
  NineSliceSprite,
  Sprite,
  Texture,
} from "../pixi";
import {
  tierFor,
  type LazyHandle,
  type Priority,
  type TextureHandle,
  type Tier,
} from "../textures";
import type { Pose } from "../timeline";
import { drawRibbon } from "./StackNode";

// One card on the table: its text frame, its printed image over it, the glow behind it and the
// marks around it (design §8.10). The image is only ever scaled evenly and turned: never
// stretched, skewed, tinted, filtered or masked, and nothing is drawn over it but Magic Duels'
// power and toughness tag over the printed box and the ◆/✓ badge on the frame's corner. Glows
// and rings lie behind or outside the picture.
//
// A card holds the textures it shows. When it needs a new one (a new tier after a resize, a new
// power for its frame) it keeps showing, and holding, the old one until the new one is ready, so
// the caches never let go of a texture on screen; when it becomes another card it shows only its
// own frame until its own picture arrives.

/** Where and how a card is drawn: the layout's node, or a zone tile's top card. */
export interface CardPlacement {
  face: Rect;
  rotation: number;
  /** The pivot the card turns about and its pose names: the face's centre, or for a hand card
   * its bottom centre. */
  pivot: Point;
  mark: Mark;
  faceUp: boolean;
  tag: TagPlacement | null;
  pips: PipPlacement[];
  badges: BadgePlacement[];
  /** Drawn height in stage units for choosing the texture tier (a hand card's risen height). */
  tierHeight: number;
  priority: Priority;
  /** The anchored player's card: its attack mark is an arrow beside it, not a sword below. */
  yours: boolean;
  /** An ability on the stack: where its "Ability" ribbon goes, above the picture. */
  ribbon: Rect | null;
}

const COLOURS = {
  tag: 0xd9d9d4,
  tagText: 0x111111,
  buffed: 0x1d7a2c,
  hurt: 0xb3121b,
  cyan: 0x3fd0e0,
  red: 0xb3121b,
  violet: 0x8d6bff,
  badge: 0x0b0b0c,
  attackYours: 0xff8a1f,
  attackTheirs: 0xe0485a,
  block: 0x7fa7ff,
  sick: 0xc9d6ff,
  selected: 0x2ec4b6,
} as const;

/** The glow's reach beyond the card's edge, in stage units (the 9-slice keeps it this wide). */
export const GLOW_REACH = 10;

/** The pose a placement rests in: at its pivot, turned as the layout turns it. */
export function restPose(
  p: { pivot: Point; rotation: number },
  alpha = 1,
): Pose {
  return { x: p.pivot.x, y: p.pivot.y, rotation: p.rotation, scale: 1, alpha };
}

function frameKeyOf(card: CardView, tier: number): string {
  return `${card.name}|${card.type_line}|${card.power}/${card.toughness}|${card.mana_cost}|${tier}`;
}

function text(
  value: string,
  size: number,
  colour: number,
  centre: Point,
): BitmapText {
  const t = new BitmapText({
    text: value,
    style: { fontFamily: "cd-bold", fontSize: size },
  });
  t.tint = colour;
  t.anchor.set(0.5);
  t.position.set(centre.x, centre.y);
  return t;
}

// A commit re-places every card, so the checks below compare numbers rather than build strings:
// most cards have not changed, and they should cost next to nothing.
const near = (a: number, b: number) => Math.abs(a - b) < 0.01;

function sameRect(a: Rect, b: Rect): boolean {
  return near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h);
}

function samePoint(a: Point, b: Point): boolean {
  return near(a.x, b.x) && near(a.y, b.y);
}

/** Whether two placements draw the same marks. Marks are drawn relative to the card's pivot, so
 * a card that only moved keeps them as they are. */
function sameMarks(a: CardPlacement, b: CardPlacement): boolean {
  if (a.yours !== b.yours || a.mark !== b.mark) return false;
  const da = a.pivot;
  const db = b.pivot;
  const same = (p: Point, q: Point) =>
    near(p.x - da.x, q.x - db.x) && near(p.y - da.y, q.y - db.y);
  if (!a.ribbon !== !b.ribbon) return false;
  if (
    a.ribbon &&
    b.ribbon &&
    (!same(a.ribbon, b.ribbon) ||
      !near(a.ribbon.w, b.ribbon.w) ||
      !near(a.ribbon.h, b.ribbon.h))
  )
    return false;
  if (!a.tag !== !b.tag) return false;
  if (
    a.tag &&
    b.tag &&
    (a.tag.text !== b.tag.text ||
      a.tag.tone !== b.tag.tone ||
      !near(a.tag.rect.w, b.tag.rect.w) ||
      !near(a.tag.rect.h, b.tag.rect.h) ||
      !same(a.tag.rect, b.tag.rect))
  )
    return false;
  if (a.pips.length !== b.pips.length || a.badges.length !== b.badges.length)
    return false;
  for (let i = 0; i < a.pips.length; i++) {
    const p = a.pips[i];
    const q = b.pips[i];
    if (
      p.counter !== q.counter ||
      p.count !== q.count ||
      !near(p.side, q.side) ||
      !same(p.centre, q.centre)
    )
      return false;
  }
  for (let i = 0; i < a.badges.length; i++) {
    const p = a.badges[i];
    const q = b.badges[i];
    if (
      p.glyph !== q.glyph ||
      p.text !== q.text ||
      !near(p.side, q.side) ||
      !same(p.centre, q.centre)
    )
      return false;
  }
  return true;
}

function sameFace(a: CardView | null, b: CardView): boolean {
  return (
    !!a &&
    a.name === b.name &&
    a.hidden === b.hidden &&
    a.type_line === b.type_line &&
    a.power === b.power &&
    a.toughness === b.toughness &&
    a.mana_cost === b.mana_cost
  );
}

export class CardNode {
  readonly root = new Container();
  /** The glow and the chosen ring, kept in a layer under every card: a pile's or the hand's
   * overlapping cards never have a neighbour's light drawn over their pictures. It follows the
   * card's pose. */
  readonly under = new Container();
  private readonly underBody = new Container();
  private readonly body = new Container();
  private readonly glow: NineSliceSprite;
  private readonly frame = new Sprite();
  private readonly image = new Sprite();
  private readonly back = new Sprite();
  private readonly ring = new Graphics();
  private readonly marks = new Container();
  private readonly kit: SceneKit;
  /** The picture this card wants now. */
  private handle: TextureHandle<Texture> | null = null;
  private handleKey = "";
  /** The picture still on screen while `handle` is on its way (the same card at another tier). */
  private held: TextureHandle<Texture> | null = null;
  /** Whose picture the image shows. */
  private imageName: string | null = null;
  private card: CardView | null = null;
  /** The text frame this card wants now ("back" while it is face down). */
  private frameKey = "";
  private frameHandle: LazyHandle<Texture> | null = null;
  /** The frame still drawn while `frameHandle`'s is being made (the same card, changed). */
  private frameHeld: LazyHandle<Texture> | null = null;
  /** Whose frame the frame sprite shows, or null for the back or the plain placeholder. */
  private frameName: string | null = null;
  private tier = 0;
  private faceUp = false;
  private marksDrawn = false;
  private placement: CardPlacement | null = null;
  /** The pose the layout gives this card (with its ui offsets); tweens end here. */
  rest: Pose = { x: 0, y: 0, rotation: 0, scale: 1, alpha: 1 };
  key = "";
  /** The image's fade-in, 0 to 1, once its texture is ready. */
  imageAlpha = 0;

  constructor(kit: SceneKit) {
    this.kit = kit;
    this.glow = new NineSliceSprite({
      texture: kit.art.glowOffered,
      leftWidth: GLOW_REACH,
      topHeight: GLOW_REACH,
      rightWidth: GLOW_REACH,
      bottomHeight: GLOW_REACH,
    });
    this.glow.blendMode = "add";
    this.glow.visible = false;
    this.image.anchor.set(0.5);
    this.image.visible = false;
    this.back.visible = false;
    this.underBody.addChild(this.glow, this.ring);
    this.under.addChild(this.underBody);
    this.body.addChild(this.frame, this.image, this.back);
    this.root.addChild(this.body, this.marks);
  }

  /** Puts the card in a layer, and its glow in the layer under it. */
  addTo(layer: Container, underLayer: Container): void {
    if (this.root.parent !== layer) layer.addChild(this.root);
    if (this.under.parent !== underLayer) underLayer.addChild(this.under);
  }

  /** Lays the card out where the layout puts it. Cheap when nothing but the pose changed. */
  place(card: CardView, p: CardPlacement): void {
    const last = this.placement;
    this.placement = p;
    const { face, pivot } = p;
    const x = face.x - pivot.x;
    const y = face.y - pivot.y;
    const w = face.w;
    const h = face.h;
    const moved =
      !last || !sameRect(last.face, face) || !samePoint(last.pivot, pivot);
    if (moved) {
      this.frame.position.set(x, y);
      this.frame.width = w;
      this.frame.height = h;
      this.back.texture = this.kit.art.back;
      this.back.position.set(x, y);
      this.back.width = w;
      this.back.height = h;
      this.image.position.set(x + w / 2, y + h / 2);
      this.fitImage();
    }

    // The glow: purple for what can be chosen, pink for a playable hand card; a teal ring for a
    // chosen one. Under every card, so no picture is ever covered by it.
    if (!last || moved || last.mark !== p.mark) {
      const glowing = p.mark === "offered" || p.mark === "playable";
      this.glow.visible = glowing;
      if (glowing) {
        this.glow.texture =
          p.mark === "playable"
            ? this.kit.art.glowPlayable
            : this.kit.art.glowOffered;
        this.glow.position.set(x - GLOW_REACH, y - GLOW_REACH);
        this.glow.width = w + GLOW_REACH * 2;
        this.glow.height = h + GLOW_REACH * 2;
      }
      this.ring.clear();
      if (p.mark === "selected")
        this.ring
          .rect(x - 2, y - 2, w + 4, h + 4)
          .stroke({ width: 4, color: COLOURS.selected, alignment: 0.5 });
    }

    this.setCard(card, p);
    if (!this.marksDrawn || !last || !sameMarks(last, p)) {
      this.marksDrawn = true;
      this.drawMarks(p);
    }
  }

  /** The face to show: the back for a hidden card (no image asked for), else the text frame with
   * the card's image over it once it arrives. */
  private setCard(card: CardView, p: CardPlacement): void {
    const tier = tierFor(p.tierHeight * 0.716 * this.kit.resolution());
    // The same face at the same tier: nothing to do.
    if (
      this.tier === tier &&
      this.faceUp === p.faceUp &&
      sameFace(this.card, card)
    ) {
      this.card = card;
      return;
    }
    this.card = card;
    this.tier = tier;
    this.faceUp = p.faceUp;
    if (!p.faceUp || !card.name) {
      this.releaseImage();
      this.releaseFrame();
      this.frameKey = "back";
      this.frame.texture = this.kit.art.back;
      this.hideImage();
      return;
    }
    this.setFrame(card, tier);
    this.setImage(card.name, tier, p.priority);
  }

  /** The text frame for the card's current characteristics, made a few a frame by the scene. */
  private setFrame(card: CardView, tier: Tier): void {
    const key = frameKeyOf(card, tier);
    if (key === this.frameKey) return;
    const previous = this.frameHandle;
    const next = this.kit.frame(card, tier);
    this.frameKey = key;
    this.frameHandle = next;
    if (next.texture) {
      this.showFrame(next.texture, card.name);
      previous?.release();
      return;
    }
    this.kit.waitForFrame(this);
    // Until it is made, the same card keeps the frame it has (its power changed, or its tier);
    // another card gets the plain placeholder, never this one's words.
    const drawn = this.frameHeld ?? (previous?.texture ? previous : null);
    if (drawn && this.frameName === card.name) {
      if (drawn !== previous) previous?.release();
      this.frameHeld = drawn;
    } else {
      previous?.release();
      this.frameHeld?.release();
      this.frameHeld = null;
      this.frame.texture = this.kit.art.blank;
      this.frameName = null;
    }
  }

  private showFrame(texture: Texture, name: string | null): void {
    this.frame.texture = texture;
    this.frameName = name;
    this.frameHeld?.release();
    this.frameHeld = null;
  }

  /** The printed image, at the tier the card's drawn size needs. */
  private setImage(name: string, tier: Tier, priority: Priority): void {
    const key = `${name}|${tier}`;
    if (key === this.handleKey) return;
    const previous = this.handle;
    // The handle whose picture is on screen now, if any.
    const shown = this.image.visible ? (this.held ?? previous) : null;
    this.handleKey = key;
    const handle = this.kit.textures.acquire(name, tier, priority);
    this.handle = handle;
    if (handle.texture) {
      this.showImage(handle.texture, name, previous !== null);
      previous?.release();
      return;
    }
    if (shown?.texture && this.imageName === name) {
      // The same picture at another tier: it stays on screen, held, until the new one settles,
      // so a resize never blanks a card and the cache never lets go of a texture it shows.
      if (shown !== previous) previous?.release();
      this.held = shown;
    } else {
      // Another card's picture is never left over this one's frame.
      previous?.release();
      this.dropHeld();
      this.hideImage();
    }
    handle.onSettle((state) => {
      if (this.handle !== handle) return;
      if (state === "ready" && handle.texture)
        this.showImage(handle.texture, name, false);
      else {
        this.dropHeld();
        this.hideImage();
      }
      this.kit.request();
    });
  }

  private dropHeld(): void {
    this.held?.release();
    this.held = null;
  }

  /** Called when its text frame may have been made. */
  refreshFrame(): void {
    const handle = this.frameHandle;
    if (!handle || this.frameKey === "back") return;
    if (handle.texture) this.showFrame(handle.texture, this.card?.name ?? null);
    else this.kit.waitForFrame(this);
  }

  private showImage(texture: Texture, name: string, instant: boolean): void {
    this.image.texture = texture;
    this.image.visible = true;
    this.imageName = name;
    this.dropHeld();
    this.fitImage();
    if (instant || this.imageAlpha >= 1) this.imageAlpha = 1;
    else this.kit.fadeImage(this);
    this.applyImageAlpha();
  }

  /** Hides the image and lets go of its texture: a card never points at one it does not hold. */
  private hideImage(): void {
    this.image.visible = false;
    this.image.texture = Texture.EMPTY;
    this.imageName = null;
    this.imageAlpha = 0;
    this.applyImageAlpha();
  }

  /** Scales the image evenly to the face's height, centred: its proportions are never changed. */
  private fitImage(): void {
    const p = this.placement;
    const texture = this.image.texture;
    if (!p || !this.image.visible || !texture || texture.height <= 0) return;
    const s = p.face.h / texture.height;
    this.image.scale.set(s, s);
  }

  setImageAlpha(alpha: number): void {
    this.imageAlpha = alpha;
    this.applyImageAlpha();
  }

  private applyImageAlpha(): void {
    this.image.alpha = this.imageAlpha;
    // Once the image covers it, the frame need not be drawn.
    this.frame.visible = !(this.image.visible && this.imageAlpha >= 1);
  }

  /** How far a face-down arrival has turned face up: 0 shows the back, 1 the face. The back
   * fades out around 60% of the way. */
  setShown(shown: number): void {
    this.showBack(1 - Math.min(1, Math.max(0, (shown - 0.55) / 0.1)));
  }

  /** Our card back over the face, 0 to 1: an arrival from a hidden zone, or a departure into
   * one. A card already face down has nothing to cover. */
  showBack(amount: number): void {
    this.back.visible = amount > 0 && this.frameKey !== "back";
    this.back.alpha = amount;
  }

  setPose(pose: Pose): void {
    const rotation = (pose.rotation * Math.PI) / 180;
    for (const c of [this.root, this.under]) {
      c.position.set(pose.x, pose.y);
      c.scale.set(pose.scale);
      c.alpha = pose.alpha;
    }
    this.body.rotation = rotation;
    this.underBody.rotation = rotation;
  }

  /** An extra glow while damage lands, from 0 to 1. */
  setDamageGlow(amount: number): void {
    const p = this.placement;
    if (!p) return;
    if (amount <= 0) {
      if (p.mark === "offered" || p.mark === "playable") {
        this.glow.texture =
          p.mark === "playable"
            ? this.kit.art.glowPlayable
            : this.kit.art.glowOffered;
        this.glow.alpha = 1;
      } else this.glow.visible = false;
      return;
    }
    const x = p.face.x - p.pivot.x;
    const y = p.face.y - p.pivot.y;
    this.glow.texture = this.kit.art.glowDamage;
    this.glow.visible = true;
    this.glow.alpha = amount;
    this.glow.position.set(x - GLOW_REACH, y - GLOW_REACH);
    this.glow.width = p.face.w + GLOW_REACH * 2;
    this.glow.height = p.face.h + GLOW_REACH * 2;
  }

  /** The glow's strength, for a breath when new choices appear. */
  setGlowAlpha(alpha: number): void {
    if (this.glow.texture !== this.kit.art.glowDamage) this.glow.alpha = alpha;
  }

  private drawMarks(p: CardPlacement): void {
    const none =
      !p.tag && !p.ribbon && p.pips.length === 0 && p.badges.length === 0;
    if (none && this.marks.children.length === 0) return;
    for (const child of this.marks.removeChildren()) child.destroy();
    if (none) return;
    const at = (q: Point): Point => ({
      x: q.x - p.pivot.x,
      y: q.y - p.pivot.y,
    });
    const g = new Graphics();
    this.marks.addChild(g);
    const texts: BitmapText[] = [];
    if (p.ribbon) texts.push(drawRibbon(g, { ...p.ribbon, ...at(p.ribbon) }));
    if (p.tag) {
      const r = p.tag.rect;
      const local = at({ x: r.x, y: r.y });
      const centre = { x: local.x + r.w / 2, y: local.y + r.h / 2 };
      const size = Math.min(
        r.h * 0.82,
        (r.w * 1.7) / Math.max(3, p.tag.text.length),
      );
      if (p.tag.tone === "loyalty") {
        // Loyalty in a black diamond, widened rather than taller than the tag, so it stays clear
        // of the copyright line as the tag does.
        const half = Math.min(r.w, r.h * 2.4) / 2;
        const rhombus = [
          centre.x - half,
          centre.y,
          centre.x,
          local.y,
          centre.x + half,
          centre.y,
          centre.x,
          local.y + r.h,
        ];
        g.poly(rhombus).fill(COLOURS.badge);
        g.poly(rhombus).stroke({
          width: Math.max(0.6, r.h * 0.08),
          color: 0xe6c68c,
        });
        texts.push(text(p.tag.text, r.h * 0.8, 0xffffff, centre));
      } else {
        g.roundRect(local.x, local.y, r.w, r.h, Math.min(r.w, r.h) * 0.18).fill(
          COLOURS.tag,
        );
        g.roundRect(
          local.x,
          local.y,
          r.w,
          r.h,
          Math.min(r.w, r.h) * 0.18,
        ).stroke({ width: Math.max(0.5, r.h * 0.06), color: 0x55574f });
        const colour =
          p.tag.tone === "buffed"
            ? COLOURS.buffed
            : p.tag.tone === "hurt"
              ? COLOURS.hurt
              : COLOURS.tagText;
        texts.push(text(p.tag.text, size, colour, centre));
      }
    }
    for (const pip of p.pips) {
      const c = at(pip.centre);
      const colour =
        pip.colour === "cyan"
          ? COLOURS.cyan
          : pip.colour === "red"
            ? COLOURS.red
            : COLOURS.violet;
      diamondPath(g, c.x, c.y, pip.side).fill(colour);
      diamondPath(g, c.x, c.y, pip.side).stroke({
        width: Math.max(0.5, pip.side * 0.1),
        color: 0x0b0b0c,
      });
      const label =
        pip.colour === "violet"
          ? `${
              pip.counter
                .replace(/[^a-z]/gi, "")
                .charAt(0)
                .toUpperCase() || "?"
            }${pip.count > 1 ? pip.count : ""}`
          : pip.count > 1
            ? `${pip.count}`
            : "";
      if (label)
        texts.push(
          text(
            label,
            pip.side * (label.length > 1 ? 0.62 : 0.8),
            pip.colour === "cyan" ? 0x07262a : 0xffffff,
            c,
          ),
        );
    }
    for (const badge of p.badges) {
      const c = at(badge.centre);
      const s = badge.side;
      switch (badge.glyph) {
        case "offered":
        case "selected":
          diamondPath(g, c.x, c.y, s).fill(COLOURS.badge);
          diamondPath(g, c.x, c.y, s).stroke({
            width: Math.max(0.6, s * 0.08),
            color: p.mark === "selected" ? COLOURS.selected : 0xa86bff,
          });
          drawIcon(
            g,
            badge.glyph === "selected" ? "check" : "offered",
            c.x,
            c.y,
            s * 0.9,
            0xffffff,
          );
          break;
        case "attack":
        case "block": {
          const icon: SceneIcon =
            badge.glyph === "block" ? "shield" : p.yours ? "arrow" : "sword";
          const colour =
            badge.glyph === "block"
              ? COLOURS.block
              : p.yours
                ? COLOURS.attackYours
                : COLOURS.attackTheirs;
          // A dark disc under the icon keeps it readable on the stone.
          g.circle(c.x, c.y, s * 0.55).fill({ color: 0x000000, alpha: 0.45 });
          drawIcon(g, icon, c.x, c.y, s, colour);
          break;
        }
        case "sick":
          drawIcon(g, "crescent", c.x, c.y, s, COLOURS.sick);
          break;
        case "count":
          diamondPath(g, c.x, c.y, s).fill(COLOURS.badge);
          diamondPath(g, c.x, c.y, s).stroke({
            width: Math.max(0.6, s * 0.07),
            color: 0xe6c68c,
          });
          texts.push(text(badge.text ?? "", s * 0.45, 0xffffff, c));
          break;
      }
    }
    if (texts.length > 0) this.marks.addChild(...texts);
  }

  private releaseImage(): void {
    this.handle?.release();
    this.handle = null;
    this.handleKey = "";
    this.dropHeld();
    this.imageAlpha = 0;
  }

  private releaseFrame(): void {
    this.frameHandle?.release();
    this.frameHandle = null;
    this.frameHeld?.release();
    this.frameHeld = null;
    this.frameName = null;
    this.frameKey = "";
  }

  /** Back to the pool: lets go of its textures and leaves the scene graph. */
  recycle(): void {
    this.releaseImage();
    this.releaseFrame();
    this.hideImage();
    this.frame.texture = this.kit.art.blank;
    this.tier = 0;
    this.faceUp = false;
    this.marksDrawn = false;
    this.card = null;
    this.placement = null;
    this.back.visible = false;
    this.back.alpha = 1;
    this.root.removeFromParent();
    this.under.removeFromParent();
    this.glow.alpha = 1;
  }

  destroy(): void {
    this.releaseImage();
    this.releaseFrame();
    this.root.destroy({ children: true });
    this.under.destroy({ children: true });
  }
}
