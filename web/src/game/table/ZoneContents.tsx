import { CardButton, CardRow } from "../Board";
import type { Seat } from "../types";
import { StackButton } from "./StackButton";
import type {
  TableModel,
  TablePlayer,
  TableUnit,
  ZoneBrowserTarget,
  ZoneContentsProps,
} from "./types";
import styles from "./table.module.css";

// The zone browsers (ZD1–ZD4): everything in a graveyard, an exile, a command zone, a board, a
// pile, the stack or the hand, as whole cards that answer as they do on the table. The table
// shows only the top of these, or as many as fit; a browser lists them all.

function playerAt(model: TableModel, seat: Seat): TablePlayer | null {
  return (
    [model.anchored, ...model.opponents].find((p) => p?.seat === seat) ?? null
  );
}

/** "Your", the player's name, or "Seat N" when the seat is not in the view (defect 7). Visible
 * titles keep the curly apostrophe. */
function whose(model: TableModel, seat: Seat): string {
  if (seat === model.viewSeat && !model.observing) return "Your";
  return `${playerAt(model, seat)?.player.name ?? `Seat ${seat + 1}`}’s`;
}

function unitAt(model: TableModel, key: string): TableUnit | null {
  for (const player of [model.anchored, ...model.opponents])
    for (const unit of player?.units ?? []) if (unit.key === key) return unit;
  return null;
}

export function zoneTitle(
  target: ZoneBrowserTarget,
  model: TableModel,
): string {
  switch (target.kind) {
    case "zone":
      return `${whose(model, target.seat)} ${target.zone === "command" ? "command zone" : target.zone}`;
    case "battlefield":
      return `${whose(model, target.seat)} battlefield`;
    case "pile": {
      const unit = unitAt(model, target.unit);
      const name = unit && model.cards.get(unit.cards[0])?.card.name;
      if (!unit || !name) return "Pile";
      return unit.kind === "host"
        ? `${name} and what is attached to it`
        : `${name} × ${unit.cards.length}`;
    }
    case "stack":
      return "Stack";
    case "hand":
      return model.handTitle;
  }
}

/** The table keys of the cards a browser lists, in the view's order. */
function keysOf(target: ZoneBrowserTarget, model: TableModel): string[] {
  switch (target.kind) {
    case "zone":
      return playerAt(model, target.seat)?.[target.zone] ?? [];
    case "battlefield":
      return (playerAt(model, target.seat)?.units ?? []).flatMap((unit) => [
        ...unit.cards,
        ...unit.attachments,
      ]);
    case "pile": {
      const unit = unitAt(model, target.unit);
      return unit ? [...unit.cards, ...unit.attachments] : [];
    }
    case "stack":
      return model.stack.map((entry) => entry.key);
    case "hand":
      return model.hand;
  }
}

export function ZoneContents({ target, model }: ZoneContentsProps) {
  const title = zoneTitle(target, model);
  const keys = keysOf(target, model);
  const count = `${keys.length} ${keys.length === 1 ? "card" : "cards"}`;
  return (
    <>
      <p className={styles.zoneCount}>{count}</p>
      {keys.length === 0 ? (
        <p className={styles.zoneEmpty}>Empty</p>
      ) : (
        <CardRow label={title} className={styles.zoneGrid}>
          {target.kind === "stack"
            ? model.stack.map((entry) => (
                <StackButton key={entry.key} entry={entry} node={undefined} />
              ))
            : keys.map((key) => {
                const card = model.cards.get(key);
                return (
                  card && (
                    <CardButton
                      key={key}
                      card={card.card}
                      located={card.located}
                      table={card}
                    />
                  )
                );
              })}
        </CardRow>
      )}
    </>
  );
}
