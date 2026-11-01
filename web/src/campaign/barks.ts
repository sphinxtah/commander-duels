import type {
  GameView,
  LogLine,
  PermanentView,
  PlayerView,
  Prompt,
  Seat,
} from "../game/types";

// What a campaign duel says while it is played (v0.8.0): the opponents' barks, the finale's
// incarnation and Kaya's tutorial lessons, each read from the seat's own views and the public log,
// as the table's effects are. The engine knows nothing of them: the handoff's events (FIRST_BOSS_*
// and the like) are recognised here from what changed between two views, as nearly as a view
// shows it. A bark whose moment the views cannot show plays when the nearest sign does, or not at
// all ("the runtime may omit barks that no longer match the state"). Pure functions, tested in
// barks.test.ts.

/** What the campaign reads of one view. */
export interface Observation {
  turn: number;
  youSeat: Seat;
  bossSeat: Seat | null;
  you: Side;
  boss: Side;
  /** The boss's attack under way: its attackers' total power, and whether any has haste. */
  bossAttack: { power: number; haste: boolean } | null;
  /** Whether a creature of yours blocks in the combat under way. */
  youBlock: boolean;
  /** Items on the stack by their controller. */
  stack: { yours: number; boss: number };
  /** Spells you have cast this turn, by the log. */
  yourSpellsThisTurn: number;
  /** New log lines since the last observation. */
  fresh: string[];
}

export interface Side {
  life: number;
  creatures: number;
  artifacts: number;
  lands: number;
  permanents: number;
  graveyard: number;
  exile: number;
  library: number;
  /** Permanents you own that the other side controls (theft and exchanges). */
  stolen: number;
  /** Planeswalkers on the battlefield, with their loyalty. */
  walkers: { id: string; name: string; loyalty: number }[];
  /** The first commander's casts from the command zone, and where it is. */
  commanderCasts: number;
  commanderZone: string | null;
  /** The largest number of colours in a permanent's mana cost. */
  colorful: number;
}

function typeOf(permanent: PermanentView): string {
  return permanent.card.type_line ?? "";
}

function colorsIn(cost: string | null): number {
  if (!cost) return 0;
  return new Set(cost.match(/[WUBRG]/g) ?? []).size;
}

function sideOf(
  view: GameView,
  player: PlayerView | null | undefined,
  seat: Seat | null,
): Side {
  const mine =
    seat === null
      ? []
      : view.battlefield.filter((p) => p.controller_seat === seat);
  const commander = player?.commanders[0];
  return {
    life: player?.life ?? 0,
    creatures: mine.filter((p) => typeOf(p).includes("Creature")).length,
    artifacts: mine.filter((p) => typeOf(p).includes("Artifact")).length,
    lands: mine.filter((p) => typeOf(p).includes("Land")).length,
    permanents: mine.length,
    graveyard: player?.graveyard.length ?? 0,
    exile: player?.exile.length ?? 0,
    library: player?.library_count ?? 0,
    stolen:
      seat === null
        ? 0
        : view.battlefield.filter(
            (p) => p.owner_seat === seat && p.controller_seat !== seat,
          ).length,
    walkers: mine
      .filter((p) => typeOf(p).includes("Planeswalker"))
      .map((p) => ({
        id: p.id,
        name: p.card.name ?? "",
        loyalty: p.counters.loyalty ?? 0,
      })),
    commanderCasts: commander?.cast_count ?? 0,
    commanderZone: commander?.zone ?? null,
    colorful: Math.max(0, ...mine.map((p) => colorsIn(p.card.mana_cost))),
  };
}

/** The view as the campaign reads it. The boss is the first opponent. */
export function observe(
  view: GameView,
  log: LogLine[],
  seenLog: number,
): Observation {
  const youSeat = view.seat ?? 0;
  const bossPlayer = view.opponents[0] ?? null;
  const bossSeat = bossPlayer?.seat ?? null;
  const byId = new Map(view.battlefield.map((p) => [p.id, p]));
  let power = 0;
  let haste = false;
  let attacking = false;
  let youBlock = false;
  for (const group of view.combat) {
    for (const id of group.attackers) {
      const attacker = byId.get(id);
      if (attacker && attacker.controller_seat === bossSeat) {
        attacking = true;
        power += Number.parseInt(attacker.card.power ?? "0", 10) || 0;
        if (attacker.card.rules.some((rule) => /\bhaste\b/i.test(rule)))
          haste = true;
      }
    }
    for (const id of group.blockers) {
      if (byId.get(id)?.controller_seat === youSeat) youBlock = true;
    }
  }
  const yourName = view.you?.name ?? "Human 1";
  const turnLines = log.filter((line) => line.turn === view.turn);
  const casting = new RegExp(`^${escape(yourName)} casts\\b`);
  return {
    turn: view.turn,
    youSeat,
    bossSeat,
    you: sideOf(view, view.you, youSeat),
    boss: sideOf(view, bossPlayer, bossSeat),
    bossAttack: attacking ? { power, haste } : null,
    youBlock,
    stack: {
      yours: view.stack.filter((item) => item.controller_seat === youSeat)
        .length,
      boss: view.stack.filter((item) => item.controller_seat === bossSeat)
        .length,
    },
    yourSpellsThisTurn: turnLines.filter((line) => casting.test(line.text))
      .length,
    fresh: log.filter((line) => line.index >= seenLog).map((line) => line.text),
  };
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Memory a duel keeps between observations: what happened before, for the triggers that need
 * it (a large attack survived, a sweep rebuilt from, a theft undone, the incarnation's way). */
export interface Memory {
  largeAttack: boolean;
  wiped: boolean;
  stolen: boolean;
  /** The finale: the incarnation has crossed, has been removed, and how often it came back. */
  arrived: boolean;
  removed: boolean;
  returns: number;
  lastReturnTurn: number;
}

export const FRESH_MEMORY: Memory = {
  largeAttack: false,
  wiped: false,
  stolen: false,
  arrived: false,
  removed: false,
  returns: 0,
  lastReturnTurn: -99,
};

/** Whether a bark's trigger fires between two observations. */
export function fires(
  trigger: string,
  before: Observation | null,
  now: Observation,
  memory: Memory,
): boolean {
  const was = before;
  const fresh = now.fresh.join("\n");
  switch (trigger) {
    case "FIRST_PLAYER_CREATURE":
      return now.you.creatures > 0 && (was?.you.creatures ?? 0) === 0;
    case "BOSS_LIFE_AT_OR_BELOW_10":
      return crossed(was?.boss.life, now.boss.life, 10);
    case "BOSS_LIFE_AT_OR_BELOW_5":
      return crossed(was?.boss.life, now.boss.life, 5);
    case "FIRST_BOSS_ARTIFACT_RECURSION":
    case "FIRST_BOSS_RECURSION_ENGINE":
    case "FIRST_BOSS_REANIMATION":
      // A card left the boss's graveyard as the boss's battlefield grew.
      return (
        !!was &&
        now.boss.graveyard < was.boss.graveyard &&
        now.boss.permanents > was.boss.permanents
      );
    case "FIRST_PLAYER_ARTIFACT_REMOVAL":
      return !!was && now.boss.artifacts < was.boss.artifacts;
    case "FIRST_BOSS_HASTE_ATTACK":
      return (
        !!now.bossAttack &&
        (now.bossAttack.haste || now.bossAttack.power >= 3) &&
        !was?.bossAttack
      );
    case "FIRST_LARGE_HASTY_ATTACK":
      return !!now.bossAttack && now.bossAttack.power >= 6 && !was?.bossAttack;
    case "PLAYER_SURVIVES_LARGE_ATTACK":
      return memory.largeAttack && !now.bossAttack && now.you.life > 0;
    case "FIRST_FAVORABLE_PLAYER_BLOCK":
      return now.youBlock && !was?.youBlock;
    case "FIRST_BOSS_COUNTERSPELL":
    case "BOSS_COUNTERS_A_SPELL":
      return /\bcountered\b/i.test(fresh) && (was?.stack.yours ?? 0) > 0;
    case "PLAYER_STOPS_FIRST_COMBO":
      return /\bcountered\b/i.test(fresh) && (was?.stack.boss ?? 0) > 0;
    case "FIRST_PLAYER_SECOND_SPELL_SAME_TURN":
      return now.yourSpellsThisTurn >= 2 && (was?.yourSpellsThisTurn ?? 0) < 2;
    case "FIRST_BOSS_TRANSFORMATION_OR_THEFT":
    case "FIRST_BOSS_THEFT":
      return now.you.stolen > 0 && (was?.you.stolen ?? 0) === 0;
    case "PLAYER_REGAINS_CONTROL_OR_REMOVES_THEFT_SOURCE":
      return (
        memory.stolen && now.you.stolen === 0 && (was?.you.stolen ?? 0) > 0
      );
    case "PLAYER_RECASTS_COMMANDER":
      return now.you.commanderCasts >= 2 && (was?.you.commanderCasts ?? 0) < 2;
    case "FIRST_PLAYER_GRAVEYARD_EXILE":
      return (
        !!was &&
        now.boss.graveyard < was.boss.graveyard &&
        now.boss.exile > was.boss.exile
      );
    case "FIRST_BOSS_FIVE_COLOR_PAYOFF":
      return now.boss.colorful >= 3 && (was?.boss.colorful ?? 0) < 3;
    case "PLAYER_DISRUPTS_FIXING":
      return !!was && now.boss.lands < was.boss.lands;
    case "FIRST_BOSS_EXILE_OR_MILL":
      return (
        !!was &&
        (now.you.exile > was.you.exile ||
          now.you.graveyard - was.you.graveyard >= 3)
      );
    case "PLAYER_LOW_LIBRARY":
      return (
        now.you.library > 0 &&
        now.you.library <= 15 &&
        (was?.you.library ?? 99) > 15
      );
    case "FIRST_BOSS_SACRIFICE_OR_DRAIN":
      return (
        !!was &&
        ((now.you.life < was.you.life && now.boss.life > was.boss.life) ||
          (now.boss.creatures < was.boss.creatures &&
            now.boss.graveyard > was.boss.graveyard &&
            !now.bossAttack &&
            !was.bossAttack))
      );
    case "PLAYER_REBUILDS_AFTER_WIPE":
      return (
        memory.wiped && now.you.creatures >= 2 && (was?.you.creatures ?? 0) < 2
      );
    case "FIRST_BOSS_PROTECTED_COMBO_ATTEMPT":
      return now.stack.boss >= 2 && (was?.stack.boss ?? 0) < 2;
    case "BOSS_TUTOR_FROM_INCARNATION":
      return (
        !!was &&
        now.boss.walkers.some((walker) =>
          was.boss.walkers.some(
            (old) => old.id === walker.id && walker.loyalty === old.loyalty + 2,
          ),
        )
      );
    case "BOSS_COMMANDER_REGENERATES":
      return /\bregenerat/i.test(fresh);
    case "BOSS_ARMY":
      return now.boss.creatures >= 5 && (was?.boss.creatures ?? 0) < 5;
    case "INCARNATION_LOYALTY_AT_LEAST_10":
      return (
        now.boss.walkers.some((walker) => walker.loyalty >= 10) &&
        !(was?.boss.walkers.some((walker) => walker.loyalty >= 10) ?? false)
      );
    default:
      return false;
  }
}

function crossed(before: number | undefined, now: number, at: number): boolean {
  return now <= at && now > 0 && (before ?? Number.POSITIVE_INFINITY) > at;
}

/** The duel's memory after an observation. */
export function remember(
  memory: Memory,
  before: Observation | null,
  now: Observation,
): Memory {
  const sweep =
    !!before &&
    before.you.creatures +
      before.boss.creatures -
      (now.you.creatures + now.boss.creatures) >=
      3;
  return {
    ...memory,
    largeAttack: now.bossAttack
      ? memory.largeAttack || now.bossAttack.power >= 6
      : false,
    wiped: memory.wiped || sweep,
    stolen: memory.stolen || now.you.stolen > 0,
  };
}

/** The finale's incarnation, as the views show it: a planeswalker of the boss's coming onto the
 * battlefield once its life is at 15 or less (its first crossing), leaving it, and coming back. */
export type Incarnation = "arrived" | "removed" | "returned" | null;

export function incarnation(
  before: Observation | null,
  now: Observation,
  memory: Memory,
): Incarnation {
  if (!before) return null;
  const had = before.boss.walkers.length;
  const has = now.boss.walkers.length;
  if (!memory.arrived) {
    return has > had && now.boss.life <= 15 ? "arrived" : null;
  }
  if (has < had) return "removed";
  if (has > had && memory.removed) return "returned";
  return null;
}

/** A tutorial lesson whose moment has come (the handoff's T01 to T11; T12 is the victory's). */
export function lesson(
  id: string,
  before: Observation | null,
  now: Observation,
  prompt: Prompt | null,
  view: GameView,
): boolean {
  const options = prompt?.options ?? [];
  const yourTurn = view.active_seat === now.youSeat;
  switch (id) {
    case "T01":
      return true;
    case "T02":
      return prompt?.kind === "mulligan";
    case "T03":
      return (
        yourTurn &&
        prompt?.kind === "priority" &&
        options.some((option) => option.action === "play_land")
      );
    case "T04":
      return prompt?.kind === "pay_mana";
    case "T05": {
      const commander = view.you?.commanders[0];
      return (
        commander?.zone === "command" &&
        options.some(
          (option) =>
            option.action === "cast" &&
            ((commander.object_id !== null &&
              option.object_id === commander.object_id) ||
              (option.label ?? "").includes(commander.name)),
        )
      );
    }
    case "T06":
      return now.you.creatures > (before?.you.creatures ?? 0);
    case "T07":
      return prompt?.kind === "declare_attackers";
    case "T08":
      return prompt?.kind === "declare_blockers";
    case "T09":
      return prompt?.kind === "priority" && now.stack.boss > 0;
    case "T10":
      return (
        /command zone/i.test(
          `${prompt?.message ?? ""} ${prompt?.detail ?? ""}`,
        ) &&
        (prompt?.kind === "yes_no" || prompt?.kind === "choose_choice")
      );
    case "T11":
      return now.boss.life > 0 && now.boss.life <= 10;
    default:
      return false;
  }
}
