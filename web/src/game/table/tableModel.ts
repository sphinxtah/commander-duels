import { cardLabel } from "../Card";
import {
  objectName,
  optionText,
  playerName,
  type Located,
  type Zone,
} from "../model";
import type {
  CardView,
  ObjectId,
  PermanentView,
  PlayerView,
  PromptOption,
  Seat,
  StackItem,
} from "../types";
import { groupUnits } from "./groups";
import type {
  Arrangement,
  BuildTableModel,
  DragKind,
  LineModel,
  Mark,
  TableCard,
  TableModel,
  TablePlayer,
  TableStackEntry,
} from "./types";

// The table model: one seat view and its prompt, rearranged for the table. Every name, mark and
// label comes from the committed view and the prompt on screen, never from the log, and a hidden
// card stays hidden: it carries its id and nothing else (design §23).

/** Marks follow what is offered, whether or not this tab can answer it now (C2). */
function markOf(offered: PromptOption[], playable: boolean): Mark {
  if (offered.some((option) => option.selected)) return "selected";
  if (playable) return "playable";
  return offered.length > 0 ? "offered" : "none";
}

const playActions = new Set<PromptOption["action"]>([
  "cast",
  "play_land",
  "activate",
]);

/** A fixture deck's slug in words: "legacy-mono-red-burn" is "Mono Red Burn". */
function deckTitle(deck: string | null | undefined): string | null {
  if (!deck) return null;
  if (deck === "custom") return "Custom deck";
  if (!/^[a-z0-9]+(-[a-z0-9]+)+$/.test(deck)) return deck;
  const parts = deck.split("-");
  if (parts[0] === "legacy" || parts[0] === "commander") parts.shift();
  return parts.map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}

/** A stack item as a card, so the scene and the magnifier can draw it like one. */
function stackCard(item: StackItem): CardView {
  return {
    id: item.id,
    hidden: item.hidden,
    name: item.hidden ? null : item.name,
    mana_cost: null,
    type_line: item.hidden ? null : item.kind === "ability" ? "Ability" : null,
    power: null,
    toughness: null,
    rules: !item.hidden && item.text ? [item.text] : [],
  };
}

function sentence(text: string): string {
  return text.trim().replace(/\.+$/, "");
}

export const buildTableModel: BuildTableModel = (input) => {
  const { snapshot, context, viewSeat, summarySeats, selfHandle, sysop } =
    input;
  const view = context.view;
  const prompt = context.prompt;
  const observing = context.observing;
  const cards = new Map<string, TableCard>();
  const base = {
    gameId: input.gameId,
    revision: snapshot.revision,
    promptId: prompt?.id ?? null,
    promptKind: prompt?.kind ?? null,
    commander: snapshot.settings.format === "commander",
    viewSeat,
    observing,
    canAnswer: context.canAnswer,
  };
  if (!view)
    return {
      ...base,
      arrangement: "duel",
      turn: 0,
      phase: null,
      step: null,
      activeSeat: null,
      prioritySeat: null,
      anchored: null,
      opponents: [],
      hand: [],
      handTitle: "Your hand",
      handBacks: 0,
      stack: [],
      combat: [],
      lines: [],
      cards,
    };

  const optionWords = (offered: PromptOption[]) =>
    offered
      .map((option) => optionText(option, context.index, view, observing))
      .join("; ");
  const withOptions = (label: string, offered: PromptOption[]) =>
    offered.length > 0 ? `${label}. Options: ${optionWords(offered)}` : label;
  // Options name a permanent by its own id or its card's (C1).
  const offeredFor = (cardId: ObjectId, permanentId?: ObjectId) => [
    ...(context.byObject.get(cardId) ?? []),
    ...(permanentId && permanentId !== cardId
      ? (context.byObject.get(permanentId) ?? [])
      : []),
  ];

  // The anchored player sits below: you, the owner SysOp observes, or for a spectator the
  // lowest seat. The others go on top, left to right in turn order after the anchored seat.
  const everyone = [...(view.you ? [view.you] : []), ...view.opponents];
  const anchoredView: PlayerView | null =
    view.you ??
    (view.opponents.length > 0
      ? view.opponents.reduce((a, b) => (b.seat < a.seat ? b : a))
      : null);
  const anchoredSeat = anchoredView?.seat ?? null;
  const others = everyone
    .filter((p) => p !== anchoredView)
    .sort((a, b) => {
      const after = (seat: Seat) =>
        anchoredSeat === null || seat > anchoredSeat ? seat : seat + 1000;
      return after(a.seat) - after(b.seat);
    });
  const arrangement: Arrangement =
    everyone.length <= 2 ? "duel" : everyone.length === 3 ? "three" : "four";
  // "You" only for the viewer's own seat; SysOp observing and spectators see names (L7).
  const youSeat = observing ? null : (view.you?.seat ?? null);

  const dragOf = (
    zone: Zone,
    offered: PromptOption[],
    controller: Seat | null,
  ): DragKind | null => {
    if (!context.canAnswer || !prompt) return null;
    const open = offered.filter((option) => !option.selected);
    if (
      zone === "hand" &&
      prompt.kind === "priority" &&
      open.some((o) => o.action === "cast" || o.action === "play_land")
    )
      return "play";
    if (zone !== "battlefield" || controller !== youSeat) return null;
    if (
      prompt.kind === "declare_attackers" &&
      open.some((o) => o.action === "toggle_attacker")
    )
      return "attack";
    if (
      prompt.kind === "declare_blockers" &&
      open.some((o) => o.action === "toggle_blocker")
    )
      return "block";
    return null;
  };

  // A permanent someone else controls says whose it is (design §3.2).
  const ownerName = (seat: Seat | null) =>
    seat === null ? null : playerName(view, seat, observing);
  const addCard = (
    zone: Zone,
    card: CardView,
    located: Located,
    owner: Seat | null,
    controller: Seat | null,
    offered: PromptOption[],
  ) => {
    const key = `${zone}:${card.id}`;
    const playable =
      zone === "hand" && offered.some((o) => playActions.has(o.action));
    cards.set(key, {
      key,
      id: card.id,
      card,
      located,
      zone,
      ownerSeat: owner,
      controllerSeat: controller,
      offered,
      mark: markOf(offered, playable),
      label: withOptions(cardLabel(card, located, ownerName(owner)), offered),
      drag: dragOf(zone, offered, controller),
    });
    return key;
  };

  // Cards in view order: hand, battlefield, stack, each player's zones by seat, then the
  // revealed and looked-at rows.
  const hand = view.you
    ? view.hand.map((card) =>
        addCard(
          "hand",
          card,
          { id: card.id, zone: "hand", seat: anchoredSeat, card },
          anchoredSeat,
          anchoredSeat,
          offeredFor(card.id),
        ),
      )
    : [];
  const permanentKey = new Map<PermanentView, string>();
  for (const permanent of view.battlefield)
    permanentKey.set(
      permanent,
      addCard(
        "battlefield",
        permanent.card,
        {
          id: permanent.id,
          zone: "battlefield",
          seat: permanent.controller_seat,
          card: permanent.card,
          permanent,
        },
        permanent.owner_seat,
        permanent.controller_seat,
        offeredFor(permanent.card.id, permanent.id),
      ),
    );

  // Ids to keys, for targets and combat: the board and the stack before the other zones.
  const keyById = new Map<ObjectId, string>();
  for (const [permanent, key] of permanentKey) {
    keyById.set(permanent.id, key);
    keyById.set(permanent.card.id, key);
  }
  for (const item of view.stack) keyById.set(item.id, `stack:${item.id}`);
  for (const player of everyone)
    for (const [zone, list] of [
      ["graveyard", player.graveyard],
      ["exile", player.exile],
      ["command", player.command_zone],
    ] as const)
      for (const card of list)
        if (!keyById.has(card.id)) keyById.set(card.id, `${zone}:${card.id}`);

  const stack: TableStackEntry[] = view.stack.map((item, position) => {
    const offered = context.byObject.get(item.id) ?? [];
    const key = `stack:${item.id}`;
    const targets: TableStackEntry["targets"] = [];
    const targetWords: string[] = [];
    for (const target of item.targets) {
      if (target.kind === "player") {
        if (target.seat === null) continue;
        targets.push({ kind: "player", seat: target.seat });
        targetWords.push(playerName(view, target.seat, observing));
      } else {
        const label =
          objectName(context.index.get(target.object_id ?? "")) ??
          target.label ??
          "an object";
        targets.push({
          kind: "object",
          key: target.object_id
            ? (keyById.get(target.object_id) ?? null)
            : null,
          label,
        });
        targetWords.push(label);
      }
    }
    let label = `${position === 0 ? "Next" : position + 1}: ${
      item.hidden ? "A hidden spell" : (item.name ?? "A spell")
    }, ${item.kind}, controlled by ${playerName(view, item.controller_seat, observing)}`;
    if (!item.hidden && item.text) label += `. ${sentence(item.text)}`;
    if (targetWords.length > 0) label += `. Targets: ${targetWords.join(", ")}`;
    label = withOptions(label, offered);
    const card = stackCard(item);
    cards.set(key, {
      key,
      id: item.id,
      card,
      located: {
        id: item.id,
        zone: "stack",
        seat: item.controller_seat,
        stack: item,
      },
      zone: "stack",
      ownerSeat: item.controller_seat,
      controllerSeat: item.controller_seat,
      offered,
      mark: markOf(offered, false),
      label,
      drag: null,
    });
    return {
      key,
      id: item.id,
      item,
      position,
      offered,
      mark: markOf(offered, false),
      label,
      targets,
    };
  });
  const zoneKeys = new Map<
    Seat,
    Record<"graveyard" | "exile" | "command", string[]>
  >();
  for (const player of [...everyone].sort((a, b) => a.seat - b.seat)) {
    const add = (zone: "graveyard" | "exile" | "command", list: CardView[]) =>
      list.map((card) =>
        addCard(
          zone,
          card,
          { id: card.id, zone, seat: player.seat, card },
          player.seat,
          player.seat,
          offeredFor(card.id),
        ),
      );
    zoneKeys.set(player.seat, {
      graveyard: add("graveyard", player.graveyard),
      exile: add("exile", player.exile),
      command: add("command", player.command_zone),
    });
  }
  // Revealed and looked-at cards are listed in the prompt column rather than drawn on the table,
  // but they are buttons there and the magnifier shows them, so they are cards here too. A card
  // you reveal from your hand is both `hand:<id>` and `revealed:<id>`. The view says nothing of
  // whose they are, so, as in `objectIndex`, they belong to no seat.
  for (const [zone, groups] of [
    ["revealed", view.revealed],
    ["looked_at", view.looked_at],
  ] as const)
    for (const group of groups)
      for (const card of group.cards)
        addCard(
          zone,
          card,
          { id: card.id, zone, seat: null, card },
          null,
          null,
          offeredFor(card.id),
        );

  const combatIds = new Set<ObjectId>();
  for (const group of view.combat) {
    group.attackers.forEach((id) => combatIds.add(id));
    group.blockers.forEach((id) => combatIds.add(id));
  }
  const commanderIds = new Set<ObjectId>();
  for (const player of everyone)
    for (const commander of player.commanders)
      if (commander.object_id) commanderIds.add(commander.object_id);

  const summaryOf = (seat: Seat) =>
    summarySeats?.find((entry) => entry.seat === seat);

  const tablePlayer = (player: PlayerView, anchored: boolean): TablePlayer => {
    const seat = player.seat;
    const name = playerName(view, seat, observing);
    const summary = summaryOf(seat);
    const kind = summary?.player ?? null;
    const self = viewSeat !== null && seat === viewSeat;
    // Other seats' decks are private: only SysOp sees their names (design §23.4).
    const title = self
      ? deckTitle(summary?.deck)
      : sysop && summary?.deck
        ? deckTitle(summary.deck)
        : kind === "bot"
          ? "Bot"
          : kind === "human"
            ? "Player"
            : null;
    const handle = summary?.handle ?? (self ? selfHandle : null);
    const seed =
      kind === "bot"
        ? `bot:${seat}`
        : handle
          ? `handle:${handle}`
          : `seat:${seat}`;
    const offered = context.bySeat.get(seat) ?? [];
    const units = groupUnits(
      view.battlefield.filter((p) => p.controller_seat === seat),
      {
        keyOf: (p) => permanentKey.get(p)!,
        offered: (p) => offeredFor(p.card.id, p.id),
        combat: combatIds,
        commanders: commanderIds,
      },
    );
    const zones = zoneKeys.get(seat)!;
    return {
      seat,
      player,
      anchored,
      name,
      title,
      kind,
      sigil: { seed, grey: !anchored },
      active: view.active_seat === seat,
      priority: view.priority_seat === seat,
      lost: player.lost,
      won: player.won,
      offered,
      mark: markOf(offered, false),
      targetLabel:
        offered.length > 0
          ? `${name}: ${player.life} life. ${optionWords(offered)}`
          : `${player.life} life`,
      sideLabel: anchored
        ? seat === youSeat
          ? "Your side of the table"
          : `${player.name}'s side of the table`
        : null,
      articleLabel: anchored ? null : `${player.name}, seat ${seat + 1}`,
      battlefieldLabel:
        seat === youSeat ? "Your battlefield" : `${player.name}'s battlefield`,
      units,
      graveyard: zones.graveyard,
      exile: zones.exile,
      command: zones.command,
      commanders: player.commanders.map((commander) => ({
        name: commander.name,
        zone: commander.zone,
        objectId: commander.object_id,
        tax: commander.tax,
        damageDealt: commander.damage_dealt,
      })),
      commanderDamageTaken: everyone.flatMap((from) =>
        from.commanders.flatMap((commander) =>
          commander.damage_dealt
            .filter((entry) => entry.seat === seat && entry.damage > 0)
            .map((entry) => ({
              fromSeat: from.seat,
              commander: commander.name,
              damage: entry.damage,
            })),
        ),
      ),
    };
  };

  const anchored = anchoredView ? tablePlayer(anchoredView, true) : null;
  const opponents = others.map((player) => tablePlayer(player, false));

  // Pile members say where they stand in their pile (§15).
  for (const player of [anchored, ...opponents])
    for (const unit of player?.units ?? [])
      if (unit.kind === "lands" || unit.kind === "tokens")
        unit.cards.forEach((key, i) => {
          const card = cards.get(key)!;
          card.label = withOptions(
            `${cardLabel(card.card, card.located, ownerName(card.ownerSeat))}, ${i + 1} of ${unit.cards.length} grouped`,
            card.offered,
          );
        });

  // Curves: casts and targets from the stack, attacks and blocks from combat (§8.3).
  const lines: LineModel[] = [];
  const ownerOf = (seat: Seat | null): LineModel["owner"] =>
    seat !== null && seat === anchoredSeat ? "viewer" : "opponent";
  for (const entry of stack) {
    const emphasis = entry.position === 0 ? "always" : "hover";
    const owner = ownerOf(entry.item.controller_seat);
    lines.push({
      key: `cast:${entry.id}`,
      kind: "cast",
      from: { seat: entry.item.controller_seat },
      to: { key: entry.key },
      owner,
      emphasis,
    });
    entry.targets.forEach((target, i) => {
      const to =
        target.kind === "player"
          ? { seat: target.seat }
          : target.key
            ? { key: target.key }
            : null;
      if (to)
        lines.push({
          key: `target:${entry.id}:${i}`,
          kind: "target",
          from: { key: entry.key },
          to,
          owner,
          emphasis,
        });
    });
  }
  view.combat.forEach((group, g) => {
    const defender = group.defender;
    const to =
      defender?.kind === "player" && defender.seat !== null
        ? { seat: defender.seat }
        : defender?.object_id && keyById.has(defender.object_id)
          ? { key: keyById.get(defender.object_id)! }
          : null;
    const attackerKeys = group.attackers.flatMap((id) => {
      const key = keyById.get(id);
      return key ? [key] : [];
    });
    for (const key of attackerKeys)
      if (to)
        lines.push({
          key: `attack:${key}`,
          kind: "attack",
          from: { key },
          to,
          owner: ownerOf(cards.get(key)?.controllerSeat ?? null),
          emphasis: "always",
        });
    for (const id of group.blockers) {
      const key = keyById.get(id);
      if (key && attackerKeys[0])
        lines.push({
          key: `block:${key}:${g}`,
          kind: "block",
          from: { key },
          to: { key: attackerKeys[0] },
          owner: ownerOf(cards.get(key)?.controllerSeat ?? null),
          emphasis: "always",
        });
    }
  });

  const you = view.you;
  return {
    ...base,
    arrangement,
    turn: view.turn,
    phase: view.phase,
    step: view.step,
    activeSeat: view.active_seat,
    prioritySeat: view.priority_seat,
    anchored,
    opponents,
    hand,
    handTitle: you
      ? observing
        ? `${you.name}'s hand`
        : "Your hand"
      : anchoredView
        ? `${anchoredView.name}'s hand`
        : "Your hand",
    handBacks: you ? 0 : (anchoredView?.hand_count ?? 0),
    stack,
    combat: view.combat,
    lines,
    cards,
  } satisfies TableModel;
};
