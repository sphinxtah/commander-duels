import { useLayoutEffect, useMemo, useRef } from "react";
import type { GameState } from "../connection";
import type { GameResultView, Seat } from "../types";
import { deriveEvents, withResult } from "./events";
import { layoutTable } from "./layout";
import { buildTableModel } from "./tableModel";
import type { BuildInput, TableDiff, TableLayout, TableModel } from "./types";

// The table's two hooks: the model and layout for what is on screen, and the events since the
// model drawn before it. Both are pure functions underneath; these only remember.

/** The model and its layout, rebuilt only when what they are built from changes. */
export function useTableModel({
  input,
  expandedSeat,
  textScale,
}: {
  input: BuildInput | null;
  expandedSeat: Seat | null;
  textScale: 1 | 1.25;
}): { model: TableModel | null; layout: TableLayout | null } {
  const context = input?.context;
  const model = useMemo(
    () => (input ? buildTableModel(input) : null),
    // The parts, not the object: a caller that builds the input afresh each render must not
    // rebuild the table each render.
    [
      input?.gameId,
      input?.snapshot,
      context?.view,
      context?.prompt,
      context?.index,
      context?.byObject,
      context?.bySeat,
      context?.canAnswer,
      context?.observing,
      input?.viewSeat,
      input?.summarySeats,
      input?.selfHandle,
      input?.sysop,
    ],
  );
  const layout = useMemo(
    () => (model ? layoutTable(model, { expandedSeat, textScale }) : null),
    [model, expandedSeat, textScale],
  );
  return { model, layout };
}

function tabHidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

/** The events between the model last drawn and this one. The first model, the first after the
 * connection opens again (a welcome or a resync) and any model while the tab is hidden are
 * baselines: the table snaps to them, and a reconnect never replays a draw (NET10). Given the
 * snapshot's result, the diff also tells how the game ended, draws included (`withResult`);
 * without it, only a won flag turning on says so. */
export function useTableEvents(
  model: TableModel | null,
  phase: GameState["phase"],
  result?: GameResultView | null,
): TableDiff | null {
  const memory = useRef<{
    drawn: TableModel | null;
    drawnResult: GameResultView | null;
    phase: GameState["phase"] | null;
    armed: boolean;
    model: TableModel | null;
    diff: TableDiff | null;
  }>({
    drawn: null,
    drawnResult: null,
    phase: null,
    armed: false,
    model: null,
    diff: null,
  });
  const m = memory.current;
  let diff: TableDiff | null;
  if (!model) diff = null;
  else if (model === m.model) diff = m.diff;
  else {
    diff = deriveEvents(m.drawn, model, {
      baseline: m.armed || (phase === "open" && m.phase !== "open"),
      hidden: tabHidden(),
    });
    if (result !== undefined)
      diff = withResult(diff, m.drawnResult, result, model);
  }

  // Remember what was drawn once React has committed it, never during a render it may discard.
  useLayoutEffect(() => {
    const m = memory.current;
    if (model && model !== m.drawn) {
      m.drawn = model;
      m.drawnResult = result ?? null;
      m.armed = false;
    } else if (phase === "open" && m.phase !== null && m.phase !== "open")
      // The connection opened again without a new model: the next one is a baseline.
      m.armed = true;
    m.phase = phase;
    m.model = model;
    m.diff = diff;
  });
  return diff;
}
