import { useEffect, useState, type CSSProperties } from "react";
import { boxStyle } from "../Board";
import { CardFace, ManaCost, permanentState } from "../Card";
import { imageSizeFor } from "../images";
import { playerName } from "../model";
import type { GameView } from "../types";
import { REGIONS } from "./geometry";
import { useTableContext } from "./TableContext";
import { useTableUi } from "./uiStore";
import type {
  MagnifierProps,
  Rect,
  TableCard,
  TableModel,
  TablePlayer,
} from "./types";
import styles from "./magnifier.module.css";

// The magnifier (v0.3.0, design §13): the card under the pointer, or the one keyboard focus is
// on, drawn large at the side of the table away from it, with what the card is now beside it.
// The pointer decides which card and where (pointer.ts writes `magnified` to the table's store);
// this only draws it. A hand card rises in place instead: the scene draws that, and with the
// DOM painter this draws the risen picture too. Nothing here is announced or takes the pointer:
// screen readers hear the same facts in each card's own name.

/** The png (745 × 1040) only where the large image (672 × 936) would be stretched: a card drawn
 * taller than 983 device pixels, as level 2 is at 1440p and both levels are at 4K. */
export function magnifierImageSize(
  level: 1 | 2,
  k: number,
  dpr: number,
): "large" | "png" {
  const height = REGIONS.magnifier.right[level].card.h;
  return height * k * dpr > 983 ? "png" : "large";
}

/** How long a card must stay magnified before its png is asked for, so a pointer sweeping
 * across the table never downloads a png for every card it crosses. */
export const PNG_DELAY_MS = 250;

export function Magnifier({
  model,
  layout,
  fit,
  view,
  observing,
  painter,
}: MagnifierProps) {
  const { ui } = useTableContext();
  const magnified = useTableUi(ui, (s) => s.magnified);
  const risen = useTableUi(ui, (s) => s.risen);
  const card = magnified ? model.cards.get(magnified.key) : undefined;
  const wanted = magnified
    ? magnifierImageSize(magnified.level, fit.k, fit.dpr)
    : "large";
  // The png waits until the same card has stayed magnified a moment.
  const [pngFor, setPngFor] = useState<string | null>(null);
  const pngKey =
    magnified && card && !card.card.hidden && wanted === "png"
      ? `${magnified.key}|${magnified.level}`
      : null;
  useEffect(() => {
    if (!pngKey) return;
    const timer = window.setTimeout(() => setPngFor(pngKey), PNG_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [pngKey]);

  const risenRect =
    painter === "dom" && risen ? layout.risen.get(risen.key) : undefined;
  const risenCard = risen ? model.cards.get(risen.key) : undefined;

  if (!(magnified && card) && !(risenRect && risenCard)) return null;
  const slot = magnified
    ? layout.regions.magnifier[magnified.side][magnified.level]
    : null;
  return (
    <>
      {risenRect && risenCard && (
        <div
          className={styles.risen}
          aria-hidden="true"
          data-magnifier="risen"
          style={picture(risenRect)}
        >
          <CardFace
            card={risenCard.card}
            size={imageSizeFor(risenRect.h * fit.k * fit.dpr)}
          />
        </div>
      )}
      {magnified && card && slot && (
        <div
          className={styles.magnifier}
          aria-hidden="true"
          data-magnifier={magnified.side}
          data-level={magnified.level}
        >
          <div className={styles.card} style={picture(slot.card)}>
            <CardFace card={card.card} size="large" />
            {pngFor === pngKey && pngKey && (
              <div className={styles.png}>
                <CardFace card={card.card} size="png" />
              </div>
            )}
          </div>
          <div className={styles.panel} style={boxStyle(slot.panel)}>
            <Facts
              card={card}
              model={model}
              view={view}
              observing={observing}
            />
          </div>
        </div>
      )}
    </>
  );
}

/** A card's picture box: the slot, with the card text frame sized to it. */
function picture(r: Rect): CSSProperties {
  return { ...boxStyle(r), "--card-w": `${r.w}px` } as CSSProperties;
}

/** What the card is now, beyond its printed picture: its state, what it is attached to or
 * enchanted by, who controls and owns it, a commander's tax and damage, a stack object's
 * targets. Everything comes from the seat's own view. */
function Facts({
  card,
  model,
  view,
  observing,
}: {
  card: TableCard;
  model: TableModel;
  view: GameView | null;
  observing: boolean;
}) {
  const shown = card.card;
  if (shown.hidden || !shown.name) return <p>A face-down card</p>;
  const name = (seat: number | null) => playerName(view, seat, observing);
  const permanent = card.located.permanent;
  const stack = card.located.stack;
  const lines: string[] = [];
  if (shown.power !== null)
    lines.push(`Power and toughness ${shown.power}/${shown.toughness}`);
  // A Two-Headed Giant teammate's card (v0.5.1): shown, not yours to play.
  if (
    card.zone === "hand" &&
    card.ownerSeat !== null &&
    card.ownerSeat !== (model.anchored?.seat ?? null)
  )
    lines.push(`In ${name(card.ownerSeat)}’s hand`);
  lines.push(...permanentState(permanent));
  if (permanent?.attached_to) {
    const host = view?.battlefield.find((p) => p.id === permanent.attached_to);
    if (host) lines.push(`Attached to ${host.card.name ?? "a face-down card"}`);
  }
  if (permanent) {
    const attached = (view?.battlefield ?? []).filter(
      (p) => p.attached_to === permanent.id,
    );
    if (attached.length)
      lines.push(
        `With ${attached.map((p) => p.card.name ?? "a face-down card").join(", ")}`,
      );
  }
  if (
    card.controllerSeat !== null &&
    card.ownerSeat !== null &&
    card.controllerSeat !== card.ownerSeat
  )
    lines.push(
      `Controlled by ${name(card.controllerSeat)}, owned by ${name(card.ownerSeat)}`,
    );
  const commander = commanderOf(card, model);
  if (commander) {
    lines.push(`Commander · tax ${commander.info.tax}`);
    for (const dealt of commander.info.damageDealt)
      lines.push(`${dealt.damage} commander damage to ${name(dealt.seat)}`);
  }
  if (stack) {
    lines.push(
      `${stack.kind === "spell" ? "Spell" : "Ability"}, controlled by ${name(stack.controller_seat)}`,
    );
    for (const target of stack.targets)
      lines.push(
        `Targets ${target.kind === "player" ? name(target.seat) : (target.label ?? "an object")}`,
      );
    if (stack.text) lines.push(stack.text);
  }
  return (
    <>
      <p className={styles.name}>
        <strong>{shown.name}</strong> <ManaCost cost={shown.mana_cost} />
      </p>
      {shown.type_line && <p className={styles.type}>{shown.type_line}</p>}
      {lines.map((line, index) => (
        <p key={index}>{line}</p>
      ))}
    </>
  );
}

/** The commander this card is, by its object in any zone the seat can see. */
function commanderOf(card: TableCard, model: TableModel) {
  const players: TablePlayer[] = [
    ...(model.anchored ? [model.anchored] : []),
    ...model.opponents,
  ];
  for (const player of players)
    for (const info of player.commanders)
      if (
        info.objectId !== null &&
        (info.objectId === card.id ||
          info.objectId === card.located.permanent?.id)
      )
        return { player, info };
  return null;
}
