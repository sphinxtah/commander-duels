import type { SigilSpec } from "../table/sigil";
import { canvas } from "./art";

// A player's sigil painted for the table: the portrait inside each diamond frame. The spec comes
// from sigil.ts, so this picture and the DOM's SVG show the same sigil. It is painted already
// cut to the diamond on a canvas of its own, so the scene needs no mask; opponents' sigils are
// grey, as Magic Duels drew their portraits.

function colour(spec: SigilSpec, lightness: number, alpha = 1): string {
  return spec.grey
    ? `hsla(0, 0%, ${lightness}%, ${alpha})`
    : `hsla(${spec.hue}, 70%, ${lightness}%, ${alpha})`;
}

/** The sigil on a `size`-pixel square canvas, clipped to the diamond inscribed in it. */
export function drawSigil(spec: SigilSpec, size: number): HTMLCanvasElement {
  const c = canvas(size, size);
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  const mid = size / 2;
  ctx.beginPath();
  ctx.moveTo(mid, 0);
  ctx.lineTo(size, mid);
  ctx.lineTo(mid, size);
  ctx.lineTo(0, mid);
  ctx.closePath();
  ctx.clip();

  const ground = ctx.createRadialGradient(mid, mid * 0.8, 0, mid, mid, mid);
  ground.addColorStop(0, colour(spec, spec.grey ? 34 : 26));
  ground.addColorStop(1, colour(spec, spec.grey ? 9 : 7));
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, size, size);

  // The sigil fills the circle inscribed in the diamond.
  const radius = size * 0.34;
  ctx.translate(mid, mid);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  spec.layers.forEach((layer, index) => {
    const r = layer.radius * radius;
    const width = Math.max(1, layer.width * radius);
    const turn = layer.turn * Math.PI * 2;
    const n = spec.symmetry;
    const light = 52 + index * 9;
    ctx.strokeStyle = colour(spec, light, 0.95);
    ctx.fillStyle = colour(spec, light, 0.8);
    ctx.lineWidth = width;
    ctx.shadowColor = colour(spec, 60, 0.6);
    ctx.shadowBlur = width * 2;
    switch (layer.shape) {
      case "ring":
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case "ray":
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const a = turn + (i / n) * Math.PI * 2;
          ctx.moveTo(Math.cos(a) * r * 0.25, Math.sin(a) * r * 0.25);
          ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.stroke();
        break;
      case "petal":
        for (let i = 0; i < n; i++) {
          const a = turn + (i / n) * Math.PI * 2;
          ctx.save();
          ctx.rotate(a);
          ctx.beginPath();
          ctx.ellipse(
            r * 0.55,
            0,
            r * 0.45,
            Math.max(width, r * 0.16),
            0,
            0,
            Math.PI * 2,
          );
          ctx.stroke();
          ctx.restore();
        }
        break;
      case "polygon":
        ctx.beginPath();
        for (let i = 0; i <= n; i++) {
          const a = turn + (i / n) * Math.PI * 2;
          const x = Math.cos(a) * r;
          const y = Math.sin(a) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        break;
      case "dots":
        for (let i = 0; i < n; i++) {
          const a = turn + (i / n) * Math.PI * 2;
          ctx.beginPath();
          ctx.arc(
            Math.cos(a) * r,
            Math.sin(a) * r,
            width * 1.2,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
        break;
    }
  });
  // A bright core, so every sigil has a centre.
  ctx.shadowBlur = radius * 0.3;
  ctx.fillStyle = colour(spec, 82);
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.07, 0, Math.PI * 2);
  ctx.fill();
  return c;
}
