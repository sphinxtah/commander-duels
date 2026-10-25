import { useId, useState, type CSSProperties, type ReactNode } from "react";
import {
  bandOf,
  eraStyles,
  linesOf,
  paletteOf,
  type EraStyle,
  type PackProduct,
} from "./packDesign";
import styles from "./shop.module.css";

// The picture of a product's sealed pack (v0.4.3): the real pack's, copied once from TCGplayer
// or Wizards of the Coast and served from this site (content/pack-art.json), or, for a product
// with none and when the picture fails to load, a pack drawn here from its set: a crimped pack
// in the set's colours and its era's texture, the set's name and symbol, and a band naming the
// booster type. Sized in rem, so Larger text enlarges it; nothing in it moves.

/** The drawing's size, in its own units: a pack three fifths as wide as it is tall. */
const W = 120;
const H = 200;
const LEFT = 4;
const RIGHT = W - 4;

type Props = {
  product: PackProduct;
  /** How tall it stands, in rem. */
  height: number;
  /** The picture to prefer: the shelf's 160-pixel one, or the counter's 480-pixel one. */
  size?: "small" | "large";
  /** Its accessible name where it stands alone; left out where the product's name is beside
   * it, which makes it decorative. */
  label?: string;
  className?: string;
};

export function PackArt({
  product,
  height,
  size = "small",
  label,
  className,
}: Props) {
  const [failed, setFailed] = useState(false);
  const art = product.art;
  const style = { "--pack-h": `${height}rem` } as CSSProperties;
  const classes = `${styles.packArt} ${className ?? ""}`;
  if (art && !failed) {
    const shown = art[size];
    // The width it shows at, for the browser's choice between the two files: a screen with
    // twice the pixels takes the large one on the shelf too.
    const width = Math.round(
      (height * 16 * art.large.width) / art.large.height,
    );
    return (
      <img
        className={classes}
        style={style}
        src={shown.src}
        srcSet={`${art.small.src} ${art.small.width}w, ${art.large.src} ${art.large.width}w`}
        sizes={`${width}px`}
        width={shown.width}
        height={shown.height}
        alt={label ?? ""}
        loading="lazy"
        decoding="async"
        draggable={false}
        data-pack-art="picture"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <DrawnPack
      product={product}
      className={classes}
      style={style}
      label={label}
    />
  );
}

function crimp(top: boolean): string {
  const teeth: string[] = [];
  for (let x = LEFT, up = true; x <= RIGHT; x += 2, up = !up)
    teeth.push(`${x} ${top ? (up ? 2 : 0) : up ? H - 2 : H}`);
  return top
    ? `M${teeth.join(" L")} L${RIGHT} 12 L${LEFT} 12 Z`
    : `M${LEFT} ${H - 12} L${RIGHT} ${H - 12} L${[...teeth].reverse().join(" L")} Z`;
}
const TOP_CRIMP = crimp(true);
const BOTTOM_CRIMP = crimp(false);

/** The era's texture, drawn over the pack's body. */
function texture(kind: EraStyle["texture"], id: string): ReactNode {
  const line = { stroke: "#fff", strokeWidth: 0.5, fill: "none" };
  switch (kind) {
    case "hatch":
      return (
        <pattern id={id} width="6" height="6" patternUnits="userSpaceOnUse">
          <path d="M0 6 L6 0 M0 0 L6 6" {...line} />
        </pattern>
      );
    case "speckle":
      return (
        <pattern id={id} width="9" height="9" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="3" r="0.8" fill="#fff" />
          <circle cx="6.5" cy="7" r="0.55" fill="#fff" />
          <circle cx="7.5" cy="2" r="0.45" fill="#fff" />
        </pattern>
      );
    case "pinstripe":
      return (
        <pattern
          id={id}
          width="4"
          height="4"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(35)"
        >
          <rect width="0.7" height="4" fill="#fff" />
        </pattern>
      );
    case "lattice":
      return (
        <pattern id={id} width="10" height="12" patternUnits="userSpaceOnUse">
          <path d="M5 0 L10 6 L5 12 L0 6 Z" {...line} />
        </pattern>
      );
    case "sheen":
      return (
        <pattern
          id={id}
          width="16"
          height="16"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(-28)"
        >
          <rect width="2" height="16" fill="#fff" />
          <rect x="5" width="5" height="16" fill="#fff" opacity="0.5" />
        </pattern>
      );
    case "bands":
      return (
        <pattern
          id={id}
          width="44"
          height="44"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(-24)"
        >
          <rect width="16" height="44" fill="#fff" />
        </pattern>
      );
    default:
      return null;
  }
}

/** The rays behind the mythic era's medallion. */
function rays(cx: number, cy: number): string {
  const parts: string[] = [];
  for (let index = 0; index < 18; index += 1) {
    const a = (index / 18) * Math.PI * 2;
    const b = a + Math.PI / 36;
    const far = 140;
    parts.push(
      `M${cx} ${cy} L${(cx + Math.cos(a) * far).toFixed(1)} ${(cy + Math.sin(a) * far).toFixed(1)} L${(cx + Math.cos(b) * far).toFixed(1)} ${(cy + Math.sin(b) * far).toFixed(1)} Z`,
    );
  }
  return parts.join(" ");
}

function DrawnPack({
  product,
  className,
  style,
  label,
}: {
  product: PackProduct;
  className: string;
  style: CSSProperties;
  label?: string;
}) {
  const id = `pack${useId().replace(/[^\w-]/g, "")}`;
  const era = eraStyles[product.era] ? product.era : "play";
  const look = eraStyles[era];
  const colours = paletteOf(product.set_code, era);
  const band = bandOf(product);
  const { lines, size } = linesOf(product.set_name);
  const year = product.released?.slice(0, 4);
  const cy = 104;
  const nameTop = 33 + (3 - lines.length) * size * 0.45;
  const bandLabel = band.label.toUpperCase();
  const bandSize = bandLabel.length > 22 ? 6 : bandLabel.length > 16 ? 7 : 8;
  return (
    <svg
      className={className}
      style={style}
      viewBox={`0 0 ${W} ${H}`}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      data-pack-art="drawn"
    >
      {label && <title>{label}</title>}
      <defs>
        <linearGradient id={`${id}-body`} x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0" stopColor={colours.light} />
          <stop offset="0.45" stopColor={colours.body} />
          <stop offset="1" stopColor={colours.deep} />
        </linearGradient>
        <linearGradient id={`${id}-side`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#000" stopOpacity="0.45" />
          <stop offset="0.12" stopColor="#000" stopOpacity="0" />
          <stop offset="0.8" stopColor="#fff" stopOpacity="0.06" />
          <stop offset="1" stopColor="#000" stopOpacity="0.45" />
        </linearGradient>
        <linearGradient id={`${id}-crimp`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={look.crimp[1]} />
          <stop offset="0.35" stopColor={look.crimp[0]} />
          <stop offset="0.7" stopColor={look.crimp[1]} />
          <stop offset="1" stopColor={look.crimp[0]} />
        </linearGradient>
        <pattern
          id={`${id}-ridges`}
          width="2.4"
          height="12"
          patternUnits="userSpaceOnUse"
        >
          <rect width="1" height="12" fill="#000" opacity="0.28" />
        </pattern>
        {texture(look.texture, `${id}-texture`)}
        <filter id={`${id}-tint`}>
          <feFlood floodColor={colours.accent} />
          <feComposite in2="SourceAlpha" operator="in" />
        </filter>
        <clipPath id={`${id}-clip`}>
          <rect x={LEFT} y="11" width={RIGHT - LEFT} height={H - 22} />
        </clipPath>
      </defs>

      <path d={TOP_CRIMP} fill={`url(#${id}-crimp)`} />
      <path d={TOP_CRIMP} fill={`url(#${id}-ridges)`} />
      <path d={BOTTOM_CRIMP} fill={`url(#${id}-crimp)`} />
      <path d={BOTTOM_CRIMP} fill={`url(#${id}-ridges)`} />

      <g clipPath={`url(#${id}-clip)`}>
        <rect
          x={LEFT}
          y="11"
          width={RIGHT - LEFT}
          height={H - 22}
          fill={`url(#${id}-body)`}
        />
        {look.texture === "burst" ? (
          <path d={rays(60, cy)} fill="#fff" opacity="0.07" />
        ) : (
          <rect
            x={LEFT}
            y="11"
            width={RIGHT - LEFT}
            height={H - 22}
            fill={`url(#${id}-texture)`}
            opacity={look.texture === "bands" ? 0.08 : 0.14}
          />
        )}
        <rect
          x={LEFT}
          y="11"
          width={RIGHT - LEFT}
          height={H - 22}
          fill={`url(#${id}-side)`}
        />
      </g>

      <rect
        x="10"
        y="17"
        width="100"
        height="166"
        rx={look.medallion === "oval" ? 9 : 3}
        fill="none"
        stroke={colours.accent}
        strokeWidth="1.1"
        opacity="0.75"
      />

      <g
        fontFamily="Georgia, 'Times New Roman', serif"
        fontWeight="700"
        textAnchor="middle"
        fill="#fdf6e6"
        stroke="#000"
        strokeOpacity="0.45"
        strokeWidth="0.6"
        paintOrder="stroke"
      >
        {lines.map((line, index) => (
          <text
            key={index}
            x={W / 2}
            y={nameTop + index * size * 1.08}
            fontSize={size}
            textLength={line.length * size * 0.56 > 92 ? 92 : undefined}
            lengthAdjust="spacingAndGlyphs"
          >
            {line}
          </text>
        ))}
      </g>

      {look.medallion === "oval" ? (
        <ellipse
          cx={W / 2}
          cy={cy}
          rx="28"
          ry="34"
          fill={colours.deep}
          stroke={colours.accent}
          strokeWidth="2"
        />
      ) : (
        <circle
          cx={W / 2}
          cy={cy}
          r="27"
          fill={colours.deep}
          stroke={colours.accent}
          strokeWidth="2"
        />
      )}
      {product.symbol ? (
        <image
          href={product.symbol}
          x={W / 2 - 18}
          y={cy - 18}
          width="36"
          height="36"
          preserveAspectRatio="xMidYMid meet"
          filter={`url(#${id}-tint)`}
        />
      ) : (
        <text
          x={W / 2}
          y={cy + 5}
          fontFamily="Georgia, serif"
          fontWeight="700"
          fontSize={product.set_code.length > 3 ? 11 : 14}
          letterSpacing="1"
          textAnchor="middle"
          fill={colours.accent}
        >
          {product.set_code}
        </text>
      )}

      {band.colours.map((colour, index) => (
        <rect
          key={index}
          x={LEFT + ((RIGHT - LEFT) * index) / band.colours.length}
          y="146"
          width={(RIGHT - LEFT) / band.colours.length}
          height="18"
          fill={colour}
        />
      ))}
      <rect
        x={LEFT}
        y="146"
        width={RIGHT - LEFT}
        height="18"
        fill="none"
        stroke={colours.accent}
        strokeWidth="0.6"
        opacity="0.8"
      />
      <text
        x={W / 2}
        y={155 + bandSize * 0.36}
        fontFamily="Inter, 'Segoe UI', sans-serif"
        fontWeight="700"
        fontSize={bandSize}
        letterSpacing="0.6"
        textAnchor="middle"
        fill={band.text}
        stroke={band.colours.length > 1 ? "#000" : undefined}
        strokeOpacity="0.5"
        strokeWidth="0.5"
        paintOrder="stroke"
        textLength={bandLabel.length * bandSize * 0.62 > 104 ? 104 : undefined}
        lengthAdjust="spacingAndGlyphs"
      >
        {bandLabel}
      </text>

      <text
        x={W / 2}
        y="177"
        fontFamily="Inter, 'Segoe UI', sans-serif"
        fontSize="6.5"
        letterSpacing="1.4"
        textAnchor="middle"
        fill="#fdf6e6"
        opacity="0.75"
      >
        {year ? `${product.set_code} · ${year}` : product.set_code}
      </text>
    </svg>
  );
}
