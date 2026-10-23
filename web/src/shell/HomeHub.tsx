import { useEffect, useState, type CSSProperties, type RefObject } from "react";
import { Portrait } from "../alliance/Portrait";
import { client, type Me, type Planeswalker, type Progress } from "../api";
import { DailyQuests } from "../quests/DailyQuests";
import { formatNames } from "../tables/tables";
import type { Hud } from "./hud";
import { Embers } from "./Embers";
import { hoverSound, selectSound } from "./menuSound";
import { Icon, type IconName } from "./pages";
import styles from "./shell.module.css";

/** What the tiles say of the account, each asked for alone: one that fails leaves its tile plain. */
interface HubData {
  /** A game of the account's still running, to resume. */
  game?: string;
  /** The format whose public queue the account waits in (v0.5.0). */
  queue?: string;
  tables?: number;
  decks?: number;
  online?: number;
  ally?: Planeswalker;
}

function useHubData(me: Me): HubData {
  const [data, setData] = useState<HubData>({});
  useEffect(() => {
    let active = true;
    const merge = (part: HubData) => {
      if (active) setData((current) => ({ ...current, ...part }));
    };
    void client.GET("/api/v1/games").then(({ data }) => {
      if (data)
        merge({ game: data.find((game) => game.status === "active")?.id });
    });
    if (me.permissions.includes("games.play"))
      void client.GET("/api/v1/queue").then(({ data }) => {
        // Since v0.5.1 also Two-Headed Giant's queue, and a friend invited to it.
        if (
          (data?.status === "waiting" || data?.status === "inviting") &&
          data.format
        )
          merge({ queue: formatNames[data.format] });
      });
    void client.GET("/api/v1/tables").then(({ data }) => {
      if (data)
        merge({
          tables: data.filter((table) => table.status === "open").length,
        });
    });
    void client.GET("/api/v1/decks").then(({ data }) => {
      if (data)
        merge({
          decks: data.filter((deck) => !deck.archived && !deck.deleted_at)
            .length,
        });
    });
    void client.GET("/api/v1/friends").then(({ data }) => {
      if (data)
        merge({
          online: data.friends.filter(
            (friend) => friend.presence && friend.presence.state !== "offline",
          ).length,
        });
    });
    if (me.alliance)
      void client.GET("/api/v1/planeswalkers").then(({ data }) => {
        if (data) merge({ ally: data.find((pw) => pw.id === me.alliance) });
      });
    return () => {
      active = false;
    };
  }, [me.id, me.alliance]);
  return data;
}

function count(value: number | undefined, one: string, many: string) {
  if (value === undefined) return undefined;
  return `${value.toLocaleString("en-US")} ${value === 1 ? one : many}`;
}

/** Of the way from this tier to the next, how far the account's wins have come: 0 to 1. */
function climb(progress: Progress): number {
  const next = progress.next_tier;
  if (!next) return 1;
  const from = progress.tier.wins;
  return Math.min(1, Math.max(0, (progress.wins - from) / (next.wins - from)));
}

/**
 * The main menu (v0.4.5), the app's home as Magic Duels' was: the account's ally greets it beside
 * the way to play, and large tiles lead to every part of the game, each with what waits there.
 */
export function HomeHub({
  me,
  hud,
  heading,
}: {
  me: Me;
  hud: Hud;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const data = useHubData(me);
  const name = me.handle ?? me.display_name;
  const progress = hud.progress;
  return (
    <div className={styles.hub}>
      <Embers />
      <section className={styles.welcome} aria-labelledby="hub-title">
        <div className={styles.allyStage}>
          {me.alliance ? (
            <Portrait
              id={me.alliance}
              name={data.ally?.name}
              description={data.ally?.description}
              portrait={data.ally?.portrait}
              size={320}
              className={styles.ally}
            />
          ) : (
            <img
              className={styles.allyMark}
              src="/brand/mark-384.webp"
              alt=""
              width={192}
              height={192}
            />
          )}
        </div>
        <div className={styles.welcomeWords}>
          <span className={styles.kicker}>
            {data.ally
              ? `Allied with ${data.ally.name}`
              : "Welcome, planeswalker"}
          </span>
          <h1 id="hub-title" ref={heading} tabIndex={-1}>
            Welcome back, <em>{name}</em>
          </h1>
          {progress && me.kind !== "sysop" && (
            <div className={styles.tier}>
              <span className={styles.tierName}>{progress.tier.name}</span>
              <span>
                {progress.wins.toLocaleString("en-US")}{" "}
                {progress.wins === 1 ? "win" : "wins"}
                {progress.next_tier &&
                  ` · ${progress.next_tier.name} at ${progress.next_tier.wins.toLocaleString("en-US")}`}
              </span>
              <span
                className={styles.tierBar}
                role="progressbar"
                aria-label={
                  progress.next_tier
                    ? `Wins towards ${progress.next_tier.name}`
                    : "The highest tier"
                }
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(climb(progress) * 100)}
              >
                <span style={{ width: `${climb(progress) * 100}%` }} />
              </span>
            </div>
          )}
          {!me.alliance && (
            <a className={styles.quiet} href="#profile">
              Choose an ally on your profile <span aria-hidden="true">→</span>
            </a>
          )}
        </div>
      </section>
      <section className={styles.tiles} aria-label="Main menu">
        <Tile
          href={
            data.game ? `#game/${data.game}` : data.queue ? "#find" : "#play"
          }
          className={styles.playTile}
          icon="play"
          title="Play"
          lead="Find a game, or battle the bots in Legacy or Commander."
          meta={
            data.game
              ? "A game is waiting for you"
              : data.queue
                ? `Looking for a ${data.queue} game`
                : undefined
          }
          action={
            data.game
              ? "Resume your game"
              : data.queue
                ? "See your place"
                : "Play now"
          }
          index={0}
        />
        <Tile
          href="#tables"
          className={styles.tablesTile}
          icon="tables"
          title="Tables"
          lead="Sit down with other players."
          meta={
            data.tables === 0
              ? "Open the first table"
              : count(data.tables, "open table", "open tables")
          }
          index={1}
        />
        <Tile
          href="#shop"
          className={styles.shopTile}
          icon="shop"
          title="Leng's Card Shop"
          lead="Packs from every era, priced in tokens."
          meta="Five packs 20% off this week"
          index={2}
        />
        <Tile
          href="#decks"
          icon="decks"
          title="Decks"
          lead="Build, tune and share your decks."
          meta={count(data.decks, "deck", "decks")}
          index={3}
        />
        <Tile
          href="#cards"
          icon="cards"
          title="Cards"
          lead="Every card you can play, and your library."
          meta={me.alliance ? "Your ally's cards too" : undefined}
          index={4}
        />
        <Tile
          href="#friends"
          icon="friends"
          title="Friends"
          lead="Find players, chat and play together."
          meta={
            data.online
              ? count(data.online, "friend online", "friends online")
              : undefined
          }
          index={5}
        />
      </section>
      {/* Today's three quests and the day's swap (v0.5.0). */}
      <DailyQuests />
    </div>
  );
}

function Tile({
  href,
  icon,
  title,
  lead,
  meta,
  action,
  className,
  index,
}: {
  href: string;
  icon: IconName;
  title: string;
  lead: string;
  meta?: string;
  action?: string;
  className?: string;
  index: number;
}) {
  return (
    <a
      href={href}
      className={[styles.tile, className].filter(Boolean).join(" ")}
      style={{ "--i": index } as CSSProperties}
      onPointerEnter={() => hoverSound()}
      onFocus={() => hoverSound()}
      onClick={selectSound}
    >
      <span className={styles.tileIcon}>
        <Icon name={icon} />
      </span>
      <span className={styles.tileWords}>
        <span className={styles.tileTitle}>{title}</span>
        <span className={styles.tileLead}>{lead}</span>
        {meta && <span className={styles.tileMeta}>{meta}</span>}
      </span>
      {action && (
        <span className={styles.tileAction} aria-hidden="true">
          {action} <span>▶</span>
        </span>
      )}
    </a>
  );
}
