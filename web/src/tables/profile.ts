import { useCallback, useEffect, useState } from "react";
import { client, describe } from "../api";
import type { components } from "../generated/api";

// Rule Zero at the table (v1.0.0, docs/tables.md): a table's profile as the screens use it. A
// profile has two parts that every screen keeps apart: what the host describes (the kind of game,
// its pace, its length, a note), which nothing checks, and what the server checks on every deck
// (custom cards, Reserved List cards, Game Changers, beside the table's own rules). The service is
// api/table_profiles.py; no deck is analysed and none makes a disclosure (the owner, 2026-11-13).

export type Profile = components["schemas"]["TableProfile"];
export type ProfileView = components["schemas"]["ProfileView"];
export type Preset = components["schemas"]["Preset"];
export type Presets = components["schemas"]["Presets"];
export type PresetSettings = components["schemas"]["PresetSettings"];
export type Intent = Profile["intent"];
export type Pace = NonNullable<Profile["pace"]>;
export type Duration = NonNullable<Profile["duration"]>;

export const INTENTS: Intent[] = [
  "learning",
  "precon",
  "upgraded",
  "high_power",
  "competitive",
  "custom",
];
/** The kinds of game, as the API names them (INTENT_NAMES in api/table_profiles.py). */
export const INTENT_NAMES: Record<Intent, string> = {
  learning: "Learning game",
  precon: "Preconstructed decks",
  upgraded: "Upgraded casual",
  high_power: "High power",
  competitive: "Competitive",
  custom: "Custom",
};
/** What each kind of game means, for the host who chooses one. A description, never a rating. */
export const INTENT_WORDS: Record<Intent, string> = {
  learning: "Questions are welcome, and a mistake may be taken back",
  precon: "Decks as they came, or built to play like them",
  upgraded: "Tuned decks, short of the format's strongest",
  high_power: "Strong decks and fast games, short of a tournament's",
  competitive: "Built and played to win, as at a tournament",
  custom: "Something else: say what in your note",
};
export const PACES: Pace[] = ["relaxed", "steady", "brisk"];
/** A pace in one word, for a filter; the API's own name says more ("Brisk: short turns"). */
export const PACE_NAMES: Record<Pace, string> = {
  relaxed: "Relaxed",
  steady: "Steady",
  brisk: "Brisk",
};
export const PACE_WORDS: Record<Pace, string> = {
  relaxed: "Relaxed: time to ask and take back",
  steady: "Steady",
  brisk: "Brisk: short turns",
};
export const DURATIONS: Duration[] = [30, 60, 90, 120, 180];
/** The longest note a host writes. */
export const NOTE_LIMIT = 280;
/** The longest name of a saved table. */
export const PRESET_NAME_LIMIT = 48;
/** The most Game Changers a profile may allow by number; above it, any number. */
export const GAME_CHANGER_LIMITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/** An expected length as every screen says it, and as an invitation does: "about 90 minutes". */
export function durationWords(minutes: number): string {
  return `about ${minutes} minutes`;
}

/** A profile that describes a custom game and restricts nothing: where a host starts from. */
export const BLANK_PROFILE: Profile = {
  version: 1,
  intent: "custom",
  pace: null,
  duration: null,
  note: "",
  enforced: { custom_cards: true, reserved_list: true, game_changers: null },
};

/** A profile as a request carries it: a view's words dropped, every field said. */
export function plain(profile: Profile | ProfileView): Profile {
  return {
    version: 1,
    intent: profile.intent,
    pace: profile.pace ?? null,
    duration: profile.duration ?? null,
    note: profile.note ?? "",
    enforced: {
      custom_cards: profile.enforced?.custom_cards ?? true,
      reserved_list: profile.enforced?.reserved_list ?? true,
      game_changers: profile.enforced?.game_changers ?? null,
    },
  };
}

/** Whether two profiles say and enforce the same. */
export function sameProfile(a: Profile | null, b: Profile | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(plain(a)) === JSON.stringify(plain(b));
}

/** What the host describes, in the order every screen says it; the note apart. */
export function describedWords(profile: ProfileView): string[] {
  return [
    profile.intent_name,
    profile.pace_name,
    profile.duration ? durationWords(profile.duration) : null,
  ].filter((words): words is string => Boolean(words));
}

/** One thing that differs between the profile a player read and the table's profile now. */
export type ProfileChange = {
  /** Which of the two parts it belongs to. */
  part: "described" | "enforced";
  text: string;
};

/** The rules the table checks whatever its profile says: they stay when a profile is removed. */
const TABLE_RULES = new Set(["banned", "not_legal", "stand_in"]);

/**
 * What changed between the profile a player last read and the table's profile as it stands, a
 * line each, by part. Either may be none: a table described for the first time, or one whose
 * description was taken away.
 */
export function profileChanges(
  before: ProfileView | null,
  after: ProfileView | null,
): ProfileChange[] {
  const changes: ProfileChange[] = [];
  const said = (label: string, was: string | null, now: string | null) => {
    if (was === now) return;
    changes.push({
      part: "described",
      text:
        was === null
          ? `${label}: ${now} (not said before)`
          : now === null
            ? `${label}: no longer said (was ${was})`
            : `${label}: ${now} (was ${was})`,
    });
  };
  const quoted = (note: string | undefined) => (note ? `“${note}”` : null);
  said("Kind of game", before?.intent_name ?? null, after?.intent_name ?? null);
  said("Pace", before?.pace_name ?? null, after?.pace_name ?? null);
  said(
    "Expected length",
    before?.duration ? durationWords(before.duration) : null,
    after?.duration ? durationWords(after.duration) : null,
  );
  said("The host's note", quoted(before?.note), quoted(after?.note));

  const was = new Map(
    (before?.enforced_rules ?? []).map((rule) => [rule.code, rule.text]),
  );
  const now = new Map(
    // A profile taken away leaves the table's own rules as they were.
    (
      after?.enforced_rules ??
      (before?.enforced_rules ?? []).filter((rule) =>
        TABLE_RULES.has(rule.code),
      )
    ).map((rule) => [rule.code, rule.text]),
  );
  for (const code of new Set([...was.keys(), ...now.keys()])) {
    const old = was.get(code);
    const next = now.get(code);
    if (old === next) continue;
    changes.push({
      part: "enforced",
      text: !old
        ? `Now checked: ${next}`
        : !next
          ? `No longer checked: ${old}`
          : `Now checked: ${next} (was: ${old})`,
    });
  }
  return changes;
}

// The profile a seated player last read at a table, kept by this browser, so that a change can
// be shown as what differs. A player sits at one open table at a time, so one is kept.
const READ_KEY = "cd.tables.profileRead";

/** The profile this browser last saw as read at the table; undefined when it kept none for it
 * (another device sat down, or the browser keeps nothing). */
export function keptRead(code: string): ProfileView | null | undefined {
  try {
    const raw = window.localStorage.getItem(READ_KEY);
    if (!raw) return undefined;
    const kept = JSON.parse(raw) as {
      code?: string;
      profile?: ProfileView | null;
    };
    if (kept.code !== code) return undefined;
    return kept.profile ?? null;
  } catch {
    return undefined;
  }
}

export function keepRead(code: string, profile: ProfileView | null) {
  try {
    window.localStorage.setItem(READ_KEY, JSON.stringify({ code, profile }));
  } catch {
    // A browser that keeps nothing shows a change whole, without what differs.
  }
}

/** The built-in profiles and the account's saved tables, with saving and removing one. Each
 * of the two answers with the account's presets as they then stand, or with the refusal. */
export function usePresets(): {
  presets: Presets | null;
  /** Saves a table under a name; a name the account has, whatever its case, is replaced. */
  save: (
    name: string,
    profile: Profile,
    settings: PresetSettings,
  ) => Promise<Presets | string>;
  remove: (id: string) => Promise<Presets | string>;
} {
  const [presets, setPresets] = useState<Presets | null>(null);
  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/me/table-presets")
      .then(({ data }) => {
        if (active && data) setPresets(data);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const save = useCallback(
    async (name: string, profile: Profile, settings: PresetSettings) => {
      const { data, error } = await client
        .PUT("/api/v1/me/table-presets", {
          body: { name, profile, settings },
        })
        .catch(() => ({ data: undefined, error: undefined }));
      if (!data) return describe(error);
      setPresets(data);
      return data;
    },
    [],
  );
  const remove = useCallback(async (id: string) => {
    const { data, error } = await client
      .DELETE("/api/v1/me/table-presets/{preset_id}", {
        params: { path: { preset_id: id } },
      })
      .catch(() => ({ data: undefined, error: undefined }));
    if (!data) return describe(error);
    setPresets(data);
    return data;
  }, []);
  return { presets, save, remove };
}

/** The select's value for a preset: a built-in one by its kind of game, a saved one by its id. */
export function presetKey(preset: Preset): string {
  return preset.built_in
    ? `built:${preset.profile.intent}`
    : `saved:${preset.id}`;
}

export function findPreset(
  presets: Presets | null,
  key: string,
): Preset | undefined {
  return [...(presets?.built_in ?? []), ...(presets?.saved ?? [])].find(
    (preset) => presetKey(preset) === key,
  );
}
