import type { ReactNode } from "react";
import { ruleHref } from "./guide";
import { pieces } from "./rules";
import styles from "./HowToPlay.module.css";

const SYMBOL = /\{([^{}]{1,6})\}/g;

/** "{W}" and friends as small mana pips; anything else as it is. */
function withSymbols(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (let match = SYMBOL.exec(text); match; match = SYMBOL.exec(text)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const symbol = match[1]!;
    out.push(
      <span
        key={`${key}-${match.index}`}
        className={styles.pip}
        data-symbol={symbol.replace("/", "")}
        role="img"
        aria-label={symbolWords(symbol)}
      >
        {symbol === "T" ? "↷" : symbol}
      </span>,
    );
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const NAMES: Record<string, string> = {
  W: "white mana",
  U: "blue mana",
  B: "black mana",
  R: "red mana",
  G: "green mana",
  C: "colourless mana",
  T: "tap",
  Q: "untap",
  X: "X",
};

export function symbolWords(symbol: string): string {
  if (/^\d+$/.test(symbol)) return `${symbol} generic mana`;
  return NAMES[symbol] ?? symbol;
}

/**
 * Text with its mana symbols drawn and its references to official rules linked. With `rules` false
 * (no official text in the build), references stay plain words.
 */
export function RichText({
  text,
  rules = true,
}: {
  text: string;
  rules?: boolean;
}) {
  return (
    <>
      {pieces(text).map((piece, index) =>
        "rule" in piece && rules ? (
          <a key={index} href={ruleHref(piece.rule)} className={styles.ruleRef}>
            {piece.text}
          </a>
        ) : (
          <span key={index}>{withSymbols(piece.text, String(index))}</span>
        ),
      )}
    </>
  );
}
