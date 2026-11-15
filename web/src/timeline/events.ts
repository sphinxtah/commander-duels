// The timeline's words (v1.0.0, docs/timeline.md): a game's structured events (docs/engine/events.md),
// as the API's one filter shows them to this reader, made into sentences a player can read, each
// with what explains it and the rule that says so. Nothing here knows more than the events do:
// where they carry no reason, the line says that the game recorded none.

/** A card or permanent the reader may see. */
export interface Card {
  ref: string;
  name: string | null;
  owner?: number | null;
  /** Its id where it was before a move. */
  was?: string;
  /** A spell's printed cost (events' version 2). */
  mana_cost?: string;
}
/** One the reader may not see: only whose it is. */
export interface Hidden {
  hidden: true;
  owner?: number | null;
}
export interface SeatRef {
  seat: number | null;
}
export type Thing = Card | Hidden | SeatRef;

export interface CostChange {
  how: "more" | "less" | "set";
  /** Commander tax (903.8), with how much it added. */
  tax?: boolean;
  amount?: number;
  by?: Thing | null;
}
export interface Cost {
  paid: string;
  x?: number;
  mode?: string;
  changes?: CostChange[];
}

export interface GameEvent {
  v: number;
  seq: number;
  epoch: number;
  turn: number;
  step: string | null;
  type: string;
  player?: number | null;
  active?: number | null;
  object?: Thing | null;
  target?: Thing | null;
  cause?: Thing | null;
  from?: string | null;
  to?: string | null;
  amount?: number | null;
  combat?: boolean;
  counter?: string | null;
  cost?: Cost;
  why?: string;
  of?: "spell" | "ability";
  immediate?: boolean;
}

export function isSeat(thing: Thing | null | undefined): thing is SeatRef {
  return !!thing && "seat" in thing;
}
export function isHidden(thing: Thing | null | undefined): thing is Hidden {
  return !!thing && "hidden" in thing;
}
export function isCard(thing: Thing | null | undefined): thing is Card {
  return !!thing && "ref" in thing;
}

/** A piece of a sentence: words, a card to look at, a card the reader may not see, a player, a
 * mana cost, or a rule to read in How to play. */
export type Piece =
  | string
  | { card: Card }
  | { hidden: Hidden }
  | { seat: number }
  | { cost: string }
  | { rule: string };

export type GroupId = "spells" | "combat" | "damage" | "moves" | "counters";

/** The kinds a reader narrows the timeline to, and the events' types each one asks for. */
export const GROUPS: { id: GroupId; label: string; types: string[] }[] = [
  {
    id: "spells",
    label: "Spells and abilities",
    types: [
      "cast",
      "activate",
      "trigger",
      "target",
      "resolve",
      "countered",
      "fizzled",
    ],
  },
  { id: "combat", label: "Combat", types: ["attack", "block"] },
  {
    id: "damage",
    label: "Damage and life",
    types: ["damage", "life_gained", "life_lost", "eliminated", "won"],
  },
  { id: "moves", label: "Cards moving", types: ["zone_change"] },
  {
    id: "counters",
    label: "Counters and tokens",
    types: ["counters_added", "counters_removed", "token_created"],
  },
];

const GROUP_OF = new Map<string, GroupId>(
  GROUPS.flatMap((group) => group.types.map((type) => [type, group.id])),
);

/** The types to ask the server for: the chosen kinds'. A page says whose turn its turns were. */
export function typesFor(groups: ReadonlySet<GroupId>): string[] {
  return GROUPS.filter((group) => groups.has(group.id)).flatMap(
    (group) => group.types,
  );
}

export interface Note {
  text: Piece[];
  /** The honest fallback: the events carry no explanation. */
  unknown?: boolean;
}

export interface Line {
  seq: number;
  turn: number;
  step: string | null;
  group: GroupId;
  text: Piece[];
  notes: Note[];
  /** Bookkeeping another line already tells (a card put onto the stack as it is cast, a land
   * tapped for mana): shown only when every event is asked for. */
  quiet: boolean;
  /** A spell or ability that finished resolving here: what follows it is what it changed. */
  resolution: boolean;
}

/** The rules the timeline cites, in one place: Wizards renumbers the keyword actions (701) when
 * it adds one, so these two are the ones to look at after a rules update. */
export const RULES = {
  totalCost: "601.2f",
  commanderTax: "903.8",
  illegalTargets: "608.2b",
  interveningIf: "603.4",
  countered: "701.6",
  destroyed: "701.8",
  sacrificed: "701.21",
  toughness: "704.5f",
  lethalDamage: "704.5g",
  deathtouch: "704.5h",
  loyalty: "704.5i",
  legendRule: "704.5j",
  unattached: "704.5m",
  commanderMoves: "903.9a",
  manaAbility: "605.3b",
} as const;

const STEPS: Record<string, string> = {
  untap: "Untap",
  upkeep: "Upkeep",
  draw: "Draw",
  precombat_main: "Main phase",
  begin_combat: "Beginning of combat",
  declare_attackers: "Declare attackers",
  declare_blockers: "Declare blockers",
  first_combat_damage: "First-strike damage",
  combat_damage: "Combat damage",
  end_combat: "End of combat",
  postcombat_main: "Second main phase",
  end_turn: "End step",
  cleanup: "Cleanup",
};

/** A step's name as the table's band says it. */
export function stepWords(step: string | null): string {
  if (!step) return "";
  return STEPS[step] ?? step.replace(/_/g, " ");
}

const ZONES: Record<string, string> = {
  library: "library",
  hand: "hand",
  battlefield: "the battlefield",
  graveyard: "graveyard",
  stack: "the stack",
  exiled: "exile",
  command: "the command zone",
};
function zoneWords(zone: string | null | undefined): string {
  return zone ? (ZONES[zone] ?? zone) : "nowhere";
}

function piece(thing: Thing | null | undefined, unseen = "a card"): Piece {
  if (isCard(thing)) return { card: thing };
  if (isHidden(thing)) return { hidden: thing };
  if (isSeat(thing) && thing.seat !== null) return { seat: thing.seat };
  return unseen;
}
function seatPiece(seat: number | null | undefined): Piece {
  return typeof seat === "number" ? { seat } : "A player";
}
/** "Ada's", for the owner of a card. */
function owners(
  thing: Thing | null | undefined,
  fallback?: number | null,
): Piece[] {
  const seat =
    (isCard(thing) || isHidden(thing) ? thing.owner : null) ?? fallback;
  return typeof seat === "number" ? [{ seat }, "’s "] : ["its owner’s "];
}
function by(cause: Thing | null | undefined): Piece[] {
  return cause ? [", by ", piece(cause, "a hidden card")] : [];
}
function plural(amount: number, one: string, many = `${one}s`): string {
  return amount === 1 ? one : many;
}

const UNKNOWN = "The game recorded no reason.";

/** What the events before a departure say of the damage a permanent took this turn. */
interface Hurt {
  amount: number;
  sources: Thing[];
}

/** A cast's cost in a sentence, and what explains a cost that is not the printed one. */
function costNotes(event: GameEvent): Note[] {
  const cost = event.cost;
  if (!cost) return [];
  const printed = isCard(event.object) ? event.object.mana_cost : undefined;
  const notes: Note[] = [];
  const changes = cost.changes ?? [];
  if (cost.x !== undefined) notes.push({ text: [`X was ${cost.x}.`] });
  if (cost.mode)
    notes.push({
      text: [
        `Cast another way than for its printed cost: ${cost.mode.replace(/_/g, " ")}.`,
      ],
    });
  for (const change of changes) {
    if (change.tax) {
      notes.push({
        text: [
          "Commander tax: ",
          { cost: `{${change.amount ?? 2}}` },
          " more, ",
          { cost: "{2}" },
          " for each time it was cast from the command zone before. ",
          { rule: RULES.commanderTax },
        ],
      });
      continue;
    }
    const words =
      change.how === "more"
        ? "Its cost was raised by "
        : change.how === "less"
          ? "Its cost was reduced by "
          : "Its cost was set by ";
    notes.push({
      text: [
        words,
        piece(change.by, "a hidden card"),
        ". ",
        { rule: RULES.totalCost },
      ],
    });
  }
  if (
    printed &&
    printed !== cost.paid &&
    changes.length === 0 &&
    cost.x === undefined &&
    !cost.mode
  )
    notes.push({
      unknown: true,
      text: [
        "Its printed cost is ",
        { cost: printed },
        ". The game recorded no reason for the difference: an additional or alternative cost, or an effect that no longer applied once it was cast.",
      ],
    });
  else if (printed && printed !== cost.paid)
    notes.unshift({ text: ["Its printed cost is ", { cost: printed }, "."] });
  return notes;
}

/** Why a permanent left the battlefield, as the events' version 2 says it. */
function departure(
  event: GameEvent,
  hurt: Hurt | undefined,
): { verb: string; notes: Note[] } {
  const damage: Note[] = hurt
    ? [
        {
          text: [
            `It had been dealt ${hurt.amount} damage this turn`,
            ...(hurt.sources.length
              ? [
                  ", by ",
                  ...hurt.sources.flatMap((source, index) => [
                    ...(index ? [" and "] : []),
                    piece(source, "a hidden card"),
                  ]),
                ]
              : []),
            ".",
          ],
        },
      ]
    : [];
  switch (event.why) {
    case "lethal_damage":
      return {
        verb: " died",
        notes: [
          {
            text: [
              "Lethal damage: the damage on it was at least its toughness, so the rules destroyed it. ",
              { rule: RULES.lethalDamage },
            ],
          },
          ...damage,
        ],
      };
    case "deathtouch":
      return {
        verb: " died",
        notes: [
          {
            text: [
              "It was dealt damage by a source with deathtouch, so the rules destroyed it. ",
              { rule: RULES.deathtouch },
            ],
          },
          ...damage,
        ],
      };
    case "toughness":
      return {
        verb: " died",
        notes: [
          {
            text: [
              "Its toughness was 0 or less, so the rules put it into the graveyard. This is not destruction: indestructible and regeneration do not stop it. ",
              { rule: RULES.toughness },
            ],
          },
        ],
      };
    case "loyalty":
      return {
        verb: " left the battlefield",
        notes: [
          {
            text: [
              "It had no loyalty left, so the rules put it into the graveyard. ",
              { rule: RULES.loyalty },
            ],
          },
        ],
      };
    case "legend_rule":
      return {
        verb: " left the battlefield",
        notes: [
          {
            text: [
              "The legend rule: its player controlled two legendary permanents with this name and kept the other. ",
              { rule: RULES.legendRule },
            ],
          },
        ],
      };
    case "unattached":
      return {
        verb: " left the battlefield",
        notes: [
          {
            text: [
              "An Aura attached to nothing it can enchant is put into the graveyard. ",
              { rule: RULES.unattached },
            ],
          },
        ],
      };
    case "destroyed":
      return {
        verb: " was destroyed",
        notes: [
          {
            text: [
              ...(event.cause
                ? ["Destroyed by ", piece(event.cause, "a hidden card"), ". "]
                : ["Destroyed. "]),
              { rule: RULES.destroyed },
            ],
          },
        ],
      };
    case "sacrificed":
      return {
        verb: " was sacrificed",
        notes: [
          {
            text: [
              ...(event.cause
                ? ["Sacrificed for ", piece(event.cause, "a hidden card"), ". "]
                : []),
              "A sacrifice is not destruction: indestructible and regeneration do not stop it. ",
              { rule: RULES.sacrificed },
            ],
          },
        ],
      };
    default:
      if (event.cause) return { verb: " left the battlefield", notes: damage };
      return {
        verb: " left the battlefield",
        notes: [
          ...damage,
          {
            unknown: true,
            text: [
              hurt
                ? "The game recorded no reason beyond that damage."
                : UNKNOWN,
            ],
          },
        ],
      };
  }
}

/** A card's move between zones, in words. */
function move(
  event: GameEvent,
  hurt: Hurt | undefined,
  settled: boolean,
): Pick<Line, "text" | "notes" | "quiet" | "group" | "resolution"> {
  const card = piece(event.object);
  const player = seatPiece(event.player);
  const whose = owners(event.object, event.player);
  const cause = by(event.cause);
  const plain = {
    notes: [],
    quiet: false,
    group: "moves" as GroupId,
    resolution: false,
  };
  const route = `${event.from}>${event.to}`;
  if (event.to === "stack")
    return {
      ...plain,
      quiet: true,
      text: [
        card,
        " was put onto the stack from ",
        ...whose,
        zoneWords(event.from),
        ".",
      ],
    };
  if (event.from === "battlefield") {
    const left = departure(event, hurt);
    const toGraveyard = event.to === "graveyard";
    // Destroyed and sacrificed are said of a permanent wherever it went (a commander goes to
    // the command zone instead); "died" only of one that reached the graveyard.
    const named = event.why === "destroyed" || event.why === "sacrificed";
    const verb =
      event.why && (toGraveyard || named) ? left.verb : " left the battlefield";
    const where: Piece[] = toGraveyard
      ? event.why
        ? []
        : [": to ", ...whose, "graveyard"]
      : event.to === "exiled"
        ? [": it was exiled"]
        : event.to === "hand"
          ? [": to ", ...whose, "hand"]
          : event.to === "library"
            ? [": into ", ...whose, "library"]
            : [": to ", zoneWords(event.to)];
    return {
      ...plain,
      text: [card, verb, ...where, ...(named ? [] : cause), "."],
      // Only a death is owed a reason: a permanent exiled or returned by no named source says so
      // by its destination alone.
      notes:
        toGraveyard || event.why
          ? left.notes
          : left.notes.filter((note) => !note.unknown),
    };
  }
  switch (route) {
    case "library>hand":
      return { ...plain, text: [player, " drew ", card, ...cause, "."] };
    case "hand>battlefield":
      return {
        ...plain,
        text: event.cause
          ? [
              card,
              " was put onto the battlefield from ",
              ...whose,
              "hand",
              ...cause,
              ".",
            ]
          : [player, " played ", card, "."],
      };
    case "stack>battlefield":
      return {
        ...plain,
        group: "spells",
        resolution: true,
        text: [card, " resolved and entered the battlefield."],
      };
    case "stack>graveyard":
      return settled
        ? {
            ...plain,
            quiet: true,
            text: [
              card,
              " was put into ",
              ...whose,
              "graveyard from the stack.",
            ],
          }
        : {
            ...plain,
            group: "spells",
            text: [
              card,
              " left the stack for ",
              ...whose,
              "graveyard",
              ...cause,
              ".",
            ],
            notes: event.cause
              ? []
              : [
                  {
                    unknown: true,
                    text: [
                      "The game recorded no resolution for it and no reason why it left the stack.",
                    ],
                  },
                ],
          };
    case "hand>graveyard":
      return { ...plain, text: [player, " discarded ", card, ...cause, "."] };
    case "library>graveyard":
      return {
        ...plain,
        text: [
          card,
          " was put into ",
          ...whose,
          "graveyard from their library",
          ...cause,
          ".",
        ],
      };
    case "graveyard>battlefield":
      return {
        ...plain,
        text: [
          card,
          " returned to the battlefield from ",
          ...whose,
          "graveyard",
          ...cause,
          ".",
        ],
      };
    case "graveyard>hand":
      return {
        ...plain,
        text: [
          card,
          " returned to ",
          ...whose,
          "hand from their graveyard",
          ...cause,
          ".",
        ],
      };
    case "graveyard>command":
    case "exiled>command":
      return {
        ...plain,
        text: [card, " was moved to the command zone."],
        notes: event.cause
          ? []
          : [
              {
                text: [
                  "A commander in a graveyard or in exile may be put into the command zone by its owner. ",
                  { rule: RULES.commanderMoves },
                ],
              },
            ],
      };
    default:
      return {
        ...plain,
        text: [
          card,
          " moved from ",
          ...whose,
          zoneWords(event.from),
          " to ",
          zoneWords(event.to),
          ...cause,
          ".",
        ],
      };
  }
}

/**
 * The events as lines, in their order. Steps are no lines: the reader heads each turn and step
 * from the lines' own `turn` and `step` (see `turnOwners`). What a line needs of the events before
 * it is kept on the way: the damage each permanent took this turn, for a death; the spells that
 * resolved, were countered or fizzled, so that their card's way to the graveyard is not a line.
 */
export function describe(events: readonly GameEvent[]): Line[] {
  const lines: Line[] = [];
  let turn = -1;
  let hurt = new Map<string, Hurt>();
  let settled = new Set<string>();
  for (const event of events) {
    if (event.turn !== turn) {
      turn = event.turn;
      hurt = new Map();
      settled = new Set();
    }
    const base = { seq: event.seq, turn: event.turn, step: event.step };
    const group = GROUP_OF.get(event.type) ?? "moves";
    const plain = {
      ...base,
      group,
      notes: [] as Note[],
      quiet: false,
      resolution: false,
    };
    const object = piece(event.object);
    const player = seatPiece(event.player);
    const name = (thing: Thing | null | undefined) =>
      isCard(thing) ? (thing.name ?? thing.ref) : null;
    switch (event.type) {
      case "step":
        break;
      case "zone_change": {
        const was = isCard(event.object)
          ? (event.object.was ?? event.object.ref)
          : "";
        const done =
          settled.has(was) || settled.has(name(event.object) ?? "\0");
        lines.push({ ...base, ...move(event, hurt.get(was), done) });
        break;
      }
      case "cast":
        lines.push({
          ...plain,
          text: [
            player,
            " cast ",
            piece(event.object, "a spell"),
            ...(event.cost ? [" for ", { cost: event.cost.paid }] : []),
            ".",
          ],
          notes: costNotes(event),
        });
        break;
      case "activate":
        lines.push({
          ...plain,
          text: [player, " activated an ability of ", object, "."],
        });
        break;
      case "trigger":
        lines.push({
          ...plain,
          text: ["An ability of ", object, " triggered, for ", player, "."],
        });
        break;
      case "target":
        lines.push({
          ...plain,
          text: [
            piece(event.cause, "A spell or ability"),
            " targets ",
            piece(event.target, "a hidden card"),
            ".",
          ],
        });
        break;
      case "resolve":
        if (isCard(event.object) && !event.immediate) {
          settled.add(event.object.ref);
          if (event.object.name) settled.add(event.object.name);
        }
        lines.push({
          ...plain,
          quiet: event.immediate === true,
          resolution: event.immediate !== true,
          text: event.immediate
            ? [object, "’s ability resolved at once: it never uses the stack."]
            : [object, " resolved."],
          notes: event.immediate
            ? [
                {
                  text: [
                    "A mana ability, or a special action. ",
                    { rule: RULES.manaAbility },
                  ],
                },
              ]
            : [],
        });
        break;
      case "countered":
        if (isCard(event.object)) {
          settled.add(event.object.ref);
          if (event.object.name) settled.add(event.object.name);
        }
        lines.push({
          ...plain,
          text: [object, " was countered", ...by(event.cause), "."],
          notes: [
            {
              text: [
                "A countered spell or ability leaves the stack and none of its effect happens; what it cost stays paid. ",
                { rule: RULES.countered },
              ],
            },
          ],
        });
        break;
      case "fizzled":
        if (isCard(event.object)) {
          settled.add(event.object.ref);
          if (event.object.name) settled.add(event.object.name);
        }
        lines.push({
          ...plain,
          text: [
            event.of === "ability" ? "An ability of " : "",
            object,
            " did not resolve.",
          ],
          notes: [
            event.why === "condition"
              ? {
                  text: [
                    "Its condition was no longer true when it would have resolved, so it was removed from the stack and did nothing. ",
                    { rule: RULES.interveningIf },
                  ],
                }
              : {
                  text: [
                    "Every one of its targets had become illegal by the time it would have resolved, so it was removed from the stack and did nothing. ",
                    { rule: RULES.illegalTargets },
                  ],
                },
          ],
        });
        break;
      case "attack":
        lines.push({
          ...plain,
          text: [
            object,
            " attacked ",
            piece(event.target, "a hidden card"),
            ".",
          ],
        });
        break;
      case "block":
        lines.push({
          ...plain,
          text: [
            object,
            " blocked ",
            piece(event.target, "a hidden card"),
            ".",
          ],
        });
        break;
      case "damage": {
        const amount = event.amount ?? 0;
        if (isCard(event.target)) {
          const taken = hurt.get(event.target.ref) ?? {
            amount: 0,
            sources: [],
          };
          taken.amount += amount;
          const source = event.cause;
          if (
            source &&
            !taken.sources.some(
              (known) =>
                isCard(known) && isCard(source) && known.ref === source.ref,
            )
          )
            taken.sources.push(source);
          hurt.set(event.target.ref, taken);
        }
        lines.push({
          ...plain,
          text: [
            piece(event.cause, "A source the game did not name"),
            ` dealt ${amount} ${event.combat ? "combat " : ""}damage to `,
            piece(event.target, "a hidden card"),
            ".",
          ],
        });
        break;
      }
      case "life_gained":
      case "life_lost":
        lines.push({
          ...plain,
          text: [
            player,
            ` ${event.type === "life_gained" ? "gained" : "lost"} ${event.amount ?? 0} life`,
            ...by(event.cause),
            ".",
          ],
        });
        break;
      case "counters_added":
      case "counters_removed": {
        const amount = event.amount ?? 1;
        const counters =
          `${amount} ${event.counter ?? ""} ${plural(amount, "counter")}`.replace(
            "  ",
            " ",
          );
        lines.push({
          ...plain,
          text: [
            counters,
            event.type === "counters_added"
              ? `${amount === 1 ? " was" : " were"} put on `
              : `${amount === 1 ? " was" : " were"} removed from `,
            piece(event.target, "a hidden card"),
            ...by(event.cause),
            ".",
          ],
        });
        break;
      }
      case "token_created":
        lines.push({
          ...plain,
          text: [
            player,
            " created ",
            piece(event.object, "a token"),
            ", a token",
            ...by(event.cause),
            ".",
          ],
        });
        break;
      case "eliminated":
        lines.push({ ...plain, text: [player, " lost the game."] });
        break;
      case "won":
        lines.push({ ...plain, text: [player, " won the game."] });
        break;
      default:
        lines.push({
          ...plain,
          text: [
            `Something the timeline has no words for yet happened (${event.type}).`,
          ],
          notes: [{ unknown: true, text: [UNKNOWN] }],
        });
    }
  }
  // A sentence that begins with words begins with a capital ("A card was put …").
  for (const line of lines) {
    const head = line.text[0];
    if (typeof head === "string" && head)
      line.text = [
        head[0].toUpperCase() + head.slice(1),
        ...line.text.slice(1),
      ];
  }
  return lines;
}

/** Whose turn each turn was: the active seat of its steps. */
export function turnOwners(events: readonly GameEvent[]): Map<number, number> {
  const owners = new Map<number, number>();
  for (const event of events)
    if (event.type === "step" && typeof event.active === "number")
      owners.set(event.turn, event.active);
  return owners;
}

/** A sentence's pieces as plain text, for a search and for a screen reader's label. */
export function plainText(
  pieces: readonly Piece[],
  seatName: (seat: number) => string,
): string {
  return pieces
    .map((part, index) =>
      typeof part === "string"
        ? part
        : "card" in part
          ? (part.card.name ?? (index ? "a card" : "A card"))
          : "hidden" in part
            ? index
              ? "a hidden card"
              : "A hidden card"
            : "seat" in part
              ? seatName(part.seat)
              : "cost" in part
                ? part.cost
                : `(rule ${part.rule})`,
    )
    .join("");
}

/* ---------- What changed? ---------- */

/** One line of a summary: how many, of what, and the cards if they are few and named. */
export interface Change {
  text: Piece[];
}

export interface Summary {
  /** The resolution's own event. */
  seq: number;
  /** The last event summed: what follows it is no longer this resolution's doing. */
  until: number;
  turn: number;
  /** What resolved. */
  source: Piece;
  changes: Change[];
  /** How much changed: the cards that moved, the players whose life changed, the tokens made and
   * the counters placed. A summary is offered from LARGE up. */
  size: number;
}

/** From how many changes a resolution counts as large, and its summary is offered. */
export const LARGE = 4;

/** What ends the stretch of events a resolution is summed over: the next thing a player or the
 * rules do on their own. What the resolution itself caused, triggers included, comes before it. */
function endsStretch(event: GameEvent): boolean {
  return (
    event.type === "step" ||
    event.type === "cast" ||
    event.type === "activate" ||
    event.type === "attack" ||
    event.type === "block" ||
    event.type === "countered" ||
    event.type === "fizzled" ||
    (event.type === "resolve" && !event.immediate) ||
    (event.type === "zone_change" &&
      event.from === "stack" &&
      event.to === "battlefield")
  );
}

function listed(things: Thing[]): Piece[] {
  const cards = things.filter(isCard);
  if (cards.length === 0 || cards.length !== things.length || cards.length > 6)
    return [];
  return [
    ": ",
    ...cards.flatMap((card, index) => [
      ...(index ? [", "] : []),
      { card } as Piece,
    ]),
  ];
}

/**
 * What changed after the resolution at `index` (a `resolve` that is not immediate, or a permanent
 * spell entering the battlefield), summed from the events up to the next action: cards that left
 * the battlefield by where they went, cards that entered it, cards drawn, discarded and put into
 * graveyards, damage and life by player, tokens, counters and the abilities that triggered.
 */
export function whatChanged(
  events: readonly GameEvent[],
  index: number,
): Summary | null {
  const anchor = events[index];
  if (!anchor) return null;
  const left = new Map<string, Thing[]>();
  const entered: Thing[] = [];
  const drew = new Map<number, number>();
  const discarded = new Map<number, number>();
  const milled = new Map<number, number>();
  const life = new Map<number, number>();
  const damage = new Map<number, number>();
  const tokens: Thing[] = [];
  let counters = 0;
  let triggers = 0;
  let hurtPermanents = 0;
  let until = anchor.seq;
  const bump = (
    map: Map<number, number>,
    seat: number | null | undefined,
    by: number,
  ) => {
    if (typeof seat === "number") map.set(seat, (map.get(seat) ?? 0) + by);
  };
  for (let at = index + 1; at < events.length; at++) {
    const event = events[at];
    if (endsStretch(event)) break;
    until = event.seq;
    switch (event.type) {
      case "zone_change": {
        const thing: Thing = event.object ?? { hidden: true };
        if (event.from === "battlefield") {
          const key =
            event.to === "graveyard"
              ? event.why === "sacrificed"
                ? "sacrificed"
                : "graveyard"
              : (event.to ?? "elsewhere");
          left.set(key, [...(left.get(key) ?? []), thing]);
        } else if (event.to === "battlefield") entered.push(thing);
        else if (event.from === "library" && event.to === "hand")
          bump(drew, event.player, 1);
        else if (event.from === "hand" && event.to === "graveyard")
          bump(discarded, event.player, 1);
        else if (event.from === "library" && event.to === "graveyard")
          bump(milled, event.player, 1);
        break;
      }
      case "damage":
        if (isSeat(event.target))
          bump(damage, event.target.seat, event.amount ?? 0);
        else hurtPermanents++;
        break;
      case "life_gained":
        bump(life, event.player, event.amount ?? 0);
        break;
      case "life_lost":
        bump(life, event.player, -(event.amount ?? 0));
        break;
      case "token_created":
        tokens.push(event.object ?? ({ hidden: true } as Hidden));
        break;
      case "counters_added":
      case "counters_removed":
        counters += event.amount ?? 1;
        break;
      case "trigger":
        triggers++;
        break;
    }
  }
  const changes: Change[] = [];
  const cards = (count: number) => `${count} ${plural(count, "card")}`;
  const departures: [string, (count: number) => string][] = [
    [
      "graveyard",
      (n) => `${n} ${plural(n, "permanent")} went to the graveyard`,
    ],
    [
      "sacrificed",
      (n) => `${n} ${plural(n, "permanent was", "permanents were")} sacrificed`,
    ],
    [
      "exiled",
      (n) => `${n} ${plural(n, "permanent was", "permanents were")} exiled`,
    ],
    ["hand", (n) => `${n} ${plural(n, "permanent")} returned to hand`],
    [
      "library",
      (n) =>
        `${n} ${plural(n, "permanent was", "permanents were")} put into a library`,
    ],
    [
      "command",
      (n) => `${n} ${plural(n, "permanent")} went to the command zone`,
    ],
  ];
  let size = 0;
  for (const [key, words] of departures) {
    const things = left.get(key);
    if (!things) continue;
    size += things.length;
    changes.push({ text: [words(things.length), ...listed(things), "."] });
  }
  // A token is told once, as created, not again as entering the battlefield.
  const arrived = entered.filter(
    (thing) =>
      !tokens.some(
        (token) => isCard(token) && isCard(thing) && token.ref === thing.ref,
      ),
  );
  if (arrived.length) {
    size += arrived.length;
    changes.push({
      text: [
        `${arrived.length} ${plural(arrived.length, "permanent")} entered the battlefield`,
        ...listed(arrived),
        ".",
      ],
    });
  }
  if (tokens.length) {
    size += tokens.length;
    changes.push({
      text: [
        `${tokens.length} ${plural(tokens.length, "token was", "tokens were")} created`,
        ...listed(tokens),
        ".",
      ],
    });
  }
  const perSeat = (
    map: Map<number, number>,
    words: (count: number) => string,
  ) => {
    for (const [seat, count] of [...map].sort(([a], [b]) => a - b)) {
      if (count === 0) continue;
      size += 1;
      changes.push({ text: [{ seat }, words(count)] });
    }
  };
  perSeat(damage, (n) => ` was dealt ${n} damage.`);
  perSeat(life, (n) => (n > 0 ? ` gained ${n} life.` : ` lost ${-n} life.`));
  perSeat(drew, (n) => ` drew ${cards(n)}.`);
  perSeat(discarded, (n) => ` discarded ${cards(n)}.`);
  perSeat(
    milled,
    (n) => ` put ${cards(n)} from their library into their graveyard.`,
  );
  if (hurtPermanents) {
    changes.push({
      text: [
        `Damage was dealt to ${hurtPermanents} ${plural(hurtPermanents, "permanent")}.`,
      ],
    });
    size += hurtPermanents;
  }
  if (counters) {
    changes.push({
      text: [
        `${counters} ${plural(counters, "counter was", "counters were")} put on or removed from permanents and players.`,
      ],
    });
    size += 1;
  }
  if (triggers)
    changes.push({
      text: [
        `${triggers} ${plural(triggers, "ability", "abilities")} triggered.`,
      ],
    });
  return {
    seq: anchor.seq,
    until,
    turn: anchor.turn,
    source: piece(anchor.object, "a spell or ability"),
    changes,
    size,
  };
}

/** Whether an event is a resolution that a summary can stand after. */
export function isResolution(event: GameEvent): boolean {
  return (
    (event.type === "resolve" && !event.immediate) ||
    (event.type === "zone_change" &&
      event.from === "stack" &&
      event.to === "battlefield")
  );
}

/** Every large resolution's summary, by its event's number. */
export function largeChanges(
  events: readonly GameEvent[],
): Map<number, Summary> {
  const found = new Map<number, Summary>();
  events.forEach((event, index) => {
    if (!isResolution(event)) return;
    const summary = whatChanged(events, index);
    if (summary && summary.size >= LARGE) found.set(event.seq, summary);
  });
  return found;
}
