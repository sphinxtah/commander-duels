import { describe, expect, it } from "vitest";
import type {
  GameView,
  LogLine,
  PermanentView,
  PlayerView,
} from "../game/types";
import {
  FRESH_MEMORY,
  fires,
  incarnation,
  lesson,
  observe,
  remember,
} from "./barks";
import { stepsAfterWin } from "./campaign";
import { castOf, finaleScene } from "./cast";
import { STORY, type Scene } from "./script";
import { stagesOf, stepsOf } from "./stage";

// The campaign's pure parts (v0.8.0): the script holds every scene of the handoff with unique
// keys and known speakers; the stage puts each speaker on their side; the barks and lessons fire
// on what changed between two views.

const PLAYER = { name: "ada", alliance: "rowan" };

function allScenes(): Scene[] {
  const scenes: Scene[] = [
    STORY.opening,
    STORY.refugeIntro,
    STORY.allianceMatch,
    STORY.allianceSphinx,
    STORY.allianceKaya,
    STORY.replay,
    STORY.finale.loss,
    STORY.endings.win,
    STORY.endings.early,
  ];
  for (const story of Object.values(STORY.encounters)) {
    scenes.push(story.pre);
    if (story.post) scenes.push(story.post);
    if (story.loss) scenes.push(story.loss);
  }
  return scenes;
}

describe("the script", () => {
  it("holds fourteen encounters, each with its scenes, and unique line keys", () => {
    const numbers = Object.keys(STORY.encounters).map(Number);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    for (const story of Object.values(STORY.encounters)) {
      expect(story.pre.lines.length).toBeGreaterThan(0);
      if (story.number < 14) {
        expect(story.post?.lines.length ?? 0).toBeGreaterThan(0);
        expect(story.loss?.lines.length).toBe(1);
        expect(story.barks?.length).toBe(2);
      }
    }
    const ids = new Set<string>();
    const lines = [
      ...allScenes().flatMap((scene) => scene.lines),
      ...STORY.finale.phase1,
      ...STORY.finale.arrival,
      ...STORY.finale.removed,
      ...STORY.finale.recast,
      STORY.finale.countered,
      ...STORY.finale.escalation,
      ...STORY.tutorialHelp,
      ...Object.values(STORY.encounters).flatMap((story) => story.barks ?? []),
    ];
    for (const line of lines) ids.add(line.id);
    // The early ending replays the standard ending's last lines.
    const repeated = STORY.endings.early.lines.filter((line) =>
      line.id.startsWith("FC.END.WIN"),
    ).length;
    expect(ids.size).toBe(lines.length - repeated);
    expect(STORY.tutorial.map((lesson) => lesson.id)).toEqual([
      "T01",
      "T02",
      "T03",
      "T04",
      "T05",
      "T06",
      "T07",
      "T08",
      "T09",
      "T10",
      "T11",
      "T12",
    ]);
  });

  it("casts every speaker with a name, and veils The Sphinx until the finale", () => {
    for (const scene of allScenes())
      for (const line of scene.lines) {
        const member = castOf(line.speaker, scene.id, PLAYER);
        if (line.speaker !== "NARRATOR")
          expect(member.name.length).toBeGreaterThan(0);
      }
    expect(castOf("SPHINX", "FC.OPEN", PLAYER).veiled).toBe(true);
    expect(castOf("SPHINX", "FC.OPEN", PLAYER).name).toBe(
      "A voice from the throne",
    );
    expect(castOf("SPHINX", "FC.E14.PRE", PLAYER).veiled).toBe(false);
    expect(finaleScene("FC.END.WIN")).toBe(true);
    // Liliana stands with the player from her defeat on.
    expect(castOf("LILIANA", "FC.E13.PRE", PLAYER).side).toBe("right");
    expect(castOf("LILIANA", "FC.E14.PRE", PLAYER).side).toBe("left");
    // A player with no ally is the Wayfarer.
    expect(
      castOf("PLAYER", "FC.OPEN", { name: "bo", alliance: null }).figure,
    ).toBe("wayfarer");
  });

  it("speaks to the player, never about them, in its narration and notes", () => {
    const texts = [
      ...allScenes().flatMap((scene) => [scene.intro ?? "", scene.outro ?? ""]),
      ...Object.values(STORY.encounters).flatMap((story) => [
        story.story,
        story.counterplay,
      ]),
    ];
    for (const text of texts)
      expect(/\bthe player\b/i.test(text), text).toBe(false);
    // The victory scenes end on their lines; what a seal revealed is the journal's.
    for (const story of Object.values(STORY.encounters))
      expect(story.post?.outro).toBe(undefined);
  });
});

describe("the stage", () => {
  it("puts allies left and opponents right, at most two on the right", () => {
    const scene = STORY.encounters[12]!.post!;
    const steps = stepsOf(scene);
    const stages = stagesOf(scene, steps, PLAYER);
    expect(stages.length).toBe(steps.length);
    for (const stage of stages) {
      expect(stage.right.length).toBeLessThanOrEqual(2);
      expect(stage.left.length).toBeLessThanOrEqual(3);
      expect(stage.left.includes("BOLAS")).toBe(false);
    }
    // The Sphinx severs Bolas: he leaves the stage after that line.
    const sever = steps.findIndex(
      (step) => step.kind === "line" && step.line.fx === "sever",
    );
    expect(stages[sever]?.severed).toBe("BOLAS");
    expect(stages[sever + 1]?.right.includes("BOLAS")).toBe(false);
  });

  it("opens with the title and the narration, and changes scenery as a line asks", () => {
    const steps = stepsOf(STORY.endings.win);
    expect(steps[0]?.kind).toBe("title");
    const stages = stagesOf(STORY.endings.win, steps, PLAYER);
    expect(stages[0]?.scenery).toBe("throne");
    expect(stages[stages.length - 1]?.scenery).toBe("refuge");
    expect(stages.some((stage) => stage.scenery === "dawn")).toBe(true);
  });
});

function permanent(
  id: string,
  seat: number,
  type: string,
  extra: Partial<PermanentView> = {},
): PermanentView {
  return {
    id,
    controller_seat: seat,
    owner_seat: seat,
    card: {
      id: `c-${id}`,
      hidden: false,
      name: id,
      mana_cost: null,
      type_line: type,
      power: "2",
      toughness: "2",
      rules: [],
    },
    tapped: false,
    summoning_sick: false,
    damage: 0,
    counters: {},
    attacking: false,
    blocking: false,
    attached_to: null,
    ...extra,
  };
}

function player(
  seat: number,
  life: number,
  extra: Partial<PlayerView> = {},
): PlayerView {
  return {
    seat,
    name: seat === 0 ? "Human 1" : "Bot 2",
    life,
    counters: {},
    library_count: 80,
    hand_count: 7,
    graveyard: [],
    exile: [],
    mana_pool: { white: 0, blue: 0, black: 0, red: 0, green: 0, colorless: 0 },
    lost: false,
    won: false,
    color_identity: null,
    command_zone: [],
    commanders: [],
    ...extra,
  };
}

function view(
  battlefield: PermanentView[],
  you: PlayerView,
  boss: PlayerView,
  extra: Partial<GameView> = {},
): GameView {
  return {
    seat: 0,
    turn: 3,
    active_seat: 0,
    priority_seat: 0,
    phase: "precombat_main",
    step: "main1",
    you,
    opponents: [boss],
    hand: [],
    battlefield,
    stack: [],
    combat: [],
    revealed: [],
    looked_at: [],
    messages: [],
    priority: null,
    ...extra,
  };
}

describe("after a win", () => {
  it("claims the seal, then shows the warden's deck and tokens once they are won", () => {
    const encounter = {
      number: 1,
      opponent: "tibalt",
      name: "Tibalt",
      title: "The Laughing Gate",
      tier: "bronze",
      location: "The outer ward",
      seal: "Pain",
      commander: "Judith, the Scourge Diva",
      skill: 1,
      status: "won",
      spoils: {
        tokens: 1000,
        deck: "Tibalt's Deck",
        commander: "Judith, the Scourge Diva",
        earned: true,
      },
    } as const;
    const state = { chapters: [], encounters: [encounter] } as never;
    const steps = stepsAfterWin(state, encounter);
    expect(steps.map((step) => step.kind)).toEqual(["seal", "spoils"]);
    expect(steps[1]).toEqual({
      kind: "spoils",
      opponent: "tibalt",
      deck: "Tibalt's Deck",
      commander: "Judith, the Scourge Diva",
      tokens: 1000,
    });
    const unearned = {
      ...encounter,
      spoils: { ...encounter.spoils, earned: false },
    };
    expect(stepsAfterWin(state, unearned).map((step) => step.kind)).toEqual([
      "seal",
    ]);
  });
});

describe("barks", () => {
  const log: LogLine[] = [];
  it("fire on the player's first creature and the boss's life crossing", () => {
    const before = observe(view([], player(0, 40), player(1, 40)), log, 0);
    const after = observe(
      view(
        [permanent("bear", 0, "Creature — Bear")],
        player(0, 40),
        player(1, 9),
      ),
      log,
      0,
    );
    expect(fires("FIRST_PLAYER_CREATURE", before, after, FRESH_MEMORY)).toBe(
      true,
    );
    expect(fires("FIRST_PLAYER_CREATURE", after, after, FRESH_MEMORY)).toBe(
      false,
    );
    expect(fires("BOSS_LIFE_AT_OR_BELOW_10", before, after, FRESH_MEMORY)).toBe(
      true,
    );
    expect(fires("BOSS_LIFE_AT_OR_BELOW_10", after, after, FRESH_MEMORY)).toBe(
      false,
    );
    expect(fires("NO_SUCH_TRIGGER", before, after, FRESH_MEMORY)).toBe(false);
  });

  it("know a theft, a sweep rebuilt from and a large attack survived", () => {
    const calm = observe(view([], player(0, 40), player(1, 40)), log, 0);
    const stolen = observe(
      view(
        [permanent("knight", 1, "Creature — Knight", { owner_seat: 0 })],
        player(0, 40),
        player(1, 40),
      ),
      log,
      0,
    );
    expect(fires("FIRST_BOSS_THEFT", calm, stolen, FRESH_MEMORY)).toBe(true);
    const crowded = observe(
      view(
        [
          permanent("a", 0, "Creature"),
          permanent("b", 0, "Creature"),
          permanent("c", 1, "Creature"),
        ],
        player(0, 40),
        player(1, 40),
      ),
      log,
      0,
    );
    const swept = observe(view([], player(0, 40), player(1, 40)), log, 0);
    const memory = remember(FRESH_MEMORY, crowded, swept);
    expect(memory.wiped).toBe(true);
    const rebuilt = observe(
      view(
        [permanent("d", 0, "Creature"), permanent("e", 0, "Creature")],
        player(0, 40),
        player(1, 40),
      ),
      log,
      0,
    );
    expect(fires("PLAYER_REBUILDS_AFTER_WIPE", swept, rebuilt, memory)).toBe(
      true,
    );
  });

  it("see the finale's incarnation cross at 15 life, leave and return", () => {
    const walker = permanent("walker", 1, "Legendary Planeswalker — Sphinx", {
      counters: { loyalty: 7 },
    });
    const before = observe(view([], player(0, 40), player(1, 16)), log, 0);
    const crossed = observe(
      view([walker], player(0, 40), player(1, 15)),
      log,
      0,
    );
    expect(incarnation(before, crossed, FRESH_MEMORY)).toBe("arrived");
    const arrived = { ...FRESH_MEMORY, arrived: true };
    const gone = observe(view([], player(0, 40), player(1, 12)), log, 0);
    expect(incarnation(crossed, gone, arrived)).toBe("removed");
    const back = observe(view([walker], player(0, 40), player(1, 12)), log, 0);
    expect(incarnation(gone, back, { ...arrived, removed: true })).toBe(
      "returned",
    );
    // A planeswalker before the threshold is no incarnation.
    const early = observe(view([walker], player(0, 40), player(1, 30)), log, 0);
    expect(incarnation(before, early, FRESH_MEMORY)).toBe(null);
  });
});

describe("lessons", () => {
  it("follow the prompt on screen", () => {
    const shown = view([], player(0, 40), player(1, 40));
    const now = observe(shown, [], 0);
    const prompt = (kind: "mulligan" | "declare_attackers") => ({
      id: "p",
      kind,
      message: "",
      detail: null,
      options: [],
      amounts: null,
      piles: null,
      xmage_query: null,
    });
    expect(lesson("T01", null, now, null, shown)).toBe(true);
    expect(lesson("T02", null, now, prompt("mulligan"), shown)).toBe(true);
    expect(lesson("T02", null, now, prompt("declare_attackers"), shown)).toBe(
      false,
    );
    expect(lesson("T07", null, now, prompt("declare_attackers"), shown)).toBe(
      true,
    );
    expect(lesson("T11", null, now, null, shown)).toBe(false);
  });
});
