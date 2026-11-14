import type { BatchPayload, ObjectId, Prompt } from "./types";

// Batch declarations (v0.9.12, the specification's section 14). A board of thirty tokens is
// thirty answers to declare by hand. The engine takes several creatures in one command and
// declares each as it declares one alone (contracts/engine-command.schema.json); this says which
// creatures a declaration's prompt offers alike, so the screen can offer them together. A batch
// never confirms the declaration: Done stays the player's own.

/** The most creatures the engine takes in one batch. */
export const BATCH_LIMIT = 250;

/** Creatures of one name a declaration offers, to declare or to withdraw together. */
export interface BatchGroup {
  key: string;
  /** What the button says: "Attack with all 12 Goblin". */
  text: string;
  batch: BatchPayload;
}

const WORDS = {
  toggle_attacker: { declare: "Attack with", withdraw: "Stop attacking with" },
  toggle_blocker: { declare: "Block with", withdraw: "Stop blocking with" },
} as const;

/** The groups a declaration's prompt offers: creatures the engine names alike, two or more, the
 * undeclared apart from the declared. A creature the seat cannot name (face down) is in none: it
 * is declared by itself. Empty for every other prompt. */
export function batchGroups(prompt: Prompt | null): BatchGroup[] {
  if (
    !prompt ||
    (prompt.kind !== "declare_attackers" && prompt.kind !== "declare_blockers")
  )
    return [];
  const action =
    prompt.kind === "declare_attackers" ? "toggle_attacker" : "toggle_blocker";
  const found = new Map<
    string,
    { label: string; declare: boolean; objects: ObjectId[] }
  >();
  for (const option of prompt.options) {
    if (option.action !== action || !option.object_id || !option.label)
      continue;
    const key = `${option.selected ? "withdraw" : "declare"}:${option.label}`;
    const group = found.get(key) ?? {
      label: option.label,
      declare: !option.selected,
      objects: [],
    };
    group.objects.push(option.object_id);
    found.set(key, group);
  }
  const groups: BatchGroup[] = [];
  for (const [key, group] of found) {
    if (group.objects.length < 2) continue;
    const objects = group.objects.slice(0, BATCH_LIMIT);
    const words = WORDS[action][group.declare ? "declare" : "withdraw"];
    const count =
      objects.length === group.objects.length
        ? `all ${objects.length}`
        : `${objects.length} of the ${group.objects.length}`;
    groups.push({
      key,
      text: `${words} ${count} ${group.label}`,
      batch: group.declare ? { objects } : { objects, declare: false },
    });
  }
  return groups;
}
