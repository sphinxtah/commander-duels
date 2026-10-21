import { CardButton, placementOf } from "../Board";
import { useTableContext } from "./TableContext";
import type { CardNode, TableCard, TableStackEntry } from "./types";

// A stack item as a button (S1): named "Next: Lightning Bolt, spell, controlled by Bot 2. …",
// with data-card set to the item's id. It answers like a card: its one option, a menu of several
// (whose items carry data-option), and with none it opens the zoom, so a spell on the stack can
// be read whole (defect 3).

/** The item as a card, for a stack drawn without a table model: a hidden spell shows its back. */
function entryCard(entry: TableStackEntry): TableCard {
  const item = entry.item;
  return {
    key: entry.key,
    id: entry.id,
    card: {
      id: item.id,
      hidden: item.hidden,
      name: item.hidden ? null : item.name,
      mana_cost: null,
      type_line: item.hidden
        ? null
        : item.kind === "ability"
          ? "Ability"
          : null,
      power: null,
      toughness: null,
      rules: !item.hidden && item.text ? [item.text] : [],
    },
    located: {
      id: item.id,
      zone: "stack",
      seat: item.controller_seat,
      stack: item,
    },
    zone: "stack",
    ownerSeat: item.controller_seat,
    controllerSeat: item.controller_seat,
    offered: entry.offered,
    mark: entry.mark,
    label: entry.label,
    drag: null,
  };
}

export function StackButton({
  entry,
  node,
}: {
  entry: TableStackEntry;
  /** Its place on the band; without one it flows (the stack browser). */
  node: CardNode | undefined;
}) {
  const scene = useTableContext();
  const card = scene.model?.cards.get(entry.key) ?? entryCard(entry);
  return (
    <CardButton
      card={card.card}
      located={card.located}
      table={card}
      place={node ? placementOf(node, scene.layout) : undefined}
    />
  );
}
