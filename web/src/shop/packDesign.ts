import { kindLabels, type ProductRef } from "./shop";

// The pack drawn in the browser (v0.4.3) for a product with no picture of its own: the 27 the
// pack art script found none for, and every set the weekly booster data job adds later. Its
// colours come from the set's code, so a set always looks the same, tinted by its era; its band
// names the booster type. Pure, so the tests can check it without drawing.

export type PackProduct = Pick<
  ProductRef,
  | "name"
  | "set_code"
  | "set_name"
  | "kind"
  | "booster"
  | "era"
  | "released"
  | "art"
  | "symbol"
>;
export type Era = ProductRef["era"];

/** FNV-1a, 32 bits: the same set code always gives the same number. */
export function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export type EraStyle = {
  /** Saturation and lightness of the pack's body, in %. */
  saturation: number;
  lightness: number;
  /** The frame, the medallion's ring and the symbol. */
  accent: string;
  /** The crimps' metal. */
  crimp: [string, string];
  texture:
    "hatch" | "speckle" | "pinstripe" | "burst" | "lattice" | "sheen" | "bands";
  /** The old packs' oval, or the round medallion of the later ones. */
  medallion: "oval" | "round";
};

export const eraStyles: Record<Era, EraStyle> = {
  first: {
    saturation: 28,
    lightness: 30,
    accent: "#d8b56a",
    crimp: ["#d9cfb8", "#8f8470"],
    texture: "hatch",
    medallion: "oval",
  },
  oldborder: {
    saturation: 38,
    lightness: 28,
    accent: "#c9a24a",
    crimp: ["#d5d0c4", "#7d776b"],
    texture: "speckle",
    medallion: "oval",
  },
  modern: {
    saturation: 44,
    lightness: 27,
    accent: "#cfd8e0",
    crimp: ["#e1e6ea", "#7b858c"],
    texture: "pinstripe",
    medallion: "round",
  },
  mythic: {
    saturation: 52,
    lightness: 26,
    accent: "#f0a548",
    crimp: ["#e4dccb", "#7f7564"],
    texture: "burst",
    medallion: "round",
  },
  frame15: {
    saturation: 55,
    lightness: 29,
    accent: "#e8c25a",
    crimp: ["#e8e3d6", "#857d6b"],
    texture: "lattice",
    medallion: "round",
  },
  collector: {
    saturation: 60,
    lightness: 27,
    accent: "#f2d27a",
    crimp: ["#efe9da", "#8a816c"],
    texture: "sheen",
    medallion: "round",
  },
  play: {
    saturation: 64,
    lightness: 33,
    accent: "#fff3d6",
    crimp: ["#f3efe6", "#8c8679"],
    texture: "bands",
    medallion: "round",
  },
};

export type Palette = {
  body: string;
  deep: string;
  light: string;
  accent: string;
  crimp: [string, string];
};

/** The set's colours: a hue from its code, saturation and lightness from its era. */
export function paletteOf(setCode: string, era: Era): Palette {
  const style = eraStyles[era] ?? eraStyles.play;
  const hue = hashOf(setCode.toUpperCase()) % 360;
  const { saturation: s, lightness: l } = style;
  return {
    body: `hsl(${hue} ${s}% ${l}%)`,
    deep: `hsl(${(hue + 18) % 360} ${s}% ${Math.max(8, l - 17)}%)`,
    light: `hsl(${(hue + 330) % 360} ${Math.min(90, s + 10)}% ${l + 22}%)`,
    accent: style.accent,
    crimp: style.crimp,
  };
}

const MANA: Record<string, string> = {
  W: "#e9dfbd",
  U: "#2f6fb3",
  B: "#2e2a2b",
  R: "#b8382c",
  G: "#2f7d45",
};
const COLOUR_WORDS: Record<string, string> = {
  w: "W",
  u: "U",
  b: "B",
  r: "R",
  g: "G",
  azorius: "WU",
  dimir: "UB",
  rakdos: "BR",
  gruul: "RG",
  selesnya: "GW",
  orzhov: "WB",
  izzet: "UR",
  golgari: "BG",
  boros: "RW",
  simic: "GU",
};
const COLOUR_NAMES: Record<string, string> = {
  W: "White",
  U: "Blue",
  B: "Black",
  R: "Red",
  G: "Green",
};

const BAND: Record<string, string> = {
  booster: "#8a6a2a",
  draft: "#a8352b",
  set: "#2a8580",
  collector: "#141414",
  play: "#5f3aa8",
  jumpstart: "#d0701c",
  theme: "#555c66",
  six: "#59616b",
  starter: "#3b7650",
  tournament: "#2b5687",
  special: "#7a2f6e",
};

export type Band = {
  label: string;
  /** One colour, or two for a guild's theme booster. */
  colours: string[];
  text: string;
};

/** The booster type's band: its words from the product's own name where it can, else the type. */
export function bandOf(product: PackProduct): Band {
  let label = kindLabels[product.kind] ?? "Booster";
  const name = product.name.trim();
  if (name.toLowerCase().startsWith(product.set_name.toLowerCase())) {
    const rest = name
      .slice(product.set_name.length)
      .replace(/^[\s:–—-]+/, "")
      .replace(/\bBooster Pack$/i, "Booster")
      .trim();
    if (rest) label = rest;
  }
  let colours = [BAND[product.kind] ?? BAND.booster];
  if (product.booster.startsWith("theme-")) {
    const word = product.booster.slice("theme-".length);
    const letters = COLOUR_WORDS[word];
    if (letters) {
      colours = [...letters].map((letter) => MANA[letter]);
      if (letters.length === 1 && !/white|blue|black|red|green/i.test(label))
        label = `${label} · ${COLOUR_NAMES[letters]}`;
    }
  }
  const text =
    product.kind === "collector"
      ? "#f2d27a"
      : colours.length === 1 && colours[0] === MANA.W
        ? "#2a2418"
        : "#fdf6e6";
  return { label, colours, text };
}

/**
 * The set's name in at most three lines of about `width` characters, and the font size (in the
 * drawing's units) they fit at.
 */
export function linesOf(
  text: string,
  width = 13,
): { lines: string[]; size: number } {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  for (const word of words) {
    const last = lines.length - 1;
    if (last >= 0 && `${lines[last]} ${word}`.length <= width)
      lines[last] = `${lines[last]} ${word}`;
    else lines.push(word);
  }
  // More than three lines: the rest joins the third, which is then squeezed to fit.
  if (lines.length > 3) lines.splice(2, lines.length, lines.slice(2).join(" "));
  const longest = Math.max(...lines.map((line) => line.length));
  const size = longest <= 8 ? 15 : longest <= 11 ? 13 : 11;
  return { lines, size };
}
