import { createContext, useContext } from "react";
import { createTableUi } from "./uiStore";
import type { TableContextValue } from "./types";

// What the table's controls share beyond the game's own context: which painter draws the faces,
// the interface store (hover, focus, the risen card, menus, drags), the layout and model on
// screen, the stage's fit and the drag controller. Outside a table (a dialog, a drawer drawn
// before the table, a test) the default paints with the DOM and keeps its interface state in a
// store of its own, so a lone CardButton still works.

export const TableContext = createContext<TableContextValue>({
  painter: "dom",
  ui: createTableUi(),
  layout: null,
  model: null,
  fit: null,
  drag: null,
});

export function useTableContext(): TableContextValue {
  return useContext(TableContext);
}
