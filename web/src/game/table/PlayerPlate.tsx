import { useState, type CSSProperties } from "react";
import { boxStyle, OptionMenu, useGameContext, useOptionMenu } from "../Board";
import { CardFace } from "../Card";
import { playerName, words } from "../model";
import type { CardView, ManaPool, Seat } from "../types";
import { AllianceControl, AlliancePills } from "./Alliance";
import { MENU, diamondBox } from "./geometry";
import { noteBlur, noteFocus } from "./pointer";
import {
  isPortraitId,
  portraitBox,
  portraitName,
  portraitSize,
  portraitUrl,
} from "./portrait";
import { sigilSpec } from "./sigil";
import { SigilSvg } from "./SigilSvg";
import { useTableContext } from "./TableContext";
import {
  STAGE_W,
  type CommanderInfo,
  type Diamond,
  type PlayerNode,
  type Rect,
  type TablePlayer,
  type ZoneBrowserTarget,
  type ZoneName,
  type ZoneTile,
} from "./types";
import { useTableUi } from "./uiStore";
import gameStyles from "../game.module.css";
import styles from "./table.module.css";

// A player's plate on the table (P1–P5, design §9.2): name and title, the pills, the portrait and
// life (a button when the prompt offers the player), the counts, the zone tiles, the status row
// and the board's Expand or Show button. Names, life and status are DOM text at every scale; the
// scene draws the diamonds, the portrait or sigil and the counts' numerals unless the dom painter
// does. A Planeswalker portrait (v0.3.1) is named in both painters. At a human table (v0.4.4) the
// pills say the player's alliances, and another player's plate has its Alliance button.

const poolColours: [keyof ManaPool, string][] = [
  ["white", "W"],
  ["blue", "U"],
  ["black", "B"],
  ["red", "R"],
  ["green", "G"],
  ["colorless", "C"],
];

/** A Two-Headed Giant teammate's hand (v0.5.0, 810.5), card names in the view's order. */
function teammateHand(cards: CardView[]): string {
  return cards.length === 0
    ? "no cards"
    : cards.map((card) => card.name ?? "a hidden card").join(", ");
}

/** The phase beside your portrait, as Magic Duels names it. */
const phaseCaptions: Record<string, string> = {
  precombat_main: "First main",
  postcombat_main: "Second main",
  end: "End",
  ending: "End",
};

/** A line of text whose anchor is its baseline, right-aligned to the anchor or left from it. */
function textStyle(t: PlayerNode["name"]): CSSProperties {
  return {
    left: t.align === "right" ? t.anchor.x - t.maxWidth : t.anchor.x,
    top: t.anchor.y - t.size,
    width: t.maxWidth,
    fontSize: t.size,
  };
}

/** A size in stage units as rem, so it follows Larger text (16 su at the normal size) as the
 * plate's other text does. Names need none: the layout already scales them. */
function rem(su: number): string {
  return `${su / 16}rem`;
}

function diamondStyle(d: Diamond): CSSProperties {
  return boxStyle(diamondBox(d));
}

/** "your" for the viewer's own seat, else the player's name with an apostrophe. */
function whose(player: TablePlayer): string {
  return player.name === "You" ? "your" : `${player.player.name}'s`;
}

function commanderWords(
  commander: CommanderInfo,
  name: (seat: Seat) => string,
): string {
  const zone =
    commander.zone === "command"
      ? "command zone"
      : commander.zone === "outside"
        ? "outside the game"
        : commander.zone;
  const dealt = commander.damageDealt
    .filter((entry) => entry.damage > 0)
    .map((entry) => `, ${entry.damage} to ${name(entry.seat)}`)
    .join("");
  return `${commander.name}: ${zone}, tax ${commander.tax}${dealt}`;
}

/** The generated sigil in the portrait's diamond, drawn by the dom painter; named when it stands
 * in for a portrait that did not load. */
function Sigil({
  player,
  node,
  label,
}: {
  player: TablePlayer;
  node: PlayerNode;
  label?: string;
}) {
  return (
    <span
      className={`${styles.diamond} ${styles.portrait}`}
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true })}
      style={diamondStyle(node.portrait)}
    >
      <SigilSvg
        spec={sigilSpec(player.sigil.seed, player.sigil.grey)}
        size={node.portrait.side * Math.SQRT2}
      />
    </span>
  );
}

/** The player's picture in their diamond: their allied Planeswalker's portrait, upright in front
 * of the frame and fitted whole (grey for an opponent), or else the sigil. The scene draws it for
 * the webgl painter, so only its name is here then. A portrait that does not load keeps the
 * sigil. */
function Portrait({ player, node }: { player: TablePlayer; node: PlayerNode }) {
  const scene = useTableContext();
  const painted = scene.painter === "dom";
  const [failed, setFailed] = useState<string | null>(null);
  const id = isPortraitId(player.portrait) ? player.portrait : null;
  if (!id) return painted ? <Sigil player={player} node={node} /> : null;
  const label = `${portraitName(id)} portrait`;
  const box = portraitBox(node.portrait);
  if (!painted)
    return (
      <span
        className={styles.slot}
        role="img"
        aria-label={label}
        style={boxStyle(box)}
      />
    );
  const url = portraitUrl(
    id,
    portraitSize(box.w * (scene.fit?.resolution ?? 1)),
  );
  if (failed === url)
    return <Sigil player={player} node={node} label={label} />;
  const frame = diamondBox(node.portrait);
  return (
    <span
      className={styles.diamond}
      role="img"
      aria-label={label}
      data-portrait={id}
      style={boxStyle(frame)}
    >
      <img
        className={styles.picture}
        src={url}
        alt=""
        decoding="async"
        draggable={false}
        data-grey={player.sigil.grey || undefined}
        style={{
          left: box.x - frame.x,
          top: box.y - frame.y,
          width: box.w,
          height: box.h,
        }}
        onError={() => setFailed(url)}
      />
    </span>
  );
}

/** The portrait and life: a button when the prompt offers this player (P3), answering its one
 * option or opening a menu of several (defect 4); otherwise only the life, in words. */
function PlayerTarget({
  player,
  node,
}: {
  player: TablePlayer;
  node: PlayerNode;
}) {
  const game = useGameContext();
  const { ui } = useTableContext();
  const key = `player:${player.seat}`;
  const options = game.canAnswer ? player.offered : [];
  const menu = useOptionMenu(key, options.length);
  if (player.offered.length === 0)
    return (
      <span
        className={styles.slot}
        role="img"
        aria-label={player.targetLabel}
        style={boxStyle(node.target)}
      />
    );
  return (
    <div
      className={styles.slot}
      style={boxStyle(node.target)}
      data-menu={menu.open || undefined}
    >
      <button
        ref={menu.button}
        type="button"
        className={styles.hit}
        data-player={player.seat}
        data-hover={key}
        data-actionable
        data-selected={player.mark === "selected" || undefined}
        disabled={options.length === 0}
        aria-label={player.targetLabel}
        aria-haspopup={options.length > 1 ? "menu" : undefined}
        onClick={() => {
          if (options.length === 1) game.choose(options[0]);
          else if (options.length > 1) menu.show();
        }}
        onFocus={(event) =>
          noteFocus(ui, key, event.currentTarget, {
            hand: false,
            shows: null,
            anchorX: null,
          })
        }
        onBlur={() => noteBlur(ui, key, null)}
      />
      {menu.open && (
        <OptionMenu
          options={options}
          onClose={menu.close}
          onChoose={(option) => {
            menu.close(true);
            game.choose(option);
          }}
          // Your plate is at the bottom of the stage: its menu opens upwards.
          placement={player.anchored ? "above" : "below"}
          align={node.target.x + MENU.width > STAGE_W ? "end" : "start"}
        />
      )}
    </div>
  );
}

/** A count in its small diamond: hand and library by name, the graveyard's for the eye only (its
 * tile is the button). A Two-Headed Giant teammate's hand (v0.5.0) names its cards on hover. */
function Count({
  at,
  count,
  label,
  title,
}: {
  at: Diamond;
  count: number;
  label?: string;
  title?: string;
}) {
  return (
    <span
      className={styles.diamond}
      style={diamondStyle(at)}
      title={title}
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true })}
    >
      <span className={styles.count} style={{ fontSize: rem(at.side * 0.6) }}>
        {count}
      </span>
    </span>
  );
}

/** A library's pile: card backs, which never ask for an image. */
const back = {
  hidden: true,
  name: null,
  mana_cost: null,
  type_line: null,
  power: null,
  toughness: null,
  rules: [],
};

/** A zone tile: the graveyard, exile or command zone as a button that opens its browser; the
 * library as a pile on its pedestal, with its count. */
function Tile({
  tile,
  player,
  onBrowse,
}: {
  tile: ZoneTile;
  player: TablePlayer;
  onBrowse: (target: ZoneBrowserTarget) => void;
}) {
  const scene = useTableContext();
  const painted = scene.painter === "dom";
  const within = (r: Rect, origin: Rect): CSSProperties =>
    ({
      left: r.x - origin.x,
      top: r.y - origin.y,
      width: r.w,
      height: r.h,
      "--card-w": `${r.w}px`,
    }) as CSSProperties;
  if (!tile.hit || tile.zone === "library")
    return painted ? (
      <div className={styles.slot} style={boxStyle(tile.card)} aria-hidden>
        {tile.count > 0 ? (
          <div className={styles.paint} style={within(tile.card, tile.card)}>
            <CardFace card={{ ...back, id: tile.key }} />
          </div>
        ) : (
          <span className={styles.tileEmpty} />
        )}
        <span className={styles.tileCount}>{tile.count}</span>
      </div>
    ) : null;
  const zone: ZoneName = tile.zone;
  const keys = player[zone];
  const actionable = keys.some(
    (key) => (scene.model?.cards.get(key)?.offered.length ?? 0) > 0,
  );
  const top = tile.topKey ? scene.model?.cards.get(tile.topKey) : undefined;
  const hit = tile.hit;
  // Your command cards stand on the table as buttons of their own; their tile is the plate under
  // them, which says what the zone holds.
  const plate = player.anchored && zone === "command";
  return (
    <div className={styles.slot} style={boxStyle(hit)}>
      <button
        type="button"
        className={styles.hit}
        data-zone={zone}
        data-hover={tile.key}
        data-actionable={actionable || undefined}
        aria-label={tile.label}
        onClick={() => onBrowse({ kind: "zone", seat: player.seat, zone })}
        onFocus={(event) =>
          noteFocus(scene.ui, tile.key, event.currentTarget, {
            hand: false,
            shows: tile.topKey,
            anchorX: hit.x + hit.w / 2,
          })
        }
        onBlur={() => noteBlur(scene.ui, tile.key, tile.topKey)}
      >
        {painted && plate && (
          <span className={styles.plateText} aria-hidden="true">
            {tile.label}
          </span>
        )}
        {painted &&
          !plate &&
          (top ? (
            <div
              className={styles.paint}
              aria-hidden="true"
              style={within(tile.card, hit)}
            >
              <CardFace card={top.card} />
            </div>
          ) : (
            <span className={styles.tileEmpty} aria-hidden="true" />
          ))}
        {painted && !plate && (
          <span className={styles.tileCount} aria-hidden="true">
            {tile.count}
          </span>
        )}
      </button>
    </div>
  );
}

/** Mana in the pool, counters on the player, and commander damage taken. */
function StatusRow({
  player,
  node,
}: {
  player: TablePlayer;
  node: PlayerNode;
}) {
  const game = useGameContext();
  const p = player.player;
  const pool = poolColours.filter(([key]) => p.mana_pool[key] > 0);
  const from = (seat: Seat) => {
    const name = playerName(game.view, seat, game.observing);
    return name === "You" ? "your" : `${name}’s`;
  };
  return (
    <div
      className={styles.status}
      data-align={node.name.align}
      style={boxStyle(node.statusRow)}
    >
      {pool.length > 0 && (
        <span
          className={styles.chip}
          role="img"
          aria-label={`Mana pool: ${pool.map(([key]) => `${p.mana_pool[key]} ${key}`).join(", ")}`}
        >
          {pool.map(([key, symbol]) => (
            <span
              key={key}
              className={`${gameStyles.poolSymbol} ${styles.symbol}`}
              data-symbol={symbol}
            >
              {p.mana_pool[key]}
              {symbol}
            </span>
          ))}
        </span>
      )}
      {Object.entries(p.counters).map(([counter, count]) => (
        <span key={counter} className={styles.chip}>
          {count} {counter.replace(/_/g, " ")}
        </span>
      ))}
      {/* Partners may share a name with another player's commander, or each other's. */}
      {player.commanderDamageTaken.map((entry, i) => (
        <span
          key={`${i}:${entry.fromSeat}:${entry.commander}`}
          className={styles.chip}
        >
          {entry.damage} from {from(entry.fromSeat)} {entry.commander}
        </span>
      ))}
    </div>
  );
}

/** Your board and a lone opponent's open in the battlefield browser; at three or four players an
 * opponent's board expands in place, the others shrinking to chips (UI02). */
function BoardButton({
  player,
  node,
  onBrowse,
  onExpand,
}: {
  player: TablePlayer;
  node: PlayerNode;
  onBrowse: (target: ZoneBrowserTarget) => void;
  onExpand: (seat: Seat | null) => void;
}) {
  const scene = useTableContext();
  const arrangement = scene.layout?.arrangement ?? scene.model?.arrangement;
  const expandable =
    !player.anchored && arrangement !== undefined && arrangement !== "duel";
  const expanded = scene.layout?.expandedSeat === player.seat;
  const painted = scene.painter === "dom";
  return (
    <div className={styles.slot} style={diamondStyle(node.expand)}>
      {expandable ? (
        <button
          type="button"
          className={`${styles.hit} ${styles.more}`}
          aria-label={`Expand ${whose(player)} board`}
          aria-expanded={expanded}
          onClick={() => onExpand(expanded ? null : player.seat)}
        >
          {painted && (expanded ? "−" : "+")}
        </button>
      ) : (
        <button
          type="button"
          className={`${styles.hit} ${styles.more}`}
          aria-label={`Show ${whose(player)} board`}
          onClick={() => onBrowse({ kind: "battlefield", seat: player.seat })}
        >
          {painted && "⤢"}
        </button>
      )}
    </div>
  );
}

/** The response timer's bar under your phase, drawn in the DOM when the scene does not draw it. */
function TimerBar({ at }: { at: Rect }) {
  const { ui } = useTableContext();
  const share = useTableUi(ui, (s) =>
    s.timer &&
    s.timer.totalMs > 0 &&
    (s.timer.phase === "running" ||
      s.timer.phase === "paused" ||
      s.timer.phase === "arming")
      ? Math.max(0, Math.min(1, s.timer.remainingMs / s.timer.totalMs))
      : null,
  );
  if (share === null) return null;
  return (
    <span className={styles.bar} aria-hidden="true" style={boxStyle(at)}>
      <span style={{ width: `${share * 100}%` }} />
    </span>
  );
}

export function PlayerPlate({
  player,
  node,
  tiles,
  onBrowse,
  onExpand,
}: {
  player: TablePlayer;
  node: PlayerNode;
  tiles: ZoneTile[];
  onBrowse: (target: ZoneBrowserTarget) => void;
  onExpand: (seat: Seat | null) => void;
}) {
  const game = useGameContext();
  const scene = useTableContext();
  const painted = scene.painter === "dom";
  const p = player.player;
  const align = node.name.align;
  const phase = scene.model?.phase ?? null;
  const name = (seat: Seat) => {
    const text = playerName(game.view, seat, game.observing);
    return text === "You" ? "you" : text;
  };
  return (
    <div
      className={styles.plate}
      data-seat={player.seat}
      data-chip={node.chip || undefined}
    >
      <span
        className={styles.name}
        data-align={align}
        style={textStyle(node.name)}
        title={player.name}
      >
        {player.name}
      </span>
      {node.title && player.title && (
        <span
          className={styles.title}
          data-align={node.title.align}
          style={textStyle(node.title)}
          title={player.title}
        >
          {player.title}
        </span>
      )}
      <span
        className={styles.pills}
        data-align={align}
        style={boxStyle(node.pills)}
      >
        {player.teammate && (
          <span className={styles.pill} data-tone="team">
            Teammate · shared life
          </span>
        )}
        {player.active && <span className={styles.pill}>Active turn</span>}
        {player.priority && (
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
        <AlliancePills seat={player.seat} />
      </span>
      <AllianceControl seat={player.seat} node={node} />
      <Portrait key={player.portrait ?? ""} player={player} node={node} />
      <PlayerTarget player={player} node={node} />
      <span
        className={`${styles.diamond} ${styles.life}`}
        aria-hidden="true"
        style={diamondStyle(node.life)}
      >
        <span
          className={styles.numeral}
          style={{ fontSize: rem(Math.max(18, node.life.side * 0.5)) }}
        >
          {p.life}
        </span>
      </span>
      <Count
        at={node.counts.hand}
        count={p.hand_count}
        label={
          p.hand
            ? `${p.hand_count} cards in your teammate's hand: ${teammateHand(p.hand)}`
            : `${p.hand_count} cards in hand`
        }
        title={p.hand ? `Your teammate's hand: ${teammateHand(p.hand)}` : undefined}
      />
      <Count at={node.counts.graveyard} count={p.graveyard.length} />
      <Count
        at={node.counts.library}
        count={p.library_count}
        label={`${p.library_count} cards in library`}
      />
      {tiles.map((tile) => (
        <Tile key={tile.key} tile={tile} player={player} onBrowse={onBrowse} />
      ))}
      {!node.chip && <StatusRow player={player} node={node} />}
      {player.commanders.length > 0 && (
        <ul className={gameStyles.visuallyHidden}>
          {player.commanders.map((commander, i) => (
            <li key={`${i}:${commander.name}`}>
              {commanderWords(commander, name)}
            </li>
          ))}
        </ul>
      )}
      <BoardButton
        player={player}
        node={node}
        onBrowse={onBrowse}
        onExpand={onExpand}
      />
      {node.phase && phase && (
        <span
          className={styles.caption}
          aria-hidden="true"
          style={boxStyle(node.phase.caption)}
        >
          {phaseCaptions[phase] ?? words(phase)}
        </span>
      )}
      {node.phase && painted && <TimerBar at={node.phase.bar} />}
    </div>
  );
}
