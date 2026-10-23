import { createContext, useContext } from "react";
import { boxStyle, useOptionMenu } from "../Board";
import type { AllianceAction, Alliances, Seat } from "../types";
import { ActionMenu } from "./ActionMenu";
import {
  ACTION_WORDS,
  allianceActions,
  alliesOf,
  listed,
  standing,
} from "./chat";
import { ALLIANCE_BUTTON, MENU, diamondBox, overlaps } from "./geometry";
import { STAGE_W, type PlayerNode, type Rect } from "./types";
import gameStyles from "../game.module.css";
import styles from "./table.module.css";

// Alliances on the plates at a human table (v0.4.4, docs/chat.md): each plate says whom its
// player is allied with, and an offer the viewer made or received; another human player still in
// the game has an Alliance button whose menu offers, accepts, declines, withdraws or ends one.
// Outside a human table's game there is no context, and the plates show none of it. At a
// Two-Headed Giant table (v0.5.1) the alliances are the teams, fixed: the plates say who is whose
// teammate already, so they show no alliance and no Alliance button.

export interface TableAlliances {
  /** The viewer's seat; null for SysOp watching. */
  mine: Seat | null;
  alliances: Alliances | null;
  /** The seats the viewer may make alliances with now (chat.ts allianceSeats). */
  open: ReadonlySet<Seat>;
  /** A seat's player, by handle. */
  handle(seat: Seat): string;
  act(action: AllianceAction, seat: Seat): void;
}

export const AllianceContext = createContext<TableAlliances | null>(null);

/** The pills a seat's alliances put on its plate. */
export function alliancePills(
  table: TableAlliances,
  seat: Seat,
): { text: string; tone: "ally" | "offer" }[] {
  const { mine, alliances } = table;
  if (alliances?.fixed) return [];
  const allies = alliesOf(alliances, seat);
  const names = (seats: Seat[]) => listed(seats.map(table.handle));
  if (seat === mine)
    return allies.length
      ? [{ text: `Allied with ${names(allies)}`, tone: "ally" }]
      : [];
  const pills: { text: string; tone: "ally" | "offer" }[] = [];
  const now = standing(alliances, mine, seat);
  if (now === "allied") pills.push({ text: "Ally", tone: "ally" });
  if (now === "offering")
    pills.push({ text: "Offers alliance", tone: "offer" });
  if (now === "offered") pills.push({ text: "Offer sent", tone: "offer" });
  const others = allies.filter((other) => other !== mine);
  if (others.length)
    pills.push({ text: `Allied with ${names(others)}`, tone: "ally" });
  return pills;
}

export function AlliancePills({ seat }: { seat: Seat }) {
  const table = useContext(AllianceContext);
  if (!table) return null;
  return alliancePills(table, seat).map((pill) => (
    <span key={pill.text} className={styles.pill} data-tone={pill.tone}>
      {pill.text}
    </span>
  ));
}

/** Where a plate's Alliance button sits. */
export function allianceBox(node: PlayerNode): Rect {
  const box = {
    x: node.target.x - ALLIANCE_BUTTON.gap - ALLIANCE_BUTTON.w,
    y:
      Math.max(
        node.pills.y + node.pills.h,
        node.statusRow.y + node.statusRow.h,
      ) + ALLIANCE_BUTTON.drop,
    w: ALLIANCE_BUTTON.w,
    h: ALLIANCE_BUTTON.h,
  };
  // Left of the count diamonds it would cover (v0.5.1): three- and four-player tables set them
  // beside the player button, on the button's row.
  const diamonds = [...Object.values(node.counts), node.expand].map(diamondBox);
  for (let moved = true; moved;) {
    const hit = diamonds.find((other) => overlaps(box, other));
    moved = hit !== undefined;
    if (hit) box.x = hit.x - ALLIANCE_BUTTON.gap - ALLIANCE_BUTTON.w;
  }
  return box;
}

/** Another player's Alliance button and its menu, while the viewer may make one with them. */
export function AllianceControl({
  seat,
  node,
}: {
  seat: Seat;
  node: PlayerNode;
}) {
  const table = useContext(AllianceContext);
  const allowed = (table?.open.has(seat) ?? false) && !table?.alliances?.fixed;
  const now = table ? standing(table.alliances, table.mine, seat) : "none";
  const actions = allowed ? allianceActions(now) : [];
  const menu = useOptionMenu(`alliance:${seat}`, actions.length);
  if (!table || !allowed || node.chip) return null;
  const name = table.handle(seat);
  const box = allianceBox(node);
  return (
    <div
      className={styles.slot}
      style={boxStyle(box)}
      data-menu={menu.open || undefined}
    >
      <button
        ref={menu.button}
        type="button"
        className={styles.alliance}
        data-alliance={seat}
        data-standing={now}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={() => (menu.open ? menu.close(false) : menu.show())}
      >
        {/* The space stays outside the hidden words, so the name reads "Alliance with Bob". */}
        Alliance <span className={gameStyles.visuallyHidden}>with {name}</span>
        <span aria-hidden="true"> ▾</span>
      </button>
      {menu.open && (
        <ActionMenu
          label={`Alliance with ${name}`}
          toggle={menu.button}
          onClose={menu.close}
          align={box.x + MENU.width > STAGE_W ? "end" : "start"}
          actions={actions.map((action) => ({
            key: action,
            label: ACTION_WORDS[action],
            onSelect: () => {
              menu.close(true);
              table.act(action, seat);
            },
          }))}
        />
      )}
    </div>
  );
}
