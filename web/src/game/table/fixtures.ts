import { objectIndex, optionsByObject, optionsBySeat } from "../model";
import type {
  CardView,
  CombatGroup,
  CommanderView,
  GameView,
  LogLine,
  ObjectId,
  PermanentView,
  PlayerView,
  PriorityControls,
  Prompt,
  PromptOption,
  Seat,
  SnapshotStatus,
  Snapshot,
  StackItem,
  TargetRef,
} from "../types";
import { mulberry32 } from "./sigil";
import type { BuildInput, SummarySeat } from "./types";

// Seat views for the table: what one connection receives, at two, three and four players, for a
// spectator and for SysOp observing, with token piles, attachments, a long stack, a full hand,
// revealed and looked-at cards and a 240-permanent stress board, plus seeded random boards. The unit tests, the table lab and
// the fake-table journey (e2e/table.spec.ts) all draw from here, so this module imports types
// and pure helpers only: it runs in the browser, in Vitest and in Playwright's Node alike.

export interface TableFixture {
  name: string;
  description: string;
  snapshot: Snapshot;
  /** The connection's seat (`GameState.seat`): null for SysOp observing and for spectators. */
  seat: Seat | null;
  role: "controller" | "observer";
  /** The game summary's seats, as GET /api/v1/games/{id} gives them to this viewer. */
  summarySeats: SummarySeat[];
  /** The viewer's own handle (`me.handle`). */
  selfHandle: string | null;
  /** Whether the viewer may see concealed information (`games.view_concealed`). */
  sysop: boolean;
}

/* ---------- printed cards ---------- */

type Printed = Omit<CardView, "id" | "hidden">;

function printed(
  name: string,
  cost: string | null,
  type: string,
  pt: string | null,
  ...rules: string[]
): Printed {
  const [power, toughness] = pt ? pt.split("/") : [null, null];
  return { name, mana_cost: cost, type_line: type, power, toughness, rules };
}

export const CARDS = {
  forest: printed(
    "Forest",
    null,
    "Basic Land — Forest",
    null,
    "({T}: Add {G}.)",
  ),
  island: printed(
    "Island",
    null,
    "Basic Land — Island",
    null,
    "({T}: Add {U}.)",
  ),
  mountain: printed(
    "Mountain",
    null,
    "Basic Land — Mountain",
    null,
    "({T}: Add {R}.)",
  ),
  plains: printed(
    "Plains",
    null,
    "Basic Land — Plains",
    null,
    "({T}: Add {W}.)",
  ),
  swamp: printed("Swamp", null, "Basic Land — Swamp", null, "({T}: Add {B}.)"),
  commandTower: printed(
    "Command Tower",
    null,
    "Land",
    null,
    "{T}: Add one mana of any color in your commander's color identity.",
  ),
  llanowarElves: printed(
    "Llanowar Elves",
    "{G}",
    "Creature — Elf Druid",
    "1/1",
    "{T}: Add {G}.",
  ),
  grizzlyBears: printed("Grizzly Bears", "{1}{G}", "Creature — Bear", "2/2"),
  serraAngel: printed(
    "Serra Angel",
    "{3}{W}{W}",
    "Creature — Angel",
    "4/4",
    "Flying",
    "Vigilance",
  ),
  shivanDragon: printed(
    "Shivan Dragon",
    "{4}{R}{R}",
    "Creature — Dragon",
    "5/5",
    "Flying",
    "{R}: Shivan Dragon gets +1/+0 until end of turn.",
  ),
  goblinGuide: printed(
    "Goblin Guide",
    "{R}",
    "Creature — Goblin Scout",
    "2/2",
    "Haste",
  ),
  savannahLions: printed("Savannah Lions", "{W}", "Creature — Cat", "2/1"),
  airElemental: printed(
    "Air Elemental",
    "{3}{U}{U}",
    "Creature — Elemental",
    "4/4",
    "Flying",
  ),
  hillGiant: printed("Hill Giant", "{3}{R}", "Creature — Giant", "3/3"),
  crawWurm: printed("Craw Wurm", "{4}{G}{G}", "Creature — Wurm", "6/4"),
  birds: printed(
    "Birds of Paradise",
    "{G}",
    "Creature — Bird",
    "0/1",
    "Flying",
    "{T}: Add one mana of any color.",
  ),
  baneslayer: printed(
    "Baneslayer Angel",
    "{3}{W}{W}",
    "Creature — Angel",
    "5/5",
    "Flying, first strike, lifelink, protection from Demons and from Dragons",
  ),
  kalonianTusker: printed(
    "Kalonian Tusker",
    "{G}{G}",
    "Creature — Beast",
    "3/3",
  ),
  lightningBolt: printed(
    "Lightning Bolt",
    "{R}",
    "Instant",
    null,
    "Lightning Bolt deals 3 damage to any target.",
  ),
  counterspell: printed(
    "Counterspell",
    "{U}{U}",
    "Instant",
    null,
    "Counter target spell.",
  ),
  giantGrowth: printed(
    "Giant Growth",
    "{G}",
    "Instant",
    null,
    "Target creature gets +3/+3 until end of turn.",
  ),
  swords: printed(
    "Swords to Plowshares",
    "{W}",
    "Instant",
    null,
    "Exile target creature. Its controller gains life equal to its power.",
  ),
  darkRitual: printed("Dark Ritual", "{B}", "Instant", null, "Add {B}{B}{B}."),
  brainstorm: printed(
    "Brainstorm",
    "{U}",
    "Instant",
    null,
    "Draw three cards, then put two cards from your hand on top of your library in any order.",
  ),
  shock: printed(
    "Shock",
    "{R}",
    "Instant",
    null,
    "Shock deals 2 damage to any target.",
  ),
  lavaSpike: printed(
    "Lava Spike",
    "{R}",
    "Sorcery — Arcane",
    null,
    "Lava Spike deals 3 damage to target player or planeswalker.",
  ),
  rampantGrowth: printed(
    "Rampant Growth",
    "{1}{G}",
    "Sorcery",
    null,
    "Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.",
  ),
  solRing: printed("Sol Ring", "{1}", "Artifact", null, "{T}: Add {C}{C}."),
  arcaneSignet: printed(
    "Arcane Signet",
    "{2}",
    "Artifact",
    null,
    "{T}: Add one mana of any color in your commander's color identity.",
  ),
  rancor: printed(
    "Rancor",
    "{G}",
    "Enchantment — Aura",
    null,
    "Enchant creature",
    "Enchanted creature gets +2/+0 and has trample.",
  ),
  pacifism: printed(
    "Pacifism",
    "{1}{W}",
    "Enchantment — Aura",
    null,
    "Enchant creature",
    "Enchanted creature can't attack or block.",
  ),
  bonesplitter: printed(
    "Bonesplitter",
    "{1}",
    "Artifact — Equipment",
    null,
    "Equipped creature gets +2/+0.",
    "Equip {1}",
  ),
  greaves: printed(
    "Lightning Greaves",
    "{2}",
    "Artifact — Equipment",
    null,
    "Equipped creature has haste and shroud.",
    "Equip {0}",
  ),
  boots: printed(
    "Swiftfoot Boots",
    "{2}",
    "Artifact — Equipment",
    null,
    "Equipped creature has hexproof and haste.",
    "Equip {1}",
  ),
  anthem: printed(
    "Glorious Anthem",
    "{1}{W}{W}",
    "Enchantment",
    null,
    "Creatures you control get +1/+1.",
  ),
  oRing: printed(
    "Oblivion Ring",
    "{2}{W}",
    "Enchantment",
    null,
    "When Oblivion Ring enters, exile another target nonland permanent.",
  ),
  ajani: printed(
    "Ajani Goldmane",
    "{2}{W}{W}",
    "Legendary Planeswalker — Ajani",
    null,
    "+1: You gain 2 life.",
  ),
  chandra: printed(
    "Chandra, Torch of Defiance",
    "{2}{R}{R}",
    "Legendary Planeswalker — Chandra",
    null,
    "+1: Add {R}{R}.",
  ),
  garruk: printed(
    "Garruk Wildspeaker",
    "{2}{G}{G}",
    "Legendary Planeswalker — Garruk",
    null,
    "+1: Untap two target lands.",
  ),
  krenko: printed(
    "Krenko, Mob Boss",
    "{2}{R}{R}",
    "Legendary Creature — Goblin Warrior",
    "3/3",
    "{T}: Create X 1/1 red Goblin creature tokens, where X is the number of Goblins you control.",
  ),
  isamaru: printed(
    "Isamaru, Hound of Konda",
    "{W}",
    "Legendary Creature — Dog",
    "2/2",
  ),
  talrand: printed(
    "Talrand, Sky Summoner",
    "{2}{U}{U}",
    "Legendary Creature — Merfolk Wizard",
    "2/2",
    "Whenever you cast an instant or sorcery spell, create a 2/2 blue Drake creature token with flying.",
  ),
  omnath: printed(
    "Omnath, Locus of Mana",
    "{2}{G}",
    "Legendary Creature — Elemental",
    "1/1",
  ),
  tymna: printed(
    "Tymna the Weaver",
    "{1}{W}{B}",
    "Legendary Creature — Human Cleric",
    "2/2",
    "Lifelink",
    "Partner",
  ),
  thrasios: printed(
    "Thrasios, Triton Hero",
    "{G}{U}",
    "Legendary Creature — Merfolk Wizard",
    "1/3",
    "Partner",
  ),
  soldier: printed("Soldier Token", null, "Token Creature — Soldier", "1/1"),
  goblin: printed("Goblin Token", null, "Token Creature — Goblin", "1/1"),
  saproling: printed(
    "Saproling Token",
    null,
    "Token Creature — Saproling",
    "1/1",
  ),
  treasure: printed(
    "Treasure Token",
    null,
    "Token Artifact — Treasure",
    null,
    "{T}, Sacrifice this artifact: Add one mana of any color.",
  ),
  drake: printed(
    "Drake Token",
    null,
    "Token Creature — Drake",
    "2/2",
    "Flying",
  ),
} satisfies Record<string, Printed>;

/* ---------- builders ---------- */

/** Makes one game's objects with ids unique within it: "<prefix>1", "<prefix>2", … */
class Objects {
  private n = 0;
  constructor(readonly prefix: string) {}
  id(): ObjectId {
    this.n += 1;
    return `${this.prefix}${this.n}`;
  }
  card(face: Printed): CardView {
    return { id: this.id(), hidden: false, ...face, rules: [...face.rules] };
  }
  hidden(): CardView {
    return {
      id: this.id(),
      hidden: true,
      name: null,
      mana_cost: null,
      type_line: null,
      power: null,
      toughness: null,
      rules: [],
    };
  }
  /** A permanent; the engine uses one reference for the permanent and its card. */
  permanent(
    controller: Seat,
    face: Printed | CardView,
    change: Partial<Omit<PermanentView, "id" | "card">> = {},
  ): PermanentView {
    const card = "id" in face ? face : this.card(face);
    return {
      id: card.id,
      controller_seat: controller,
      owner_seat: controller,
      card,
      tapped: false,
      summoning_sick: false,
      damage: 0,
      counters: {},
      attacking: false,
      blocking: false,
      attached_to: null,
      ...change,
    };
  }
  many(
    count: number,
    controller: Seat,
    face: Printed,
    change: Partial<Omit<PermanentView, "id" | "card">> = {},
  ): PermanentView[] {
    return Array.from({ length: count }, () =>
      this.permanent(controller, face, change),
    );
  }
}

function player(
  seat: Seat,
  name: string,
  change: Partial<PlayerView> = {},
): PlayerView {
  return {
    seat,
    name,
    life: 20,
    counters: {},
    library_count: 40,
    hand_count: 7,
    graveyard: [],
    exile: [],
    mana_pool: { white: 0, blue: 0, black: 0, red: 0, green: 0, colorless: 0 },
    lost: false,
    won: false,
    color_identity: null,
    command_zone: [],
    commanders: [],
    ...change,
  };
}

function commander(
  card: CardView,
  zone: CommanderView["zone"],
  change: Partial<CommanderView> = {},
): CommanderView {
  return {
    name: card.name ?? "",
    zone,
    object_id: card.id,
    cast_count: 0,
    tax: 0,
    damage_dealt: [],
    ...change,
  };
}

let optionCount = 0;
function option(
  action: PromptOption["action"],
  change: Partial<Omit<PromptOption, "id" | "action">> = {},
): PromptOption {
  optionCount += 1;
  return {
    id: String(optionCount),
    action,
    label: null,
    object_id: null,
    seat: null,
    selected: false,
    ...change,
  };
}

/** A prompt; its options are numbered from 1 in the order given. */
function prompt(
  id: string,
  kind: Prompt["kind"],
  message: string,
  options: (() => PromptOption)[],
): Prompt {
  optionCount = 0;
  return {
    id,
    kind,
    message,
    detail: null,
    options: options.map((make) => make()),
    amounts: null,
    piles: null,
    xmage_query: null,
  };
}

const playerTarget = (seat: Seat): TargetRef => ({
  kind: "player",
  seat,
  object_id: null,
  label: null,
});
const objectTarget = (card: CardView): TargetRef => ({
  kind: "object",
  seat: null,
  object_id: card.id,
  label: card.name,
});

function spell(
  objects: Objects,
  controller: Seat,
  face: Printed,
  targets: TargetRef[] = [],
): StackItem {
  return {
    id: objects.id(),
    kind: "spell",
    controller_seat: controller,
    name: face.name,
    text: face.rules.join(" ") || null,
    hidden: false,
    targets,
  };
}

const controls: PriorityControls = {
  passing: null,
  your_turn: ["main1", "main2"],
  opponent_turn: [],
  stop_on_new_stack_objects: true,
  stop_on_attackers: true,
  stop_on_blockers: true,
  pass_after_casting: false,
  full_control: false,
};

function view(
  change: Partial<GameView> & Pick<GameView, "you" | "opponents">,
): GameView {
  return {
    seat: change.you?.seat ?? null,
    turn: 1,
    active_seat: 0,
    priority_seat: 0,
    phase: "precombat_main",
    step: "precombat_main",
    hand: [],
    battlefield: [],
    stack: [],
    combat: [],
    revealed: [],
    looked_at: [],
    messages: [],
    priority: change.you ? controls : null,
    ...change,
  };
}

function log(turn: number, active: Seat, lines: string[]): LogLine[] {
  return lines.map((text, index) => ({
    index,
    turn,
    active_seat: active,
    step: "precombat_main",
    text,
  }));
}

function fixture(f: {
  name: string;
  description: string;
  format: "legacy" | "commander" | "two_headed_giant";
  seats: SummarySeat[];
  view: GameView | null;
  prompt?: Prompt | null;
  status?: SnapshotStatus;
  revision?: number;
  seat?: Seat | null;
  role?: "controller" | "observer";
  selfHandle?: string | null;
  sysop?: boolean;
  log?: LogLine[];
}): TableFixture {
  const promptShown = f.prompt ?? null;
  const seat = f.seat === undefined ? 0 : f.seat;
  return {
    name: f.name,
    description: f.description,
    seat,
    role: f.role ?? (seat === null ? "observer" : "controller"),
    summarySeats: f.seats,
    selfHandle: f.selfHandle === undefined ? "alice" : f.selfHandle,
    sysop: f.sysop ?? false,
    snapshot: {
      game_id: `fx-${f.name}`,
      revision: f.revision ?? 12,
      status: f.status ?? (promptShown ? "your_prompt" : "waiting"),
      seat: f.view?.seat ?? null,
      settings: {
        format: f.format,
        rules_profile:
          f.format === "two_headed_giant"
            ? "two_headed_giant_legacy"
            : f.format,
        seats: f.seats.map((s) => ({
          seat: s.seat,
          player: s.player,
          deck: s.deck,
        })),
        skill: 3,
        turn_cap: 40,
        idle_timeout_seconds: 900,
        spectator_delay_seconds: 0,
      },
      prompt: promptShown,
      view: f.view,
      result: null,
      log_count: f.log?.length ?? 0,
      log_from: 0,
      log: f.log ?? [],
    },
  };
}

const alice = (deck: string | null = null): SummarySeat => ({
  seat: 0,
  player: "human",
  handle: "alice",
  deck,
});
const bot = (seat: Seat, deck: string | null = null): SummarySeat => ({
  seat,
  player: "bot",
  handle: null,
  deck,
});

/* ---------- the fixtures ---------- */

function duel(): TableFixture {
  const o = new Objects("d");
  const hand = [
    o.card(CARDS.forest),
    o.card(CARDS.lightningBolt),
    o.card(CARDS.grizzlyBears),
    o.card(CARDS.giantGrowth),
    o.card(CARDS.shivanDragon),
    o.card(CARDS.mountain),
    o.card(CARDS.counterspell),
  ];
  const forests = o.many(3, 0, CARDS.forest);
  const mountains = [
    o.permanent(0, CARDS.mountain, { tapped: true }),
    o.permanent(0, CARDS.mountain),
  ];
  const elves = o.permanent(0, CARDS.llanowarElves, { tapped: true });
  const bears = o.permanent(0, CARDS.grizzlyBears, {
    counters: { "+1/+1": 2 },
  });
  const rancor = o.permanent(0, CARDS.rancor, { attached_to: bears.id });
  const solRing = o.permanent(0, CARDS.solRing);
  const birds = o.permanent(0, CARDS.birds, { summoning_sick: true });
  const islands = o.many(4, 1, CARDS.island);
  const swamps = [
    o.permanent(1, CARDS.swamp, { tapped: true }),
    o.permanent(1, CARDS.swamp),
  ];
  const air = o.permanent(1, CARDS.airElemental);
  const angel = o.permanent(1, CARDS.serraAngel, { damage: 2 });
  const anthem = o.permanent(1, CARDS.anthem);
  const ajani = o.permanent(1, CARDS.ajani, { counters: { loyalty: 4 } });
  const you = player(0, "Alice", {
    life: 18,
    library_count: 46,
    hand_count: hand.length,
    graveyard: [o.card(CARDS.lavaSpike), o.card(CARDS.shock)],
    mana_pool: { white: 0, blue: 0, black: 0, red: 0, green: 1, colorless: 0 },
  });
  const opponent = player(1, "Bot 2", {
    life: 14,
    library_count: 49,
    hand_count: 3,
    counters: { poison: 2 },
    graveyard: [o.card(CARDS.brainstorm), o.card(CARDS.darkRitual)],
    exile: [o.card(CARDS.swords)],
  });
  const [forest, bolt, bearsCard, growth, , mountain] = hand;
  return fixture({
    name: "duel",
    description:
      "Legacy, two players: your main phase with spells and lands to play.",
    format: "legacy",
    seats: [alice("legacy-mono-green-creatures"), bot(1)],
    view: view({
      turn: 7,
      you,
      opponents: [opponent],
      hand,
      battlefield: [
        ...forests,
        ...mountains,
        elves,
        bears,
        rancor,
        solRing,
        birds,
        ...islands,
        ...swamps,
        air,
        angel,
        anthem,
        ajani,
      ],
    }),
    prompt: prompt("p-duel", "priority", "Play spells and abilities.", [
      () => option("pass"),
      () => option("pass_until_end_of_turn"),
      () => option("pass_until_next_turn"),
      () => option("cast", { object_id: bolt.id }),
      () => option("cast", { object_id: bearsCard.id }),
      () => option("cast", { object_id: growth.id }),
      () => option("play_land", { object_id: forest.id }),
      () => option("play_land", { object_id: mountain.id }),
      ...forests.map((p) => () => option("activate_mana", { object_id: p.id })),
      () => option("activate_mana", { object_id: mountains[1].id }),
      () => option("activate_mana", { object_id: solRing.id }),
    ]),
    log: log(7, 0, ["Turn 7: Alice.", "Alice draws a card."]),
  });
}

function three(): TableFixture {
  const o = new Objects("t");
  const krenko = o.card(CARDS.krenko);
  const guide = o.permanent(0, CARDS.goblinGuide, {
    attacking: true,
    tapped: true,
  });
  const giant = o.permanent(0, CARDS.hillGiant);
  const goblins = o.many(5, 0, CARDS.goblin);
  const isamaru = o.permanent(1, CARDS.isamaru);
  const talrand = o.permanent(2, CARDS.talrand);
  const you = player(0, "Alice", {
    life: 32,
    library_count: 80,
    hand_count: 2,
    command_zone: [krenko],
    commanders: [
      commander(krenko, "command", {
        cast_count: 1,
        tax: 2,
        damage_dealt: [{ seat: 1, damage: 6 }],
      }),
    ],
  });
  const bot2 = player(1, "Bot 2", {
    life: 34,
    library_count: 82,
    hand_count: 5,
    graveyard: [
      o.card(CARDS.swords),
      o.card(CARDS.savannahLions),
      o.card(CARDS.plains),
    ],
    exile: [o.card(CARDS.goblinGuide)],
    commanders: [commander(isamaru.card, "battlefield")],
  });
  const bot3 = player(2, "Bot 3", {
    life: 40,
    library_count: 85,
    hand_count: 6,
    graveyard: [o.card(CARDS.counterspell)],
    commanders: [
      commander(talrand.card, "battlefield", { cast_count: 1, tax: 2 }),
    ],
  });
  const hand = [o.card(CARDS.lightningBolt), o.card(CARDS.mountain)];
  return fixture({
    name: "three",
    description:
      "Commander, three players: declaring attackers with goblins in piles.",
    format: "commander",
    seats: [alice("commander-mono-red-raiders"), bot(1), bot(2)],
    view: view({
      turn: 9,
      phase: "combat",
      step: "declare_attackers",
      you,
      opponents: [bot2, bot3],
      hand,
      battlefield: [
        ...o.many(4, 0, CARDS.mountain),
        ...o.many(2, 0, CARDS.mountain, { tapped: true }),
        o.permanent(0, CARDS.commandTower),
        o.permanent(0, CARDS.solRing),
        o.permanent(0, CARDS.arcaneSignet),
        guide,
        giant,
        ...goblins,
        ...o.many(3, 0, CARDS.goblin, { tapped: true }),
        o.permanent(0, CARDS.shivanDragon, { summoning_sick: true }),
        ...o.many(5, 1, CARDS.plains),
        isamaru,
        o.permanent(1, CARDS.savannahLions),
        o.permanent(1, CARDS.serraAngel),
        o.permanent(1, CARDS.oRing),
        o.permanent(1, CARDS.anthem),
        ...o.many(6, 2, CARDS.island),
        talrand,
        o.permanent(2, CARDS.airElemental),
        ...o.many(2, 2, CARDS.drake),
      ],
      combat: [
        {
          attackers: [guide.id],
          defender: playerTarget(1),
          blockers: [],
          blocked: false,
        },
      ],
    }),
    prompt: prompt("p-three", "declare_attackers", "Declare attackers.", [
      () => option("toggle_attacker", { object_id: guide.id, selected: true }),
      () => option("toggle_attacker", { object_id: giant.id }),
      ...goblins.map(
        (p) => () => option("toggle_attacker", { object_id: p.id }),
      ),
      () => option("all_attack"),
      () => option("done"),
    ]),
  });
}

function four(): TableFixture {
  const o = new Objects("f");
  const tymna = o.card(CARDS.tymna);
  const thrasios = o.card(CARDS.thrasios);
  const baneslayer = o.permanent(0, CARDS.baneslayer);
  const omnath = o.permanent(1, CARDS.omnath);
  const wurm = o.permanent(1, CARDS.crawWurm);
  const tusker = o.permanent(1, CARDS.kalonianTusker, { tapped: true });
  const lions = o.permanent(2, CARDS.savannahLions);
  const isamaru = o.card(CARDS.isamaru);
  const shock = spell(o, 0, CARDS.shock);
  const you = player(0, "Alice", {
    life: 27,
    library_count: 70,
    hand_count: 3,
    command_zone: [tymna, thrasios],
    commanders: [
      commander(tymna, "command", { cast_count: 1, tax: 2 }),
      commander(thrasios, "command"),
    ],
  });
  const bot2 = player(1, "Bot 2", {
    life: 31,
    library_count: 74,
    hand_count: 4,
    commanders: [
      commander(omnath.card, "battlefield", {
        damage_dealt: [{ seat: 0, damage: 4 }],
      }),
    ],
  });
  const bot3 = player(2, "Bot 3", {
    life: 22,
    library_count: 71,
    hand_count: 2,
    command_zone: [isamaru],
    commanders: [commander(isamaru, "command", { cast_count: 2, tax: 4 })],
    graveyard: [o.card(CARDS.swords), o.card(CARDS.pacifism)],
  });
  const bot4 = player(3, "Bot 4", {
    life: 0,
    lost: true,
    library_count: 60,
    hand_count: 0,
  });
  return fixture({
    name: "four",
    description:
      "Commander, four players: choosing a target, partners in your command zone, one player out.",
    format: "commander",
    seats: [alice("commander-mono-white-soldiers"), bot(1), bot(2), bot(3)],
    view: view({
      turn: 11,
      phase: "postcombat_main",
      step: "postcombat_main",
      you,
      opponents: [bot2, bot3, bot4],
      hand: [
        o.card(CARDS.plains),
        o.card(CARDS.counterspell),
        o.card(CARDS.brainstorm),
      ],
      battlefield: [
        ...o.many(4, 0, CARDS.plains),
        ...o.many(3, 0, CARDS.swamp, { tapped: true }),
        ...o.many(2, 0, CARDS.island),
        o.permanent(0, CARDS.commandTower),
        o.permanent(0, CARDS.solRing, { tapped: true }),
        baneslayer,
        o.permanent(0, CARDS.ajani, { counters: { loyalty: 5 } }),
        o.permanent(0, CARDS.oRing),
        ...o.many(5, 1, CARDS.forest),
        omnath,
        wurm,
        tusker,
        ...o.many(4, 2, CARDS.swamp),
        lions,
        o.permanent(2, CARDS.goblinGuide, { counters: { "-1/-1": 1 } }),
      ],
      stack: [shock],
    }),
    prompt: prompt("p-four", "choose_target", "Choose any target for Shock.", [
      () => option("choose", { seat: 0 }),
      () => option("choose", { seat: 1 }),
      () => option("choose", { seat: 2 }),
      () => option("choose", { object_id: baneslayer.id }),
      () => option("choose", { object_id: omnath.id }),
      () => option("choose", { object_id: wurm.id }),
      () => option("choose", { object_id: tusker.id }),
      () => option("choose", { object_id: lions.id }),
      () => option("cancel"),
    ]),
  });
}

function spectator(): TableFixture {
  const o = new Objects("w");
  const bot1 = player(0, "Bot 1", { hand_count: 6, life: 35 });
  const bot2 = player(1, "Bot 2", { hand_count: 4, life: 28 });
  const bot3 = player(2, "Bot 3", { hand_count: 5, life: 40 });
  return fixture({
    name: "spectator",
    description:
      "A spectator watching three bots: the lowest seat sits below, its hand as backs.",
    format: "commander",
    seats: [bot(0), bot(1), bot(2)],
    seat: null,
    role: "observer",
    selfHandle: "watcher",
    status: "spectating",
    view: view({
      turn: 5,
      active_seat: 1,
      priority_seat: 1,
      you: null,
      opponents: [bot1, bot2, bot3],
      battlefield: [
        ...o.many(4, 0, CARDS.forest),
        o.permanent(0, CARDS.llanowarElves),
        ...o.many(3, 1, CARDS.island, { tapped: true }),
        o.permanent(1, CARDS.airElemental),
        ...o.many(4, 2, CARDS.mountain),
        o.permanent(2, CARDS.hillGiant),
      ],
    }),
    prompt: null,
  });
}

function sysop(): TableFixture {
  const base = duel();
  return {
    ...base,
    name: "sysop",
    description:
      "SysOp observing Alice's duel: her view, named, never answerable here.",
    seat: null,
    role: "observer",
    selfHandle: "sysop",
    sysop: true,
    summarySeats: [
      alice("legacy-mono-green-creatures"),
      bot(1, "legacy-mono-red-burn"),
    ],
    snapshot: { ...base.snapshot, game_id: "fx-sysop" },
  };
}

/** Two-Headed Giant (v0.5.1): Alice (seat 0) and her teammate Bot 2 (seat 1) against Bot 3 and
 * Bot 4. Each team shows its one life total on both plates; Bot 2's hand is in Alice's view, card
 * for card (810.5), and the other team's hands are counts only. */
function giant(): TableFixture {
  const o = new Objects("g");
  const hand = [
    o.card(CARDS.forest),
    o.card(CARDS.grizzlyBears),
    o.card(CARDS.giantGrowth),
    o.card(CARDS.rampantGrowth),
    o.card(CARDS.crawWurm),
  ];
  const theirs = [
    o.card(CARDS.lightningBolt),
    o.card(CARDS.mountain),
    o.card(CARDS.goblinGuide),
    o.card(CARDS.lavaSpike),
    o.card(CARDS.hillGiant),
    o.card(CARDS.shock),
  ];
  const you = player(0, "Alice", {
    team: 0,
    life: 24,
    library_count: 48,
    hand_count: hand.length,
  });
  const teammate = player(1, "Bot 2", {
    team: 0,
    life: 24,
    library_count: 49,
    hand_count: theirs.length,
    hand: theirs,
    graveyard: [o.card(CARDS.shock)],
  });
  const bot3 = player(2, "Bot 3", {
    team: 1,
    life: 27,
    library_count: 47,
    hand_count: 5,
    counters: { poison: 4 },
  });
  const bot4 = player(3, "Bot 4", {
    team: 1,
    life: 27,
    library_count: 48,
    hand_count: 4,
    counters: { poison: 3 },
    graveyard: [o.card(CARDS.counterspell)],
  });
  const [forest, bears, growth] = hand;
  return fixture({
    name: "giant",
    description:
      "Two-Headed Giant: your team's main phase, your teammate's hand face up by their plate, the other team's hands as counts.",
    format: "two_headed_giant",
    seats: [alice("legacy-mono-green-creatures"), bot(1), bot(2), bot(3)],
    view: view({
      turn: 7,
      you,
      opponents: [teammate, bot3, bot4],
      hand,
      battlefield: [
        ...o.many(3, 0, CARDS.forest),
        o.permanent(0, CARDS.llanowarElves),
        o.permanent(0, CARDS.grizzlyBears),
        ...o.many(3, 1, CARDS.mountain),
        o.permanent(1, CARDS.goblinGuide),
        ...o.many(3, 2, CARDS.plains),
        o.permanent(2, CARDS.savannahLions),
        o.permanent(2, CARDS.serraAngel),
        ...o.many(3, 3, CARDS.island),
        o.permanent(3, CARDS.airElemental),
      ],
    }),
    prompt: prompt("p-giant", "priority", "Play spells and abilities.", [
      () => option("pass"),
      () => option("pass_until_next_turn"),
      () => option("cast", { object_id: bears.id }),
      () => option("cast", { object_id: growth.id }),
      () => option("play_land", { object_id: forest.id }),
    ]),
    log: log(7, 0, ["Turn 7: Alice.", "Alice draws a card."]),
  });
}

/** SysOp observing Alice's Two-Headed Giant game: her view, her teammate's hand in it. */
function giantSysop(): TableFixture {
  const base = giant();
  return {
    ...base,
    name: "giantSysop",
    description:
      "SysOp observing Alice's Two-Headed Giant game: her view with her teammate's hand, every player named and every team numbered.",
    seat: null,
    role: "observer",
    selfHandle: "sysop",
    sysop: true,
    summarySeats: [
      alice("legacy-mono-green-creatures"),
      bot(1, "legacy-mono-red-burn"),
      bot(2, "legacy-mono-white-weenie"),
      bot(3, "legacy-mono-blue-skies"),
    ],
    snapshot: { ...base.snapshot, game_id: "fx-giant-sysop" },
  };
}

function tokens(): TableFixture {
  const o = new Objects("k");
  const treasures = o.many(3, 0, CARDS.treasure);
  return fixture({
    name: "tokens",
    description:
      "Token groups: a pile of seven, a tapped pair, treasures, a split-out token and a dozen saprolings.",
    format: "legacy",
    seats: [alice(), bot(1)],
    view: view({
      turn: 6,
      you: player(0, "Alice", { hand_count: 0 }),
      opponents: [player(1, "Bot 2")],
      battlefield: [
        ...o.many(7, 0, CARDS.soldier),
        ...o.many(2, 0, CARDS.soldier, { tapped: true }),
        ...treasures,
        o.permanent(0, CARDS.goblin, { counters: { "+1/+1": 1 } }),
        o.permanent(0, CARDS.goblin),
        ...o.many(5, 0, CARDS.plains),
        ...o.many(12, 1, CARDS.saproling),
        ...o.many(6, 1, CARDS.forest),
      ],
    }),
    prompt: prompt("p-tokens", "priority", "Play spells and abilities.", [
      () => option("pass"),
      ...treasures.map(
        (p) => () => option("activate_mana", { object_id: p.id }),
      ),
    ]),
  });
}

function attachments(): TableFixture {
  const o = new Objects("a");
  const bears = o.permanent(0, CARDS.grizzlyBears);
  const angel = o.permanent(0, CARDS.serraAngel);
  const tusker = o.permanent(0, CARDS.kalonianTusker);
  const giant = o.permanent(0, CARDS.hillGiant, { tapped: true });
  const splitter = o.permanent(0, CARDS.bonesplitter, {
    attached_to: tusker.id,
  });
  const onAngel = [
    CARDS.greaves,
    CARDS.boots,
    CARDS.bonesplitter,
    CARDS.rancor,
    CARDS.rancor,
    CARDS.pacifism,
  ].map((face) => o.permanent(0, face, { attached_to: angel.id }));
  return fixture({
    name: "attachments",
    description:
      "Hosts with two and six attachments, a chain of two, a tapped host, and the opponent's Aura on your creature.",
    format: "legacy",
    seats: [alice(), bot(1)],
    view: view({
      turn: 8,
      you: player(0, "Alice", { hand_count: 0 }),
      opponents: [player(1, "Bot 2")],
      battlefield: [
        bears,
        o.permanent(0, CARDS.rancor, { attached_to: bears.id }),
        o.permanent(0, CARDS.bonesplitter, { attached_to: bears.id }),
        angel,
        ...onAngel,
        tusker,
        splitter,
        // An Aura on the Equipment: it joins the creature at the chain's root.
        o.permanent(0, CARDS.rancor, { attached_to: splitter.id }),
        giant,
        o.permanent(0, CARDS.greaves, { attached_to: giant.id, tapped: true }),
        ...o.many(4, 0, CARDS.forest),
        // The opponent controls this Pacifism, so it stays on their side (B1).
        o.permanent(1, CARDS.pacifism, { attached_to: giant.id }),
        o.permanent(1, CARDS.airElemental),
        ...o.many(4, 1, CARDS.plains),
      ],
    }),
    prompt: null,
  });
}

function stack(): TableFixture {
  const o = new Objects("s");
  const air = o.permanent(1, CARDS.airElemental);
  const bears = o.permanent(0, CARDS.grizzlyBears);
  const bolt = spell(o, 0, CARDS.lightningBolt, [objectTarget(air.card)]);
  const counter: StackItem = {
    ...spell(o, 1, CARDS.counterspell),
    targets: [
      {
        kind: "object",
        seat: null,
        object_id: bolt.id,
        label: "Lightning Bolt",
      },
    ],
  };
  const hidden: StackItem = {
    id: o.id(),
    kind: "spell",
    controller_seat: 1,
    name: null,
    text: null,
    hidden: true,
    targets: [],
  };
  const ability: StackItem = {
    id: o.id(),
    kind: "ability",
    controller_seat: 0,
    name: "Ajani Goldmane",
    text: "+1: You gain 2 life.",
    hidden: false,
    targets: [],
  };
  const items = [
    counter,
    bolt,
    hidden,
    ability,
    spell(o, 0, CARDS.giantGrowth, [objectTarget(bears.card)]),
    spell(o, 1, CARDS.shock, [playerTarget(0)]),
    spell(o, 1, CARDS.brainstorm),
    spell(o, 0, CARDS.darkRitual),
  ];
  return fixture({
    name: "stack",
    description:
      "Eight items on the stack: spells, an ability, a hidden spell, and targets on players, creatures and spells.",
    format: "legacy",
    seats: [alice(), bot(1)],
    view: view({
      turn: 4,
      active_seat: 1,
      priority_seat: 0,
      you: player(0, "Alice"),
      opponents: [player(1, "Bot 2")],
      battlefield: [
        bears,
        o.permanent(0, CARDS.ajani, { counters: { loyalty: 5 } }),
        ...o.many(4, 0, CARDS.mountain, { tapped: true }),
        air,
        ...o.many(5, 1, CARDS.island, { tapped: true }),
      ],
      stack: items,
    }),
    prompt: prompt("p-stack", "choose_target", "Choose target spell.", [
      () => option("choose", { object_id: counter.id }),
      () => option("choose", { object_id: hidden.id }),
      () => option("choose", { object_id: items[6].id }),
      () => option("cancel"),
    ]),
  });
}

function hand25(): TableFixture {
  const o = new Objects("h");
  const faces = [
    CARDS.forest,
    CARDS.island,
    CARDS.lightningBolt,
    CARDS.grizzlyBears,
    CARDS.counterspell,
    CARDS.serraAngel,
    CARDS.giantGrowth,
    CARDS.shivanDragon,
    CARDS.darkRitual,
  ];
  const hand = Array.from({ length: 25 }, (_, i) =>
    o.card(faces[i % faces.length]),
  );
  return fixture({
    name: "hand25",
    description:
      "Twenty-five cards in hand: the fan's twenty slots end in “+6”.",
    format: "legacy",
    seats: [alice(), bot(1)],
    view: view({
      turn: 15,
      you: player(0, "Alice", { hand_count: hand.length }),
      opponents: [player(1, "Bot 2")],
      hand,
      battlefield: [
        ...o.many(6, 0, CARDS.forest),
        ...o.many(3, 0, CARDS.island),
        ...o.many(5, 1, CARDS.mountain),
      ],
    }),
    prompt: prompt("p-hand", "priority", "Play spells and abilities.", [
      () => option("pass"),
      ...hand
        .filter((card) => card.name !== "Forest" && card.name !== "Island")
        .slice(0, 6)
        .map((card) => () => option("cast", { object_id: card.id })),
      () => option("play_land", { object_id: hand[0].id }),
      () => option("play_land", { object_id: hand[1].id }),
    ]),
  });
}

function blockers(): TableFixture {
  const o = new Objects("b");
  const dragon = o.permanent(1, CARDS.shivanDragon, {
    attacking: true,
    tapped: true,
  });
  const guide = o.permanent(1, CARDS.goblinGuide, {
    attacking: true,
    tapped: true,
  });
  const giant = o.permanent(1, CARDS.hillGiant, {
    attacking: true,
    tapped: true,
  });
  const ajani = o.permanent(0, CARDS.ajani, { counters: { loyalty: 3 } });
  const bears = o.permanent(0, CARDS.grizzlyBears, { blocking: true });
  const angel = o.permanent(0, CARDS.serraAngel);
  const elves = o.permanent(0, CARDS.llanowarElves);
  const lions = o.permanent(0, CARDS.savannahLions);
  const combat: CombatGroup[] = [
    {
      attackers: [dragon.id],
      defender: playerTarget(0),
      blockers: [],
      blocked: false,
    },
    {
      attackers: [guide.id],
      defender: playerTarget(0),
      blockers: [bears.id],
      blocked: true,
    },
    {
      attackers: [giant.id],
      defender: objectTarget(ajani.card),
      blockers: [],
      blocked: false,
    },
  ];
  return fixture({
    name: "blockers",
    description:
      "Bot 2 attacks with three creatures; you declare blockers, one already blocking.",
    format: "legacy",
    seats: [alice(), bot(1)],
    view: view({
      turn: 10,
      active_seat: 1,
      priority_seat: 0,
      phase: "combat",
      step: "declare_blockers",
      you: player(0, "Alice", { life: 9 }),
      opponents: [player(1, "Bot 2", { life: 12 })],
      battlefield: [
        angel,
        elves,
        lions,
        bears,
        ajani,
        ...o.many(5, 0, CARDS.plains),
        ...o.many(6, 1, CARDS.mountain, { tapped: true }),
        dragon,
        guide,
        giant,
      ],
      combat,
    }),
    prompt: prompt("p-block", "declare_blockers", "Declare blockers.", [
      () => option("toggle_blocker", { object_id: angel.id }),
      () => option("toggle_blocker", { object_id: elves.id }),
      () => option("toggle_blocker", { object_id: lions.id }),
      () => option("toggle_blocker", { object_id: bears.id, selected: true }),
      () => option("done"),
    ]),
  });
}

function revealed(): TableFixture {
  const o = new Objects("r");
  const hand = [
    o.card(CARDS.shivanDragon),
    o.card(CARDS.forest),
    o.card(CARDS.giantGrowth),
  ];
  const theirs = [
    o.card(CARDS.counterspell),
    o.card(CARDS.island),
    o.card(CARDS.brainstorm),
  ];
  const top = [o.card(CARDS.serraAngel), o.card(CARDS.mountain)];
  return fixture({
    name: "revealed",
    description:
      "Bot 2's hand revealed to you, your Shivan Dragon revealed from your hand and the top of your library: the prompt's rows, one card in your hand as well.",
    format: "legacy",
    seats: [alice(), bot(1)],
    view: view({
      turn: 9,
      active_seat: 0,
      priority_seat: 0,
      you: player(0, "Alice", { hand_count: hand.length, life: 16 }),
      opponents: [player(1, "Bot 2", { hand_count: theirs.length })],
      hand,
      battlefield: [
        ...o.many(4, 0, CARDS.swamp),
        o.permanent(0, CARDS.grizzlyBears),
        ...o.many(3, 1, CARDS.island, { tapped: true }),
        o.permanent(1, CARDS.airElemental),
      ],
      revealed: [
        { name: "Bot 2's hand", cards: theirs },
        { name: "Alice's hand", cards: [hand[0]] },
      ],
      looked_at: [{ name: "Top of your library", cards: top }],
    }),
    prompt: prompt(
      "p-revealed",
      "choose_target",
      "Choose a nonland card from Bot 2's hand.",
      [
        () => option("choose", { object_id: theirs[0].id }),
        () => option("choose", { object_id: theirs[2].id }),
      ],
    ),
  });
}

function starting(): TableFixture {
  return fixture({
    name: "starting",
    description: "Before the first view: the table is being set up.",
    format: "legacy",
    seats: [alice(), bot(1)],
    view: null,
    prompt: null,
    status: "starting",
    revision: 0,
  });
}

/* ---------- random boards ---------- */

const pick = <T>(random: () => number, list: readonly T[]): T =>
  list[Math.floor(random() * list.length)];
const between = (random: () => number, min: number, max: number) =>
  min + Math.floor(random() * (max - min + 1));

const LANDS = [
  CARDS.forest,
  CARDS.island,
  CARDS.mountain,
  CARDS.plains,
  CARDS.swamp,
  CARDS.commandTower,
];
const CREATURES = [
  CARDS.llanowarElves,
  CARDS.grizzlyBears,
  CARDS.serraAngel,
  CARDS.shivanDragon,
  CARDS.goblinGuide,
  CARDS.savannahLions,
  CARDS.airElemental,
  CARDS.hillGiant,
  CARDS.crawWurm,
  CARDS.birds,
  CARDS.baneslayer,
  CARDS.kalonianTusker,
];
const TOKENS = [
  CARDS.soldier,
  CARDS.goblin,
  CARDS.saproling,
  CARDS.treasure,
  CARDS.drake,
];
const OTHERS = [CARDS.solRing, CARDS.arcaneSignet, CARDS.anthem, CARDS.oRing];
const ATTACHMENTS = [
  CARDS.rancor,
  CARDS.pacifism,
  CARDS.bonesplitter,
  CARDS.greaves,
  CARDS.boots,
];
const WALKERS = [CARDS.ajani, CARDS.chandra, CARDS.garruk];
const SPELLS = [
  CARDS.lightningBolt,
  CARDS.counterspell,
  CARDS.giantGrowth,
  CARDS.swords,
  CARDS.darkRitual,
  CARDS.brainstorm,
  CARDS.shock,
  CARDS.lavaSpike,
  CARDS.rampantGrowth,
];
const COMMANDERS = [
  CARDS.krenko,
  CARDS.isamaru,
  CARDS.talrand,
  CARDS.omnath,
  CARDS.tymna,
  CARDS.thrasios,
];
const isCreatureFace = (face: Printed | CardView) =>
  /\bCreature\b/.test(face.type_line ?? "");

/** One player's random permanents, appended to `board`. */
function randomPermanents(
  random: () => number,
  o: Objects,
  seat: Seat,
  count: number,
  board: PermanentView[],
) {
  const token = pick(random, TOKENS);
  for (let i = 0; i < count; i++) {
    const roll = random();
    const tapped = random() < 0.3;
    if (roll < 0.36) {
      board.push(
        o.permanent(seat, pick(random, LANDS.slice(0, 4)), { tapped }),
      );
      continue;
    }
    if (roll < 0.72 && roll >= 0.56) {
      // Tokens of one kind per player, so piles form.
      board.push(
        o.permanent(seat, random() < 0.8 ? token : pick(random, TOKENS), {
          tapped: random() < 0.15,
          counters: random() < 0.08 ? { "+1/+1": 1 } : {},
        }),
      );
      continue;
    }
    if (roll < 0.56) {
      const face = pick(random, CREATURES);
      const toughness = Number(face.toughness ?? 1);
      board.push(
        o.permanent(seat, face, {
          tapped,
          summoning_sick: random() < 0.1,
          damage:
            random() < 0.1 && toughness > 1
              ? between(random, 1, toughness - 1)
              : 0,
          counters:
            random() < 0.15
              ? { "+1/+1": between(random, 1, 3) }
              : random() < 0.05
                ? { "-1/-1": 1, charge: 2 }
                : {},
        }),
      );
      continue;
    }
    if (roll < 0.8) {
      board.push(o.permanent(seat, pick(random, OTHERS), { tapped }));
      continue;
    }
    if (roll < 0.92) {
      const own = board.filter(
        (p) => p.controller_seat === seat && isCreatureFace(p.card),
      );
      const anyone = board.filter((p) => isCreatureFace(p.card));
      const chained = board.filter(
        (p) => p.controller_seat === seat && p.attached_to,
      );
      // Mostly on one's own creature; now and then on another player's, or down a chain.
      const host =
        random() < 0.05 && chained.length > 0
          ? pick(random, chained)
          : random() < 0.9 && own.length > 0
            ? pick(random, own)
            : anyone.length > 0
              ? pick(random, anyone)
              : null;
      board.push(
        o.permanent(seat, pick(random, ATTACHMENTS), {
          attached_to: host?.id ?? null,
          tapped: random() < 0.05,
        }),
      );
      continue;
    }
    if (roll < 0.97) {
      board.push(
        o.permanent(seat, pick(random, WALKERS), {
          counters: { loyalty: between(random, 1, 7) },
        }),
      );
      continue;
    }
    board.push(o.permanent(seat, o.hidden(), { tapped }));
  }
}

/** A seeded random board for `players` players: the same seed always gives the same board.
 * It covers what the layout must survive: 0–40 permanents per player, tapped cards, piles,
 * attachments (chained and across controllers), counters, combat, a stack of 0–8, a hand of
 * 0–25, command zones, eliminated players, and the spectator's and SysOp's views. As Two-Headed
 * Giant (four players, v0.5.1) the teams share their life, and seat 0's view shows its
 * teammate's hand of 0–20 cards. */
export function randomFixture(
  seed: number,
  players: 2 | 3 | 4,
  change: {
    maxPermanents?: number;
    perspective?: "player" | "spectator" | "sysop";
    twoHeadedGiant?: boolean;
  } = {},
): TableFixture {
  const random = mulberry32(seed * 7919 + players);
  const o = new Objects(`r${seed}-`);
  const giant = change.twoHeadedGiant === true && players === 4;
  const commanderGame = !giant && (players > 2 || random() < 0.3);
  const roll = random();
  const perspective =
    change.perspective ??
    (roll < 0.06 ? "spectator" : roll < 0.12 ? "sysop" : "player");
  const max = change.maxPermanents ?? 40;
  const seats = Array.from({ length: players }, (_, seat) => seat);
  const active = pick(random, seats);
  const board: PermanentView[] = [];
  const views = seats.map((seat) => {
    const lost = seat !== 0 && random() < 0.05;
    if (!lost)
      randomPermanents(random, o, seat, between(random, 0, max), board);
    const command = commanderGame
      ? Array.from({ length: between(random, 0, 3) }, () =>
          o.card(pick(random, COMMANDERS)),
        )
      : [];
    return player(seat, seat === 0 ? "Alice" : `Bot ${seat + 1}`, {
      life: lost ? 0 : between(random, 1, 40),
      lost,
      library_count: between(random, 0, 60),
      hand_count: between(random, 0, 10),
      graveyard: Array.from({ length: between(random, 0, 20) }, () =>
        o.card(pick(random, [...SPELLS, ...CREATURES, ...LANDS])),
      ),
      exile: Array.from({ length: between(random, 0, 5) }, () =>
        random() < 0.1 ? o.hidden() : o.card(pick(random, SPELLS)),
      ),
      command_zone: command,
      commanders: command.map((card) =>
        commander(card, "command", { tax: 2 * between(random, 0, 3) }),
      ),
      counters: random() < 0.1 ? { poison: between(random, 1, 9) } : {},
    });
  });
  // A commander on the battlefield, now and then.
  if (commanderGame)
    for (const p of views)
      if (!p.lost && random() < 0.4) {
        const face = pick(random, COMMANDERS);
        const permanent = o.permanent(p.seat, face, { tapped: random() < 0.3 });
        board.push(permanent);
        p.commanders.push(
          commander(permanent.card, "battlefield", {
            damage_dealt: [
              { seat: (p.seat + 1) % players, damage: between(random, 0, 21) },
            ],
          }),
        );
      }

  // Combat in some boards.
  const step = pick(random, [
    "precombat_main",
    "declare_attackers",
    "declare_blockers",
    "combat_damage",
    "end_turn",
  ]);
  const combat: CombatGroup[] = [];
  if (step !== "precombat_main" && step !== "end_turn") {
    const attackers = board.filter(
      (p) =>
        p.controller_seat === active &&
        isCreatureFace(p.card) &&
        !p.attached_to &&
        random() < 0.35,
    );
    for (const attacker of attackers) {
      attacker.attacking = true;
      attacker.tapped = random() < 0.8;
      const defender = pick(
        random,
        seats.filter((s) => s !== active),
      );
      const blockers =
        step !== "declare_attackers"
          ? board.filter(
              (p) =>
                p.controller_seat === defender &&
                isCreatureFace(p.card) &&
                !p.blocking &&
                !p.tapped &&
                random() < 0.15,
            )
          : [];
      blockers.forEach((p) => (p.blocking = true));
      combat.push({
        attackers: [attacker.id],
        defender: playerTarget(defender),
        blockers: blockers.map((p) => p.id),
        blocked: blockers.length > 0,
      });
    }
  }

  const hand = Array.from({ length: between(random, 0, 25) }, () =>
    o.card(pick(random, [...LANDS, ...CREATURES, ...SPELLS])),
  );
  views[0].hand_count = hand.length;
  const stackItems: StackItem[] = Array.from(
    { length: between(random, 0, 8) },
    () => {
      const controller = pick(random, seats);
      const kind = random();
      const targets: TargetRef[] =
        random() < 0.5
          ? [
              random() < 0.5 || board.length === 0
                ? playerTarget(pick(random, seats))
                : objectTarget(pick(random, board).card),
            ]
          : [];
      if (kind < 0.1)
        return {
          id: o.id(),
          kind: "spell" as const,
          controller_seat: controller,
          name: null,
          text: null,
          hidden: true,
          targets: [],
        };
      if (kind < 0.3 && board.length > 0) {
        const source = pick(random, board);
        return {
          id: o.id(),
          kind: "ability" as const,
          controller_seat: controller,
          name: source.card.name,
          text: source.card.rules[0] ?? null,
          hidden: false,
          targets,
        };
      }
      return spell(o, controller, pick(random, SPELLS), targets);
    },
  );

  // A prompt for seat 0, offering a random share of what it could.
  const yours = board.filter((p) => p.controller_seat === 0);
  const options: (() => PromptOption)[] = [];
  let kind: Prompt["kind"] = "priority";
  const promptRoll = random();
  if (step === "declare_attackers" && active === 0 && promptRoll < 0.7) {
    kind = "declare_attackers";
    for (const p of yours)
      if (isCreatureFace(p.card) && (!p.tapped || p.attacking))
        options.push(() =>
          option("toggle_attacker", { object_id: p.id, selected: p.attacking }),
        );
    options.push(
      () => option("all_attack"),
      () => option("done"),
    );
  } else if (step === "declare_blockers" && active !== 0 && promptRoll < 0.7) {
    kind = "declare_blockers";
    for (const p of yours)
      if (isCreatureFace(p.card) && (!p.tapped || p.blocking))
        options.push(() =>
          option("toggle_blocker", { object_id: p.id, selected: p.blocking }),
        );
    options.push(() => option("done"));
  } else if (promptRoll < 0.3) {
    kind = "choose_target";
    for (const seat of seats)
      if (random() < 0.5) options.push(() => option("choose", { seat }));
    for (const p of board)
      if (random() < 0.25)
        options.push(() =>
          option("choose", { object_id: p.id, selected: random() < 0.05 }),
        );
    for (const item of stackItems)
      if (random() < 0.3)
        options.push(() => option("choose", { object_id: item.id }));
    for (const p of views)
      for (const card of p.graveyard)
        if (random() < 0.1)
          options.push(() => option("choose", { object_id: card.id }));
    options.push(() => option("cancel"));
  } else {
    options.push(
      () => option("pass"),
      () => option("pass_until_next_turn"),
    );
    for (const card of hand)
      if (random() < 0.4)
        options.push(() =>
          option(
            LANDS.some((l) => l.name === card.name) ? "play_land" : "cast",
            {
              object_id: card.id,
            },
          ),
        );
    for (const p of yours)
      if (!p.tapped && random() < 0.3)
        options.push(() =>
          option(isCreatureFace(p.card) ? "activate" : "activate_mana", {
            object_id: p.id,
          }),
        );
    for (const p of views[0].command_zone)
      if (random() < 0.5)
        options.push(() => option("cast", { object_id: p.id }));
  }
  const shown =
    promptRoll > 0.95 ? null : prompt(`p-r${seed}`, kind, "Random.", options);

  const youView = views[0];
  const spectating = perspective === "spectator";
  if (giant) {
    const lives = [between(random, 1, 30), between(random, 1, 30)];
    for (const p of views) {
      p.team = Math.floor(p.seat / 2);
      p.life = p.lost ? 0 : lives[p.team];
    }
    // Seat 0's teammate's hand, in seat 0's view (a spectator's has none).
    if (!spectating) {
      views[1].hand = Array.from({ length: between(random, 0, 20) }, () =>
        o.card(pick(random, [...LANDS, ...CREATURES, ...SPELLS])),
      );
      views[1].hand_count = views[1].hand.length;
    }
  }
  return fixture({
    name: `random-${players}-${seed}${giant ? "-giant" : ""}`,
    description: `Seeded random board ${seed} for ${players} players${giant ? " in Two-Headed Giant" : ""} (${perspective}).`,
    format: giant ? "two_headed_giant" : commanderGame ? "commander" : "legacy",
    seats: seats.map((seat) =>
      seat === 0
        ? alice(perspective === "spectator" ? null : "custom")
        : bot(seat, perspective === "sysop" ? "legacy-mono-red-burn" : null),
    ),
    seat: perspective === "player" ? 0 : null,
    role: perspective === "player" ? "controller" : "observer",
    sysop: perspective === "sysop",
    selfHandle: perspective === "player" ? "alice" : "observer",
    status: spectating ? "spectating" : shown ? "your_prompt" : "waiting",
    revision: 1 + (seed % 97),
    view: view({
      turn: between(random, 1, 30),
      active_seat: active,
      priority_seat: pick(random, seats),
      phase:
        step === "precombat_main"
          ? "precombat_main"
          : step === "end_turn"
            ? "end"
            : "combat",
      step,
      you: spectating ? null : youView,
      opponents: spectating ? views : views.slice(1),
      hand: spectating ? [] : hand,
      battlefield: board,
      stack: stackItems,
      combat,
    }),
    prompt: spectating ? null : shown,
  });
}

function stress(): TableFixture {
  // Four players with sixty permanents each, a full hand and a long stack: the 240-permanent
  // board the renderer's budget and the layout's timing are measured on.
  const base = randomFixture(240, 4, {
    maxPermanents: 0,
    perspective: "player",
  });
  const random = mulberry32(2400);
  const o = new Objects("x");
  const board: PermanentView[] = [];
  for (const seat of [0, 1, 2, 3]) randomPermanents(random, o, seat, 60, board);
  const view = base.snapshot.view!;
  const players = [view.you!, ...view.opponents].map((p) => ({
    ...p,
    lost: false,
    life: Math.max(1, p.life),
    commanders: p.commanders.filter((c) => c.zone === "command"),
    graveyard: Array.from({ length: 15 }, () => o.card(pick(random, SPELLS))),
    exile: Array.from({ length: 4 }, () => o.card(pick(random, SPELLS))),
  }));
  const hand = Array.from({ length: 25 }, () =>
    o.card(pick(random, [...LANDS, ...CREATURES, ...SPELLS])),
  );
  players[0].hand_count = hand.length;
  const stackItems = Array.from({ length: 8 }, (_, i) =>
    spell(o, i % 4, pick(random, SPELLS), [playerTarget((i + 1) % 4)]),
  );
  const handCards = hand.filter(
    (card) => !LANDS.some((l) => l.name === card.name),
  );
  return {
    ...base,
    name: "stress",
    description:
      "Four players, 240 permanents, 25 cards in hand and 8 on the stack.",
    snapshot: {
      ...base.snapshot,
      game_id: "fx-stress",
      status: "your_prompt",
      view: {
        ...view,
        turn: 20,
        active_seat: 0,
        priority_seat: 0,
        phase: "precombat_main",
        step: "precombat_main",
        you: players[0],
        opponents: players.slice(1),
        hand,
        battlefield: board,
        stack: stackItems,
        combat: [],
      },
      prompt: prompt("p-stress", "priority", "Play spells and abilities.", [
        () => option("pass"),
        ...handCards
          .slice(0, 10)
          .map((card) => () => option("cast", { object_id: card.id })),
        ...board
          .filter((p) => p.controller_seat === 0 && !p.tapped)
          .slice(0, 20)
          .map((p) => () => option("activate_mana", { object_id: p.id })),
      ]),
    },
  };
}

export type FixtureName =
  | "duel"
  | "three"
  | "four"
  | "spectator"
  | "sysop"
  | "tokens"
  | "attachments"
  | "stack"
  | "hand25"
  | "blockers"
  | "revealed"
  | "stress"
  | "starting"
  | "giant"
  | "giantSysop";

const makers: Record<FixtureName, () => TableFixture> = {
  duel,
  three,
  four,
  spectator,
  sysop,
  giant,
  giantSysop,
  tokens,
  attachments,
  stack,
  hand25,
  blockers,
  revealed,
  stress,
  starting,
};

export const FIXTURE_NAMES = Object.keys(makers) as FixtureName[];

/** A fresh copy of a fixture: callers may change it freely. */
export function tableFixture(name: FixtureName): TableFixture {
  return makers[name]();
}

/** The table model's input for a fixture, as the game screen builds it from a connection that
 * is open and has nothing in flight. */
export function fixtureInput(
  f: TableFixture,
  change: { canAnswer?: boolean } = {},
): BuildInput {
  const view = f.snapshot.view;
  const prompt = f.snapshot.prompt;
  return {
    gameId: f.snapshot.game_id,
    snapshot: f.snapshot,
    context: {
      view,
      prompt,
      index: objectIndex(view),
      byObject: optionsByObject(prompt),
      bySeat: optionsBySeat(prompt),
      canAnswer:
        change.canAnswer ?? (f.role === "controller" && !f.snapshot.result),
      observing: f.seat === null,
    },
    viewSeat: f.seat,
    summarySeats: f.summarySeats,
    selfHandle: f.selfHandle,
    sysop: f.sysop,
  };
}
