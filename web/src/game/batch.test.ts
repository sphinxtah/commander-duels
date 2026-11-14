import { describe, expect, it } from "vitest";
import { BATCH_LIMIT, batchGroups } from "./batch";
import type { Prompt, PromptOption } from "./types";

function toggle(
  id: number,
  label: string | null,
  selected = false,
  action: PromptOption["action"] = "toggle_attacker",
): PromptOption {
  return {
    id: String(id),
    action,
    label,
    object_id: `o${id}`,
    seat: null,
    selected,
  };
}

function declaration(kind: Prompt["kind"], options: PromptOption[]): Prompt {
  return {
    id: "p",
    kind,
    message: "",
    detail: null,
    options: [
      ...options,
      {
        id: "done",
        action: "done",
        label: "Done",
        object_id: null,
        seat: null,
        selected: false,
      },
    ],
    amounts: null,
    piles: null,
    xmage_query: null,
  };
}

describe("batch groups", () => {
  it("offers each name with two or more, the declared apart from the undeclared", () => {
    const groups = batchGroups(
      declaration("declare_attackers", [
        toggle(1, "Goblin"),
        toggle(2, "Goblin"),
        toggle(3, "Goblin", true),
        toggle(4, "Goblin", true),
        toggle(5, "Goblin"),
        toggle(6, "Hill Giant"),
        toggle(7, "Soldier", true),
      ]),
    );
    expect(groups.map((group) => [group.text, group.batch])).toEqual([
      ["Attack with all 3 Goblin", { objects: ["o1", "o2", "o5"] }],
      [
        "Stop attacking with all 2 Goblin",
        { objects: ["o3", "o4"], declare: false },
      ],
    ]);
  });

  it("words a block, and leaves the attacker to the game's question", () => {
    const [group] = batchGroups(
      declaration("declare_blockers", [
        toggle(1, "Saproling", false, "toggle_blocker"),
        toggle(2, "Saproling", false, "toggle_blocker"),
      ]),
    );
    expect(group.text).toBe("Block with all 2 Saproling");
    expect(group.batch).toEqual({ objects: ["o1", "o2"] });
  });

  it("leaves out what the seat cannot name, and every other prompt", () => {
    // Face-down creatures have no label: each is declared by itself.
    expect(
      batchGroups(
        declaration("declare_attackers", [toggle(1, null), toggle(2, null)]),
      ),
    ).toEqual([]);
    expect(
      batchGroups({
        ...declaration("declare_attackers", [
          toggle(1, "Goblin"),
          toggle(2, "Goblin"),
        ]),
        kind: "priority",
      }),
    ).toEqual([]);
    expect(batchGroups(null)).toEqual([]);
  });

  it("names how many it takes when a board holds more than one command does", () => {
    const many = Array.from({ length: BATCH_LIMIT + 50 }, (_, index) =>
      toggle(index + 1, "Goblin"),
    );
    const [group] = batchGroups(declaration("declare_attackers", many));
    expect(group.batch.objects).toHaveLength(BATCH_LIMIT);
    expect(group.text).toBe(`Attack with ${BATCH_LIMIT} of the 300 Goblin`);
  });
});
