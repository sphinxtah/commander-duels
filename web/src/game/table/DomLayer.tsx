import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  CardButton,
  CardRow,
  CombatPanel,
  MoreButton,
  placementOf,
  StackPanel,
  useGameContext,
} from "../Board";
import { PlayerPlate } from "./PlayerPlate";
import { useTablePointer } from "./pointer";
import { TableContext, useTableContext } from "./TableContext";
import type {
  DomLayerProps,
  RowLayout,
  TableContextValue,
  TablePlayer,
} from "./types";
import gameStyles from "../game.module.css";
import styles from "./table.module.css";

// The table's DOM layer (design §9.1): every card, stack item, player, zone tile and "+N" as a
// real, named button at its layout hit, in this order (which is the Tab order): the opponents,
// each in an article with their plate and battlefield rows (and a Two-Headed Giant teammate's
// hand, v0.5.1); the stack on the band and the combat in words; then your side with your plate,
// rows, command zone and hand. Sections, rows and articles take no pointer events and hold no
// layout of their own: their buttons are placed on the stage.

export function DomLayer({
  model,
  layout,
  painter,
  onBrowse,
  onExpand,
}: DomLayerProps) {
  const outer = useTableContext();
  const game = useGameContext();
  // What this layer is drawn from, for everything inside it.
  const scene = useMemo<TableContextValue>(
    () => ({ ...outer, painter, layout, model }),
    [outer, painter, layout, model],
  );
  const root = useRef<HTMLDivElement>(null);
  // Leaving every card for a moment clears the preview too, not only the magnifier (V4).
  const pointer = useTablePointer(outer.ui, layout, outer.fit, {
    onClear: () => game.preview(null),
  });

  // The wheel over a card magnifies it instead of scrolling. React listens to the wheel
  // passively, where preventDefault does nothing, so this listener is the element's own.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (
        !event.ctrlKey &&
        event.target instanceof Element &&
        event.target.closest("[data-card][data-hover]")
      )
        event.preventDefault();
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, []);

  const node = (key: string): ReactNode => {
    const placed = layout.nodes.get(key);
    if (!placed) return null;
    if (placed.kind === "more")
      return <MoreButton key={key} node={placed} onBrowse={onBrowse} />;
    const card = model.cards.get(key);
    const place = placementOf(placed, layout);
    return (
      card &&
      place && (
        <CardButton
          key={key}
          card={card.card}
          located={card.located}
          table={card}
          place={place}
        />
      )
    );
  };
  const row = (r: RowLayout) => (
    <CardRow key={r.key} label={r.label} className={styles.region}>
      {r.nodes.map(node)}
    </CardRow>
  );
  const battlefieldRows = (seat: number) =>
    layout.rows.filter(
      (r) =>
        r.seat === seat &&
        r.key !== "hand" &&
        !r.key.startsWith("hand:") &&
        !r.key.startsWith("command:"),
    );

  /** A player's plate and battlefield rows, and a teammate's hand (v0.5.1) after them. */
  const side = (player: TablePlayer) => {
    const plate = layout.players.get(player.seat);
    const shownHand = layout.rows.find((r) => r.key === `hand:${player.seat}`);
    return (
      <>
        {plate && (
          <PlayerPlate
            player={player}
            node={plate}
            tiles={layout.zones.filter((tile) => tile.seat === player.seat)}
            onBrowse={onBrowse}
            onExpand={onExpand}
          />
        )}
        {battlefieldRows(player.seat).map(row)}
        {player.units.length === 0 && (
          <p className={gameStyles.visuallyHidden}>No permanents</p>
        )}
        {shownHand && row(shownHand)}
      </>
    );
  };

  const anchored = model.anchored;
  const commandRow = layout.rows.find((r) => r.key.startsWith("command:"));
  const handRow = layout.rows.find((r) => r.key === "hand");
  const handCount = model.hand.length || model.handBacks;
  return (
    <TableContext.Provider value={scene}>
      <div
        ref={root}
        className={styles.layer}
        data-painter={painter}
        onPointerMove={pointer.onPointerMove}
        onClickCapture={pointer.onClickCapture}
        onWheel={pointer.onWheel}
      >
        <section className={styles.region} aria-label="Opponents">
          {model.opponents.map((player) => (
            <article
              key={player.seat}
              className={styles.region}
              aria-label={player.articleLabel ?? player.name}
              data-active={player.active || undefined}
              data-lost={player.lost || undefined}
            >
              {side(player)}
            </article>
          ))}
        </section>

        <StackPanel lane={layout.stackLane} onBrowse={onBrowse} />
        <CombatPanel />

        {anchored && (
          <section
            className={styles.region}
            aria-label={anchored.sideLabel ?? `${anchored.name}'s side`}
            data-active={anchored.active || undefined}
          >
            {side(anchored)}
            {commandRow && row(commandRow)}
            <h2 className={gameStyles.visuallyHidden}>
              {model.handTitle} <span>{handCount}</span>
            </h2>
            {handRow
              ? row(handRow)
              : handCount === 0 && (
                  <p className={gameStyles.visuallyHidden}>No cards in hand</p>
                )}
          </section>
        )}
      </div>
    </TableContext.Provider>
  );
}
