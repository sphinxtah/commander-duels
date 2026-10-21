import { useId } from "react";
import type { TierId } from "../api";
import { tierNames, tierOrder } from "./alliance";
import styles from "./alliance.module.css";

// The tiers' badges until the owner's own arrive (v0.3.1): metal crests, as the owner chose. A
// shield per tier in bronze, silver, gold and platinum metal, Mythic in the mythic rarity's
// orange-red and Godlike prismatic in Magic's five colours. Each is drawn from gradients, so it
// stays sharp from 24 to 128 pixels; the emblem tells the tiers apart without their colour too:
// one to four chevrons for the metals, an eight-pointed star for Mythic, five pips for Godlike.

type Metal = { hi: string; mid: string; lo: string; deep: string };
const metals: Record<TierId, Metal> = {
  bronze: { hi: "#f6c99a", mid: "#c27a3e", lo: "#6e3a19", deep: "#40200b" },
  silver: { hi: "#ffffff", mid: "#c3c9cf", lo: "#6f7880", deep: "#353c42" },
  gold: { hi: "#fff4c2", mid: "#e0b13f", lo: "#8f6110", deep: "#4f3304" },
  platinum: { hi: "#f5fdff", mid: "#a9cbd8", lo: "#577785", deep: "#263e49" },
  mythic: { hi: "#ffd6a0", mid: "#ee6a26", lo: "#a3281a", deep: "#4f1008" },
  godlike: { hi: "#ffffff", mid: "#d9d2ee", lo: "#4b3f63", deep: "#1b1428" },
};
// White, blue, black, red and green, in the colour pie's order.
const fiveColors = ["#f9f1c4", "#3d8fd6", "#4b3c4f", "#e2453c", "#2e9b5c"];

const SHIELD =
  "M32 2.5 L59 10.5 V34 C59 51.5 47.5 63.5 32 70 C16.5 63.5 5 51.5 5 34 V10.5 Z";
const FACE =
  "M32 9 L53 15.2 V34.5 C53 48 44.2 57.6 32 62.8 C19.8 57.6 11 48 11 34.5 V15.2 Z";
const SHEEN = "M5 10.5 L32 2.5 L59 10.5 V22 C44 28 22 21 5 29 Z";
// A Planeswalker's spark: four long points, and for Mythic and Godlike four short ones between.
const SPARK = "M32 17 L35 27 L45 30 L35 33 L32 43 L29 33 L19 30 L29 27 Z";
const STAR =
  "M32 15 L34.6 25.2 L41.5 20.5 L36.8 27.4 L47 30 L36.8 32.6 L41.5 39.5 L34.6 34.8 L32 45 L29.4 34.8 L22.5 39.5 L27.2 32.6 L17 30 L27.2 27.4 L22.5 20.5 L29.4 25.2 Z";

/** Chevrons under the spark: one for Bronze up to four for Platinum, narrowing with the shield. */
function chevrons(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const y = 45.5 + index * 3.6;
    const half = 8 - index * 1;
    return `M${32 - half} ${y} L32 ${y + 3.4} L${32 + half} ${y}`;
  });
}

/** Five pips in a ring around the spark, one per colour, starting with white at the top. */
function pips(): { x: number; y: number; color: string }[] {
  return fiveColors.map((color, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / 5;
    return {
      x: 32 + Math.cos(angle) * 16.5,
      y: 30 + Math.sin(angle) * 16.5,
      color,
    };
  });
}

export function tierLabel(tier: TierId): string {
  return `${tierNames[tier]} tier`;
}

export function TierBadge({
  tier,
  size = 48,
  decorative = false,
  className,
}: {
  tier: TierId;
  /** Its width in CSS pixels; the crest is a little taller than it is wide. */
  size?: number;
  /** Beside words that already name the tier, the crest is hidden from screen readers. */
  decorative?: boolean;
  className?: string;
}) {
  // Every crest on a page has gradients of its own: an ID shared by two would draw one crest's
  // metal on the other. The tier is part of it too, so crests drawn in separate React roots,
  // whose useId may repeat, still never borrow another tier's metal. useId's punctuation is not
  // safe inside url(#…).
  const id = `crest-${tier}${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const metal = metals[tier];
  const rank = tierOrder.indexOf(tier);
  const prismatic = tier === "godlike";
  const stops = (colors: string[]) =>
    colors.map((color, index) => (
      <stop
        key={index}
        offset={colors.length === 1 ? 0 : index / (colors.length - 1)}
        stopColor={color}
      />
    ));
  return (
    <svg
      className={[styles.crest, className].filter(Boolean).join(" ")}
      viewBox="0 0 64 72"
      width={size}
      height={(size * 72) / 64}
      data-tier={tier}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : tierLabel(tier)}
      aria-hidden={decorative || undefined}
      focusable="false"
    >
      <defs>
        {/* Prismatic runs across the crest, so all five colours show on its rim; metal runs
            from the light at the top left. */}
        <linearGradient
          id={`${id}-metal`}
          x1="0"
          y1="0"
          x2="1"
          y2={prismatic ? "0" : "1"}
        >
          {stops(
            prismatic
              ? fiveColors
              : [metal.hi, metal.mid, metal.lo, metal.mid, metal.lo],
          )}
        </linearGradient>
        <linearGradient
          id={`${id}-face`}
          x1={prismatic ? "0" : "1"}
          y1="0"
          x2="0"
          y2="1"
        >
          {stops(prismatic ? fiveColors : [metal.mid, metal.lo, metal.deep])}
        </linearGradient>
        <linearGradient id={`${id}-relief`} x1="0" y1="0" x2="0" y2="1">
          {stops([metal.hi, metal.mid])}
        </linearGradient>
        <linearGradient id={`${id}-sheen`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* The rim: metal, edged in the page's own dark so it reads on light ground too. */}
      <path
        d={SHIELD}
        fill={`url(#${id}-metal)`}
        className={styles.crestEdge}
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      {/* The face, sunk below the rim, its bevel catching the light. */}
      <path
        d={FACE}
        fill={`url(#${id}-face)`}
        stroke={metal.hi}
        strokeOpacity="0.75"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      {prismatic && (
        // A dark veil keeps the white spark and the pips readable over the five colours.
        <path d={FACE} fill={metal.deep} fillOpacity="0.45" />
      )}
      <path d={SHEEN} fill={`url(#${id}-sheen)`} />
      <path
        d={tier === "mythic" ? STAR : SPARK}
        fill={`url(#${id}-relief)`}
        stroke={metal.deep}
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      {rank < 4 &&
        chevrons(rank + 1).map((d, index) => (
          <g
            key={index}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d={d} stroke={metal.deep} strokeWidth="3.4" />
            <path d={d} stroke={metal.hi} strokeWidth="1.6" />
          </g>
        ))}
      {prismatic &&
        pips().map((pip) => (
          <circle
            key={pip.color}
            cx={pip.x}
            cy={pip.y}
            r="3.2"
            fill={pip.color}
            stroke={metal.hi}
            strokeWidth="1.1"
          />
        ))}
    </svg>
  );
}
