import { useId } from "react";
import type { Figure } from "./cast";

// The campaign's drawn figures (v0.8.0): the speakers with no portrait of the owner's. The High
// Priest (the Sphinx's administrator, a robed and hooded figure whose staff holds a light of each
// colour), a survivor of the fairground with her lantern, and the Wayfarer, the player without an
// ally, cloaked, the bond's sigil glowing on the chest. Original art, drawn as SVG in the page.

const FIVE = ["#f9f1c4", "#3d8fd6", "#8f6bb0", "#e2453c", "#2e9b5c"];

export function FigureArt({
  figure,
  lights = 5,
  className,
}: {
  figure: Figure;
  /** The High Priest's staff: how many of its five lights still burn. */
  lights?: number;
  className?: string;
}) {
  const id = useId().replace(/:/g, "");
  if (figure === "high-priest")
    return <HighPriest id={id} lights={lights} className={className} />;
  if (figure === "survivor") return <Survivor id={id} className={className} />;
  return <Wayfarer id={id} className={className} />;
}

function HighPriest({
  id,
  lights,
  className,
}: {
  id: string;
  lights: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 400 600"
      role="img"
      aria-label="The High Priest"
      focusable="false"
    >
      <defs>
        <linearGradient id={`${id}robe`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#efe6cf" />
          <stop offset="0.45" stopColor="#bdb08f" />
          <stop offset="1" stopColor="#4a4233" />
        </linearGradient>
        <linearGradient id={`${id}shade`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity="0.55" />
          <stop offset="0.5" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.45" />
        </linearGradient>
        <linearGradient id={`${id}stole`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f4dca6" />
          <stop offset="1" stopColor="#8d6c3c" />
        </linearGradient>
        <radialGradient id={`${id}hood`} cx="0.5" cy="0.55" r="0.5">
          <stop offset="0" stopColor="#05070a" />
          <stop offset="0.7" stopColor="#14171c" />
          <stop offset="1" stopColor="#2a2a2c" />
        </radialGradient>
        <radialGradient id={`${id}glow`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#fff6d6" stopOpacity="0.95" />
          <stop offset="1" stopColor="#f4dca6" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* The staff, held at his right. */}
      <rect x="292" y="70" width="9" height="520" rx="4" fill="#6b5330" />
      <rect
        x="294"
        y="70"
        width="3"
        height="520"
        fill="#b8915a"
        opacity="0.6"
      />
      <circle
        cx="296"
        cy="62"
        r="40"
        fill="none"
        stroke="#d5b77c"
        strokeWidth="5"
      />
      <circle
        cx="296"
        cy="62"
        r="70"
        fill={`url(#${id}glow)`}
        opacity={0.12 + 0.12 * lights}
      />
      {FIVE.map((color, index) => {
        const angle = (-90 + index * 72) * (Math.PI / 180);
        const lit = index < lights;
        return (
          <g key={color}>
            {lit && (
              <circle
                cx={296 + Math.cos(angle) * 40}
                cy={62 + Math.sin(angle) * 40}
                r="17"
                fill={color}
                opacity="0.35"
              />
            )}
            <circle
              cx={296 + Math.cos(angle) * 40}
              cy={62 + Math.sin(angle) * 40}
              r="8"
              fill={lit ? color : "#2b2a2a"}
              stroke="#f4dca6"
              strokeWidth="1.5"
            />
          </g>
        );
      })}
      {/* The robe: wide shoulders falling to the floor. */}
      <path
        d="M200 150 C150 160 110 190 96 250 C80 330 70 470 52 600 L348 600 C330 470 320 330 304 250 C290 190 250 160 200 150 Z"
        fill={`url(#${id}robe)`}
      />
      <path
        d="M200 150 C150 160 110 190 96 250 C80 330 70 470 52 600 L348 600 C330 470 320 330 304 250 C290 190 250 160 200 150 Z"
        fill={`url(#${id}shade)`}
      />
      {/* Folds. */}
      <path
        d="M150 260 C140 360 130 470 118 600 M250 260 C262 360 272 470 284 600 M200 300 V600"
        stroke="#5e5442"
        strokeWidth="3"
        opacity="0.55"
        fill="none"
      />
      {/* The stole, with a gem of each colour. */}
      <path
        d="M172 178 L160 600 L196 600 L194 192 Z"
        fill={`url(#${id}stole)`}
      />
      <path
        d="M228 178 L240 600 L204 600 L206 192 Z"
        fill={`url(#${id}stole)`}
      />
      {FIVE.map((color, index) => (
        <g key={`gem-${color}`}>
          <circle
            cx={178 - index * 1.5}
            cy={260 + index * 62}
            r="7"
            fill={color}
          />
          <circle
            cx={222 + index * 1.5}
            cy={260 + index * 62}
            r="7"
            fill={color}
          />
        </g>
      ))}
      {/* The hand on the staff. */}
      <path
        d="M276 300 C286 288 312 290 314 306 C314 322 290 326 278 318 Z"
        fill="#cdb98f"
      />
      {/* The hood and its shadowed face, with a faint gold gaze. */}
      <path
        d="M200 40 C150 40 122 86 124 146 C126 190 150 214 200 220 C250 214 274 190 276 146 C278 86 250 40 200 40 Z"
        fill="#e7dcc0"
      />
      <path
        d="M200 62 C164 62 146 98 148 144 C150 178 168 196 200 200 C232 196 250 178 252 144 C254 98 236 62 200 62 Z"
        fill={`url(#${id}hood)`}
      />
      <ellipse cx="184" cy="140" rx="7" ry="3" fill="#f4dca6" opacity="0.85" />
      <ellipse cx="216" cy="140" rx="7" ry="3" fill="#f4dca6" opacity="0.85" />
      <path
        d="M200 40 C174 46 160 60 156 76"
        stroke="#fff"
        strokeWidth="3"
        opacity="0.35"
        fill="none"
      />
    </svg>
  );
}

function Survivor({ id, className }: { id: string; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 400 600"
      role="img"
      aria-label="A survivor"
      focusable="false"
    >
      <defs>
        <linearGradient id={`${id}shawl`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6b4a3a" />
          <stop offset="1" stopColor="#2a1c17" />
        </linearGradient>
        <radialGradient id={`${id}lamp`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffd38a" stopOpacity="0.9" />
          <stop offset="1" stopColor="#e9893a" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}lit`} x1="1" y1="0" x2="0" y2="0">
          <stop offset="0" stopColor="#e9893a" stopOpacity="0.45" />
          <stop offset="0.6" stopColor="#e9893a" stopOpacity="0" />
        </linearGradient>
      </defs>
      <circle cx="300" cy="400" r="110" fill={`url(#${id}lamp)`} />
      {/* Body under a shawl, a little bowed. */}
      <path
        d="M196 190 C150 196 120 230 110 290 C98 370 92 480 80 600 L320 600 C312 480 300 370 290 290 C282 236 250 196 196 190 Z"
        fill={`url(#${id}shawl)`}
      />
      <path
        d="M196 190 C150 196 120 230 110 290 C98 370 92 480 80 600 L320 600 C312 480 300 370 290 290 C282 236 250 196 196 190 Z"
        fill={`url(#${id}lit)`}
      />
      <path
        d="M120 300 C170 330 240 330 290 300"
        stroke="#8c6a55"
        strokeWidth="4"
        fill="none"
      />
      {/* Head and scarf. */}
      <circle cx="198" cy="150" r="52" fill="#3a2a22" />
      <path
        d="M150 140 C150 96 180 80 200 80 C224 80 250 98 250 140 C238 120 220 112 200 112 C180 112 162 120 150 140 Z"
        fill="#7a5442"
      />
      <path
        d="M176 150 C176 170 188 186 200 186 C214 186 224 170 224 150 C214 160 188 160 176 150 Z"
        fill="#c99a78"
        opacity="0.8"
      />
      {/* The lantern in her hand. */}
      <path
        d="M268 340 C276 330 296 330 302 342"
        stroke="#3a2a22"
        strokeWidth="6"
        fill="none"
      />
      <rect
        x="276"
        y="352"
        width="44"
        height="64"
        rx="8"
        fill="#2a1c17"
        stroke="#d5b77c"
        strokeWidth="3"
      />
      <rect x="284" y="362" width="28" height="44" rx="5" fill="#ffd38a" />
      <path
        d="M298 370 C292 380 294 392 298 398 C304 390 306 380 298 370 Z"
        fill="#fff4d6"
      />
    </svg>
  );
}

function Wayfarer({ id, className }: { id: string; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 400 600"
      role="img"
      aria-label="The Wayfarer"
      focusable="false"
    >
      <defs>
        <linearGradient id={`${id}cloak`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#24413c" />
          <stop offset="1" stopColor="#0c1716" />
        </linearGradient>
        <radialGradient id={`${id}sigil`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#f4dca6" stopOpacity="1" />
          <stop offset="1" stopColor="#d5b77c" stopOpacity="0" />
        </radialGradient>
      </defs>
      <path
        d="M200 140 C140 150 106 196 96 260 C82 350 74 470 60 600 L340 600 C326 470 318 350 304 260 C294 196 260 150 200 140 Z"
        fill={`url(#${id}cloak)`}
      />
      <path
        d="M150 230 C140 340 132 470 122 600 M252 230 C262 340 270 470 280 600"
        stroke="#3a5d55"
        strokeWidth="3"
        fill="none"
        opacity="0.7"
      />
      <path
        d="M200 36 C150 36 124 84 126 140 C128 184 152 206 200 212 C248 206 272 184 274 140 C276 84 250 36 200 36 Z"
        fill="#1b322e"
      />
      <path
        d="M200 64 C168 64 152 98 154 138 C156 168 172 186 200 190 C228 186 244 168 246 138 C248 98 232 64 200 64 Z"
        fill="#050909"
      />
      <path
        d="M200 36 C176 42 160 56 154 74"
        stroke="#d5b77c"
        strokeWidth="2"
        opacity="0.45"
        fill="none"
      />
      <circle
        cx="200"
        cy="300"
        r="56"
        fill={`url(#${id}sigil)`}
        opacity="0.75"
      />
      <path
        d="M200 268 L207 293 L232 300 L207 307 L200 332 L193 307 L168 300 L193 293 Z"
        fill="#fff6d6"
      />
    </svg>
  );
}
