import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ObjectId, PromptOption, Seat } from "../types";
import { dropZoneAt } from "./layout";
import { toDesign } from "./stage";
import type {
  DragController,
  DropZone,
  StageFit,
  TableCard,
  TableLayout,
  TableModel,
  TableUiStore,
} from "./types";

// Drag and drop on the table (UI04, design §16). A drop is only another way to give an answer the
// card already offers: a hand card onto your side plays it, a creature onto an opponent attacks
// with it, a creature onto an attacker blocks it. Nothing here answers on its own: a drop names
// one of the prompt's options or opens the card's menu, and it is refused when the prompt changed
// while the card was held. Only the mouse drags; Playwright's clicks, the keyboard and touch
// never do, and a press that moves less than 8 pixels is an ordinary click.

/** CSS pixels a mouse press must move before it becomes a drag. */
export const DRAG_THRESHOLD = 8;
/** How long a drop's chained choice (the defender, the attacker blocked) waits for its prompt. */
export const CHAIN_MS = 2000;
/** How long the click that ends a drag may take to arrive; it is swallowed. */
export const CLICK_SWALLOW_MS = 1000;

export const DROP_REFUSED = "That cannot go there.";
export const DROP_STALE = "The choice changed; drop again.";

/** The card's options a drop on this zone answers: none when the drop means nothing here. */
export function dropOptions(
  card: TableCard,
  zone: DropZone,
  model: TableModel | null,
): PromptOption[] {
  // A selected attacker or blocker is already declared: dropping it again changes nothing.
  const open = card.offered.filter((option) => !option.selected);
  switch (card.drag) {
    case "play":
      return zone.kind === "battlefield"
        ? open.filter((o) => o.action === "cast" || o.action === "play_land")
        : [];
    case "attack":
      return zone.kind === "attack"
        ? open.filter((o) => o.action === "toggle_attacker")
        : [];
    case "block": {
      if (zone.kind !== "card") return [];
      const attacker = model?.cards.get(zone.key);
      return attacker?.located.permanent?.attacking
        ? open.filter((o) => o.action === "toggle_blocker")
        : [];
    }
    default:
      return [];
  }
}

export interface DragDeps {
  layout: TableLayout | null;
  fit: StageFit | null;
  ui: TableUiStore;
  /** The prompt on screen: its id and revision, or null while this tab cannot answer. */
  promptKey: string | null;
  choose(option: PromptOption): void;
  /** Opens the card's option menu (setting the store's `menu` to the key does it). */
  openMenu(key: string, options: PromptOption[]): void;
  /** Says something politely: why a drop did nothing. */
  status(text: string): void;
  /** The table model on screen, to check that a block lands on an attacker and to finish a
   * chained choice. Without it, block drops are refused and nothing is chained. */
  model?: TableModel | null;
}

/** What a drop already said about the prompt expected next (C12): the defender an attacker was
 * dropped on, or the attacker a blocker was dropped on. `answered` is the prompt the drop
 * answered; `awaiting` is the next prompt once it is drawn, while this tab cannot answer it yet
 * (the snapshot that draws it can come before the result of the answer that led to it). */
type Intent = (
  | { kind: "choose_defender"; seat: Seat }
  | { kind: "choose_target"; key: string }
) & { at: number; answered: string | null; awaiting: string | null };

export interface DragEngine extends DragController {
  /** The prompt or the lease changed: a held card is let go, a chained choice is tried. */
  promptChanged(): void;
  dispose(): void;
}

type Listening = Pick<Window, "addEventListener" | "removeEventListener">;

function elementOf(target: EventTarget | null): Element | null {
  return typeof Element !== "undefined" && target instanceof Element
    ? target
    : null;
}

/** The options of the next prompt that a chained intent picks: it must be exactly one. */
function chained(model: TableModel, intent: Intent): PromptOption[] {
  if (intent.kind === "choose_defender")
    return (
      [model.anchored, ...model.opponents].find(
        (player) => player?.seat === intent.seat,
      )?.offered ?? []
    );
  return model.cards.get(intent.key)?.offered ?? [];
}

export function createDragController(
  deps: () => DragDeps,
  clock: { now(): number } = { now: () => performance.now() },
  events: Listening = window,
): DragEngine {
  // A press goes from "pressed" (under the threshold: still a click) to "dragging", and from
  // there to "cancelled" when Escape or a new prompt ends the drag while the button is still
  // down: the ghost has gone, but the press lasts until its release, whose click must still be
  // swallowed.
  let press: {
    card: TableCard;
    x0: number;
    y0: number;
    pointerId: number;
    element: Element | null;
    promptKey: string | null;
    phase: "pressed" | "dragging" | "cancelled";
    valid: DropZone[];
  } | null = null;
  let swallow: { id: ObjectId; until: number } | null = null;
  let intent: Intent | null = null;

  const listen = (on: boolean) => {
    const method = on ? events.addEventListener : events.removeEventListener;
    method.call(events, "pointermove", onMove as EventListener, true);
    method.call(events, "pointerup", onUp as EventListener, true);
    method.call(events, "pointercancel", onCancel as EventListener, true);
    method.call(events, "pointerdown", onDown as EventListener, true);
  };

  function end() {
    if (press) listen(false);
    press = null;
  }

  /** The press is over: the click its release makes on the card is swallowed, for a moment
   * from now. After a cancel the pointer is no longer held to the card, so a release elsewhere
   * makes no click on it, and nothing is swallowed. */
  function released(target: EventTarget | null) {
    if (!press || press.phase === "pressed") return;
    const on = elementOf(target);
    const onCard =
      press.phase === "dragging" || !press.element || !on
        ? true
        : press.element.contains(on);
    swallow = onCard
      ? { id: press.card.id, until: clock.now() + CLICK_SWALLOW_MS }
      : null;
  }

  /** Cancels the press. One still under the threshold is forgotten: its click is a click. A drag
   * ends with the button still down: the ghost goes, the card stays where it is, and the press
   * waits for its release, however late it comes. */
  function abandon() {
    if (press?.phase === "pressed") end();
    if (press?.phase !== "dragging") return;
    press.phase = "cancelled";
    // No end to the swallow until the release starts its moment.
    swallow = { id: press.card.id, until: Number.POSITIVE_INFINITY };
    try {
      // The pointer goes back to what is under it, for hovering and for the release.
      press.element?.releasePointerCapture?.(press.pointerId);
    } catch {
      // Capture already ended with the press.
    }
    deps().ui.set({ drag: null });
  }

  function onMove(event: PointerEvent) {
    if (!press || event.pointerId !== press.pointerId) return;
    if (press.phase === "cancelled") return;
    const d = deps();
    let start = false;
    if (press.phase === "pressed") {
      const moved = Math.hypot(
        event.clientX - press.x0,
        event.clientY - press.y0,
      );
      if (moved <= DRAG_THRESHOLD) return;
      if (d.promptKey !== press.promptKey || !d.layout || !d.fit) {
        end();
        return;
      }
      press.phase = "dragging";
      start = true;
      const card = press.card;
      const model = d.model ?? null;
      press.valid = d.layout.drops.filter(
        (zone) => dropOptions(card, zone, model).length > 0,
      );
      try {
        press.element?.setPointerCapture?.(press.pointerId);
      } catch {
        // The press may have ended already; the window still hears the release.
      }
    }
    if (!d.layout || !d.fit) return;
    const point = toDesign(d.fit, event.clientX, event.clientY);
    const drag = {
      key: press.card.key,
      point,
      over: dropZoneAt(d.layout, point),
      valid: press.valid,
    };
    if (!start) {
      d.ui.set({ drag });
      return;
    }
    // The card is carried now. Nothing rises or is hovered under it until it is let go (the
    // captured pointer would name only the carried card), and the magnifier a hover opened
    // closes, so it covers nothing the card is aimed at.
    const magnified = d.ui.get().magnified;
    d.ui.set({
      drag,
      risen: null,
      hover: null,
      ...(magnified?.level === 1 ? { magnified: null } : {}),
    });
  }

  function onUp(event: PointerEvent) {
    if (!press || event.pointerId !== press.pointerId) return;
    const held = press;
    released(event.target);
    if (held.phase === "dragging") deps().ui.set({ drag: null });
    end();
    if (held.phase !== "dragging") return;
    const d = deps();
    if (d.promptKey !== held.promptKey) {
      d.status(DROP_STALE);
      return;
    }
    const model = d.model ?? null;
    const zone =
      d.layout && d.fit
        ? dropZoneAt(d.layout, toDesign(d.fit, event.clientX, event.clientY))
        : null;
    const options = zone ? dropOptions(held.card, zone, model) : [];
    if (options.length === 0) d.status(DROP_REFUSED);
    else if (options.length > 1) d.openMenu(held.card.key, options);
    else {
      d.choose(options[0]);
      const answered = model?.promptId ?? null;
      const at = clock.now();
      const chain = { at, answered, awaiting: null };
      if (model && zone?.kind === "attack" && zone.seat !== null)
        intent = { kind: "choose_defender", seat: zone.seat, ...chain };
      else if (model && zone?.kind === "card")
        intent = { kind: "choose_target", key: zone.key, ...chain };
      else intent = null;
    }
  }

  function onCancel(event: PointerEvent) {
    if (!press || event.pointerId !== press.pointerId) return;
    released(event.target);
    if (press.phase === "dragging") deps().ui.set({ drag: null });
    end();
  }

  // The same pointer pressed again before its release was heard (it was let go outside the
  // window): that press is over, and nothing it would have swallowed is coming. (A press's own
  // pointerdown has passed the window by the time it is listened for.)
  function onDown(event: PointerEvent) {
    if (!press || event.pointerId !== press.pointerId) return;
    if (press.phase !== "pressed") swallow = null;
    end();
  }

  return {
    onPointerDown(event, card) {
      swallow = null;
      end();
      if (event.pointerType !== "mouse" || event.button !== 0 || !card.drag)
        return;
      const target = elementOf(event.target);
      press = {
        card,
        x0: event.clientX,
        y0: event.clientY,
        pointerId: event.pointerId,
        element: target?.closest("[data-card]") ?? target,
        promptKey: deps().promptKey,
        phase: "pressed",
        valid: [],
      };
      listen(true);
    },

    consumeClick(id) {
      if (!swallow || swallow.id !== id) return false;
      const live = clock.now() <= swallow.until;
      swallow = null;
      return live;
    },

    cancel() {
      abandon();
    },

    get active() {
      return press?.phase === "dragging";
    },

    promptChanged() {
      const d = deps();
      if (
        press &&
        press.phase !== "cancelled" &&
        d.promptKey !== press.promptKey
      ) {
        if (press.phase === "dragging") d.status(DROP_STALE);
        abandon();
      }
      if (!intent) return;
      const model = d.model ?? null;
      const promptId = model?.promptId ?? null;
      if (intent.awaiting === null) {
        // The prompt the drop answered is still the one on screen, or none is drawn yet: wait
        // for the next.
        if (promptId === intent.answered || promptId === null) return;
      } else if (promptId !== intent.awaiting) {
        // Another prompt came before this tab could answer the one it waited for.
        intent = null;
        return;
      }
      if (
        !model ||
        clock.now() - intent.at > CHAIN_MS ||
        model.promptKind !== intent.kind
      ) {
        intent = null;
        return;
      }
      // Drawn, but the answer that led here is still in flight: wait on this same prompt.
      if (!model.canAnswer) {
        intent = { ...intent, awaiting: promptId };
        return;
      }
      const pending = intent;
      intent = null;
      const options = chained(model, pending);
      if (options.length === 1) d.choose(options[0]);
    },

    dispose() {
      end();
      intent = null;
      swallow = null;
    },
  };
}

/** The table's drag controller, answering through the `choose` of the render on screen. */
export function useDragController(a: DragDeps): DragController {
  const deps = useRef(a);
  useLayoutEffect(() => {
    deps.current = a;
  });
  const controller = useMemo(
    () => createDragController(() => deps.current),
    [],
  );
  // After the commit that drew a new prompt, or let this tab answer it, so a chained choice
  // answers what is on screen.
  useLayoutEffect(
    () => controller.promptChanged(),
    [controller, a.promptKey, a.model?.promptId, a.model?.canAnswer],
  );
  useEffect(() => () => controller.dispose(), [controller]);
  return controller;
}
