import type {
  CardView,
  CombatGroup,
  CommanderView,
  GameView,
  LogLine,
  ObjectId,
  PermanentView,
  PlayerView,
  Seat,
  Snapshot,
  StackItem,
} from "../game/types";

// The Beginner's watched game (v0.8.4, docs/menus.md#the-tutorial): a Commander game between two
// bots, written move by move as the seat views the engine would send Mira's seat, and played back
// on the real table. Being written, it shows every lesson at the moment its narration explains it
// (lands and mana, casting, summoning sickness, haste, attacking and blocking, the stack, the
// commander, its tax and commander damage), the same way every time, with no engine game.

type Face = Omit<CardView, "id" | "hidden">;

function face(
  name: string,
  cost: string | null,
  type: string,
  pt: string | null,
  ...rules: string[]
): Face {
  const [power, toughness] = pt ? pt.split("/") : [null, null];
  return { name, mana_cost: cost, type_line: type, power, toughness, rules };
}

const CARDS = {
  forest: face("Forest", null, "Basic Land — Forest", null, "({T}: Add {G}.)"),
  plains: face("Plains", null, "Basic Land — Plains", null, "({T}: Add {W}.)"),
  swamp: face("Swamp", null, "Basic Land — Swamp", null, "({T}: Add {B}.)"),
  mountain: face(
    "Mountain",
    null,
    "Basic Land — Mountain",
    null,
    "({T}: Add {R}.)",
  ),
  bears: face("Grizzly Bears", "{1}{G}", "Creature — Bear", "2/2"),
  elves: face(
    "Llanowar Elves",
    "{G}",
    "Creature — Elf Druid",
    "1/1",
    "{T}: Add {G}.",
  ),
  lions: face("Savannah Lions", "{W}", "Creature — Cat", "2/1"),
  growth: face(
    "Giant Growth",
    "{G}",
    "Instant",
    null,
    "Target creature gets +3/+3 until end of turn.",
  ),
  swords: face(
    "Swords to Plowshares",
    "{W}",
    "Instant",
    null,
    "Exile target creature. Its controller gains life equal to its power.",
  ),
  sigarda: face(
    "Sigarda, Host of Herons",
    "{2}{G}{W}{W}",
    "Legendary Creature — Angel",
    "5/5",
    "Flying, hexproof",
    "Spells and abilities your opponents control can't cause you to sacrifice permanents.",
  ),
  goblin: face(
    "Raging Goblin",
    "{R}",
    "Creature — Goblin Berserker",
    "1/1",
    "Haste",
  ),
  bolt: face(
    "Lightning Bolt",
    "{R}",
    "Instant",
    null,
    "Lightning Bolt deals 3 damage to any target.",
  ),
  judith: face(
    "Judith, the Scourge Diva",
    "{1}{B}{R}",
    "Legendary Creature — Human Shaman",
    "2/2",
    "Other creatures you control get +1/+0.",
    "Whenever a nontoken creature you control dies, Judith, the Scourge Diva deals 1 damage to any target.",
  ),
  giant: face("Hill Giant", "{3}{R}", "Creature — Giant", "3/3"),
  angel: face(
    "Serra Angel",
    "{3}{W}{W}",
    "Creature — Angel",
    "4/4",
    "Flying",
    "Vigilance",
  ),
  ogre: face("Gray Ogre", "{2}{R}", "Creature — Ogre", "2/2"),
} satisfies Record<string, Face>;

export const MIRA: Seat = 0;
export const VOK: Seat = 1;
const NAMES = ["Mira", "Vok"];

/** One moment of the game: what the table shows, and the log so far. */
export type DemoFrame = Snapshot;

/** One lesson: its words, and the frames the table plays through as it is read. */
export interface DemoBeat {
  title: string;
  text: string;
  frames: DemoFrame[];
}

/** The game as it is built, move by move. */
class Table {
  private n = 0;
  private revision = 0;
  turn = 1;
  active: Seat = MIRA;
  phase = "beginning";
  step = "untap";
  hand: CardView[] = [];
  players: [PlayerView, PlayerView];
  battlefield: PermanentView[] = [];
  stack: StackItem[] = [];
  combat: CombatGroup[] = [];
  log: LogLine[] = [];
  private frames: DemoFrame[] = [];

  constructor() {
    this.players = [this.player(MIRA, "GW"), this.player(VOK, "BR")];
  }

  private player(seat: Seat, identity: string): PlayerView {
    return {
      seat,
      name: NAMES[seat]!,
      life: 40,
      counters: {},
      library_count: 92,
      hand_count: 7,
      graveyard: [],
      exile: [],
      mana_pool: {
        white: 0,
        blue: 0,
        black: 0,
        red: 0,
        green: 0,
        colorless: 0,
      },
      lost: false,
      won: false,
      color_identity: identity,
      command_zone: [],
      commanders: [],
    };
  }

  card(made: Face): CardView {
    this.n += 1;
    return {
      id: `demo-${this.n}`,
      hidden: false,
      ...made,
      rules: [...made.rules],
    };
  }

  commander(seat: Seat, made: Face): CardView {
    const card = this.card(made);
    const player = this.players[seat];
    player.command_zone = [card];
    const view: CommanderView = {
      name: made.name ?? "",
      zone: "command",
      object_id: card.id,
      cast_count: 0,
      tax: 0,
      damage_dealt: [],
    };
    player.commanders = [view];
    return card;
  }

  say(text: string): void {
    this.log.push({
      index: this.log.length,
      turn: this.turn,
      active_seat: this.active,
      step: this.step,
      text,
    });
  }

  /** The table as it is now, as one frame. */
  frame(): void {
    this.revision += 1;
    const view: GameView = {
      seat: MIRA,
      turn: this.turn,
      active_seat: this.active,
      priority_seat: this.active,
      phase: this.phase,
      step: this.step,
      you: this.players[MIRA],
      opponents: [this.players[VOK]],
      hand: this.hand,
      battlefield: this.battlefield,
      stack: this.stack,
      combat: this.combat,
      revealed: [],
      looked_at: [],
      messages: [],
      priority: null,
    };
    const snapshot: Snapshot = {
      game_id: "tutorial-demo",
      revision: this.revision,
      status: "waiting",
      seat: MIRA,
      settings: {
        format: "commander",
        rules_profile: "commander",
        seats: [
          { seat: MIRA, player: "bot", deck: null },
          { seat: VOK, player: "bot", deck: null },
        ],
        skill: 4,
        turn_cap: 80,
        idle_timeout_seconds: 900,
        spectator_delay_seconds: 0,
      },
      prompt: null,
      view,
      result: null,
      log_count: this.log.length,
      log_from: 0,
      log: [],
    };
    this.frames.push(structuredClone({ ...snapshot, log: [...this.log] }));
  }

  /** The frames made since the last call. */
  take(): DemoFrame[] {
    const frames = this.frames;
    this.frames = [];
    return frames;
  }

  at(phase: string, step: string = phase): void {
    this.phase = phase;
    this.step = step;
  }

  newTurn(seat: Seat): void {
    this.turn += 1;
    this.active = seat;
    this.combat = [];
    this.at("beginning", "untap");
    for (const permanent of this.battlefield)
      if (permanent.controller_seat === seat) {
        permanent.tapped = false;
        permanent.summoning_sick = false;
      }
    this.say(`Turn ${this.turn}: ${NAMES[seat]}.`);
  }

  /** The end of a turn: damage wears off, and so do "until end of turn" effects. */
  endTurn(): void {
    this.at("end", "end_turn");
    this.combat = [];
    for (const permanent of this.battlefield) {
      permanent.damage = 0;
      permanent.attacking = false;
      permanent.blocking = false;
    }
  }

  draw(seat: Seat, made?: Face): CardView | null {
    const player = this.players[seat];
    player.library_count -= 1;
    player.hand_count += 1;
    this.at("beginning", "draw");
    this.say(`${NAMES[seat]} draws a card.`);
    if (seat !== MIRA || !made) return null;
    const card = this.card(made);
    this.hand.push(card);
    return card;
  }

  private fromHand(seat: Seat, card: CardView): void {
    this.players[seat].hand_count -= 1;
    if (seat === MIRA) this.hand = this.hand.filter((c) => c.id !== card.id);
  }

  /** A card of Vok's, from his hidden hand. */
  his(made: Face): CardView {
    return this.card(made);
  }

  playLand(seat: Seat, card: CardView): PermanentView {
    this.fromHand(seat, card);
    const permanent = this.permanent(seat, card);
    this.say(`${NAMES[seat]} plays ${card.name}.`);
    return permanent;
  }

  permanent(seat: Seat, card: CardView, sick = false): PermanentView {
    const permanent: PermanentView = {
      id: card.id,
      controller_seat: seat,
      owner_seat: seat,
      card,
      tapped: false,
      summoning_sick: sick,
      damage: 0,
      counters: {},
      attacking: false,
      blocking: false,
      attached_to: null,
    };
    this.battlefield.push(permanent);
    return permanent;
  }

  tap(...permanents: PermanentView[]): void {
    for (const permanent of permanents) permanent.tapped = true;
  }

  cast(
    seat: Seat,
    card: CardView,
    targets: { seat?: Seat; card?: CardView }[] = [],
    from: "hand" | "command" = "hand",
  ): void {
    if (from === "hand") this.fromHand(seat, card);
    else {
      const player = this.players[seat];
      player.command_zone = player.command_zone.filter((c) => c.id !== card.id);
      const commander = player.commanders[0]!;
      commander.zone = "stack";
      commander.cast_count += 1;
      // What the next cast from the command zone costs more.
      commander.tax = commander.cast_count * 2;
    }
    this.stack.push({
      id: card.id,
      kind: "spell",
      controller_seat: seat,
      name: card.name,
      text: card.rules.join(" ") || null,
      hidden: false,
      targets: targets.map((target) =>
        target.card
          ? {
              kind: "object",
              seat: null,
              object_id: target.card.id,
              label: target.card.name,
            }
          : {
              kind: "player",
              seat: target.seat ?? null,
              object_id: null,
              label: null,
            },
      ),
    });
    const named = targets.find((target) => target.card)?.card?.name;
    this.say(
      `${NAMES[seat]} casts ${card.name}${named ? ` targeting ${named}` : ""}.`,
    );
  }

  /** The top of the stack resolves: a permanent spell enters, any other goes to the graveyard. */
  resolve(card: CardView): PermanentView | null {
    this.stack = this.stack.filter((item) => item.id !== card.id);
    const seat = this.owner(card);
    this.say(`${card.name} resolves.`);
    const type = card.type_line ?? "";
    if (type.includes("Instant") || type.includes("Sorcery")) {
      this.players[seat].graveyard.push(card);
      return null;
    }
    const creature = type.includes("Creature");
    const haste = card.rules.some((rule) => /\bHaste\b/.test(rule));
    const permanent = this.permanent(seat, card, creature && !haste);
    const commander = this.players[seat].commanders[0];
    if (commander?.object_id === card.id) commander.zone = "battlefield";
    return permanent;
  }

  private owners = new Map<ObjectId, Seat>();
  own(seat: Seat, ...cards: CardView[]): void {
    for (const card of cards) this.owners.set(card.id, seat);
  }
  private owner(card: CardView): Seat {
    return this.owners.get(card.id) ?? MIRA;
  }

  attack(attackers: PermanentView[], defender: Seat): void {
    this.at("combat", "declare_attackers");
    for (const attacker of attackers) {
      attacker.attacking = true;
      if (!attacker.card.rules.some((rule) => rule.includes("Vigilance")))
        attacker.tapped = true;
    }
    this.combat = attackers.map((attacker) => ({
      attackers: [attacker.id],
      defender: {
        kind: "player",
        seat: defender,
        object_id: null,
        label: null,
      },
      blockers: [],
      blocked: false,
    }));
    this.say(
      `${NAMES[attackers[0]!.controller_seat]} attacks ${NAMES[defender]} with ${attackers
        .map((a) => a.card.name)
        .join(" and ")}.`,
    );
  }

  block(blocker: PermanentView, attacker: PermanentView): void {
    this.at("combat", "declare_blockers");
    blocker.blocking = true;
    const group = this.combat.find((g) => g.attackers.includes(attacker.id));
    if (group) {
      group.blockers.push(blocker.id);
      group.blocked = true;
    }
    this.say(`${blocker.card.name} blocks ${attacker.card.name}.`);
  }

  /** A permanent goes to its owner's graveyard. */
  dies(permanent: PermanentView): void {
    this.battlefield = this.battlefield.filter((p) => p.id !== permanent.id);
    this.players[permanent.owner_seat].graveyard.push(permanent.card);
    this.say(`${permanent.card.name} dies.`);
  }

  /** A commander leaving the battlefield goes back to the command zone, as its owner chooses. */
  toCommand(permanent: PermanentView): void {
    this.battlefield = this.battlefield.filter((p) => p.id !== permanent.id);
    const player = this.players[permanent.owner_seat];
    player.command_zone = [permanent.card];
    const commander = player.commanders[0]!;
    commander.zone = "command";
    this.say(
      `${NAMES[permanent.owner_seat]} puts ${permanent.card.name} into the command zone.`,
    );
  }

  life(seat: Seat, change: number): void {
    this.players[seat].life += change;
  }

  commanderDamage(from: Seat, to: Seat, amount: number): void {
    const commander = this.players[from].commanders[0]!;
    const entry = commander.damage_dealt.find((d) => d.seat === to);
    if (entry) entry.damage += amount;
    else commander.damage_dealt.push({ seat: to, damage: amount });
  }

  setPower(permanent: PermanentView, power: number, toughness: number): void {
    permanent.card.power = String(power);
    permanent.card.toughness = String(toughness);
  }
}

/** The whole game, lesson by lesson. */
export function buildDemo(): DemoBeat[] {
  const t = new Table();
  const beats: DemoBeat[] = [];
  const beat = (title: string, text: string) =>
    beats.push({ title, text, frames: t.take() });

  // The start: both commanders wait in the command zone, seven cards in each hand.
  const sigarda = t.commander(MIRA, CARDS.sigarda);
  const judith = t.commander(VOK, CARDS.judith);
  t.own(MIRA, sigarda);
  t.own(VOK, judith);
  const [forest1, plains1, bearsCard, growth, swords, forest2, lions] = [
    CARDS.forest,
    CARDS.plains,
    CARDS.bears,
    CARDS.growth,
    CARDS.swords,
    CARDS.forest,
    CARDS.lions,
  ].map((made) => t.card(made)) as CardView[];
  t.hand = [forest1!, plains1!, bearsCard!, growth!, swords!, forest2!, lions!];
  t.own(MIRA, ...t.hand);
  t.say("Turn 1: Mira.");
  t.at("beginning", "untap");
  t.frame();
  beat(
    "A game of Commander",
    "Two bots are playing Commander. Mira (green and white) sits at the bottom, her hand shown to you; Vok (black and red) sits across the table. Each has 40 life and a 100-card deck: a commander, waiting in the command zone by their portrait, and 99 other cards, shuffled to make their library. Each drew seven to start. You only watch: press Next for each move.",
  );

  t.at("beginning", "upkeep");
  t.frame();
  t.at("precombat_main");
  t.frame();
  beat(
    "The steps of a turn",
    "Every turn runs in the same order. First the beginning: untap, upkeep, draw a card. Then a main phase, combat, a second main phase, and the end. The red band across the middle shows whose turn it is and the step. In a two-player game, whoever goes first skips their first draw, so Mira goes straight to her main phase.",
  );

  const f1 = t.playLand(MIRA, forest1!);
  t.frame();
  beat(
    "Lands and mana",
    "Once in each of their turns, in a main phase, a player may play one land from their hand. Lands make mana, which pays for spells: tapping Mira's Forest (turning it sideways) gives one green mana, {G}. Plains give white {W}, Islands blue {U}, Swamps black {B} and Mountains red {R}.",
  );

  // Turn 2: Vok.
  t.endTurn();
  t.frame();
  t.newTurn(VOK);
  t.draw(VOK);
  t.frame();
  const swamp1 = t.his(CARDS.swamp);
  t.own(VOK, swamp1);
  const s1 = t.playLand(VOK, swamp1);
  t.at("precombat_main");
  t.frame();
  beat(
    "Taking turns",
    "Mira has nothing more to do, so she ends her turn. Vok's turn begins: he untaps, draws a card and plays a Swamp. Hands and libraries are hidden from the other players, so you see only the backs of Vok's cards.",
  );

  // Turn 3: Mira casts Grizzly Bears.
  t.endTurn();
  t.newTurn(MIRA);
  const elvesCard = t.draw(MIRA, CARDS.elves)!;
  t.own(MIRA, elvesCard);
  t.frame();
  t.at("precombat_main");
  const p1 = t.playLand(MIRA, plains1!);
  t.frame();
  t.tap(f1, p1);
  t.cast(MIRA, bearsCard!);
  t.frame();
  const bears = t.resolve(bearsCard!)!;
  t.frame();
  beat(
    "Casting a spell",
    "Mira draws and plays a Plains. To cast a spell, a player pays the mana cost at its top right. Grizzly Bears costs {1}{G}: one green mana and one of any kind, so Mira taps her Forest and Plains. A new creature has summoning sickness: it can't attack, or use an ability with {T} (tap) in its cost, until its controller's next turn.",
  );

  // Turn 4: Vok casts a creature with haste and attacks.
  t.endTurn();
  t.newTurn(VOK);
  t.draw(VOK);
  t.frame();
  t.at("precombat_main");
  const mountain1 = t.his(CARDS.mountain);
  const goblinCard = t.his(CARDS.goblin);
  t.own(VOK, mountain1, goblinCard);
  const m1 = t.playLand(VOK, mountain1);
  t.frame();
  t.tap(m1);
  t.cast(VOK, goblinCard);
  t.frame();
  const goblin = t.resolve(goblinCard)!;
  t.frame();
  beat(
    "Haste",
    "Vok draws, plays a Mountain and casts Raging Goblin for {R}. It has haste, so summoning sickness doesn't hold it back: it can attack this very turn.",
  );

  t.at("combat", "begin_combat");
  t.frame();
  t.attack([goblin], MIRA);
  t.frame();
  beat(
    "Attacking",
    "In combat, the player whose turn it is picks which of their creatures attack, and whom. Attacking taps a creature. Raging Goblin is a 1/1: power 1, the damage it deals, and toughness 1, the damage that destroys it. It attacks Mira.",
  );

  t.block(bears, goblin);
  t.frame();
  t.at("combat", "combat_damage");
  bears.damage = 1;
  t.say("Raging Goblin deals 1 damage to Grizzly Bears.");
  t.say("Grizzly Bears deals 2 damage to Raging Goblin.");
  t.frame();
  t.dies(goblin);
  t.at("combat", "end_combat");
  t.frame();
  beat(
    "Blocking",
    "The defender may block with any untapped creature, even one that arrived this turn. Mira blocks with her Grizzly Bears, a 2/2. The two deal their power in damage to each other: 1 to the Bears, 2 to the Goblin. Damage at least equal to its toughness destroys a creature, so the Goblin goes to Vok's graveyard, his pile of used cards. Damage on the Bears wears off at the end of the turn.",
  );

  // Turn 5: Mira attacks; Vok takes damage.
  t.endTurn();
  t.newTurn(MIRA);
  t.draw(MIRA, CARDS.plains);
  const plains2 = t.hand[t.hand.length - 1]!;
  t.own(MIRA, plains2);
  t.at("precombat_main");
  const f2 = t.playLand(MIRA, forest2!);
  t.tap(f2);
  t.cast(MIRA, elvesCard);
  t.frame();
  const elves = t.resolve(elvesCard)!;
  t.frame();
  t.at("combat", "begin_combat");
  t.attack([bears], VOK);
  t.frame();
  t.at("combat", "combat_damage");
  t.life(VOK, -2);
  t.say("Grizzly Bears deals 2 damage to Vok.");
  t.frame();
  beat(
    "Damage to a player",
    "Mira plays a Forest and casts Llanowar Elves, which can tap for {G} once its summoning sickness wears off. Then she attacks Vok with her Bears. With no creature to block, Vok takes their 2 damage: his 40 life becomes 38. A player at 0 life or less loses the game.",
  );

  // Turn 6: Vok keeps his mana for Mira's turn.
  t.endTurn();
  t.newTurn(VOK);
  t.draw(VOK);
  t.at("precombat_main");
  const swamp2 = t.his(CARDS.swamp);
  t.own(VOK, swamp2);
  const s2 = t.playLand(VOK, swamp2);
  t.frame();
  t.endTurn();
  t.frame();
  beat(
    "Mana kept back",
    "Vok plays a Swamp and casts nothing, so his lands stay untapped as his turn ends. Untapped lands can still make mana in Mira's turn, for an instant: a spell that can be cast at any time, even in another player's turn.",
  );

  // Turn 7: the stack.
  t.newTurn(MIRA);
  t.draw(MIRA, CARDS.forest);
  const forest3 = t.hand[t.hand.length - 1]!;
  t.own(MIRA, forest3);
  t.at("precombat_main");
  const p2 = t.playLand(MIRA, plains2);
  t.frame();
  t.at("combat", "begin_combat");
  t.attack([bears], VOK);
  t.frame();
  const boltCard = t.his(CARDS.bolt);
  t.own(VOK, boltCard);
  t.tap(m1);
  t.cast(VOK, boltCard, [{ card: bears.card }]);
  t.frame();
  beat(
    "The stack",
    "Mira plays a Plains and attacks with her Bears. Vok answers: he taps a Mountain for Lightning Bolt, aimed at the Bears, and its 3 damage would destroy them. A spell doesn't happen at once. It waits on the stack, in the middle of the band, and each player may respond before it resolves (takes effect).",
  );

  t.tap(elves);
  t.cast(MIRA, growth!, [{ card: bears.card }]);
  t.frame();
  beat(
    "Responding",
    "Mira responds: she taps her Elves for {G} and casts Giant Growth, an instant of her own, on the Bears. It goes on the stack on top of the Bolt. The stack resolves from the top down, so the last spell cast happens first.",
  );

  t.resolve(growth!);
  t.setPower(bears, 5, 5);
  t.frame();
  t.resolve(boltCard);
  bears.damage = 3;
  t.say("Lightning Bolt deals 3 damage to Grizzly Bears.");
  t.frame();
  t.at("combat", "declare_blockers");
  t.frame();
  t.at("combat", "combat_damage");
  t.life(VOK, -5);
  t.say("Grizzly Bears deals 5 damage to Vok.");
  t.frame();
  beat(
    "Last in, first out",
    "Giant Growth resolves first: the Bears are 5/5 until the end of the turn. Then the Bolt resolves, and 3 damage is no longer enough. Vok has no creature to block with, and the Bears hit him for 5: he is at 33.",
  );

  // Turn 8: Vok casts his commander.
  t.endTurn();
  t.setPower(bears, 2, 2);
  t.newTurn(VOK);
  t.draw(VOK);
  t.at("precombat_main");
  const mountain2 = t.his(CARDS.mountain);
  t.own(VOK, mountain2);
  const m2 = t.playLand(VOK, mountain2);
  t.frame();
  t.tap(s1, m1, s2);
  t.cast(VOK, judith, [], "command");
  t.frame();
  const judithOut = t.resolve(judith)!;
  t.frame();
  beat(
    "The commander",
    "Vok casts his commander, Judith, the Scourge Diva, straight from the command zone, paying {1}{B}{R} as for any spell. A commander is the legendary creature a deck is built around, and every card in the deck may use only its colors. Judith gives Vok's other creatures +1/+0: one more power each.",
  );

  // Turn 9: removal, and Mira's commander.
  t.endTurn();
  t.newTurn(MIRA);
  t.draw(MIRA, CARDS.plains);
  const plains3 = t.hand[t.hand.length - 1]!;
  t.own(MIRA, plains3);
  t.at("precombat_main");
  const p3 = t.playLand(MIRA, plains3);
  t.frame();
  t.tap(p1);
  t.cast(MIRA, swords!, [{ card: judithOut.card }]);
  t.frame();
  t.resolve(swords!);
  t.toCommand(judithOut);
  t.life(VOK, 2);
  t.say("Vok gains 2 life.");
  t.frame();
  beat(
    "Back to the command zone",
    "Mira casts Swords to Plowshares on Judith, exiling her: she is removed from the game. But a commander that goes to the graveyard or into exile may be moved back to the command zone, and Vok moves Judith there. Swords gives him life equal to her power, 2: he is at 35.",
  );

  t.tap(f1, f2, p2, p3, elves);
  t.cast(MIRA, sigarda, [], "command");
  t.frame();
  const sigardaOut = t.resolve(sigarda)!;
  t.frame();
  beat(
    "Mira's commander",
    "Then Mira casts her own commander, Sigarda, Host of Herons, for {2}{G}{W}{W}: a 5/5 with flying, so only creatures with flying or reach can block her, and hexproof, so her opponents' spells and abilities can't target her.",
  );

  // Turn 10: the commander tax.
  t.endTurn();
  t.newTurn(VOK);
  t.draw(VOK);
  t.at("precombat_main");
  const swamp3 = t.his(CARDS.swamp);
  t.own(VOK, swamp3);
  const s3 = t.playLand(VOK, swamp3);
  t.frame();
  t.tap(s1, m1, s2, m2, s3);
  t.cast(VOK, judith, [], "command");
  t.frame();
  t.resolve(judith);
  t.frame();
  beat(
    "The commander tax",
    "A commander costs {2} more for each time it has already been cast from the command zone: the commander tax. Judith's second cast costs her {1}{B}{R} and {2} more, five mana in all, and Vok taps all five of his lands to bring her back.",
  );

  // Turn 11: commander damage.
  t.endTurn();
  t.newTurn(MIRA);
  t.draw(MIRA, CARDS.forest);
  t.at("precombat_main");
  t.playLand(MIRA, forest3);
  t.tap(p1);
  t.cast(MIRA, lions!);
  t.frame();
  t.resolve(lions!);
  t.at("combat", "begin_combat");
  t.attack([sigardaOut], VOK);
  t.frame();
  t.at("combat", "combat_damage");
  t.life(VOK, -5);
  t.commanderDamage(MIRA, VOK, 5);
  t.say("Sigarda, Host of Herons deals 5 damage to Vok.");
  t.frame();
  beat(
    "Commander damage",
    "Mira casts Savannah Lions, then attacks with Sigarda. Nothing of Vok's can fly, so nothing can block her. Combat damage from a commander is also counted on its own, by the player's portrait: a player dealt 21 combat damage by one commander loses, whatever their life. Sigarda has dealt Vok 5, and he is at 30.",
  );

  // A few turns later: Sigarda has hit on turns 13, 15 and 17.
  t.endTurn();
  t.turn = 17;
  t.newTurn(VOK);
  t.at("end", "end_turn");
  t.life(VOK, -15);
  t.commanderDamage(MIRA, VOK, 15);
  t.life(MIRA, -14);
  const angelCard = t.card(CARDS.angel);
  t.own(MIRA, angelCard);
  t.permanent(MIRA, angelCard);
  for (const made of [CARDS.ogre, CARDS.giant]) {
    const card = t.his(made);
    t.own(VOK, card);
    const permanent = t.permanent(VOK, card);
    // Judith's +1/+0.
    t.setPower(permanent, Number(made.power) + 1, Number(made.toughness));
  }
  for (const land of [CARDS.forest, CARDS.plains, CARDS.forest])
    t.permanent(MIRA, t.card(land));
  for (const land of [CARDS.mountain, CARDS.swamp, CARDS.mountain])
    t.permanent(VOK, t.card(land));
  t.players[MIRA].library_count -= 4;
  t.players[VOK].library_count -= 4;
  t.players[VOK].graveyard.push(t.card(CARDS.bolt));
  t.say("Vok ends his turn.");
  t.frame();
  beat(
    "A few turns later",
    "Skipping ahead to the end of turn 18: Sigarda has hit Vok three more times, 20 commander damage in all. Vok still has 15 life, and Mira 26 after his attacks, but one more hit from Sigarda ends the game, however much life he has left.",
  );

  // Turn 19: the last attack.
  t.newTurn(MIRA);
  t.draw(MIRA, CARDS.plains);
  t.at("precombat_main");
  t.frame();
  t.at("combat", "begin_combat");
  t.attack([sigardaOut], VOK);
  t.frame();
  t.at("combat", "combat_damage");
  t.life(VOK, -5);
  t.commanderDamage(MIRA, VOK, 5);
  t.say("Sigarda, Host of Herons deals 5 damage to Vok.");
  t.frame();
  t.players[VOK].lost = true;
  t.players[MIRA].won = true;
  t.say(
    "Vok has been dealt 21 or more combat damage by Sigarda, Host of Herons and loses the game.",
  );
  t.say("Mira wins the game.");
  t.frame();
  beat(
    "The end of the game",
    "Sigarda attacks once more: 25 commander damage, and Vok loses with 10 life left. With three or four players, the rest would play on until one was left. That was a whole game of Commander, from the first land to the last attack.",
  );

  t.frame();
  beat(
    "Your turn at the table",
    "In your own games, your choices are the big diamonds at the table's left: Continue (to let the game go on), Attack, Block and the like, with every other choice listed below them. Play a card from your hand by dragging it onto the table, or click it. Any card shows large as you point at it. The small diamonds on the band open the Game menu (options, Concede) and the log.",
  );
  return beats;
}
