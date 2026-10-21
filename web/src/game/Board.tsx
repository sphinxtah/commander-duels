import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { CardFace, cardLabel, permanentState } from "./Card";
import {
  isLand,
  objectName,
  optionText,
  playerName,
  type Located,
} from "./model";
import type {
  CardView,
  GameView,
  ObjectId,
  PermanentView,
  PlayerView,
  Prompt,
  PromptOption,
  Seat,
} from "./types";
import { MENU } from "./table/geometry";
import { noteBlur, noteFocus } from "./table/pointer";
import { toDesign } from "./table/stage";
import { StackButton } from "./table/StackButton";
import { useTableContext } from "./table/TableContext";
import {
  STAGE_W,
  type CardNode,
  type MoreNode,
  type Rect,
  type TableCard,
  type TableLayout,
  type ZoneBrowserTarget,
} from "./table/types";
import styles from "./game.module.css";
import tableStyles from "./table/table.module.css";

export interface GameContextValue {
  view: GameView | null;
  prompt: Prompt | null;
  index: Map<ObjectId, Located>;
  byObject: Map<ObjectId, PromptOption[]>;
  bySeat: Map<Seat, PromptOption[]>;
  /** This tab controls the seat and no answer is in flight. */
  canAnswer: boolean;
  /** SysOp watching another player's game: the seat's owner is named, never "You". */
  observing: boolean;
  choose: (option: PromptOption) => void;
  zoom: (card: CardView, located?: Located) => void;
  preview: (card: CardView | null, located?: Located) => void;
}

export const GameContext = createContext<GameContextValue | null>(null);

export function useGameContext(): GameContextValue {
  const value = useContext(GameContext);
  if (!value) throw new Error("GameContext is missing");
  return value;
}

/** What arrow keys move between in a row: its cards, and its "+N" buttons. */
const ROVING = "[data-card],[data-roving]";

/** Arrow keys move between the cards of one zone; Tab moves between zones. */
export function moveFocus(event: KeyboardEvent<HTMLElement>) {
  const keys = [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
  ];
  if (!keys.includes(event.key)) return;
  const cards = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(ROVING),
  );
  const at = cards.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? cards.length - 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? Math.max(0, at - 1)
          : Math.min(cards.length - 1, at + 1);
  cards.forEach((card, i) => (card.tabIndex = i === next ? 0 : -1));
  cards[next]?.focus();
}

/** One tab stop per zone: the first card, or the one last focused. */
export function useRovingTabStop(container: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const cards = Array.from(
      container.current?.querySelectorAll<HTMLElement>(ROVING) ?? [],
    );
    if (cards.length && !cards.some((card) => card.tabIndex === 0))
      cards[0].tabIndex = 0;
  });
}

export function CardRow({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const row = useRef<HTMLDivElement>(null);
  useRovingTabStop(row);
  return (
    <div
      ref={row}
      role="group"
      aria-label={label}
      className={`${styles.cardRow} ${className ?? ""}`}
      onKeyDown={moveFocus}
    >
      {children}
    </div>
  );
}

/* ---------- placing controls on the table ---------- */

/** Where a card's button sits on the table (design §9.3): its layout hit, the side its menu
 * opens on, and the node it stands for. */
export interface CardPlacement {
  key: string;
  hit: Rect;
  menu: "below" | "above";
  role: CardNode["role"];
  /** The node there: the dom painter paints its picture; a pile member names its group. */
  node?: CardNode;
  /** Its place in the stage's paint order, from 1 (dom painter). */
  z?: number;
}

/** A rectangle of the stage as a positioned element's box, and its paint order. */
export function boxStyle(r: Rect, z?: number): CSSProperties {
  return {
    left: r.x,
    top: r.y,
    width: r.w,
    height: r.h,
    ...(z === undefined ? {} : { "--z": z }),
  } as CSSProperties;
}

// Paint order of every control with a hit: cards in the scene's order, then the "+N" buttons
// over them. Hits never overlap; only the dom painter's pictures do.
const paintOrders = new WeakMap<TableLayout, Map<string, number>>();
export function paintRank(
  layout: TableLayout | null,
  key: string,
): number | undefined {
  if (!layout) return undefined;
  let order = paintOrders.get(layout);
  if (!order) {
    const placed = [...layout.nodes.values()].filter((node) => node.hit);
    const z = (node: CardNode | MoreNode) =>
      node.kind === "card" ? node.z : Number.MAX_SAFE_INTEGER;
    placed.sort((a, b) => z(a) - z(b));
    order = new Map(placed.map((node, i) => [node.key, i + 1]));
    paintOrders.set(layout, order);
  }
  return order.get(key);
}

/** A card node's placement, or undefined when it is drawn without a hit. */
export function placementOf(
  node: CardNode,
  layout: TableLayout | null,
): CardPlacement | undefined {
  return node.hit
    ? {
        key: node.key,
        hit: node.hit,
        menu: node.menu,
        role: node.role,
        node,
        z: paintRank(layout, node.key),
      }
    : undefined;
}

/** A menu's side: it ends at the hit's right edge when it would leave the stage. */
function menuAlign(hit: Rect): "start" | "end" {
  return hit.x + MENU.width > STAGE_W ? "end" : "start";
}

/** An option menu's open state, shared with the table's store: the response timer stops when one
 * opens, and a drop with several answers opens one by setting the store's `menu` to its key. */
export function useOptionMenu(key: string, available: number) {
  const { ui } = useTableContext();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const count = useRef(available);
  useLayoutEffect(() => {
    count.current = available;
  });
  useEffect(
    () =>
      ui.subscribe(() => {
        if (ui.get().menu === key && count.current > 0) setOpen(true);
      }),
    [ui, key],
  );
  useEffect(
    () => () => {
      if (ui.get().menu === key) ui.set({ menu: null });
    },
    [ui, key],
  );
  return {
    open,
    button,
    show() {
      setOpen(true);
      ui.set({ menu: key });
    },
    // Leaving the menu by a choice or Escape puts focus back on its button, not on the page.
    close(refocus: boolean) {
      if (refocus) button.current?.focus();
      setOpen(false);
      if (ui.get().menu === key) ui.set({ menu: null });
    },
  };
}

/** The dom painter's picture of a placed card: its face as it lies on the table, and what the
 * scene would draw over it. Positioned against the button, which sits at the hit. */
function Picture({
  node,
  card,
  origin,
}: {
  node: CardNode;
  card: CardView;
  origin: Rect;
}) {
  const at = (r: Rect): CSSProperties => ({
    left: r.x - origin.x,
    top: r.y - origin.y,
    width: r.w,
    height: r.h,
  });
  const square = (c: { x: number; y: number }, side: number) =>
    at({ x: c.x - side / 2, y: c.y - side / 2, w: side, h: side });
  const glyphs = {
    offered: "◆",
    selected: "✓",
    attack: "➤",
    block: "⛨",
    sick: "☾",
    count: "",
  } as const;
  return (
    <>
      <div
        className={tableStyles.paint}
        aria-hidden="true"
        data-mark={node.mark}
        style={
          {
            ...at(node.face),
            transform: node.rotation
              ? `rotate(${node.rotation}deg)`
              : undefined,
            // The hand fans about each card's bottom centre; a tapped card turns about its middle.
            transformOrigin: node.role === "hand" ? "50% 100%" : "50% 50%",
            "--card-w": `${node.face.w}px`,
          } as CSSProperties
        }
      >
        <CardFace card={card} />
      </div>
      {node.tag && (
        <span
          className={tableStyles.tag}
          data-tone={node.tag.tone}
          aria-hidden="true"
          style={{ ...at(node.tag.rect), fontSize: node.tag.rect.h * 0.8 }}
        >
          {node.tag.text}
        </span>
      )}
      {node.pips.map((pip) => (
        <span
          key={pip.counter}
          className={tableStyles.pip}
          data-colour={pip.colour}
          aria-hidden="true"
          style={{ ...square(pip.centre, pip.side), fontSize: pip.side * 0.6 }}
        >
          <span>
            {pip.count > 1
              ? pip.count
              : pip.colour === "violet"
                ? pip.counter.charAt(0).toUpperCase()
                : ""}
          </span>
        </span>
      ))}
      {node.badges.map((badge) => (
        <span
          key={badge.glyph}
          className={tableStyles.badge}
          data-glyph={badge.glyph}
          aria-hidden="true"
          style={{
            ...square(badge.centre, badge.side),
            fontSize: badge.side * 0.6,
          }}
        >
          <span>{badge.text ?? glyphs[badge.glyph]}</span>
        </span>
      ))}
    </>
  );
}

/** A card the seat can see. Clicking answers its one option, or opens a menu of several;
 * without options it opens the zoom. Right-click or Z zooms. With `place` it stands on the
 * table at its layout hit (clear, over the scene's picture, or painting the face itself with
 * the dom painter); without, it flows where it is put (the prompt's rows, drawers, inspection).
 * `table` is the card as the table model has it: its options, name and keys. */
export function CardButton({
  card,
  located,
  small,
  place,
  table,
}: {
  card: CardView;
  located?: Located;
  small?: boolean;
  place?: CardPlacement;
  table?: TableCard;
}) {
  const game = useGameContext();
  const scene = useTableContext();
  const own = useId();
  const permanent = located?.permanent;
  // Options name a permanent by its own id or its card's; the engine uses one reference for both.
  const offered = table?.offered ?? [
    ...(game.byObject.get(card.id) ?? []),
    ...(permanent && permanent.id !== card.id
      ? (game.byObject.get(permanent.id) ?? [])
      : []),
  ];
  const options = game.canAnswer ? offered : [];
  const selected = offered.some((option) => option.selected);
  const state = permanentState(permanent);
  const label =
    table?.label ??
    cardLabel(card, located) +
      (offered.length
        ? `. Options: ${offered.map((o) => optionText(o, game.index, game.view, game.observing)).join("; ")}`
        : "");
  // The table's key for this card. Only the placed button answers to it in the store's `menu`:
  // the same card in a drawer opens its own menu.
  const key = place?.key ?? table?.key;
  const menu = useOptionMenu(
    place?.key ?? `${key ?? "card"}#${own}`,
    options.length,
  );
  const drag = scene.drag;

  function activate() {
    if (options.length === 1) game.choose(options[0]);
    else if (options.length > 1) menu.show();
    else game.zoom(card, located);
  }

  // Where the magnifier opens for keyboard focus: away from the card.
  function anchorX(element: Element): number | null {
    if (place) return place.hit.x + place.hit.w / 2;
    if (!scene.fit) return null;
    const box = element.getBoundingClientRect();
    return toDesign(scene.fit, box.left + box.width / 2, box.top).x;
  }

  const handlers = {
    onClick() {
      // The click a drag's release makes is not a press of the card.
      if (drag?.consumeClick(card.id)) return;
      activate();
    },
    onContextMenu(event: MouseEvent) {
      event.preventDefault();
      game.zoom(card, located);
    },
    onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
      if (event.key.toLowerCase() === "z" && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        game.zoom(card, located);
      }
    },
    onMouseEnter() {
      game.preview(card, located);
    },
    onFocus(event: FocusEvent<HTMLButtonElement>) {
      game.preview(card, located);
      if (key)
        noteFocus(scene.ui, key, event.currentTarget, {
          hand: place?.role === "hand",
          shows: key,
          anchorX: anchorX(event.currentTarget),
        });
    },
    onBlur() {
      if (key) noteBlur(scene.ui, key);
    },
  };

  const optionMenu = menu.open && (
    <OptionMenu
      options={options}
      onClose={menu.close}
      onChoose={(option) => {
        menu.close(true);
        game.choose(option);
      }}
      onZoom={() => {
        menu.close(true);
        game.zoom(card, located);
      }}
      placement={place?.menu}
      align={place ? menuAlign(place.hit) : undefined}
    />
  );

  if (place) {
    const node = place.node;
    const painted = scene.painter === "dom";
    return (
      <div
        className={tableStyles.slot}
        style={boxStyle(place.hit, painted ? place.z : undefined)}
        data-small={small || undefined}
        data-tapped={permanent?.tapped || undefined}
        data-menu={menu.open || undefined}
      >
        <button
          ref={menu.button}
          type="button"
          data-card={card.id}
          data-node={place.key}
          data-role={place.role}
          data-hover={place.key}
          data-group={node?.member ? node.unit : undefined}
          data-group-size={node?.member?.size}
          tabIndex={-1}
          className={tableStyles.hit}
          data-actionable={offered.length > 0 || undefined}
          data-selected={selected || undefined}
          data-attacking={permanent?.attacking || undefined}
          data-blocking={permanent?.blocking || undefined}
          aria-label={label}
          aria-haspopup={options.length > 1 ? "menu" : undefined}
          onPointerDown={
            drag && table?.drag
              ? (event) => drag.onPointerDown(event.nativeEvent, table)
              : undefined
          }
          {...handlers}
        >
          {painted && node && (
            <Picture node={node} card={card} origin={place.hit} />
          )}
        </button>
        {optionMenu}
      </div>
    );
  }

  return (
    <div
      className={styles.cardSlot}
      data-small={small || undefined}
      data-tapped={permanent?.tapped || undefined}
    >
      <button
        ref={menu.button}
        type="button"
        data-card={card.id}
        data-hover={key}
        tabIndex={-1}
        className={styles.card}
        data-actionable={offered.length > 0 || undefined}
        data-selected={selected || undefined}
        data-attacking={permanent?.attacking || undefined}
        data-blocking={permanent?.blocking || undefined}
        aria-label={label}
        aria-haspopup={options.length > 1 ? "menu" : undefined}
        {...handlers}
      >
        <CardFace card={card} />
        {offered.length > 0 && (
          <span className={styles.actionMark} aria-hidden="true">
            {selected ? "✓" : "◆"}
          </span>
        )}
      </button>
      {(state.length > 0 || (permanent && card.power !== null)) && (
        <div className={styles.strip} aria-hidden="true">
          {permanent && card.power !== null && (
            <strong>
              {card.power}/{card.toughness}
            </strong>
          )}
          {permanent?.attacking && <span data-tone="attack">ATK</span>}
          {permanent?.blocking && <span data-tone="block">BLK</span>}
          {permanent && permanent.damage > 0 && (
            <span data-tone="damage">−{permanent.damage}</span>
          )}
          {Object.entries(permanent?.counters ?? {}).map(([counter, count]) => (
            <span key={counter} title={counter}>
              {count}× {counter.replace(/_/g, " ")}
            </span>
          ))}
          {permanent?.tapped && <span>Tapped</span>}
          {permanent?.summoning_sick && <span>Sick</span>}
        </div>
      )}
      {optionMenu}
    </div>
  );
}

/** "+N": what a pile, a row, the hand, your command zone or the stack has beyond what it shows,
 * opening the browser that lists all of it. Arrow keys reach it with the row's cards. */
export function MoreButton({
  node,
  onBrowse,
}: {
  node: MoreNode;
  onBrowse: (target: ZoneBrowserTarget) => void;
}) {
  const scene = useTableContext();
  return (
    <div
      className={tableStyles.slot}
      style={boxStyle(
        node.hit,
        scene.painter === "dom" ? paintRank(scene.layout, node.key) : undefined,
      )}
    >
      <button
        type="button"
        className={`${tableStyles.hit} ${tableStyles.more}`}
        data-more={node.opens.kind}
        data-roving
        data-node={node.key}
        data-hover={node.key}
        tabIndex={-1}
        aria-label={node.label}
        onClick={() => onBrowse(node.opens)}
      >
        +{node.count}
      </button>
    </div>
  );
}

export function OptionMenu({
  options,
  onChoose,
  onClose,
  onZoom,
  placement,
  align,
}: {
  options: PromptOption[];
  onChoose: (option: PromptOption) => void;
  /** Closes the menu; true puts focus back on the card. */
  onClose: (refocus: boolean) => void;
  /** Adds "Card details", which opens the zoom. */
  onZoom?: () => void;
  /** On the table: below the card, or above it near the stage's bottom edge. */
  placement?: "below" | "above";
  /** On the table: "end" near the stage's right edge, so the menu stays on the stage. */
  align?: "start" | "end";
}) {
  const game = useGameContext();
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);
  // A press anywhere outside closes the menu. Blur cannot be the signal: Safari does not focus a
  // pressed button, so pressing an item would blur the menu, with nowhere to go, before the click.
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [onClose]);
  const onTable = placement !== undefined || align !== undefined;
  return (
    <div
      ref={menu}
      role="menu"
      className={`${styles.menu} ${onTable ? tableStyles.tableMenu : ""}`}
      data-placement={placement}
      data-align={align}
      // Pressing an item keeps focus where it is, in every browser; the click still answers.
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose(true);
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const items = Array.from(
            menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
          );
          const at = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "ArrowDown" ? at + 1 : at - 1;
          items[(next + items.length) % items.length]?.focus();
        }
      }}
      // Tab or Shift-Tab out of the menu closes it; focus that goes nowhere does not.
      onBlur={(event) => {
        if (
          event.relatedTarget &&
          !menu.current?.contains(event.relatedTarget as Node)
        )
          onClose(false);
      }}
    >
      {options.map((option) => (
        <button
          key={option.id}
          role="menuitem"
          type="button"
          data-option={option.id}
          onClick={() => onChoose(option)}
        >
          {optionText(option, game.index, game.view, game.observing)}
        </button>
      ))}
      {onZoom && (
        <button role="menuitem" type="button" onClick={onZoom}>
          Card details
        </button>
      )}
    </div>
  );
}

/** Lands on one row, everything else on another; attachments follow what they are attached to. */
export function Battlefield({
  permanents,
  label,
  small,
}: {
  permanents: PermanentView[];
  label: string;
  small?: boolean;
}) {
  const game = useGameContext();
  const ids = new Set(permanents.map((p) => p.id));
  const attached = new Map<ObjectId, PermanentView[]>();
  const roots: PermanentView[] = [];
  for (const permanent of permanents) {
    if (permanent.attached_to && ids.has(permanent.attached_to)) {
      const list = attached.get(permanent.attached_to) ?? [];
      list.push(permanent);
      attached.set(permanent.attached_to, list);
    } else roots.push(permanent);
  }
  const render = (permanent: PermanentView) => (
    <div key={permanent.id} className={styles.attachGroup}>
      <CardButton
        card={permanent.card}
        located={game.index.get(permanent.id)}
        small={small}
      />
      {(attached.get(permanent.id) ?? []).map((child) => (
        <CardButton
          key={child.id}
          card={child.card}
          located={game.index.get(child.id)}
          small
        />
      ))}
    </div>
  );
  const lands = roots.filter((p) => isLand(p.card) && !attached.has(p.id));
  const others = roots.filter((p) => !lands.includes(p));
  if (permanents.length === 0)
    return <p className={styles.emptyZone}>No permanents</p>;
  return (
    <div className={styles.battlefield}>
      {others.length > 0 && (
        <CardRow label={`${label}: creatures and other permanents`}>
          {others.map(render)}
        </CardRow>
      )}
      {lands.length > 0 && (
        <CardRow label={`${label}: lands`} className={styles.lands}>
          {lands.map(render)}
        </CardRow>
      )}
    </div>
  );
}

const poolColours: [keyof PlayerView["mana_pool"], string][] = [
  ["white", "W"],
  ["blue", "U"],
  ["black", "B"],
  ["red", "R"],
  ["green", "G"],
  ["colorless", "C"],
];

/** A player's public state: life, counts, counters, pool, commanders and zone browsers. Kept only
 * until the game screen draws the table, where PlayerPlate takes its place. */
export function PlayerHeader({
  player,
  onZone,
}: {
  player: PlayerView;
  onZone: (seat: Seat, zone: "graveyard" | "exile" | "command") => void;
}) {
  const game = useGameContext();
  const view = game.view;
  const options = game.canAnswer ? (game.bySeat.get(player.seat) ?? []) : [];
  const offered = game.bySeat.get(player.seat) ?? [];
  const active = view?.active_seat === player.seat;
  const priority = view?.priority_seat === player.seat;
  const name =
    player.seat === view?.seat && !game.observing ? "You" : player.name;
  const pool = poolColours.filter(([key]) => player.mana_pool[key] > 0);
  return (
    <div className={styles.playerHeader} data-lost={player.lost || undefined}>
      <div className={styles.playerName}>
        <strong>{name}</strong>
        {active && <span className={styles.pill}>Active turn</span>}
        {priority && (
          <span className={styles.pill} data-tone="priority">
            Priority
          </span>
        )}
        {player.lost && (
          <span className={styles.pill} data-tone="lost">
            Out
          </span>
        )}
        {player.won && (
          <span className={styles.pill} data-tone="won">
            Winner
          </span>
        )}
      </div>
      {offered.length > 0 ? (
        <button
          type="button"
          className={styles.life}
          data-actionable
          data-selected={offered.some((o) => o.selected) || undefined}
          disabled={options.length === 0}
          aria-label={`${name}: ${player.life} life. ${offered
            .map((o) => optionText(o, game.index, view, game.observing))
            .join("; ")}`}
          onClick={() => options[0] && game.choose(options[0])}
        >
          ♥ {player.life}
        </button>
      ) : (
        <span className={styles.life} aria-label={`${player.life} life`}>
          ♥ {player.life}
        </span>
      )}
      <ul className={styles.counts}>
        <li aria-label={`${player.hand_count} cards in hand`}>
          ✋ {player.hand_count}
        </li>
        <li aria-label={`${player.library_count} cards in library`}>
          ▤ {player.library_count}
        </li>
        <li>
          <button
            type="button"
            onClick={() => onZone(player.seat, "graveyard")}
          >
            Graveyard {player.graveyard.length}
          </button>
        </li>
        <li>
          <button type="button" onClick={() => onZone(player.seat, "exile")}>
            Exile {player.exile.length}
          </button>
        </li>
        {(player.command_zone.length > 0 || player.commanders.length > 0) && (
          <li>
            <button
              type="button"
              onClick={() => onZone(player.seat, "command")}
            >
              Command {player.command_zone.length}
            </button>
          </li>
        )}
        {Object.entries(player.counters).map(([counter, count]) => (
          <li key={counter}>
            {count} {counter.replace(/_/g, " ")}
          </li>
        ))}
        {pool.length > 0 && (
          <li
            aria-label={`Mana pool: ${pool.map(([key]) => `${player.mana_pool[key]} ${key}`).join(", ")}`}
          >
            Pool{" "}
            {pool.map(([key, symbol]) => (
              <span
                key={key}
                className={styles.poolSymbol}
                data-symbol={symbol}
              >
                {player.mana_pool[key]}
                {symbol}
              </span>
            ))}
          </li>
        )}
      </ul>
      {player.commanders.length > 0 && (
        <ul className={styles.commanders}>
          {player.commanders.map((commander) => (
            <li key={commander.name}>
              <strong>{commander.name}</strong>
              <span>{commander.zone}</span>
              <span>Tax {commander.tax}</span>
              {commander.damage_dealt.map((entry) => (
                <span key={entry.seat}>
                  {entry.damage} to{" "}
                  {playerName(view, entry.seat, game.observing)}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The stack, top first (S1). On the table (`lane`) each item is a StackButton at its place on
 * the band, the items beyond those drawn behind a "+N"; without a table model it is the list
 * the screen drew before the table. */
export function StackPanel({
  lane,
  onBrowse,
}: {
  lane?: Rect;
  onBrowse?: (target: ZoneBrowserTarget) => void;
} = {}) {
  const scene = useTableContext();
  return scene.model ? (
    <TableStack placed={lane !== undefined} onBrowse={onBrowse} />
  ) : (
    <StackList />
  );
}

function TableStack({
  placed,
  onBrowse,
}: {
  placed: boolean;
  onBrowse?: (target: ZoneBrowserTarget) => void;
}) {
  const scene = useTableContext();
  const title = useId();
  const list = useRef<HTMLOListElement>(null);
  useRovingTabStop(list);
  const model = scene.model;
  if (!model || model.stack.length === 0) return null;
  const nodeOf = (key: string) => {
    const node = scene.layout?.nodes.get(key);
    return node?.kind === "card" ? node : undefined;
  };
  // On the table, an item drawn without a hit is counted by the "+N" instead.
  const entries = placed
    ? model.stack.filter((entry) => nodeOf(entry.key)?.hit)
    : model.stack;
  const more = placed ? scene.layout?.nodes.get("more:stack") : undefined;
  return (
    <section
      className={placed ? tableStyles.region : styles.stack}
      aria-labelledby={title}
    >
      <h2 id={title} className={placed ? styles.visuallyHidden : undefined}>
        Stack <span>top resolves first</span>
      </h2>
      <ol ref={list} className={tableStyles.list} onKeyDown={moveFocus}>
        {entries.map((entry) => (
          <li
            key={entry.key}
            data-actionable={entry.offered.length > 0 || undefined}
            data-selected={entry.offered.some((o) => o.selected) || undefined}
          >
            <StackButton
              entry={entry}
              node={placed ? nodeOf(entry.key) : undefined}
            />
          </li>
        ))}
        {more?.kind === "more" && onBrowse && (
          <li>
            <MoreButton node={more} onBrowse={onBrowse} />
          </li>
        )}
      </ol>
    </section>
  );
}

function StackList() {
  const game = useGameContext();
  const view = game.view;
  if (!view || view.stack.length === 0) return null;
  return (
    <section className={styles.stack} aria-labelledby="stack-title">
      <h2 id="stack-title">
        Stack <span>top resolves first</span>
      </h2>
      <ol>
        {view.stack.map((item, position) => {
          const offered = game.byObject.get(item.id) ?? [];
          return (
            <li
              key={item.id}
              data-actionable={offered.length > 0 || undefined}
              data-selected={offered.some((o) => o.selected) || undefined}
            >
              <div className={styles.stackHead}>
                <span className={styles.stackOrder}>
                  {position === 0 ? "Next" : position + 1}
                </span>
                <strong>{item.hidden ? "A hidden spell" : item.name}</strong>
                <span className={styles.stackKind}>{item.kind}</span>
              </div>
              <div className={styles.stackMeta}>
                Controlled by{" "}
                {playerName(view, item.controller_seat, game.observing)}
              </div>
              {item.text && <p>{item.text}</p>}
              {item.targets.length > 0 && (
                <div className={styles.stackMeta}>
                  Targets:{" "}
                  {item.targets
                    .map((target) =>
                      target.kind === "player"
                        ? playerName(view, target.seat, game.observing)
                        : (objectName(game.index.get(target.object_id ?? "")) ??
                          target.label ??
                          "an object"),
                    )
                    .join(", ")}
                </div>
              )}
              {game.canAnswer &&
                offered.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={styles.inlineOption}
                    onClick={() => game.choose(option)}
                  >
                    {optionText(option, game.index, view, game.observing)}
                  </button>
                ))}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Who attacks whom, in words (S2). On the table the arrows and marks show it, so the words are
 * for screen readers only. */
export function CombatPanel() {
  const game = useGameContext();
  const scene = useTableContext();
  const view = game.view;
  if (!view || view.combat.length === 0) return null;
  const name = (id: ObjectId) => objectName(game.index.get(id)) ?? "a creature";
  return (
    <section
      className={scene.model ? styles.visuallyHidden : styles.combat}
      aria-labelledby="combat-title"
    >
      <h2 id="combat-title">Combat</h2>
      <ul>
        {view.combat.map((group, index) => (
          <li key={index}>
            {group.attackers.map(name).join(", ")} →{" "}
            {group.defender
              ? group.defender.kind === "player"
                ? playerName(view, group.defender.seat, game.observing)
                : name(group.defender.object_id ?? "")
              : "no defender yet"}
            {group.blockers.length > 0
              ? `, blocked by ${group.blockers.map(name).join(", ")}`
              : group.blocked
                ? ", blocked"
                : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Graveyard, exile and command-zone browsers (UI03), with any options their cards have. Kept
 * only until the game screen draws the table, where the zone drawer with ZoneContents takes its
 * place. */
export function ZoneDialog({
  target,
  onClose,
}: {
  target: { seat: Seat; zone: "graveyard" | "exile" | "command" } | null;
  onClose: () => void;
}) {
  const game = useGameContext();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (target) dialog.current?.showModal();
    else dialog.current?.close();
  }, [target]);
  const player = target
    ? [game.view?.you, ...(game.view?.opponents ?? [])].find(
        (p) => p?.seat === target.seat,
      )
    : undefined;
  const cards =
    !player || !target
      ? []
      : target.zone === "graveyard"
        ? player.graveyard
        : target.zone === "exile"
          ? player.exile
          : player.command_zone;
  const title = target
    ? `${target.seat === game.view?.seat && !game.observing ? "Your" : `${player?.name ?? `Seat ${target.seat + 1}`}’s`} ${
        target.zone === "command" ? "command zone" : target.zone
      }`
    : "";
  return (
    <dialog
      ref={dialog}
      className={styles.zoneDialog}
      onClose={onClose}
      aria-labelledby="zone-title"
    >
      <button
        className={styles.zoomClose}
        aria-label="Close"
        onClick={() => dialog.current?.close()}
      >
        ×
      </button>
      <h2 id="zone-title">
        {title} <span>{cards.length} cards</span>
      </h2>
      {cards.length === 0 ? (
        <p className={styles.emptyZone}>Empty</p>
      ) : (
        <CardRow label={title} className={tableStyles.zoneGrid}>
          {cards.map((card) => (
            <CardButton
              key={card.id}
              card={card}
              located={game.index.get(card.id)}
            />
          ))}
        </CardRow>
      )}
    </dialog>
  );
}
