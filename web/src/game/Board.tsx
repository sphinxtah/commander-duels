import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
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
import styles from "./game.module.css";

export interface GameContextValue {
  view: GameView | null;
  prompt: Prompt | null;
  index: Map<ObjectId, Located>;
  byObject: Map<ObjectId, PromptOption[]>;
  bySeat: Map<Seat, PromptOption[]>;
  /** This tab controls the seat and no answer is in flight. */
  canAnswer: boolean;
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

/** Arrow keys move between the cards of one zone; Tab moves between zones. */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
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
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-card]"),
  );
  const at = cards.indexOf(document.activeElement as HTMLButtonElement);
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
  // One tab stop per zone: the first card, or the one last focused.
  useEffect(() => {
    const cards = Array.from(
      row.current?.querySelectorAll<HTMLButtonElement>("[data-card]") ?? [],
    );
    if (cards.length && !cards.some((card) => card.tabIndex === 0))
      cards[0].tabIndex = 0;
  });
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

/** A card the seat can see. Clicking answers its one option, or opens a menu of several;
 * without options it opens the zoom. Right-click or Z zooms. */
export function CardButton({
  card,
  located,
  small,
}: {
  card: CardView;
  located?: Located;
  small?: boolean;
}) {
  const game = useGameContext();
  const [menu, setMenu] = useState(false);
  const permanent = located?.permanent;
  // Options name a permanent by its own id or its card's; the engine uses one reference for both.
  const offered = [
    ...(game.byObject.get(card.id) ?? []),
    ...(permanent && permanent.id !== card.id
      ? (game.byObject.get(permanent.id) ?? [])
      : []),
  ];
  const options = game.canAnswer ? offered : [];
  const selected = offered.some((option) => option.selected);
  const state = permanentState(permanent);
  const label =
    cardLabel(card, located) +
    (offered.length
      ? `. Options: ${offered.map((o) => optionText(o, game.index, game.view)).join("; ")}`
      : "");

  function activate() {
    if (options.length === 1) game.choose(options[0]);
    else if (options.length > 1) setMenu(true);
    else game.zoom(card, located);
  }

  return (
    <div
      className={styles.cardSlot}
      data-small={small || undefined}
      data-tapped={permanent?.tapped || undefined}
    >
      <button
        type="button"
        data-card={card.id}
        tabIndex={-1}
        className={styles.card}
        data-actionable={offered.length > 0 || undefined}
        data-selected={selected || undefined}
        data-attacking={permanent?.attacking || undefined}
        data-blocking={permanent?.blocking || undefined}
        aria-label={label}
        aria-haspopup={options.length > 1 ? "menu" : undefined}
        onClick={activate}
        onContextMenu={(event) => {
          event.preventDefault();
          game.zoom(card, located);
        }}
        onKeyDown={(event) => {
          if (
            event.key.toLowerCase() === "z" &&
            !event.ctrlKey &&
            !event.metaKey
          ) {
            event.preventDefault();
            game.zoom(card, located);
          }
        }}
        onMouseEnter={() => game.preview(card, located)}
        onFocus={() => game.preview(card, located)}
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
      {menu && (
        <OptionMenu
          options={options}
          onClose={() => setMenu(false)}
          onChoose={(option) => {
            setMenu(false);
            game.choose(option);
          }}
          onZoom={() => {
            setMenu(false);
            game.zoom(card, located);
          }}
        />
      )}
    </div>
  );
}

function OptionMenu({
  options,
  onChoose,
  onClose,
  onZoom,
}: {
  options: PromptOption[];
  onChoose: (option: PromptOption) => void;
  onClose: () => void;
  onZoom: () => void;
}) {
  const game = useGameContext();
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);
  return (
    <div
      ref={menu}
      role="menu"
      className={styles.menu}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
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
      onBlur={(event) => {
        if (!menu.current?.contains(event.relatedTarget as Node)) onClose();
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
          {optionText(option, game.index, game.view)}
        </button>
      ))}
      <button role="menuitem" type="button" onClick={onZoom}>
        Card details
      </button>
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

/** A player's public state: life, counts, counters, pool, commanders and zone browsers. */
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
  const name = player.seat === view?.seat ? "You" : player.name;
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
            .map((o) => optionText(o, game.index, view))
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
              <span>
                {commander.zone === "hidden" ? "hidden" : commander.zone}
              </span>
              <span>Tax {commander.tax}</span>
              {commander.damage_dealt.map((entry) => (
                <span key={entry.seat}>
                  {entry.damage} to {playerName(view, entry.seat)}
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function StackPanel() {
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
                Controlled by {playerName(view, item.controller_seat)}
              </div>
              {item.text && <p>{item.text}</p>}
              {item.targets.length > 0 && (
                <div className={styles.stackMeta}>
                  Targets:{" "}
                  {item.targets
                    .map((target) =>
                      target.kind === "player"
                        ? playerName(view, target.seat)
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
                    {optionText(option, game.index, view)}
                  </button>
                ))}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function CombatPanel() {
  const game = useGameContext();
  const view = game.view;
  if (!view || view.combat.length === 0) return null;
  const name = (id: ObjectId) => objectName(game.index.get(id)) ?? "a creature";
  return (
    <section className={styles.combat} aria-labelledby="combat-title">
      <h2 id="combat-title">Combat</h2>
      <ul>
        {view.combat.map((group, index) => (
          <li key={index}>
            {group.attackers.map(name).join(", ")} →{" "}
            {group.defender
              ? group.defender.kind === "player"
                ? playerName(view, group.defender.seat)
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

/** Graveyard, exile and command-zone browsers (UI03), with any options their cards have. */
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
    ? `${target.seat === game.view?.seat ? "Your" : `${player?.name ?? "Their"}’s`} ${
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
        <CardRow label={title} className={styles.zoneGrid}>
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
