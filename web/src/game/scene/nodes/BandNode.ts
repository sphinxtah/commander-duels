import type { BandLayout } from "../../table/types";
import type { SceneKit } from "../createTableScene";
import { diamondPath, drawIcon, type SceneIcon } from "../icons";
import { Container, Graphics, Sprite } from "../pixi";

// The red band across the middle of the table (design §8.2): a red strip edged in dark and gold,
// embossed with small diamonds, with the socket the stack's top card lies in at its centre. At
// its right, the combat step icons (attack, block, damage; the current one lit) while combat
// runs, and the five phase pips joined by a line. The turn and step words over it, and the HUD's
// diamond buttons at its left, are the DOM's.

const PHASES = [
  "beginning",
  "precombat_main",
  "combat",
  "postcombat_main",
  "end",
];
const COMBAT: [SceneIcon, string[]][] = [
  ["swords", ["begin_combat", "declare_attackers"]],
  ["shield", ["declare_blockers"]],
  ["damage", ["first_combat_damage", "combat_damage", "end_combat"]],
];

export class BandNode {
  readonly root = new Container();
  private readonly strip = new Sprite();
  private readonly emboss = new Graphics();
  private readonly marks = new Graphics();
  private readonly kit: SceneKit;
  private span = "";
  private steps = "";

  constructor(kit: SceneKit) {
    this.kit = kit;
    this.root.addChild(this.strip, this.emboss, this.marks);
  }

  /** The band across the visible width (wider than the stage on ultrawide screens). */
  resize(band: BandLayout, left: number, right: number): void {
    const span = `${band.rect.y},${band.rect.h},${left},${right}`;
    if (span === this.span) return;
    this.span = span;
    this.strip.texture = this.kit.art.band;
    this.strip.position.set(left, band.rect.y);
    this.strip.width = right - left;
    this.strip.height = band.rect.h;
    const g = this.emboss;
    g.clear();
    const y = band.rect.y + band.rect.h / 2;
    const first = Math.ceil((left - 60) / 120);
    for (let i = first; 60 + i * 120 < right; i++) {
      const x = 60 + i * 120;
      // Clear of the HUD's diamonds, the centre socket and the step icons and phase pips.
      if ((x > 0 && x < 240) || (x > 860 && x < 1060) || (x > 1420 && x < 1910))
        continue;
      diamondPath(g, x, y + 0.8, 12).stroke({
        width: 1.2,
        color: 0xffb0a0,
        alpha: 0.18,
      });
      diamondPath(g, x, y, 12).stroke({
        width: 1.2,
        color: 0x2a0406,
        alpha: 0.55,
      });
    }
    // The socket at the centre, faint: a diamond ring cut into the stone and the band, where the
    // stack's top card lies and the phase emblem appears.
    const e = band.emblem;
    diamondPath(g, e.cx, e.cy, e.side * 0.92).fill({
      color: 0x1a0203,
      alpha: 0.22,
    });
    diamondPath(g, e.cx, e.cy + 1.2, e.side * 0.92).stroke({
      width: 1.5,
      color: 0xf2e2b0,
      alpha: 0.18,
    });
    diamondPath(g, e.cx, e.cy, e.side * 0.92).stroke({
      width: 2,
      color: 0x0d0f0f,
      alpha: 0.45,
    });
    this.steps = "";
  }

  /** Lights the current phase pip and, during combat, the current step's icon. */
  update(band: BandLayout, phase: string | null, step: string | null): void {
    const steps = `${phase}|${step}`;
    if (steps === this.steps) return;
    this.steps = steps;
    const g = this.marks;
    g.clear();
    const current = PHASES.indexOf(phase ?? "");
    const pips = band.phases;
    if (pips.length > 1)
      g.rect(
        pips[0].cx,
        pips[0].cy - 1,
        pips[pips.length - 1].cx - pips[0].cx,
        2,
      ).fill({
        color: 0x1a0203,
        alpha: 0.9,
      });
    pips.forEach((d, i) => {
      const lit = i === current;
      const passed = current >= 0 && i < current;
      diamondPath(g, d.cx, d.cy, d.side + 3).fill(0x1a0203);
      diamondPath(g, d.cx, d.cy, d.side).fill(
        lit ? 0xf2e2b0 : passed ? 0x8a6a3c : 0x2b0a0c,
      );
      diamondPath(g, d.cx, d.cy, d.side).stroke({
        width: 1,
        color: lit ? 0xffffff : 0xc9a46a,
        alpha: lit ? 0.9 : 0.5,
      });
    });
    if (phase === "combat")
      band.combatIcons.forEach((d, i) => {
        const [icon, lit] = COMBAT[i];
        const on = lit.includes(step ?? "");
        diamondPath(g, d.cx, d.cy, d.side + 2).fill(0x0b0b0c);
        diamondPath(g, d.cx, d.cy, d.side).stroke({
          width: 1,
          color: on ? 0xf2e2b0 : 0x6d5a3a,
        });
        drawIcon(g, icon, d.cx, d.cy, d.side * 0.95, on ? 0xffffff : 0x6f6f6f);
      });
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
