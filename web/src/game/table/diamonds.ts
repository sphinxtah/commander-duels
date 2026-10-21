import type { Prompt, PromptOption } from "../types";

// The prompt column's diamond buttons (design §10): Magic Duels' words for the moment's main
// choices, with an icon each. A label that says less than the option does keeps the option's
// own words in its accessible name, as a visually hidden suffix, so "Continue" is still heard
// as passing priority.

export type IconName =
  | "chevron"
  | "swords"
  | "swordsAll"
  | "shield"
  | "check"
  | "shuffle"
  | "cross"
  | "wand"
  | "dot"
  | "pile"
  | "flag"
  | "hourglass"
  | "menu"
  | "log"
  | "priority"
  | "fullscreen"
  | "inspect";

/** Each icon as stroked SVG path data in a 24 × 24 box. */
export const ICONS: Record<IconName, string> = {
  chevron: "M9 5l7 7-7 7",
  swords: "M5 5l14 14M19 5L5 19M6.5 14.5l3 3M17.5 14.5l-3 3",
  swordsAll: "M3 6l11 11M14 6L3 17M10 6l11 11M21 6L10 17",
  shield: "M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z",
  check: "M5 12.5l4.5 4.5L19 7",
  shuffle:
    "M4 7h4l8 10h4M4 17h4l8-10h4M18 4.5L20.5 7 18 9.5M18 14.5l2.5 2.5-2.5 2.5",
  cross: "M6 6l12 12M18 6L6 18",
  wand: "M4 20L15 9M14 3.5v3M17.5 7H21M18.5 3.5l-2 2",
  dot: "M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5",
  pile: "M5 8h14M5 12h14M5 16h14",
  flag: "M6 21V4h11l-2.5 4 2.5 4H6",
  hourglass:
    "M7 3h10M7 21h10M8 3c0 5 8 6 8 9s-8 4-8 9M16 3c0 5-8 6-8 9s8 4 8 9",
  menu: "M5 7h14M5 12h14M5 17h14",
  log: "M6 4h12v16H6zM9 8h6M9 12h6M9 16h4",
  priority: "M6 4v16M12 4v16M18 4v16M4 8h4M10 15h4M16 11h4",
  fullscreen: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  inspect:
    "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 1 0 0-5",
};

export interface DuelsLabel {
  /** What the button shows. */
  label: string;
  icon: IconName;
  /** The option's own words, read after the label but not shown, when the label says less. */
  hidden: string | null;
}

function selected(prompt: Prompt, action: PromptOption["action"]): boolean {
  return prompt.options.some(
    (option) => option.action === action && option.selected,
  );
}

/** An option's diamond: its label, icon and hidden suffix. `text` is the option in words
 * (optionText), used wherever Magic Duels has no word of its own. */
export function duelsLabel(
  option: PromptOption,
  prompt: Prompt,
  text: string,
): DuelsLabel {
  const plain = (label: string, icon: IconName): DuelsLabel => ({
    label,
    icon,
    hidden: null,
  });
  switch (option.action) {
    case "pass":
      return {
        label: "Continue",
        icon: "chevron",
        hidden: prompt.kind === "priority" ? "Pass priority" : text,
      };
    case "all_attack":
      return plain("Attack With All", "swordsAll");
    case "keep":
      return plain("Keep Hand", "check");
    case "mulligan":
      return plain("Mulligan", "shuffle");
    case "yes":
      return plain("Yes", "check");
    case "no":
      return plain("No", "cross");
    case "cancel":
      return plain("Cancel", "cross");
    case "suggested":
      return plain("Use the Suggestion", "wand");
    case "done":
      if (prompt.kind === "declare_attackers")
        return {
          label: selected(prompt, "toggle_attacker") ? "Attack" : "No Attacks",
          icon: "swords",
          hidden: "Done",
        };
      if (prompt.kind === "declare_blockers")
        return {
          label: selected(prompt, "toggle_blocker") ? "Block" : "No Blocks",
          icon: "shield",
          hidden: "Done",
        };
      return plain("Done", "check");
    case "choose_pile":
      return plain(text, "pile");
    default:
      return plain(text, "dot");
  }
}
