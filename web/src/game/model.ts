import type {
  CardView,
  GameView,
  ObjectId,
  PermanentView,
  PlayerView,
  Prompt,
  PromptOption,
  Seat,
  StackItem,
} from "./types";

// Lookups the board and the prompt panel share. Everything here reads the seat's own view, so
// nothing can name more than the engine already showed this seat.

export type Zone =
  | "hand"
  | "battlefield"
  | "stack"
  | "graveyard"
  | "exile"
  | "command"
  | "revealed"
  | "looked_at";

export interface Located {
  id: ObjectId;
  zone: Zone;
  seat: Seat | null;
  card?: CardView;
  permanent?: PermanentView;
  stack?: StackItem;
}

export function players(view: GameView): PlayerView[] {
  return [...(view.you ? [view.you] : []), ...view.opponents].sort(
    (a, b) => a.seat - b.seat,
  );
}

/** A player as the viewer reads them: "You" for the viewer's own seat. SysOp observing another
 * player's game sees that player's view but owns no seat in it, so the owner goes by name. */
export function playerName(
  view: GameView | null,
  seat: Seat | null,
  observing = false,
): string {
  if (seat === null || !view) return "—";
  if (view.you?.seat === seat) return observing ? view.you.name : "You";
  return (
    view.opponents.find((p) => p.seat === seat)?.name ?? `Seat ${seat + 1}`
  );
}

/** The seat controlling a player's turn (rule 723, v0.5.1: Mindslaver, Sorin Markov and the
 * like), or null while the player controls it themselves. Every view says it of every player. */
export function controllerOf(
  view: GameView | null,
  seat: Seat | null,
): Seat | null {
  if (!view || seat === null) return null;
  return players(view).find((p) => p.seat === seat)?.controlled_by ?? null;
}

/** Whose turn it is, for the band's turn line: "Your turn", "Bot 2’s turn". In Two-Headed Giant
 * (v0.5.0) a team takes its turn together: "Your team’s turn", "Other team’s turn", and to SysOp
 * observing and spectators each team by its number. A turn another player controls (rule 723,
 * v0.5.1) says who controls it: "You control bob’s turn", "ada controls your turn". `name` gives a
 * seat's name as the table shows it (handles at a human table). Null before the first turn. */
export function turnHolder(
  view: GameView,
  observing: boolean,
  name: (seat: Seat) => string,
): string | null {
  const active = view.active_seat;
  if (active === null) return null;
  const team = players(view).find((p) => p.seat === active)?.team ?? null;
  const ours =
    !observing && (active === view.seat || active === teammateOf(view));
  const watching = observing || view.you === null;
  const controller = controllerOf(view, active);
  if (controller === null)
    return ours
      ? active === view.seat
        ? "Your turn"
        : "Your team’s turn"
      : team !== null
        ? watching
          ? `Team ${team + 1}’s turn`
          : "Other team’s turn"
        : `${name(active)}’s turn`;
  const whose = ours
    ? active === view.seat
      ? "your"
      : "your team’s"
    : team !== null
      ? watching
        ? `Team ${team + 1}’s`
        : "the other team’s"
      : `${name(active)}’s`;
  return controller === view.seat && !observing
    ? `You control ${whose} turn`
    : `${name(controller)} controls ${whose} turn`;
}

/** The viewer's teammate's seat in Two-Headed Giant (v0.5.0); null in other games and for
 * spectators. Teammates take their turns together and share one life total. */
export function teammateOf(view: GameView | null): Seat | null {
  const team = view?.you?.team;
  if (team === undefined || team === null) return null;
  return view?.opponents.find((p) => p.team === team)?.seat ?? null;
}

/** Every object the seat can see, by its opaque id. */
export function objectIndex(view: GameView | null): Map<ObjectId, Located> {
  const index = new Map<ObjectId, Located>();
  if (!view) return index;
  const add = (card: CardView, zone: Zone, seat: Seat | null) =>
    index.set(card.id, { id: card.id, zone, seat, card });
  view.hand.forEach((card) => add(card, "hand", view.seat));
  for (const player of players(view)) {
    // A Two-Headed Giant teammate's hand, which the seat may see (810.5, v0.5.1), and the hand
    // of a player whose turn the seat controls (723.4, v0.5.1).
    if (player !== view.you)
      player.hand?.forEach((card) => add(card, "hand", player.seat));
    player.graveyard.forEach((card) => add(card, "graveyard", player.seat));
    player.exile.forEach((card) => add(card, "exile", player.seat));
    player.command_zone.forEach((card) => add(card, "command", player.seat));
  }
  view.revealed.forEach((group) =>
    group.cards.forEach((card) => add(card, "revealed", null)),
  );
  view.looked_at.forEach((group) =>
    group.cards.forEach((card) => add(card, "looked_at", null)),
  );
  for (const permanent of view.battlefield) {
    const located: Located = {
      id: permanent.id,
      zone: "battlefield",
      seat: permanent.controller_seat,
      card: permanent.card,
      permanent,
    };
    index.set(permanent.card.id, located);
    index.set(permanent.id, located);
  }
  for (const item of view.stack)
    index.set(item.id, {
      id: item.id,
      zone: "stack",
      seat: item.controller_seat,
      stack: item,
    });
  return index;
}

export function objectName(located: Located | undefined): string | null {
  if (!located) return null;
  if (located.stack)
    return located.stack.hidden ? "A hidden spell" : located.stack.name;
  if (located.card?.hidden) return "A face-down card";
  return located.card?.name ?? null;
}

export function optionsByObject(
  prompt: Prompt | null,
): Map<ObjectId, PromptOption[]> {
  const map = new Map<ObjectId, PromptOption[]>();
  for (const option of prompt?.options ?? [])
    if (option.object_id) {
      const list = map.get(option.object_id) ?? [];
      list.push(option);
      map.set(option.object_id, list);
    }
  return map;
}

export function optionsBySeat(
  prompt: Prompt | null,
): Map<Seat, PromptOption[]> {
  const map = new Map<Seat, PromptOption[]>();
  for (const option of prompt?.options ?? [])
    if (option.seat !== null && !option.object_id) {
      const list = map.get(option.seat) ?? [];
      list.push(option);
      map.set(option.seat, list);
    }
  return map;
}

const verbs: Record<PromptOption["action"], string> = {
  pass: "Pass priority",
  pass_until_stack_resolved: "Pass until the stack resolves",
  pass_until_next_main: "Pass until the next main phase",
  pass_until_end_of_turn: "Pass until the end of the turn",
  pass_until_next_turn: "Pass until the next turn",
  pass_until_end_step_before_my_turn:
    "Pass until the end step before your turn",
  pass_until_my_turn: "Pass until your next turn",
  cast: "Cast",
  play_land: "Play",
  activate: "Activate",
  activate_mana: "Tap for mana",
  mulligan: "Mulligan",
  keep: "Keep hand",
  yes: "Yes",
  no: "No",
  choose: "Choose",
  done: "Done",
  tap_source: "Tap",
  use_pool: "Use from pool",
  special_payment: "Special payment",
  cancel: "Cancel",
  toggle_attacker: "Attack with",
  all_attack: "Attack With All",
  toggle_blocker: "Block with",
  suggested: "Use the suggestion",
  use_ability: "Use",
  choose_mode: "Choose",
  put_first: "Put first",
  choose_pile: "Choose",
};

/** The option in words: the engine's label, or the action and its object or player. */
export function optionText(
  option: PromptOption,
  index: Map<ObjectId, Located>,
  view: GameView | null,
  observing = false,
): string {
  const subject = option.object_id
    ? objectName(index.get(option.object_id))
    : option.seat !== null
      ? playerName(view, option.seat, observing)
      : null;
  if (option.action === "toggle_attacker" && option.selected && subject)
    return `Stop attacking with ${subject}`;
  if (option.action === "toggle_blocker" && option.selected && subject)
    return `Stop blocking with ${subject}`;
  if (option.label) {
    // The engine labels object options with the object's name; say what the option does.
    if (subject && option.label === subject)
      return option.action === "activate_mana"
        ? `Tap ${subject} for mana`
        : `${verbs[option.action]} ${subject}`;
    if (subject && !option.label.includes(subject) && option.object_id)
      return `${option.label} (${subject})`;
    return option.label;
  }
  return subject ? `${verbs[option.action]} ${subject}` : verbs[option.action];
}

/** The option the "primary" key and button answer: pass, done, keep or yes. */
export function primaryOption(prompt: Prompt | null): PromptOption | undefined {
  const order: PromptOption["action"][] = ["pass", "done", "keep", "yes"];
  for (const action of order) {
    const found = prompt?.options.find((option) => option.action === action);
    if (found) return found;
  }
  return undefined;
}

export function words(value: string | null): string {
  if (!value) return "";
  const text = value.replace(/_/g, " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function isLand(card: CardView): boolean {
  return /\bLand\b/.test(card.type_line ?? "");
}

export function isCreature(card: CardView): boolean {
  return /\bCreature\b/.test(card.type_line ?? "");
}

const colourNames: Record<string, string> = {
  W: "white",
  U: "blue",
  B: "black",
  R: "red",
  G: "green",
  C: "colorless",
  X: "X",
  S: "snow",
  T: "tap",
  Q: "untap",
};

/** Splits "{2}{W}{U/P}" into its symbols. */
export function manaSymbols(cost: string | null): string[] {
  return cost
    ? (cost.match(/\{[^}]+\}/g) ?? []).map((s) => s.slice(1, -1))
    : [];
}

export function manaWords(cost: string | null): string {
  return manaSymbols(cost)
    .map((symbol) =>
      /^\d+$/.test(symbol)
        ? `${symbol} generic`
        : symbol
            .split("/")
            .map((part) => colourNames[part] ?? part)
            .join(" or "),
    )
    .join(", ");
}

/** The result in words for the viewer's seat; with no seat (SysOp observing), in neutral words. */
export function resultText(
  view: GameView | null,
  seat: Seat | null,
  result: {
    kind: string;
    winner_seat: Seat | null;
    /** The winning team in Two-Headed Giant (v0.5.0). */
    winner_seats?: Seat[];
    draw: boolean;
    turns: number;
  },
  /** A seat's player by name: at a human table their handle (v0.4.0); else the view's. */
  nameOf: (winner: Seat) => string = (winner) =>
    playerName(view, winner, seat === null),
): { title: string; detail: string } {
  const turns = `${result.turns} turn${result.turns === 1 ? "" : "s"}`;
  if (result.draw)
    return {
      title: "A draw",
      detail: `The game ended in a draw after ${turns}.`,
    };
  if (result.winner_seat !== null) {
    // A team wins together (Two-Headed Giant): either teammate's seat is a victory. Since v0.5.1
    // the result names the winning team: you and your teammate, the other team's players, or to
    // SysOp observing the team's number as the plates give it.
    const seats = result.winner_seats ?? [];
    const team = seats.length > 1 ? seats : [];
    if (result.winner_seat === seat || (seat !== null && team.includes(seat))) {
      const mates = team.filter((other) => other !== seat).map(nameOf);
      return {
        title: "Victory",
        detail:
          team.length > 1
            ? mates.length > 0
              ? `You and ${mates.join(" and ")} won in ${turns}.`
              : `Your team won in ${turns}.`
            : `You won in ${turns}.`,
      };
    }
    const winner =
      team.length > 1
        ? team.map(nameOf).join(" and ")
        : nameOf(result.winner_seat);
    const number = view
      ? players(view).find((p) => p.seat === team[0])?.team
      : undefined;
    return {
      title: seat === null ? "Game over" : "Defeat",
      detail:
        seat === null && team.length > 1 && typeof number === "number"
          ? `Team ${number + 1} won in ${turns}: ${winner}.`
          : `${winner} won in ${turns}.`,
    };
  }
  const kinds: Record<string, string> = {
    turn_limit: "The turn limit was reached",
    closed: "The game was closed",
    idle_timeout: "The game timed out while waiting",
    humans_eliminated: "Every human player is out",
    error: "The rules engine stopped the game",
    completed: "The game is over",
  };
  return {
    title: "Game over",
    detail: `${kinds[result.kind] ?? "The game ended"} after ${turns}.`,
  };
}
