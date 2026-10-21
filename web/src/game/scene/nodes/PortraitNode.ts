import { containFit, portraitBox, portraitSize } from "../../table/portrait";
import type { Diamond, PlayerNode, Rect, TablePlayer } from "../../table/types";
import type { SceneKit } from "../createTableScene";
import { diamondPath } from "../icons";
import { BitmapText, Container, Graphics, Sprite } from "../pixi";

// A player's portrait (design §8.4, §8.6–§8.8): their picture in a diamond frame, black-rimmed
// with a gold hairline (yours in colour, opponents' grey with a thinner bevel), life in a red
// diamond below it and the counts of hand, graveyard and library in small black diamonds beside
// it. The picture is their allied Planeswalker's portrait (v0.3.1), standing upright in front of
// the frame and fitted whole, or else their sigil, cut to the diamond; while a portrait is on its
// way the frame stays empty, so neither flashes in for the other. The names, the life numeral and
// the pills are the DOM's text; the count numerals are drawn here.
// The active player's portrait glows gold and an active opponent's column is lit; a player who
// lost is cracked and dimmed, with a shade over their column (the scene plays both in as the
// player is eliminated, design §14). Your portrait also carries the purple bar: the response
// timer while it runs, otherwise how far the turn has come.

/** How much a lost player's portrait and zone tiles fade, and how dark the shade over their
 * column grows. */
export const LOST_DIM = { fade: 0.45, shade: 0.35 } as const;

const PHASES = [
  "beginning",
  "precombat_main",
  "combat",
  "postcombat_main",
  "end",
];

function count(value: number, d: Diamond): BitmapText {
  const t = new BitmapText({
    text: `${value}`,
    style: {
      fontFamily: "cd-bold",
      fontSize: d.side * (value > 99 ? 0.52 : 0.62),
    },
  });
  t.tint = 0xffffff;
  t.anchor.set(0.5);
  t.position.set(d.cx, d.cy + d.side * 0.02);
  return t;
}

export class PortraitNode {
  /** Drawn under the cards: the lit floor of an active opponent's column. */
  readonly floor = new Graphics();
  /** Drawn under the cards: the shade over a lost player's column. */
  readonly shade = new Graphics();
  readonly root = new Container();
  private readonly frame = new Graphics();
  private readonly sigil = new Sprite();
  private readonly picture = new Sprite();
  private readonly crack = new Sprite();
  private readonly life = new Graphics();
  private readonly counts = new Container();
  private readonly bar = new Graphics();
  private readonly kit: SceneKit;
  private signature = "";
  private node: PlayerNode | null = null;
  private barValue = -1;
  private barTimer = false;
  /** Whether the player has lost, as of the last update. */
  lost = false;

  constructor(kit: SceneKit) {
    this.kit = kit;
    this.crack.texture = kit.art.crack;
    this.crack.visible = false;
    this.shade.alpha = 0;
    this.picture.visible = false;
    this.root.addChild(
      this.frame,
      this.sigil,
      this.picture,
      this.crack,
      this.life,
      this.counts,
      this.bar,
    );
  }

  update(
    node: PlayerNode,
    player: TablePlayer,
    o: { column: Rect | null; activeLine: number | null },
  ): void {
    this.node = node;
    this.lost = player.lost;
    const p = player.player;
    const box = portraitBox(node.portrait);
    const picture = player.portrait
      ? this.kit.portrait(
          player.portrait,
          portraitSize(box.w * this.kit.resolution()),
          player.sigil.grey,
        )
      : "missing";
    const signature = [
      player.portrait,
      typeof picture === "string" ? picture : picture.uid,
      node.portrait.cx,
      node.portrait.cy,
      node.portrait.side,
      node.area.x,
      node.area.y,
      node.area.w,
      node.area.h,
      node.chip,
      player.sigil.seed,
      player.sigil.grey,
      player.active,
      player.lost,
      p.hand_count,
      p.graveyard.length,
      p.library_count,
      o.column?.x,
      o.column?.w,
      o.activeLine,
    ].join("|");
    if (signature === this.signature) return;
    this.signature = signature;

    const { portrait } = node;
    const f = this.frame;
    f.clear();
    if (player.active) {
      // A soft gold glow around the active player's frame.
      for (let i = 4; i >= 1; i--)
        diamondPath(f, portrait.cx, portrait.cy, portrait.side + i * 7).fill({
          color: 0xe6c27a,
          alpha: 0.06 + (4 - i) * 0.03,
        });
    }
    const rim = player.anchored ? 8 : 5;
    diamondPath(f, portrait.cx, portrait.cy, portrait.side + 4).fill({
      color: 0x000000,
      alpha: 0.4,
    });
    diamondPath(f, portrait.cx, portrait.cy, portrait.side).fill(0x050606);
    diamondPath(f, portrait.cx, portrait.cy, portrait.side - rim * 1.2).stroke({
      width: Math.max(0.8, portrait.side * 0.012),
      color: 0xd9b56e,
    });
    const inner = portrait.side - rim * 2;
    this.sigil.visible = picture === "missing";
    if (this.sigil.visible) {
      this.sigil.texture = this.kit.sigil(player.sigil.seed, player.sigil.grey);
      this.sigil.anchor.set(0.5);
      this.sigil.position.set(portrait.cx, portrait.cy);
      this.sigil.width = inner * Math.SQRT2;
      this.sigil.height = inner * Math.SQRT2;
    }
    this.picture.visible = typeof picture !== "string";
    if (typeof picture !== "string") {
      const fit = containFit(box, picture.width, picture.height);
      this.picture.texture = picture;
      this.picture.position.set(fit.x, fit.y);
      this.picture.width = fit.w;
      this.picture.height = fit.h;
    }
    // The crack's and the dimming's strength is the scene's (setLost), which plays them in.
    this.crack.anchor.set(0.5);
    this.crack.position.set(portrait.cx, portrait.cy);
    this.crack.width = inner * Math.SQRT2;
    this.crack.height = inner * Math.SQRT2;
    const shade = this.shade;
    shade.clear();
    shade
      .rect(node.area.x, node.area.y, node.area.w, node.area.h)
      .fill({ color: 0x000000, alpha: 1 });

    // Life: a red diamond with a dark rim; the numeral over it is the DOM's.
    const l = this.life;
    l.clear();
    l.position.set(node.life.cx, node.life.cy);
    diamondPath(l, 0, 0, node.life.side + 4).fill(0x0a0303);
    diamondPath(l, 0, 0, node.life.side).fill(0xa3161b);
    diamondPath(l, 0, -node.life.side * 0.12, node.life.side * 0.62).fill({
      color: 0xffffff,
      alpha: 0.08,
    });
    diamondPath(l, 0, 0, node.life.side - 3).stroke({
      width: 1,
      color: 0xe7a0a0,
      alpha: 0.5,
    });

    for (const child of this.counts.removeChildren()) child.destroy();
    const g = new Graphics();
    this.counts.addChild(g);
    const values: [Diamond, number][] = [
      [node.counts.hand, p.hand_count],
      [node.counts.graveyard, p.graveyard.length],
      [node.counts.library, p.library_count],
    ];
    for (const [d, value] of values) {
      diamondPath(g, d.cx, d.cy, d.side + 2).fill({
        color: 0x000000,
        alpha: 0.5,
      });
      diamondPath(g, d.cx, d.cy, d.side).fill(0x0b0b0c);
      diamondPath(g, d.cx, d.cy, d.side - 2).stroke({
        width: 0.8,
        color: 0x8f8a7c,
        alpha: 0.8,
      });
      this.counts.addChild(count(value, d));
    }

    // The active opponent's column: a little more light, and a gold line along its foot.
    const floor = this.floor;
    floor.clear();
    if (player.active && o.column) {
      floor.rect(o.column.x, o.column.y, o.column.w, o.column.h).fill({
        color: 0xffffff,
        alpha: 0.06,
      });
      if (o.activeLine !== null)
        floor.rect(o.column.x, o.activeLine - 2, o.column.w, 4).fill({
          color: 0xe6c27a,
          alpha: 0.85,
        });
    }
    this.barValue = -1;
  }

  /** The purple bar beside your portrait: `timer` is the share of the response timer left, or
   * null to show how far the turn has come. Says whether it drew anything new. */
  setBar(phase: string | null, timer: number | null): boolean {
    const bar = this.node?.phase?.bar;
    if (!bar) return false;
    const value =
      timer ?? Math.max(0, PHASES.indexOf(phase ?? "")) / (PHASES.length - 1);
    if (value === this.barValue && (timer !== null) === this.barTimer)
      return false;
    this.barValue = value;
    this.barTimer = timer !== null;
    const g = this.bar;
    g.clear();
    g.roundRect(bar.x, bar.y, bar.w, bar.h, bar.h / 2).fill({
      color: 0x0b0b0c,
      alpha: 0.7,
    });
    const w = Math.max(0, Math.min(1, value)) * bar.w;
    if (w > 0)
      g.roundRect(bar.x, bar.y, w, bar.h, bar.h / 2).fill({
        color: timer !== null ? 0xa66bff : 0x7d4fc4,
        alpha: timer !== null ? 1 : 0.85,
      });
    diamondPath(g, bar.x + w, bar.y + bar.h / 2, 12).fill(0x0b0b0c);
    diamondPath(g, bar.x + w, bar.y + bar.h / 2, 9).fill(
      timer !== null ? 0xc9a6ff : 0x9b74e0,
    );
    return true;
  }

  /** The life diamond's pulse when life changes, 1 at rest. */
  pulseLife(scale: number): void {
    this.life.scale.set(scale);
  }

  /** How far a player's loss shows, 0 to 1: the crack spreads over the picture, the portrait fades
   * and the shade darkens their column. */
  setLost(amount: number): void {
    this.crack.visible = amount > 0;
    this.crack.alpha = amount;
    this.root.alpha = 1 - LOST_DIM.fade * amount;
    this.shade.alpha = LOST_DIM.shade * amount;
    this.shade.visible = amount > 0;
  }

  destroy(): void {
    this.floor.destroy();
    this.shade.destroy();
    this.root.destroy({ children: true });
  }
}
