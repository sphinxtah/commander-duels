import { manaSymbols } from "../model";
import { mulberry32 } from "../table/sigil";
import type { CardView } from "../types";

// The table's own art, generated on canvases when the scene starts (design §11): the scratched
// stone, the red band, the card back, the glows and the crack over a lost player's sigil, and
// the text frame drawn under every card face. Nothing is a picture from Magic Duels or Wizards:
// the layout and the shapes follow the screenshots, the art is ours. These are 2D canvases the
// scene wraps as textures; a lost WebGL context re-uploads them, since they stay in memory.

export const FONT = `Inter, "Segoe UI", sans-serif`;

export function canvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

function context(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("No 2D canvas for the table's art.");
  return ctx;
}

/** A small tile of grey noise, repeated at two scales for the stone's grain and mottling. */
function noiseTile(size: number, random: () => number): HTMLCanvasElement {
  const tile = canvas(size, size);
  const ctx = context(tile);
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const v = 96 + random() * 64;
    image.data[i] = v;
    image.data[i + 1] = v;
    image.data[i + 2] = v + 2;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return tile;
}

/**
 * The tabletop: grey, scratched stone, lighter where the light falls on the middle and darker
 * towards the rims. It is drawn flat; the scene lays it on the table plane in perspective, so its
 * grain and scratches shrink away from the player as Magic Duels' table did.
 */
export function stone(
  width = 2048,
  height = 1152,
  seed = 7,
): HTMLCanvasElement {
  const random = mulberry32(seed);
  const c = canvas(width, height);
  const ctx = context(c);
  const base = ctx.createLinearGradient(0, 0, 0, height);
  base.addColorStop(0, "#5f6362");
  base.addColorStop(0.5, "#6d7170");
  base.addColorStop(1, "#5b5f5e");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);

  // Grain at two scales: fine speckle and broad, soft mottling.
  const tile = noiseTile(256, random);
  ctx.globalCompositeOperation = "overlay";
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = ctx.createPattern(tile, "repeat")!;
  ctx.fillRect(0, 0, width, height);
  ctx.globalAlpha = 0.45;
  ctx.imageSmoothingEnabled = true;
  for (let y = 0; y < height; y += 256 * 6)
    for (let x = 0; x < width; x += 256 * 6)
      ctx.drawImage(tile, x, y, 256 * 6, 256 * 6);
  ctx.globalCompositeOperation = "source-over";

  // Worn patches: darker and lighter blotches, very faint.
  for (let i = 0; i < 26; i++) {
    const x = random() * width;
    const y = random() * height;
    const r = 60 + random() * 260;
    const patch = ctx.createRadialGradient(x, y, 0, x, y, r);
    const dark = random() < 0.6;
    patch.addColorStop(
      0,
      dark ? "rgba(20,22,22,0.16)" : "rgba(255,255,250,0.06)",
    );
    patch.addColorStop(1, "rgba(0,0,0,0)");
    ctx.globalAlpha = 1;
    ctx.fillStyle = patch;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Scratches: short, slightly bent strokes, a light edge beside a dark cut.
  ctx.lineCap = "round";
  for (let i = 0; i < 900; i++) {
    const x = random() * width;
    const y = random() * height;
    const angle = random() * Math.PI;
    const length = 12 + random() ** 2 * 170;
    const bend = (random() - 0.5) * length * 0.25;
    const dx = Math.cos(angle) * length;
    const dy = Math.sin(angle) * length;
    const light = random() < 0.45;
    ctx.strokeStyle = light ? "#f4f2ea" : "#141616";
    ctx.globalAlpha = (light ? 0.05 : 0.08) + random() * 0.08;
    ctx.lineWidth = 0.6 + random() * 1.4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(
      x + dx / 2 - (dy / length) * bend,
      y + dy / 2 + (dx / length) * bend,
      x + dx,
      y + dy,
    );
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Light on the middle of the table, falling off to the rims.
  const vignette = ctx.createRadialGradient(
    width / 2,
    height * 0.55,
    height * 0.15,
    width / 2,
    height * 0.55,
    width * 0.62,
  );
  vignette.addColorStop(0, "rgba(255,255,248,0.07)");
  vignette.addColorStop(0.55, "rgba(0,0,0,0)");
  vignette.addColorStop(1, "rgba(0,0,0,0.5)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);
  return c;
}

/**
 * The red band across the middle of the table, as a narrow strip the scene stretches sideways: a
 * red gradient with dark edges and thin gold highlights. `height` is in device pixels for the
 * band's 44 stage units.
 */
export function bandStrip(height: number): HTMLCanvasElement {
  const c = canvas(4, height);
  const ctx = context(c);
  const unit = height / 44;
  const red = ctx.createLinearGradient(0, 0, 0, height);
  red.addColorStop(0, "#6e0f12");
  red.addColorStop(0.5, "#a3161b");
  red.addColorStop(1, "#6e0f12");
  ctx.fillStyle = red;
  ctx.fillRect(0, 0, 4, height);
  ctx.fillStyle = "#2a0406";
  ctx.fillRect(0, 0, 4, 2 * unit);
  ctx.fillRect(0, height - 2 * unit, 4, 2 * unit);
  ctx.fillStyle = "rgba(226,186,110,0.75)";
  ctx.fillRect(0, 2 * unit, 4, Math.max(1, unit));
  ctx.fillStyle = "rgba(226,186,110,0.35)";
  ctx.fillRect(0, height - 3 * unit, 4, Math.max(1, unit));
  return c;
}

/**
 * Our card back: a dark lattice with a gold edge and the site's wordless mark in the middle (drawn
 * once the mark's image has loaded; the lattice alone until then). It stands in for every hidden
 * card, so a face-down card never asks for an image.
 */
export function cardBack(
  width: number,
  height: number,
  mark: CanvasImageSource | null,
): HTMLCanvasElement {
  const c = canvas(width, height);
  const ctx = context(c);
  const r = width * 0.045;
  ctx.beginPath();
  ctx.roundRect(0, 0, width, height, r);
  ctx.fillStyle = "#14201f";
  ctx.fill();
  ctx.save();
  ctx.clip();
  // Diagonal stripes, as the DOM's card back draws them.
  ctx.strokeStyle = "#1d2c2d";
  ctx.lineWidth = width * 0.025;
  for (let x = -height; x < width + height; x += width * 0.05) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + height, height);
    ctx.stroke();
  }
  // A faint diamond lattice over them.
  ctx.strokeStyle = "rgba(230,198,140,0.10)";
  ctx.lineWidth = Math.max(1, width * 0.006);
  const step = width * 0.22;
  for (let x = -height; x < width + height; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + height, height);
    ctx.moveTo(x + height, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  if (mark) {
    const w = width * 0.55;
    const size =
      "width" in mark && typeof mark.width === "number" && mark.width > 0
        ? (mark.height as number) / mark.width
        : 1;
    ctx.globalAlpha = 0.8;
    ctx.drawImage(mark, (width - w) / 2, (height - w * size) / 2, w, w * size);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
  ctx.lineWidth = Math.max(1.5, width * 0.016);
  ctx.strokeStyle = "rgba(230,198,140,0.55)";
  ctx.beginPath();
  ctx.roundRect(
    ctx.lineWidth / 2,
    ctx.lineWidth / 2,
    width - ctx.lineWidth,
    height - ctx.lineWidth,
    r,
  );
  ctx.stroke();
  return c;
}

/**
 * A glow for the 9-slice drawn behind a card: soft light outside a rectangle and a crisp ring at
 * its edge, clear inside. The card's own picture covers the middle, so a glow never lies over an
 * image. `inset` is the glow's reach in pixels; the 9-slice keeps it at that width.
 */
export function glow(colour: string, inset: number): HTMLCanvasElement {
  const size = inset * 4;
  const c = canvas(size, size);
  const ctx = context(c);
  const edge = inset;
  ctx.shadowColor = colour;
  ctx.shadowBlur = inset * 0.8;
  ctx.fillStyle = colour;
  ctx.globalAlpha = 0.9;
  ctx.fillRect(edge, edge, size - edge * 2, size - edge * 2);
  ctx.fillRect(edge, edge, size - edge * 2, size - edge * 2);
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillRect(edge, edge, size - edge * 2, size - edge * 2);
  ctx.globalCompositeOperation = "source-over";
  // The inner ring, a little brighter, just outside the card's edge.
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1, inset * 0.18);
  ctx.strokeRect(
    edge - ctx.lineWidth / 2,
    edge - ctx.lineWidth / 2,
    size - edge * 2 + ctx.lineWidth,
    size - edge * 2 + ctx.lineWidth,
  );
  return c;
}

/** Cracks across a lost player's sigil: jagged lines from a point off its centre. */
export function crack(size: number, seed = 3): HTMLCanvasElement {
  const random = mulberry32(seed);
  const c = canvas(size, size);
  const ctx = context(c);
  const ox = size * 0.42;
  const oy = size * 0.38;
  ctx.lineJoin = "miter";
  for (let i = 0; i < 7; i++) {
    let angle = (i / 7) * Math.PI * 2 + random() * 0.6;
    let x = ox;
    let y = oy;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const steps = 4 + Math.floor(random() * 4);
    for (let s = 0; s < steps; s++) {
      const length = size * (0.05 + random() * 0.09);
      angle += (random() - 0.5) * 0.9;
      x += Math.cos(angle) * length;
      y += Math.sin(angle) * length;
      ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(0,0,0,0.85)";
    ctx.lineWidth = size * 0.022;
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = size * 0.007;
    ctx.stroke();
  }
  return c;
}

const SYMBOL_COLOURS: Record<string, string> = {
  W: "#f4ecd2",
  U: "#9fc5e8",
  B: "#9d9290",
  R: "#e99d84",
  G: "#9fcf9f",
  C: "#cbc2bf",
};

/** Words wrapped to a width, as many lines as fit. */
function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  width: number,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The text frame under a card's face: its name and cost, type line, rules (when the frame is
 * wide enough to read them) and printed power and toughness, from the engine's view. It shows
 * while the image loads and stays when an image is missing or fails (UI03), as the DOM's frame
 * does. `width` is in device pixels; the height follows a card's proportions.
 */
export function textFrame(card: CardView, width: number): HTMLCanvasElement {
  const height = Math.round(width * 1.3968);
  const c = canvas(width, height);
  const ctx = context(c);
  const pad = width * 0.06;
  const r = width * 0.045;
  const back = ctx.createLinearGradient(0, 0, 0, height);
  back.addColorStop(0, "#2a3633");
  back.addColorStop(1, "#1d2826");
  ctx.beginPath();
  ctx.roundRect(0, 0, width, height, r);
  ctx.fillStyle = back;
  ctx.fill();
  ctx.lineWidth = Math.max(1, width * 0.012);
  ctx.strokeStyle = "rgba(124,139,134,0.55)";
  ctx.stroke();

  ctx.textBaseline = "top";
  const nameSize = width * 0.1;
  ctx.font = `600 ${nameSize}px ${FONT}`;
  ctx.fillStyle = "#eef0ea";
  // The cost at the right of the name line, as small coloured discs.
  const symbols = manaSymbols(card.mana_cost);
  const disc = nameSize * 0.92;
  let x = width - pad;
  for (const symbol of [...symbols].reverse()) {
    x -= disc;
    const key = symbol.replace("/P", "").split("/")[0];
    ctx.beginPath();
    ctx.arc(x + disc / 2, pad + disc / 2, disc / 2, 0, Math.PI * 2);
    ctx.fillStyle = SYMBOL_COLOURS[key] ?? "#cbc2bf";
    ctx.fill();
    ctx.fillStyle = "#151a19";
    ctx.font = `700 ${disc * 0.62}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(
      symbol.replace("/P", "").replace("/", ""),
      x + disc / 2,
      pad + disc * 0.2,
    );
    ctx.textAlign = "left";
    x -= disc * 0.08;
  }
  ctx.font = `600 ${nameSize}px ${FONT}`;
  ctx.fillStyle = "#eef0ea";
  const nameRoom = x - pad - width * 0.02;
  let name = card.name ?? "";
  while (name.length > 1 && ctx.measureText(name).width > nameRoom)
    name = name.slice(0, -2) + "…";
  ctx.fillText(name, pad, pad);

  const typeSize = width * 0.075;
  let y = pad + nameSize * 1.5;
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = Math.max(1, width * 0.006);
  ctx.beginPath();
  ctx.moveTo(pad, y);
  ctx.lineTo(width - pad, y);
  ctx.stroke();
  y += typeSize * 0.45;
  ctx.font = `${typeSize}px ${FONT}`;
  ctx.fillStyle = "#c5cfc9";
  for (const line of wrap(ctx, card.type_line ?? "", width - pad * 2).slice(
    0,
    2,
  )) {
    ctx.fillText(line, pad, y);
    y += typeSize * 1.2;
  }

  // Rules only where they can be read: from 240 device pixels wide.
  const ptRoom = card.power !== null ? width * 0.16 : 0;
  if (width >= 240) {
    const rulesSize = width * 0.068;
    ctx.font = `${rulesSize}px ${FONT}`;
    ctx.fillStyle = "#d9dfda";
    y += rulesSize * 0.5;
    const bottom = height - pad - ptRoom;
    outer: for (const rule of card.rules)
      for (const line of wrap(ctx, rule, width - pad * 2)) {
        if (y + rulesSize > bottom) break outer;
        ctx.fillText(line, pad, y);
        y += rulesSize * 1.22;
      }
  }

  if (card.power !== null) {
    const text = `${card.power}/${card.toughness}`;
    const size = width * 0.09;
    ctx.font = `700 ${size}px ${FONT}`;
    const w = ctx.measureText(text).width + size * 0.6;
    const h = size * 1.35;
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.beginPath();
    ctx.roundRect(width - pad - w, height - pad - h, w, h, size * 0.2);
    ctx.fill();
    ctx.fillStyle = "#eef0ea";
    ctx.fillText(
      text,
      width - pad - w + size * 0.3,
      height - pad - h + size * 0.2,
    );
  }
  return c;
}
