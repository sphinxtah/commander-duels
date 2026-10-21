import { describe, expect, it } from "vitest";
import type { Prompt, PromptOption } from "../types";
import { duelsLabel, ICONS } from "./diamonds";

function option(
  action: PromptOption["action"],
  selected = false,
): PromptOption {
  return {
    id: action,
    action,
    label: null,
    object_id: null,
    seat: null,
    selected,
  };
}

function prompt(kind: Prompt["kind"], options: PromptOption[]): Prompt {
  return {
    id: "p",
    kind,
    message: "",
    detail: null,
    options,
    amounts: null,
    piles: null,
    xmage_query: null,
  };
}

describe("the prompt column's diamond labels", () => {
  it.each([
    ["priority", "pass", "Continue", "chevron", "Pass priority"],
    ["mulligan", "keep", "Keep Hand", "check", null],
    ["mulligan", "mulligan", "Mulligan", "shuffle", null],
    ["yes_no", "yes", "Yes", "check", null],
    ["yes_no", "no", "No", "cross", null],
    ["choose_target", "done", "Done", "check", null],
    ["choose_target", "cancel", "Cancel", "cross", null],
    ["pay_mana", "suggested", "Use the Suggestion", "wand", null],
  ] as const)("%s / %s reads %s", (kind, action, label, icon, hidden) => {
    const shown = option(action);
    expect(duelsLabel(shown, prompt(kind, [shown]), "words")).toEqual({
      label,
      icon,
      hidden,
    });
  });

  it("says No Attacks and No Blocks until a creature is chosen, then Attack and Block", () => {
    const done = option("done");
    expect(
      duelsLabel(
        done,
        prompt("declare_attackers", [done, option("toggle_attacker")]),
        "Done",
      ),
    ).toEqual({ label: "No Attacks", icon: "swords", hidden: "Done" });
    expect(
      duelsLabel(
        done,
        prompt("declare_attackers", [done, option("toggle_attacker", true)]),
        "Done",
      ).label,
    ).toBe("Attack");
    expect(
      duelsLabel(
        done,
        prompt("declare_blockers", [done, option("toggle_blocker")]),
        "Done",
      ),
    ).toEqual({ label: "No Blocks", icon: "shield", hidden: "Done" });
    expect(
      duelsLabel(
        done,
        prompt("declare_blockers", [done, option("toggle_blocker", true)]),
        "Done",
      ).label,
    ).toBe("Block");
  });

  it("says Attack With All, and keeps the option's own words for everything else", () => {
    const all = option("all_attack");
    expect(duelsLabel(all, prompt("declare_attackers", [all]), "x")).toEqual({
      label: "Attack With All",
      icon: "swordsAll",
      hidden: null,
    });
    const cast = option("cast");
    expect(
      duelsLabel(cast, prompt("priority", [cast]), "Cast Lightning Bolt"),
    ).toEqual({ label: "Cast Lightning Bolt", icon: "dot", hidden: null });
    const pile = option("choose_pile");
    expect(duelsLabel(pile, prompt("choose_pile", [pile]), "Pile 1").icon).toBe(
      "pile",
    );
  });

  it("has a drawn icon for every name", () => {
    for (const path of Object.values(ICONS)) expect(path).toMatch(/^M/);
  });
});
