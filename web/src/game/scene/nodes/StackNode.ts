import type { TableLayout, TableModel } from "../../table/types";
import { BitmapText, Container, Graphics } from "../pixi";

// What the stack adds to its cards on the band (design §8.3): the stack items are card nodes,
// the top one in the band's socket and older ones fanned to its left; an ability shows its
// source's picture a little smaller, with an "Ability" ribbon above the picture, never over it.

export class StackNode {
  readonly root = new Container();
  private signature = "";

  update(model: TableModel, layout: TableLayout): void {
    const abilities = model.stack.filter(
      (entry) => entry.item.kind === "ability" && layout.nodes.has(entry.key),
    );
    const signature = abilities
      .map((entry) => {
        const node = layout.nodes.get(entry.key)!;
        return node.kind === "card"
          ? `${entry.key}@${node.footprint.x},${node.footprint.y},${node.footprint.w},${node.face.y}`
          : "";
      })
      .join(";");
    if (signature === this.signature) return;
    this.signature = signature;
    for (const child of this.root.removeChildren()) child.destroy();
    for (const entry of abilities) {
      const node = layout.nodes.get(entry.key);
      if (node?.kind !== "card") continue;
      const box = node.footprint;
      const room = node.face.y - box.y;
      if (room < 6) continue;
      const g = new Graphics();
      const h = Math.min(room - 1, 14);
      const w = box.w * 0.86;
      g.roundRect(box.x + (box.w - w) / 2, node.face.y - h - 1, w, h, 3).fill({
        color: 0x0b0b0c,
        alpha: 0.9,
      });
      g.roundRect(box.x + (box.w - w) / 2, node.face.y - h - 1, w, h, 3).stroke(
        {
          width: 1,
          color: 0xe6c68c,
          alpha: 0.7,
        },
      );
      const label = new BitmapText({
        text: "ABILITY",
        style: { fontFamily: "cd-bold", fontSize: h * 0.72 },
      });
      label.tint = 0xf2e2b0;
      label.anchor.set(0.5);
      label.position.set(box.x + box.w / 2, node.face.y - h / 2 - 1);
      this.root.addChild(g, label);
    }
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
