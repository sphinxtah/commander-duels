import type { ReactNode } from "react";
import type { SigilLayer, SigilSpec } from "./sigil";

// A player's sigil as SVG: the portrait the dom painter draws, and the preview in Settings. The
// PixiJS scene draws the same spec on its canvas. Shapes are drawn in a 2 × 2 box centred on the
// origin, with attributes only: the CSP allows no style markup.

const TURN = 2 * Math.PI;

function point(radius: number, angle: number): [number, number] {
  return [radius * Math.sin(angle), -radius * Math.cos(angle)];
}

function layer(
  { shape, radius, width, turn }: SigilLayer,
  n: number,
  key: number,
): ReactNode {
  const angles = Array.from({ length: n }, (_, i) => (turn + i / n) * TURN);
  const stroke = { strokeWidth: width, fill: "none" } as const;
  switch (shape) {
    case "ring":
      return <circle key={key} r={radius} {...stroke} />;
    case "ray":
      return (
        <g key={key} {...stroke}>
          {angles.map((a, i) => {
            const [x1, y1] = point(radius * 0.35, a);
            const [x2, y2] = point(radius, a);
            return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} />;
          })}
        </g>
      );
    case "petal":
      return (
        <g key={key} {...stroke}>
          {angles.map((a, i) => (
            <ellipse
              key={i}
              cx={0}
              cy={-radius / 2}
              rx={Math.max(0.05, radius * 0.18)}
              ry={radius / 2}
              transform={`rotate(${(a * 180) / Math.PI})`}
            />
          ))}
        </g>
      );
    case "polygon":
      return (
        <polygon
          key={key}
          points={angles.map((a) => point(radius, a).join(",")).join(" ")}
          {...stroke}
        />
      );
    case "dots":
      return (
        <g key={key} stroke="none">
          {angles.map((a, i) => {
            const [cx, cy] = point(radius, a);
            return (
              <circle
                key={i}
                cx={cx}
                cy={cy}
                r={Math.max(0.03, width)}
                fill="currentColor"
              />
            );
          })}
        </g>
      );
  }
}

export function SigilSvg({ spec, size }: { spec: SigilSpec; size: number }) {
  // Opponents' sigils are grey, as Magic Duels drew their portraits; yours keeps its colour.
  const ink = spec.grey ? "hsl(0 0% 74%)" : `hsl(${spec.hue} 72% 64%)`;
  const ground = spec.grey ? "hsl(0 0% 12%)" : `hsl(${spec.hue} 40% 12%)`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="-1 -1 2 2"
      aria-hidden="true"
      focusable="false"
      color={ink}
      stroke="currentColor"
      strokeLinecap="round"
      data-sigil={spec.grey ? "grey" : "colour"}
    >
      <rect x={-1} y={-1} width={2} height={2} fill={ground} stroke="none" />
      {spec.layers.map((l, i) => layer(l, spec.symmetry, i))}
    </svg>
  );
}
