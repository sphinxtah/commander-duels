import { beforeEach, describe, expect, it } from "vitest";
import {
  BLANK_PROFILE,
  describedWords,
  durationWords,
  findPreset,
  keepRead,
  keptRead,
  plain,
  presetKey,
  profileChanges,
  sameProfile,
  type Preset,
  type Presets,
  type ProfileView,
} from "./profile";

// Rule Zero at the table (v1.0.0): what the screens share about a table's profile.

function view(fields: Partial<ProfileView> = {}): ProfileView {
  return {
    version: 1,
    intent: "upgraded",
    pace: "steady",
    duration: 90,
    note: "",
    enforced: { custom_cards: true, reserved_list: true, game_changers: 3 },
    intent_name: "Upgraded casual",
    pace_name: "Steady",
    enforced_rules: [
      { code: "game_changers", text: "At most 3 Game Changers a deck" },
    ],
    ...fields,
  };
}

beforeEach(() => window.localStorage.clear());

describe("a profile", () => {
  it("is sent without a view's words, every field said", () => {
    expect(plain(view({ note: "Hello" }))).toEqual({
      version: 1,
      intent: "upgraded",
      pace: "steady",
      duration: 90,
      note: "Hello",
      enforced: { custom_cards: true, reserved_list: true, game_changers: 3 },
    });
    // What a profile leaves out is what the API's defaults are: nothing said, nothing refused.
    expect(plain({ version: 1, intent: "custom", note: "" })).toEqual(
      BLANK_PROFILE,
    );
  });

  it("is the same as another when it says and enforces the same", () => {
    expect(sameProfile(plain(view()), plain(view()))).toBe(true);
    expect(sameProfile(plain(view()), plain(view({ note: "x" })))).toBe(false);
    expect(sameProfile(null, null)).toBe(true);
    expect(sameProfile(plain(view()), null)).toBe(false);
  });

  it("says what its host describes in one order, the length as an invitation does", () => {
    expect(durationWords(90)).toBe("about 90 minutes");
    expect(describedWords(view())).toEqual([
      "Upgraded casual",
      "Steady",
      "about 90 minutes",
    ]);
    expect(
      describedWords(view({ pace: null, pace_name: null, duration: null })),
    ).toEqual(["Upgraded casual"]);
  });
});

describe("what changed between the profile a player read and the table's now", () => {
  it("is nothing when nothing differs", () => {
    expect(profileChanges(view(), view())).toEqual([]);
    expect(profileChanges(null, null)).toEqual([]);
  });

  it("is said a line a difference, each in its own part", () => {
    const after = view({
      intent: "high_power",
      intent_name: "High power",
      pace: null,
      pace_name: null,
      duration: 60,
      note: "Bring your best",
      enforced_rules: [
        { code: "reserved_list", text: "No Reserved List cards" },
        { code: "game_changers", text: "No Game Changers" },
      ],
    });
    expect(profileChanges(view({ note: "Easy does it" }), after)).toEqual([
      {
        part: "described",
        text: "Kind of game: High power (was Upgraded casual)",
      },
      { part: "described", text: "Pace: no longer said (was Steady)" },
      {
        part: "described",
        text: "Expected length: about 60 minutes (was about 90 minutes)",
      },
      {
        part: "described",
        text: "The host's note: “Bring your best” (was “Easy does it”)",
      },
      {
        part: "enforced",
        text: "Now checked: No Game Changers (was: At most 3 Game Changers a deck)",
      },
      { part: "enforced", text: "Now checked: No Reserved List cards" },
    ]);
  });

  it("says a table described for the first time", () => {
    expect(profileChanges(null, view())).toEqual([
      {
        part: "described",
        text: "Kind of game: Upgraded casual (not said before)",
      },
      { part: "described", text: "Pace: Steady (not said before)" },
      {
        part: "described",
        text: "Expected length: about 90 minutes (not said before)",
      },
      {
        part: "enforced",
        text: "Now checked: At most 3 Game Changers a deck",
      },
    ]);
  });

  it("keeps the table's own rules when a description is taken away", () => {
    const before = view({
      enforced_rules: [
        { code: "banned", text: "No cards banned in the format" },
        { code: "game_changers", text: "At most 3 Game Changers a deck" },
      ],
    });
    expect(profileChanges(before, null)).toEqual([
      {
        part: "described",
        text: "Kind of game: no longer said (was Upgraded casual)",
      },
      { part: "described", text: "Pace: no longer said (was Steady)" },
      {
        part: "described",
        text: "Expected length: no longer said (was about 90 minutes)",
      },
      {
        part: "enforced",
        text: "No longer checked: At most 3 Game Changers a deck",
      },
    ]);
  });
});

describe("the profile a seated player last read", () => {
  it("is kept by the browser for the one table they sit at", () => {
    expect(keptRead("code-1")).toBeUndefined();
    keepRead("code-1", view());
    expect(keptRead("code-1")).toEqual(view());
    // Another table's is not this one's.
    expect(keptRead("code-2")).toBeUndefined();
    // A table read with no description is kept as that, apart from nothing kept.
    keepRead("code-2", null);
    expect(keptRead("code-2")).toBeNull();
    expect(keptRead("code-1")).toBeUndefined();
  });

  it("is nothing where the browser's store is unreadable", () => {
    window.localStorage.setItem("cd.tables.profileRead", "{not json");
    expect(keptRead("code-1")).toBeUndefined();
  });
});

describe("a preset", () => {
  const builtIn: Preset = {
    id: null,
    name: "Upgraded casual",
    built_in: true,
    profile: view(),
    settings: {},
  };
  const saved: Preset = {
    id: "p1",
    name: "Friday night",
    built_in: false,
    profile: view(),
    settings: { format: "commander" },
  };
  const presets: Presets = {
    built_in: [builtIn],
    saved: [saved],
    limit: 20,
    paces: [],
  };

  it("is chosen by its kind of game when built in, by its id when saved", () => {
    expect(presetKey(builtIn)).toBe("built:upgraded");
    expect(presetKey(saved)).toBe("saved:p1");
    expect(findPreset(presets, "saved:p1")).toBe(saved);
    expect(findPreset(presets, "built:upgraded")).toBe(builtIn);
    expect(findPreset(presets, "")).toBeUndefined();
    expect(findPreset(null, "saved:p1")).toBeUndefined();
  });
});
