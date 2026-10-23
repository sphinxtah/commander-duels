import { useId, type ReactNode } from "react";
import type { BadgeGroup } from "./records";
import styles from "./records.module.css";

// The achievements' badges (v0.5.0), until the owner's own art: a medallion drawn from
// gradients, gold once earned and dark iron before, with its group's emblem struck in the middle,
// so the groups tell apart without their colour. The words beside it name the achievement.

// White, blue, black, red and green, in the colour pie's order (as the tiers' crests have them).
const fiveColors = ["#f9f1c4", "#3d8fd6", "#4b3c4f", "#e2453c", "#2e9b5c"];

const emblems: Record<BadgeGroup, ReactNode> = {
  // A star.
  victories: (
    <path d="M32 16 L35.8 27 L47.2 27.2 L38.1 34.1 L41.4 45 L32 38.5 L22.6 45 L25.9 34.1 L16.8 27.2 L28.2 27 Z" />
  ),
  // A crown.
  commander: <path d="M19 42 L17 24 L25 31 L32 19 L39 31 L47 24 L45 42 Z" />,
  // A column.
  legacy: (
    <path d="M21 19 H43 V23 H39 V41 H43 V45 H21 V41 H25 V23 H21 Z M29 23 V41 H31 V23 Z M33 23 V41 H35 V23 Z" />
  ),
  colours: (
    <>
      {fiveColors.map((color, index) => {
        const angle = -Math.PI / 2 + (index * 2 * Math.PI) / 5;
        return (
          <circle
            key={color}
            cx={32 + Math.cos(angle) * 9}
            cy={32 + Math.sin(angle) * 9}
            r="4.6"
            fill={color}
            stroke="#00000066"
          />
        );
      })}
    </>
  ),
  // A gear.
  bots: (
    <path
      fillRule="evenodd"
      d="M29.5 16 H34.5 L35.4 20.6 L39.2 22.2 L43.1 19.5 L46.5 22.9 L43.8 26.8 L45.4 30.6 L50 31.5 V36.5 L45.4 37.4 L43.8 41.2 L46.5 45.1 L43.1 48.5 L39.2 45.8 L35.4 47.4 L34.5 52 H29.5 L28.6 47.4 L24.8 45.8 L20.9 48.5 L17.5 45.1 L20.2 41.2 L18.6 37.4 L14 36.5 V31.5 L18.6 30.6 L20.2 26.8 L17.5 22.9 L20.9 19.5 L24.8 22.2 L28.6 20.6 Z M38 34 A6 6 0 1 0 26 34 A6 6 0 1 0 38 34 Z"
      transform="translate(0 -2)"
    />
  ),
  // Two players facing each other.
  players: (
    <>
      <circle cx="24" cy="25" r="5" />
      <circle cx="40" cy="25" r="5" />
      <path d="M14 44 C14 35 34 35 34 44 Z M30 44 C30 35 50 35 50 44 Z" />
    </>
  ),
  // A pennant on its staff.
  quests: <path d="M23 16 H26 V48 H23 Z M26 17 L46 24 L26 31 Z" />,
  // A card with a gem.
  shop: (
    <path
      fillRule="evenodd"
      d="M23 16 H41 A2 2 0 0 1 43 18 V46 A2 2 0 0 1 41 48 H23 A2 2 0 0 1 21 46 V18 A2 2 0 0 1 23 16 Z M32 24 L38 32 L32 40 L26 32 Z"
    />
  ),
  // Two rings joined.
  friends: (
    <path
      fill="none"
      strokeWidth="4"
      d="M27 32 m-9 0 a9 9 0 1 0 18 0 a9 9 0 1 0 -18 0 M37 32 m-9 0 a9 9 0 1 0 18 0 a9 9 0 1 0 -18 0"
    />
  ),
};

export function Badge({
  group,
  earned,
  size = 56,
  label,
}: {
  group: BadgeGroup;
  earned: boolean;
  size?: number;
  /** Shown to screen readers; beside words that name it already, leave it out. */
  label?: string;
}) {
  const id = `badge-${group}${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ink = earned ? "#3d2a0c" : "#6f7d77";
  return (
    <svg
      className={styles.badge}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      data-earned={earned || undefined}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <defs>
        <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="1" y2="1">
          {(earned
            ? ["#fff4c2", "#e0b13f", "#8f6110", "#e0b13f", "#6e4a0c"]
            : ["#6b7a75", "#3a4744", "#1d2826", "#3a4744", "#141c1b"]
          ).map((color, index) => (
            <stop key={index} offset={index / 4} stopColor={color} />
          ))}
        </linearGradient>
        <radialGradient id={`${id}-face`} cx="0.4" cy="0.32" r="0.8">
          <stop
            offset="0"
            stopColor={earned ? "#fbe7ae" : "#3f4d49"}
          />
          <stop
            offset="1"
            stopColor={earned ? "#c18b35" : "#1a2423"}
          />
        </radialGradient>
      </defs>
      <circle cx="32" cy="32" r="30" fill={`url(#${id}-rim)`} />
      <circle
        cx="32"
        cy="32"
        r="24.5"
        fill={`url(#${id}-face)`}
        stroke="#00000059"
        strokeWidth="1.2"
      />
      <g fill={ink} stroke={ink}>
        {emblems[group]}
      </g>
    </svg>
  );
}
