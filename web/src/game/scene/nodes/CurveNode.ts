import type { CurvePlacement, Point as StagePoint } from "../../table/types";
import type { SceneKit } from "../createTableScene";
import { diamondPath } from "../icons";
import { Container, Graphics, MeshRope, Point } from "../pixi";

// A curved line on the table (design §8.3): from the player who cast a spell (their portrait) to
// the card on the stack, from a spell to each of its targets, or from an attacker to whom it
// attacks. A soft glow under a 4 su stroke, gold for yours and crimson for opponents', ending in
// a small diamond. A new cast's line draws itself on; lines of items below the top of the stack
// show only while that item is pointed at, focused or magnified.

const SEGMENTS = 24;
const COLOURS = { viewer: 0xf2e2b0, opponent: 0xe0485a } as const;

function at(c: CurvePlacement, t: number): StagePoint {
  const u = 1 - t;
  return {
    x: u * u * c.p0.x + 2 * u * t * c.c.x + t * t * c.p1.x,
    y: u * u * c.p0.y + 2 * u * t * c.c.y + t * t * c.p1.y,
  };
}

export class CurveNode {
  readonly root = new Container();
  private readonly glowPoints: Point[];
  private readonly corePoints: Point[];
  private readonly glow: MeshRope;
  private readonly core: MeshRope;
  private readonly head = new Graphics();
  private curve: CurvePlacement | null = null;
  private drawn = -1;

  constructor(kit: SceneKit) {
    this.glowPoints = Array.from({ length: SEGMENTS + 1 }, () => new Point());
    this.corePoints = Array.from({ length: SEGMENTS + 1 }, () => new Point());
    this.glow = new MeshRope({
      texture: kit.art.ropeGlow,
      points: this.glowPoints,
    });
    this.core = new MeshRope({
      texture: kit.art.ropeCore,
      points: this.corePoints,
    });
    this.glow.alpha = 0.55;
    this.root.addChild(this.glow, this.core, this.head);
  }

  update(curve: CurvePlacement): void {
    const colour = COLOURS[curve.owner];
    this.glow.tint = colour;
    this.core.tint = colour;
    const same =
      this.curve &&
      this.curve.p0.x === curve.p0.x &&
      this.curve.p0.y === curve.p0.y &&
      this.curve.p1.x === curve.p1.x &&
      this.curve.p1.y === curve.p1.y &&
      this.curve.owner === curve.owner;
    this.curve = curve;
    if (!same) {
      const drawn = this.drawn < 0 ? 1 : this.drawn;
      this.drawn = -1;
      this.setDrawn(drawn);
    }
  }

  /** How much of the line is drawn, from its start: 0 to 1. */
  setDrawn(amount: number): void {
    const c = this.curve;
    if (!c) return;
    const t1 = Math.max(0.001, Math.min(1, amount));
    if (t1 === this.drawn) return;
    this.drawn = t1;
    for (let i = 0; i <= SEGMENTS; i++) {
      const p = at(c, (i / SEGMENTS) * t1);
      this.glowPoints[i].set(p.x, p.y);
      this.corePoints[i].set(p.x, p.y);
    }
    const end = at(c, t1);
    const before = at(c, Math.max(0, t1 - 0.02));
    const angle = Math.atan2(end.y - before.y, end.x - before.x);
    const g = this.head;
    g.clear();
    g.position.set(end.x, end.y);
    // The diamond's right corner points along the line.
    g.rotation = angle;
    diamondPath(g, 0, 0, 14).fill(COLOURS[c.owner]);
    diamondPath(g, 0, 0, 14).stroke({
      width: 1.5,
      color: 0x1a0d0d,
      alpha: 0.6,
    });
  }

  /** Shows or hides the line; says whether that changed anything to draw. */
  setVisible(visible: boolean): boolean {
    if (this.root.visible === visible) return false;
    this.root.visible = visible;
    return true;
  }

  /** How much of the line is drawn now, 0 to 1. */
  get drawnShare(): number {
    return this.drawn < 0 ? 1 : this.drawn;
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
