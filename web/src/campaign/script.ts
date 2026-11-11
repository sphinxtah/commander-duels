// The Final Concordance's script (v0.8.0): every line of the campaign's scenes, barks and tutorial
// prompts, from the owner's campaign handoff (version 1, 2026-10-31; its scene keys, such as
// FC.E04.POST.05, are the stable keys the progress and the journal use). The staging is ours: each
// scene's scenery and phase, and a line's effect (fx) or change of scenery. docs/campaign.md.
// The handoff itself is the owner's and stays outside the repository (the gitignored campaign/).

import type { SceneryId } from "./scenery/Scenery";

/** Who speaks. NARRATOR is a caption; PLAYER is the account (its ally's portrait). */
export type Speaker =
  | "NARRATOR"
  | "PLAYER"
  | "KAYA"
  | "HIGH_PRIEST"
  | "SPHINX"
  | "SURVIVOR"
  | "TIBALT"
  | "DARETTI"
  | "DOMRI"
  | "DOVIN"
  | "OKO"
  | "XENAGOS"
  | "TEZZERET"
  | "ARZAKON"
  | "ASHIOK"
  | "OB_NIXILIS"
  | "DIHADA"
  | "BOLAS"
  | "LILIANA";

/** A line's effect, played as it begins. */
export type Fx =
  | "lamps-out"
  | "five-suns"
  | "gold-thread"
  | "flash"
  | "voice"
  | "laugh"
  | "shadows-return"
  | "sparks"
  | "shake"
  | "stamp"
  | "mirror"
  | "silence"
  | "glitch"
  | "prism"
  | "chains"
  | "sever"
  | "burn"
  | "names-dim"
  | "reveal"
  | "fracture"
  | "staff-dims"
  | "lights-return";

export interface Line {
  id: string;
  speaker: Speaker;
  text: string;
  fx?: Fx;
  /** The scenery's phase from this line on. */
  phase?: string;
  /** Another scenery from this line on. */
  scenery?: SceneryId;
}

export interface Scene {
  /** The scene's key, as the progress records it seen (FC.E01.PRE). */
  id: string;
  scenery: SceneryId;
  phase?: string;
  caption?: { kicker: string; title: string; sub?: string };
  /** A narration before the first line: the place as the player arrives. */
  intro?: string;
  lines: Line[];
  /** A narration after the last line: what the scene revealed. */
  outro?: string;
}

/** A bark: a line said during the duel, never pausing it. */
export interface Bark extends Line {
  trigger: string;
}

export interface EncounterStory {
  number: number;
  title: string;
  /** The boss's seat when it is not the first opponent: The Sphinx as King B at the court. */
  bossSeat?: number;
  pre: Scene;
  /** The victory scene (none for the finale, whose endings are below). */
  post?: Scene;
  loss?: Scene;
  barks?: Bark[];
  /** What the victory revealed, for the journal. */
  story: string;
  /** How to beat the encounter, for the journal and a retry. */
  counterplay: string;
  design: string;
}

export interface Story {
  opening: Scene;
  refugeIntro: Scene;
  allianceMatch: Scene;
  allianceSphinx: Scene;
  allianceKaya: Scene;
  replay: Scene;
  tutorialHelp: Line[];
  encounters: Record<number, EncounterStory>;
  finale: {
    phase1: Line[];
    arrival: Line[];
    removed: Line[];
    recast: Line[];
    countered: Line;
    escalation: Bark[];
    loss: Scene;
    arrivalTip: string;
  };
  endings: { win: Scene; early: Scene };
  /** Ward 14's end since v0.9.6: The Sphinx recalls Liliana and Nicol Bolas and flees. */
  flight: Scene;
  /** Ward 15, the court (v0.9.6): its incarnation, there from the start, and the victory's
   * scene before the ending. */
  court: {
    arrival: Line[];
    removed: Line[];
    returned: Line[];
    post: Scene;
    arrivalTip: string;
  };
  tutorial: { id: string; when: string; text: string }[];
}

/** The campaign map's description (the handoff: it reveals nothing of the finale). */
export const MAP_LINE = "Defeat each warden to reach the throne";

export const STORY: Story = {
  opening: {
    id: "FC.OPEN",
    scenery: "village",
    phase: "dusk",
    caption: {
      kicker: "The Final Concordance",
      title: "The First Lamp",
    },
    intro:
      "A village at dusk loses its small protective lights. A healer presses a dim charm to a patient's hand. The sky briefly shows five overlapping suns. Your alliance sigil warms, and a gold thread leads into an impossible doorway.",
    lines: [
      {
        id: "FC.OPEN.01",
        speaker: "NARRATOR",
        text: "The first thing to fail was a lamp. By nightfall, the wards were dark. By morning, people had begun to disappear.",
        fx: "lamps-out",
        phase: "dark",
      },
      {
        id: "FC.OPEN.02",
        speaker: "HIGH_PRIEST",
        text: "A frightened world mistakes disorder for freedom. My master offers an end to both.",
      },
      {
        id: "FC.OPEN.03",
        speaker: "PLAYER",
        text: "Where have you taken them?",
        fx: "five-suns",
      },
      {
        id: "FC.OPEN.04",
        speaker: "HIGH_PRIEST",
        text: "To a place where their gifts will serve a lasting purpose. You have a gift as well. Enter, and you may be worthy to witness it.",
        fx: "gold-thread",
      },
      {
        id: "FC.OPEN.05",
        speaker: "KAYA",
        text: "Do not answer him. Step away from the gold.",
        fx: "flash",
      },
      {
        id: "FC.OPEN.06",
        speaker: "PLAYER",
        text: "Kaya?",
      },
      {
        id: "FC.OPEN.07",
        speaker: "KAYA",
        text: "An incarnation of her. A stolen history with enough sense to dislike the thief. I can explain when we are somewhere less likely to swallow you.",
      },
      {
        id: "FC.OPEN.08",
        speaker: "SPHINX",
        text: "Let the challenger enter. A bond that cannot endure a question is of little use to me.",
        fx: "voice",
      },
      {
        id: "FC.OPEN.09",
        speaker: "KAYA",
        text: "He has thirteen wardens between the prisoners and that voice. Defeat a warden, take its seal, and the next door opens.",
      },
      {
        id: "FC.OPEN.10",
        speaker: "PLAYER",
        text: "Then we start with the first door.",
      },
      {
        id: "FC.OPEN.11",
        speaker: "KAYA",
        text: "We start with your commander. Open the bond and I will show you how to hold it.",
      },
    ],
  },
  refugeIntro: {
    id: "FC.REFUGE.INTRO",
    scenery: "refuge",
    caption: {
      kicker: "Outside his command chain",
      title: "The Refuge",
    },
    lines: [
      {
        id: "FC.REFUGE.INTRO.01",
        speaker: "KAYA",
        text: "This room is outside his command chain. You can rebuild your deck here without giving up the ground you have taken.",
      },
      {
        id: "FC.REFUGE.INTRO.02",
        speaker: "PLAYER",
        text: "Can you come with me?",
      },
      {
        id: "FC.REFUGE.INTRO.03",
        speaker: "KAYA",
        text: "I keep the passage open. You win the seals. If the duel goes wrong, follow the silver light back.",
      },
    ],
  },
  allianceMatch: {
    id: "FC.ALLIANCE.MATCH",
    scenery: "refuge",
    lines: [
      {
        id: "FC.ALLIANCE.MATCH.01",
        speaker: "KAYA",
        text: "The figure in that ward is an incarnation. The bond you chose belongs to you. That incarnation does not get to rewrite it.",
      },
    ],
  },
  allianceSphinx: {
    id: "FC.ALLIANCE.SPHINX",
    scenery: "throne",
    lines: [
      {
        id: "FC.ALLIANCE.SPHINX.01",
        speaker: "SPHINX",
        text: "You carry my sign and raise your commander against me?",
      },
      {
        id: "FC.ALLIANCE.SPHINX.02",
        speaker: "PLAYER",
        text: "I accepted power. I did not surrender my will.",
      },
      {
        id: "FC.ALLIANCE.SPHINX.03",
        speaker: "KAYA",
        text: "A symbol is not a command. Keep fighting.",
      },
    ],
  },
  allianceKaya: {
    id: "FC.ALLIANCE.KAYA",
    scenery: "refuge",
    lines: [
      {
        id: "FC.ALLIANCE.KAYA.01",
        speaker: "KAYA",
        text: "Two reflections of the same history can still make their own choices. Your bond brought you here; mine keeps the refuge open.",
      },
    ],
  },
  replay: {
    id: "FC.REPLAY",
    scenery: "refuge",
    caption: {
      kicker: "The Archive remembers",
      title: "Replay",
    },
    lines: [
      {
        id: "FC.REPLAY.01",
        speaker: "KAYA",
        text: "The Archive kept the shape of those battles. We can study them without rebuilding the prison.",
      },
      {
        id: "FC.REPLAY.02",
        speaker: "PLAYER",
        text: "Even the throne?",
      },
      {
        id: "FC.REPLAY.03",
        speaker: "KAYA",
        text: "Especially the throne. This time, we know what is waiting.",
      },
    ],
  },
  tutorialHelp: [
    {
      id: "FC.TUTORIAL.HELP.01",
      speaker: "KAYA",
      text: "You can inspect a card before you commit. Nothing moves until you confirm the action.",
    },
    {
      id: "FC.TUTORIAL.HELP.02",
      speaker: "KAYA",
      text: "That creature is dangerous, but it is not attacking yet. You can save the answer for the right moment.",
    },
    {
      id: "FC.TUTORIAL.HELP.03",
      speaker: "KAYA",
      text: "You do not need to spend all your mana. Sometimes the possibility of a response is useful.",
    },
    {
      id: "FC.TUTORIAL.HELP.04",
      speaker: "KAYA",
      text: "A lost creature is not always a lost turn. Look at what your next play will accomplish.",
    },
  ],
  encounters: {
    "1": {
      number: 1,
      title: "The Laughing Gate",
      pre: {
        id: "FC.E01.PRE",
        scenery: "fairground",
        caption: {
          kicker: "Encounter 01",
          title: "The Laughing Gate",
          sub: "Bronze | The abandoned fairground | Seal 01 Pain",
        },
        intro:
          "Beyond the refuge, a fairground has been rebuilt from mismatched memories. Painted horses breathe. A child's shadow remains trapped on a carousel after its owner has escaped. Tibalt is using frightened captives to test the first intake of the Concordance Engine. Kaya guides you through the outer ward while holding its evacuation passage open.",
        lines: [
          {
            id: "FC.E01.PRE.01",
            speaker: "KAYA",
            text: "Stay with me. Your commander is your anchor here. Call on that bond before you spend power you cannot replace.",
          },
          {
            id: "FC.E01.PRE.02",
            speaker: "TIBALT",
            text: "A beginner? How considerate. I was running out of small things to frighten.",
            fx: "laugh",
          },
          {
            id: "FC.E01.PRE.03",
            speaker: "PLAYER",
            text: "Release the people on the wheel.",
          },
          {
            id: "FC.E01.PRE.04",
            speaker: "TIBALT",
            text: "They are rehearsing. The Sphinx wants everyone ready for their part.",
          },
          {
            id: "FC.E01.PRE.05",
            speaker: "KAYA",
            text: "Break his command, and the gate opens. I will get them out. You take the duel.",
          },
        ],
        phase: "trapped",
      },
      story:
        "The first seal held a command to keep its prisoners conscious. The Engine harms real people; the arena is no consequence-free illusion.",
      counterplay:
        "Play lands, develop creatures, attack safely, and identify legal responses. Killing Judith alone does not win the duel.",
      design:
        "Copper carousel; soot-red lamps; silhouettes detach and reunite after victory. Avoid graphic torture. End with the sound of machinery below.",
      post: {
        id: "FC.E01.POST",
        scenery: "fairground",
        lines: [
          {
            id: "FC.E01.POST.01",
            speaker: "TIBALT",
            text: "That was not the ending I prepared.",
          },
          {
            id: "FC.E01.POST.02",
            speaker: "PLAYER",
            text: "They were never your audience.",
          },
          {
            id: "FC.E01.POST.03",
            speaker: "KAYA",
            text: "The shadows are moving with their owners again. Take the seal.",
            fx: "shadows-return",
            phase: "free",
          },
          {
            id: "FC.E01.POST.04",
            speaker: "SURVIVOR",
            text: "The machines came from below the arena. A goblin kept asking how much pain the copper could hold.",
          },
          {
            id: "FC.E01.POST.05",
            speaker: "KAYA",
            text: "Daretti. Then we go down before he repairs this gate.",
          },
        ],
        phase: "trapped",
      },
      loss: {
        id: "FC.E01.LOSS",
        scenery: "fairground",
        lines: [
          {
            id: "FC.E01.LOSS.01",
            speaker: "KAYA",
            text: "I have the passage. Come back through it. We know his tricks now.",
          },
        ],
        phase: "trapped",
      },
      barks: [
        {
          id: "FC.E01.BARK.01",
          speaker: "TIBALT",
          text: "You brought company. Good. An audience improves everything.",
          trigger: "FIRST_PLAYER_CREATURE",
        },
        {
          id: "FC.E01.BARK.02",
          speaker: "TIBALT",
          text: "Stop learning so quickly.",
          trigger: "BOSS_LIFE_AT_OR_BELOW_10",
        },
      ],
    },
    "2": {
      number: 2,
      title: "The Foundry Below",
      pre: {
        id: "FC.E02.PRE",
        scenery: "foundry",
        caption: {
          kicker: "Encounter 02",
          title: "The Foundry Below",
          sub: "Bronze | The buried salvage foundry | Seal 02 Matter",
        },
        intro:
          "You descend beneath the fairground. Broken cages travel along a conveyor into a furnace that produces polished armor. The plates bear names instead of serial numbers. Daretti has been promised a foundry that can never be closed by an academy or a ruler, and he has stopped asking what supplies its raw material.",
        lines: [
          {
            id: "FC.E02.PRE.01",
            speaker: "DARETTI",
            text: "Mind the rail. It costs more than the people who usually fall over it.",
            fx: "sparks",
          },
          {
            id: "FC.E02.PRE.02",
            speaker: "PLAYER",
            text: "You built the cages upstairs.",
          },
          {
            id: "FC.E02.PRE.03",
            speaker: "DARETTI",
            text: "I build what I am paid to build. The Sphinx pays in possibilities.",
          },
          {
            id: "FC.E02.PRE.04",
            speaker: "KAYA",
            text: "These plates have memories inside them.",
          },
          {
            id: "FC.E02.PRE.05",
            speaker: "DARETTI",
            text: "Then try not to scratch them. A perfect copy requires a clean surface.",
          },
        ],
      },
      story:
        "The second seal identifies the wardens as incarnations made from recorded magical identities. Their bodies are constructed, but they think, choose, and can hurt the people outside the Archive.",
      counterplay:
        "Remove the source of recursion or its valuable target. A sacrifice is a cost, paid as the ability is used.",
      design:
        "Scrap iron and copper become immaculate gold near the exit. Conveyor direction leads the eye toward the next ward.",
      post: {
        id: "FC.E02.POST",
        scenery: "foundry",
        lines: [
          {
            id: "FC.E02.POST.01",
            speaker: "DARETTI",
            text: "Fine. Take the regulator. Let someone else explain the delays.",
            fx: "sparks",
          },
          {
            id: "FC.E02.POST.02",
            speaker: "PLAYER",
            text: "Who is receiving your shipments?",
          },
          {
            id: "FC.E02.POST.03",
            speaker: "DARETTI",
            text: "A boy with an army of beasts and no patience for invoices.",
          },
          {
            id: "FC.E02.POST.04",
            speaker: "KAYA",
            text: "Domri. His ward is above us.",
          },
          {
            id: "FC.E02.POST.05",
            speaker: "DARETTI",
            text: "Try the broken wall. He considers doors a personal insult.",
          },
        ],
      },
      loss: {
        id: "FC.E02.LOSS",
        scenery: "foundry",
        lines: [
          {
            id: "FC.E02.LOSS.01",
            speaker: "DARETTI",
            text: "You lasted longer than the last prototype. That is something.",
          },
        ],
      },
      barks: [
        {
          id: "FC.E02.BARK.01",
          speaker: "DARETTI",
          text: "Nothing is wasted. Especially your effort.",
          trigger: "FIRST_BOSS_ARTIFACT_RECURSION",
        },
        {
          id: "FC.E02.BARK.02",
          speaker: "KAYA",
          text: "Good. Break the machine that keeps replacing the others.",
          trigger: "FIRST_PLAYER_ARTIFACT_REMOVAL",
        },
      ],
    },
    "3": {
      number: 3,
      title: "The Broken Streets",
      pre: {
        id: "FC.E03.PRE",
        scenery: "streets",
        caption: {
          kicker: "Encounter 03",
          title: "The Broken Streets",
          sub: "Bronze | A reconstructed Ravnican district | Seal 03 Force",
        },
        intro:
          "A Ravnican street grows through the foundry ceiling. Beasts batter a gate while frightened residents hide behind an overturned tram. Domri believes the Sphinx will erase the laws that keep the Gruul dispossessed. He has not considered who will rule the cleared ground.",
        lines: [
          {
            id: "FC.E03.PRE.01",
            speaker: "DOMRI",
            text: "The old city is finished. You can get out of the way or go down with it.",
            fx: "shake",
          },
          {
            id: "FC.E03.PRE.02",
            speaker: "PLAYER",
            text: "There are people behind that gate.",
          },
          {
            id: "FC.E03.PRE.03",
            speaker: "DOMRI",
            text: "There were people outside their gates too. Nobody opened those.",
          },
          {
            id: "FC.E03.PRE.04",
            speaker: "KAYA",
            text: "The Sphinx is building a throne with the rubble.",
          },
          {
            id: "FC.E03.PRE.05",
            speaker: "DOMRI",
            text: "Then I will smash that when I reach it. First, you.",
            fx: "shake",
          },
        ],
      },
      story:
        "The conspiracy offers incompatible rewards. Domri has been promised freedom while the next warden has been promised perfect order.",
      counterplay:
        "Trade creatures deliberately, preserve life as a resource, and save removal for an attacker that changes combat math.",
      design:
        "Ravnican stone split by roots; diagonal motion and drum rhythms. Victory ends the charge rather than destroying the city.",
      post: {
        id: "FC.E03.POST",
        scenery: "streets",
        lines: [
          {
            id: "FC.E03.POST.01",
            speaker: "DOMRI",
            text: "His orders said the streets would belong to us.",
          },
          {
            id: "FC.E03.POST.02",
            speaker: "PLAYER",
            text: "Read the last line.",
          },
          {
            id: "FC.E03.POST.03",
            speaker: "DOMRI",
            text: '"Until administration is restored." He put that in?',
          },
          {
            id: "FC.E03.POST.04",
            speaker: "KAYA",
            text: "Dovin did. The next gate is his court.",
          },
          {
            id: "FC.E03.POST.05",
            speaker: "DOMRI",
            text: "Then tell the lawman I want my city back.",
          },
        ],
      },
      loss: {
        id: "FC.E03.LOSS",
        scenery: "streets",
        lines: [
          {
            id: "FC.E03.LOSS.01",
            speaker: "DOMRI",
            text: "Next time bring something that can stand in the street.",
          },
        ],
      },
      barks: [
        {
          id: "FC.E03.BARK.01",
          speaker: "DOMRI",
          text: "Do not give them time to build another wall!",
          trigger: "FIRST_BOSS_HASTE_ATTACK",
        },
        {
          id: "FC.E03.BARK.02",
          speaker: "KAYA",
          text: "You cannot stop every charge. Make this one cost him.",
          trigger: "FIRST_FAVORABLE_PLAYER_BLOCK",
        },
      ],
    },
    "4": {
      number: 4,
      title: "The Court of Necessary Silence",
      pre: {
        id: "FC.E04.PRE",
        scenery: "tribunal",
        caption: {
          kicker: "Encounter 04",
          title: "The Court of Necessary Silence",
          sub: "Bronze | The sealed tribunal | Seal 04 Law",
        },
        intro:
          "The tribunal is almost silent. Hundreds of petitions stand upright in the air, each stamped REJECTED before the writer finishes. Dovin has made a legal model in which disagreement is treated as a defect. The bronze ward cannot be exited while his command controls the transit writ.",
        lines: [
          {
            id: "FC.E04.PRE.01",
            speaker: "DOVIN",
            text: "You have damaged three essential services and obstructed a lawful evacuation.",
            fx: "stamp",
          },
          {
            id: "FC.E04.PRE.02",
            speaker: "PLAYER",
            text: "Those people were being imprisoned.",
          },
          {
            id: "FC.E04.PRE.03",
            speaker: "DOVIN",
            text: "Imprisonment is an emotional description of regulated movement.",
          },
          {
            id: "FC.E04.PRE.04",
            speaker: "KAYA",
            text: "And who regulates you?",
          },
          {
            id: "FC.E04.PRE.05",
            speaker: "DOVIN",
            text: "A system with fewer errors than yours. Present your objection through the permitted procedure.",
            fx: "stamp",
          },
        ],
      },
      story:
        "The Final Concordance will make the Sphinx the sole authority over permitted magic. And a first warning: the Engine is recording your victories.",
      counterplay:
        "Sequence threats, hold a creature after a wipe, and force the opponent to spend answers before committing the commander.",
      design:
        "White marble and blue glass; every surface is symmetrical until the seal breaks. Bronze badge transitions to Silver after the post scene.",
      post: {
        id: "FC.E04.POST",
        scenery: "tribunal",
        lines: [
          {
            id: "FC.E04.POST.01",
            speaker: "DOVIN",
            text: "An exception does not invalidate the model.",
          },
          {
            id: "FC.E04.POST.02",
            speaker: "PLAYER",
            text: "Your model has doors without handles.",
          },
          {
            id: "FC.E04.POST.03",
            speaker: "DOVIN",
            text: "The Sphinx promised peace. Unrestricted choice was the remaining variable.",
          },
          {
            id: "FC.E04.POST.04",
            speaker: "KAYA",
            text: "We have the writ. The next ward belongs to Oko. Beyond this court, even a face may be a lie.",
          },
          {
            id: "FC.E04.POST.05",
            speaker: "HIGH_PRIEST",
            text: "The outer examination is complete. Enter, challenger. Your victories have been recorded.",
            fx: "voice",
          },
        ],
      },
      loss: {
        id: "FC.E04.LOSS",
        scenery: "tribunal",
        lines: [
          {
            id: "FC.E04.LOSS.01",
            speaker: "DOVIN",
            text: "Your appeal has been preserved. Its outcome has not changed.",
          },
        ],
      },
      barks: [
        {
          id: "FC.E04.BARK.01",
          speaker: "DOVIN",
          text: "Objection denied.",
          trigger: "FIRST_BOSS_COUNTERSPELL",
        },
        {
          id: "FC.E04.BARK.02",
          speaker: "KAYA",
          text: "He can answer a threat. Make him choose which one matters.",
          trigger: "FIRST_PLAYER_SECOND_SPELL_SAME_TURN",
        },
      ],
    },
    "5": {
      number: 5,
      title: "The Garden of Borrowed Faces",
      pre: {
        id: "FC.E05.PRE",
        scenery: "garden",
        caption: {
          kicker: "Encounter 05",
          title: "The Garden of Borrowed Faces",
          sub: "Silver | An artificial fae garden | Seal 05 Identity",
        },
        intro:
          "The court opens into a garden where statues wear familiar faces. One wears the face of your ally. Oko has been using stolen identities to enter the Archive's secured rooms. He knows the Sphinx expects betrayal and considers that an invitation to become more inventive.",
        lines: [
          {
            id: "FC.E05.PRE.01",
            speaker: "OKO",
            text: "You arrived wearing someone else's power. I thought we might have that in common.",
            fx: "mirror",
          },
          {
            id: "FC.E05.PRE.02",
            speaker: "PLAYER",
            text: "My alliance was a choice.",
          },
          {
            id: "FC.E05.PRE.03",
            speaker: "OKO",
            text: "Of course. Most cages are decorated by their occupants.",
          },
          {
            id: "FC.E05.PRE.04",
            speaker: "KAYA",
            text: "Show us the face you were paid to wear.",
          },
          {
            id: "FC.E05.PRE.05",
            speaker: "OKO",
            text: "Which payment? Which face? Let us find out what remains when yours stops working.",
            fx: "mirror",
          },
        ],
      },
      story:
        "The Sphinx is recording your alliance bond as well as your spells. That bond is a voluntary magical relationship the constructed wardens cannot supply on their own.",
      counterplay:
        "Stop evasive draw sources and identify whether removing an effect restores a transformed permanent. When your commander would leave play, you may send it to the command zone instead.",
      design:
        "Silver mirrors in living hedges. Use only a framed portrait reflection for the active alliance cameo; never require a new full-body model for every alliance.",
      post: {
        id: "FC.E05.POST",
        scenery: "garden",
        lines: [
          {
            id: "FC.E05.POST.01",
            speaker: "OKO",
            text: "The good news is that I never intended to keep my promise.",
            fx: "mirror",
          },
          {
            id: "FC.E05.POST.02",
            speaker: "KAYA",
            text: "To us or to him?",
          },
          {
            id: "FC.E05.POST.03",
            speaker: "OKO",
            text: "You understand me perfectly.",
          },
          {
            id: "FC.E05.POST.04",
            speaker: "PLAYER",
            text: "Where is the next seal?",
          },
          {
            id: "FC.E05.POST.05",
            speaker: "OKO",
            text: "Follow the cheering. Xenagos has persuaded an entire hall to applaud its own consumption.",
          },
        ],
      },
      loss: {
        id: "FC.E05.LOSS",
        scenery: "garden",
        lines: [
          {
            id: "FC.E05.LOSS.01",
            speaker: "OKO",
            text: "You were so certain that face belonged to you.",
          },
        ],
      },
      barks: [
        {
          id: "FC.E05.BARK.01",
          speaker: "OKO",
          text: "A small improvement. You may thank me later.",
          trigger: "FIRST_BOSS_TRANSFORMATION_OR_THEFT",
        },
        {
          id: "FC.E05.BARK.02",
          speaker: "PLAYER",
          text: "You changed the shape. The bond still answers.",
          trigger: "PLAYER_RECASTS_COMMANDER",
        },
      ],
    },
    "6": {
      number: 6,
      title: "The Feast That Never Ends",
      pre: {
        id: "FC.E06.PRE",
        scenery: "revel",
        caption: {
          kicker: "Encounter 06",
          title: "The Feast That Never Ends",
          sub: "Silver | The captured revel hall | Seal 06 Devotion",
        },
        intro:
          "A star-filled ceiling hangs above revelers who cannot stop dancing. Their devotion is drawn into a vessel beneath the feast. Xenagos has been promised a worshipful world without rival gods. He knows the promise is dangerous, but believes adoration can make any lie true enough to rule.",
        lines: [
          {
            id: "FC.E06.PRE.01",
            speaker: "XENAGOS",
            text: "Come in! They have been waiting for something worth celebrating.",
            fx: "flash",
          },
          {
            id: "FC.E06.PRE.02",
            speaker: "PLAYER",
            text: "They look exhausted.",
          },
          {
            id: "FC.E06.PRE.03",
            speaker: "XENAGOS",
            text: "Divinity is demanding work. I have been carrying my share.",
          },
          {
            id: "FC.E06.PRE.04",
            speaker: "KAYA",
            text: "You are draining them.",
          },
          {
            id: "FC.E06.PRE.05",
            speaker: "XENAGOS",
            text: "I am giving their lives meaning. Let us see whether they prefer your victory to mine.",
          },
        ],
        phase: "feast",
      },
      story:
        "The Engine does not simply copy magic. It consumes attention, devotion, and living mana to sustain its incarnations and extend its reach.",
      counterplay:
        "Hold instant-speed interaction for the enhanced attacker. Indestructible does not answer exile, sacrifice, or an opponent's alternative victory.",
      design:
        "Festive gold becomes sickly starlight. The first true silence after victory is a relief, followed by the distant hum of the bridge.",
      post: {
        id: "FC.E06.POST",
        scenery: "revel",
        lines: [
          {
            id: "FC.E06.POST.01",
            speaker: "XENAGOS",
            text: "Do you hear that? They are cheering for you.",
          },
          {
            id: "FC.E06.POST.02",
            speaker: "PLAYER",
            text: "They are cheering because they can stop.",
            fx: "silence",
            phase: "silent",
          },
          {
            id: "FC.E06.POST.03",
            speaker: "KAYA",
            text: "The vessel is emptying into a bridge. That is where the captives' power goes.",
          },
          {
            id: "FC.E06.POST.04",
            speaker: "XENAGOS",
            text: "Then hurry. Tezzeret charges dearly for an open door.",
          },
        ],
        phase: "feast",
      },
      loss: {
        id: "FC.E06.LOSS",
        scenery: "revel",
        lines: [
          {
            id: "FC.E06.LOSS.01",
            speaker: "XENAGOS",
            text: "The chorus knows a tragedy when it hears one.",
          },
        ],
      },
      barks: [
        {
          id: "FC.E06.BARK.01",
          speaker: "XENAGOS",
          text: "There! Something worthy of a song!",
          trigger: "FIRST_LARGE_HASTY_ATTACK",
        },
        {
          id: "FC.E06.BARK.02",
          speaker: "KAYA",
          text: "Survive the burst. The applause is feeding him.",
          trigger: "PLAYER_SURVIVES_LARGE_ATTACK",
        },
      ],
    },
    "7": {
      number: 7,
      title: "The Bridge of Unfinished Bodies",
      pre: {
        id: "FC.E07.PRE",
        scenery: "transit",
        caption: {
          kicker: "Encounter 07",
          title: "The Bridge of Unfinished Bodies",
          sub: "Silver | The transit works | Seal 07 Transit",
        },
        intro:
          "Metal frameworks cross a gulf and receive faces on the far side. Tezzeret has designed a transit network for constructed bodies, keeping his own escape route concealed in its schematics. He wants an independent empire of technology, and regards the Sphinx as a financier who will eventually be replaced.",
        lines: [
          {
            id: "FC.E07.PRE.01",
            speaker: "TEZZERET",
            text: "Do not look over the rail. Some of the unfinished ones still recognize faces.",
            fx: "glitch",
          },
          {
            id: "FC.E07.PRE.02",
            speaker: "PLAYER",
            text: "You are making people.",
          },
          {
            id: "FC.E07.PRE.03",
            speaker: "TEZZERET",
            text: "I am making bodies. Other departments supply the unpleasant parts.",
          },
          {
            id: "FC.E07.PRE.04",
            speaker: "KAYA",
            text: "You have served monsters before. You know how this ends.",
          },
          {
            id: "FC.E07.PRE.05",
            speaker: "TEZZERET",
            text: "I know how it ends for the servant who fails to build an exit.",
          },
        ],
      },
      story:
        "The Sphinx is learning from your successful bonds. Winning still frees captives and transfers real seals, but it also advances his research.",
      counterplay:
        "Graveyard hate, artifact removal, and pressure while the opponent spends mana setting up.",
      design:
        "Suspended mechanical ribs, blue transit arcs, incomplete silhouettes. Keep the bridge visually distinct from a living World Tree portal.",
      post: {
        id: "FC.E07.POST",
        scenery: "transit",
        lines: [
          {
            id: "FC.E07.POST.01",
            speaker: "TEZZERET",
            text: "Take the transit seal. It will not stop what your duels have already done.",
          },
          {
            id: "FC.E07.POST.02",
            speaker: "PLAYER",
            text: "Explain.",
          },
          {
            id: "FC.E07.POST.03",
            speaker: "TEZZERET",
            text: "Every victory teaches the Engine how your bond survives resistance. You are its missing live test.",
            fx: "flash",
          },
          {
            id: "FC.E07.POST.04",
            speaker: "KAYA",
            text: "Then we take the test all the way to its author.",
          },
          {
            id: "FC.E07.POST.05",
            speaker: "TEZZERET",
            text: "The next door belongs to Arzakon. He has sold this kind of lie before.",
          },
        ],
      },
      loss: {
        id: "FC.E07.LOSS",
        scenery: "transit",
        lines: [
          {
            id: "FC.E07.LOSS.01",
            speaker: "TEZZERET",
            text: "Useful data. Perhaps you will perform better in the next iteration.",
          },
        ],
      },
      barks: [
        {
          id: "FC.E07.BARK.01",
          speaker: "TEZZERET",
          text: "A functioning machine corrects its own losses.",
          trigger: "FIRST_BOSS_RECURSION_ENGINE",
        },
        {
          id: "FC.E07.BARK.02",
          speaker: "KAYA",
          text: "Keep that part out of his workshop.",
          trigger: "FIRST_PLAYER_GRAVEYARD_EXILE",
        },
      ],
    },
    "8": {
      number: 8,
      title: "The False Dominion",
      pre: {
        id: "FC.E08.PRE",
        scenery: "prism",
        caption: {
          kicker: "Encounter 08",
          title: "The False Dominion",
          sub: "Silver | The prism observatory | Seal 08 Dominion",
        },
        intro:
          "Five miniature worlds orbit a prism. Arzakon has drafted the territorial rewards promised to the other conspirators. Each deed grants a world that the Sphinx intends to empty first. Arzakon expects to steal the completed network, unaware that the agreement also defines Arzakon as property of the Archive.",
        lines: [
          {
            id: "FC.E08.PRE.01",
            speaker: "ARZAKON",
            text: "Every ruler wants the same gift: a world that cannot refuse.",
            fx: "prism",
          },
          {
            id: "FC.E08.PRE.02",
            speaker: "PLAYER",
            text: "You promised that gift before.",
          },
          {
            id: "FC.E08.PRE.03",
            speaker: "ARZAKON",
            text: "An unsuccessful conquest is still an education.",
          },
          {
            id: "FC.E08.PRE.04",
            speaker: "KAYA",
            text: "And the Sphinx learned from yours.",
          },
          {
            id: "FC.E08.PRE.05",
            speaker: "ARZAKON",
            text: "Then let us determine which of us understood the lesson.",
          },
        ],
      },
      story:
        "The conspiracy's contracts contain ownership traps: each defeated seal transfers genuine authority to its victor, and that authority is the means of an eventual countermand.",
      counterplay:
        "Disrupt a critical mana source, answer the payoff rather than every accelerator, and maintain a threat while holding interaction.",
      design:
        "Five suspended horizons around a fractured silver prism. A previously magnificent deed folds into a chain when its hidden clause is revealed.",
      post: {
        id: "FC.E08.POST",
        scenery: "prism",
        lines: [
          {
            id: "FC.E08.POST.01",
            speaker: "ARZAKON",
            text: "This clause was not in the agreement.",
          },
          {
            id: "FC.E08.POST.02",
            speaker: "PLAYER",
            text: '"All instantiated authorities remain assets of the Archive." You sold worlds you were never going to own.',
            fx: "chains",
          },
          {
            id: "FC.E08.POST.03",
            speaker: "ARZAKON",
            text: "He will make an asset of you as well.",
          },
          {
            id: "FC.E08.POST.04",
            speaker: "KAYA",
            text: "The seals we won are real. We need to learn what they can revoke.",
          },
          {
            id: "FC.E08.POST.05",
            speaker: "ASHIOK",
            text: "Begin with the certainty that you can win.",
            fx: "glitch",
          },
        ],
      },
      loss: {
        id: "FC.E08.LOSS",
        scenery: "prism",
        lines: [
          {
            id: "FC.E08.LOSS.01",
            speaker: "ARZAKON",
            text: "A world, a wizard, a will. Each yields to sufficient pressure.",
          },
        ],
      },
      barks: [
        {
          id: "FC.E08.BARK.01",
          speaker: "ARZAKON",
          text: "One language. Five voices. All of them mine.",
          trigger: "FIRST_BOSS_FIVE_COLOR_PAYOFF",
        },
        {
          id: "FC.E08.BARK.02",
          speaker: "KAYA",
          text: "Those colors have to meet somewhere. Break the connection.",
          trigger: "PLAYER_DISRUPTS_FIXING",
        },
      ],
    },
    "9": {
      number: 9,
      title: "The Victory You Fear",
      pre: {
        id: "FC.E09.PRE",
        scenery: "nightmare",
        caption: {
          kicker: "Encounter 09",
          title: "The Victory You Fear",
          sub: "Gold | The nightmare archive | Seal 09 Fear",
        },
        intro:
          "The observatory becomes your own victory celebration. Friends applaud without faces. A likeness of your ally promises safety if you stop resisting. Ashiok is testing a population-control mechanism that makes disobedience feel like catastrophe before anyone acts.",
        lines: [
          {
            id: "FC.E09.PRE.01",
            speaker: "ASHIOK",
            text: "You have imagined this moment. Everyone safe. Everyone grateful.",
            fx: "glitch",
          },
          {
            id: "FC.E09.PRE.02",
            speaker: "PLAYER",
            text: "Let me see their faces.",
          },
          {
            id: "FC.E09.PRE.03",
            speaker: "ASHIOK",
            text: "You did not imagine those as carefully.",
            fx: "glitch",
          },
          {
            id: "FC.E09.PRE.04",
            speaker: "KAYA",
            text: "Look at me. The feeling is real. The promise belongs to the throne.",
          },
          {
            id: "FC.E09.PRE.05",
            speaker: "ASHIOK",
            text: "How comforting, to believe fear must be false before it can be useful.",
          },
        ],
      },
      story:
        "The promised peace preserves consciousness while suppressing independent choice. The victims would understand their captivity and be unable to act against it.",
      counterplay:
        "Track exile separately from the graveyard; pressure the engine before it becomes a huge attacker.",
      design:
        "Distorted versions of previously visited rooms; stable UI remains outside the effect. Ashiok uses no gendered pronouns.",
      post: {
        id: "FC.E09.POST",
        scenery: "nightmare",
        lines: [
          {
            id: "FC.E09.POST.01",
            speaker: "ASHIOK",
            text: "You keep the fear and refuse the conclusion. How inconvenient.",
          },
          {
            id: "FC.E09.POST.02",
            speaker: "PLAYER",
            text: "I can be afraid and still choose.",
          },
          {
            id: "FC.E09.POST.03",
            speaker: "KAYA",
            text: "The lens records how he plans to silence the survivors. They will still be awake.",
          },
          {
            id: "FC.E09.POST.04",
            speaker: "OB_NIXILIS",
            text: "Of course they will. Subjects should understand when they have been conquered.",
            fx: "shake",
          },
        ],
      },
      loss: {
        id: "FC.E09.LOSS",
        scenery: "nightmare",
        lines: [
          {
            id: "FC.E09.LOSS.01",
            speaker: "ASHIOK",
            text: "We can visit that ending again whenever you like.",
          },
        ],
      },
      barks: [
        {
          id: "FC.E09.BARK.01",
          speaker: "ASHIOK",
          text: "A small possibility you will no longer need.",
          trigger: "FIRST_BOSS_EXILE_OR_MILL",
        },
        {
          id: "FC.E09.BARK.02",
          speaker: "KAYA",
          text: "Count what remains. Do not let the image hide the state of the duel.",
          trigger: "PLAYER_LOW_LIBRARY",
        },
      ],
    },
    "10": {
      number: 10,
      title: "The City That Kneels",
      pre: {
        id: "FC.E10.PRE",
        scenery: "amphitheater",
        caption: {
          kicker: "Encounter 10",
          title: "The City That Kneels",
          sub: "Gold | The conquest amphitheater | Seal 10 Conquest",
        },
        intro:
          "You enter a city already rehearsing surrender. Empty armor kneels in rows. Ob Nixilis has organized the Engine's expansion into an occupation plan: first seize the ways between worlds, then tax every act of resistance until only obedience is affordable.",
        lines: [
          {
            id: "FC.E10.PRE.01",
            speaker: "OB_NIXILIS",
            text: "The nightmare was gentle. It allowed you to wake up.",
            fx: "shake",
          },
          {
            id: "FC.E10.PRE.02",
            speaker: "PLAYER",
            text: "You would rule what is left of these people?",
          },
          {
            id: "FC.E10.PRE.03",
            speaker: "OB_NIXILIS",
            text: "I have ruled less.",
          },
          {
            id: "FC.E10.PRE.04",
            speaker: "KAYA",
            text: "He promised every one of you a throne.",
          },
          {
            id: "FC.E10.PRE.05",
            speaker: "OB_NIXILIS",
            text: "Then the last war will be among us. I intend to survive it.",
          },
        ],
      },
      story:
        "The apparent coalition is a future civil war. The Sphinx intends to prevent even that by binding the conspirators before opening the Engine to living worlds.",
      counterplay:
        "Protect the resource that supports the next turn. Diversify threats and keep graveyard recovery or card advantage available after the first wipe.",
      design:
        "Red banners, black basalt, distant footsteps without crowds. Broken knees on empty armor rise after victory; no graphic civilian executions.",
      post: {
        id: "FC.E10.POST",
        scenery: "amphitheater",
        lines: [
          {
            id: "FC.E10.POST.01",
            speaker: "OB_NIXILIS",
            text: "Finish it, then.",
          },
          {
            id: "FC.E10.POST.02",
            speaker: "PLAYER",
            text: "Your command is broken. That is what we came for.",
          },
          {
            id: "FC.E10.POST.03",
            speaker: "OB_NIXILIS",
            text: "Mercy. An expensive habit.",
          },
          {
            id: "FC.E10.POST.04",
            speaker: "KAYA",
            text: "He wanted us to spend our strength on him. The command chain points higher.",
          },
          {
            id: "FC.E10.POST.05",
            speaker: "DIHADA",
            text: "At last. Someone who knows the difference between a weapon and its owner.",
            fx: "chains",
          },
        ],
      },
      loss: {
        id: "FC.E10.LOSS",
        scenery: "amphitheater",
        lines: [
          {
            id: "FC.E10.LOSS.01",
            speaker: "OB_NIXILIS",
            text: "You may keep your courage. I have no use for it now.",
          },
        ],
      },
      barks: [
        {
          id: "FC.E10.BARK.01",
          speaker: "OB_NIXILIS",
          text: "Every defense has a price. Keep paying.",
          trigger: "FIRST_BOSS_SACRIFICE_OR_DRAIN",
        },
        {
          id: "FC.E10.BARK.02",
          speaker: "OB_NIXILIS",
          text: "Better. Conquest should require an effort.",
          trigger: "PLAYER_REBUILDS_AFTER_WIPE",
        },
      ],
    },
    "11": {
      number: 11,
      title: "The Gallery of Bound Champions",
      pre: {
        id: "FC.E11.PRE",
        scenery: "gallery",
        caption: {
          kicker: "Encounter 11",
          title: "The Gallery of Bound Champions",
          sub: "Platinum | The dominion gallery | Seal 11 Will",
        },
        intro:
          "Portraits of legendary champions hang from chains. Some turn their heads as you pass. Dihada designed the incarnation contracts and expects to own the Sphinx once his ascension requires a physical vessel. She has already written a second contract for your commander.",
        lines: [
          {
            id: "FC.E11.PRE.01",
            speaker: "DIHADA",
            text: "Such devotion. Your commander comes when you call, even after death.",
            fx: "chains",
          },
          {
            id: "FC.E11.PRE.02",
            speaker: "PLAYER",
            text: "That does not make them mine.",
          },
          {
            id: "FC.E11.PRE.03",
            speaker: "DIHADA",
            text: "You lack ambition. Fortunately, that can be corrected.",
          },
          {
            id: "FC.E11.PRE.04",
            speaker: "KAYA",
            text: "Every champion you touch becomes a prisoner.",
          },
          {
            id: "FC.E11.PRE.05",
            speaker: "DIHADA",
            text: "And every prisoner becomes useful. Let us discuss what you could be.",
          },
        ],
      },
      story:
        "Ownership of the ward seals passes to their victor. A final witness can authenticate a countermand, but Bolas controls access to her.",
      counterplay:
        "Exile key recursion pieces, remove a sacrifice outlet at the correct time, and check ownership before choosing how to recover a stolen commander.",
      design:
        "Platinum chains reflected in black marble. Portraits are character illustrations, not new battle models. Chains detach from the seals rather than from victims' bodies.",
      post: {
        id: "FC.E11.POST",
        scenery: "gallery",
        lines: [
          {
            id: "FC.E11.POST.01",
            speaker: "DIHADA",
            text: "The pact transfers on defeat. He insisted on that provision.",
            fx: "chains",
          },
          {
            id: "FC.E11.POST.02",
            speaker: "KAYA",
            text: "Then the seals can be transferred again.",
          },
          {
            id: "FC.E11.POST.03",
            speaker: "DIHADA",
            text: "If you reach the last witness. If she is allowed to speak.",
          },
          {
            id: "FC.E11.POST.04",
            speaker: "PLAYER",
            text: "Who holds her?",
          },
          {
            id: "FC.E11.POST.05",
            speaker: "DIHADA",
            text: "Bolas. A dragon who mistakes being indispensable for being free.",
          },
        ],
      },
      loss: {
        id: "FC.E11.LOSS",
        scenery: "gallery",
        lines: [
          {
            id: "FC.E11.LOSS.01",
            speaker: "DIHADA",
            text: "You will learn to call this opportunity.",
          },
        ],
      },
      barks: [
        {
          id: "FC.E11.BARK.01",
          speaker: "DIHADA",
          text: "A signature can be made with another hand.",
          trigger: "FIRST_BOSS_THEFT",
        },
        {
          id: "FC.E11.BARK.02",
          speaker: "PLAYER",
          text: "You can borrow the weapon. You cannot keep the bond.",
          trigger: "PLAYER_REGAINS_CONTROL_OR_REMOVES_THEFT_SOURCE",
        },
      ],
    },
    "12": {
      number: 12,
      title: "The Throne Behind the Throne",
      pre: {
        id: "FC.E12.PRE",
        scenery: "citadel",
        caption: {
          kicker: "Encounter 12",
          title: "The Throne Behind the Throne",
          sub: "Platinum | The counterfeit citadel | Seal 12 Ascension",
        },
        intro:
          "Bolas waits beneath a sky built to resemble his triumph. He contributed an ascension design and assumes the Archive is an instrument he can seize when its lesser collaborators have finished. His incarnation has genuine will and overwhelming pride; knowing he was copied has only sharpened his demand to rule.",
        lines: [
          {
            id: "FC.E12.PRE.01",
            speaker: "BOLAS",
            text: "You have been useful. The Sphinx lacks the manners to tell you.",
            fx: "flash",
          },
          {
            id: "FC.E12.PRE.02",
            speaker: "PLAYER",
            text: "Another employer offering me a throne?",
          },
          {
            id: "FC.E12.PRE.03",
            speaker: "BOLAS",
            text: "I am offering you the chance to survive the change of ownership.",
          },
          {
            id: "FC.E12.PRE.04",
            speaker: "KAYA",
            text: "The contract names you as an asset.",
          },
          {
            id: "FC.E12.PRE.05",
            speaker: "BOLAS",
            text: "A clerk's word. I have outlived languages that tried to contain me.",
          },
        ],
      },
      story:
        "The Sphinx controls the machinery sustaining the incarnations. His advantage is the Archive itself, not a power beyond every version of Bolas.",
      counterplay:
        "Identify the actual win attempt, protect graveyard interaction, and keep an answer for the second line.",
      design:
        "A counterfeit Amonkhet-inspired throne, visibly constructed inside the Archive. Bolas remains defiant; no kneeling or comic defeat.",
      post: {
        id: "FC.E12.POST",
        scenery: "citadel",
        lines: [
          {
            id: "FC.E12.POST.01",
            speaker: "BOLAS",
            text: "Sphinx. Show yourself.",
          },
          {
            id: "FC.E12.POST.02",
            speaker: "SPHINX",
            text: "Your contribution has been accepted. Your authority has expired.",
            fx: "voice",
          },
          {
            id: "FC.E12.POST.03",
            speaker: "BOLAS",
            text: "You think this record is all that I am?",
          },
          {
            id: "FC.E12.POST.04",
            speaker: "SPHINX",
            text: "It is all of you that is here.",
            fx: "sever",
          },
          {
            id: "FC.E12.POST.05",
            speaker: "KAYA",
            text: "He is severing the incarnation. Take the seal before the throne collapses.",
          },
          {
            id: "FC.E12.POST.06",
            speaker: "LILIANA",
            text: "Leave the dragon to his pride. I am the door you still have to open.",
            fx: "flash",
          },
        ],
      },
      loss: {
        id: "FC.E12.LOSS",
        scenery: "citadel",
        lines: [
          {
            id: "FC.E12.LOSS.01",
            speaker: "BOLAS",
            text: "Remember the moment when you could have accepted.",
          },
        ],
      },
      barks: [
        {
          id: "FC.E12.BARK.01",
          speaker: "BOLAS",
          text: "You mistake permission to act for the ability to matter.",
          trigger: "FIRST_BOSS_PROTECTED_COMBO_ATTEMPT",
        },
        {
          id: "FC.E12.BARK.02",
          speaker: "BOLAS",
          text: "There you are. I wondered when you would begin.",
          trigger: "PLAYER_STOPS_FIRST_COMBO",
        },
      ],
    },
    "13": {
      number: 13,
      title: "The Last Testament",
      pre: {
        id: "FC.E13.PRE",
        scenery: "names",
        caption: {
          kicker: "Encounter 13",
          title: "The Last Testament",
          sub: "Mythic | The chamber of living names | Seal 13 Witness",
        },
        intro:
          "Names burn across Liliana's skin and the chamber walls. She joined the conspiracy to secure a body and a freedom no demon could revoke. Dihada's contract made her the final witness and collateralized the prisoners. Direct refusal would destroy the names entrusted to her. She must defend the seal with her full strength, but a legitimate defeat permits it to pass to the victor.",
        lines: [
          {
            id: "FC.E13.PRE.01",
            speaker: "LILIANA",
            text: "I know what you have been told. Some of it is even true.",
          },
          {
            id: "FC.E13.PRE.02",
            speaker: "PLAYER",
            text: "You helped build this.",
          },
          {
            id: "FC.E13.PRE.03",
            speaker: "LILIANA",
            text: "I wanted a future that belonged to me. I should have noticed who was writing it.",
          },
          {
            id: "FC.E13.PRE.04",
            speaker: "KAYA",
            text: "Give us the witness seal.",
          },
          {
            id: "FC.E13.PRE.05",
            speaker: "LILIANA",
            text: "I cannot surrender it. The names burn if I do. You will have to take it, and I am required to try to kill you.",
            fx: "burn",
          },
          {
            id: "FC.E13.PRE.06",
            speaker: "PLAYER",
            text: "Then try. When this is over, you are going to help us free them.",
          },
        ],
        phase: "burning",
      },
      story:
        "You hold the power to revoke the Engine, and you know why the Sphinx's physical arrival matters. Liliana aids the final breach, though she will not walk at your side.",
      counterplay:
        "Separate graveyard recursion from activated sacrifice outlets. Hold interaction for the enabling action and be prepared to stop a second attempt.",
      design:
        "Violet script on black glass; each name dims safely rather than burning away after victory. Voice shifts from controlled hostility to exhausted precision.",
      post: {
        id: "FC.E13.POST",
        scenery: "names",
        lines: [
          {
            id: "FC.E13.POST.01",
            speaker: "LILIANA",
            text: "The seal recognizes the victor. The names are still here.",
            fx: "names-dim",
            phase: "dim",
          },
          {
            id: "FC.E13.POST.02",
            speaker: "KAYA",
            text: "Tell us how to stop him.",
          },
          {
            id: "FC.E13.POST.03",
            speaker: "LILIANA",
            text: "Thirteen seals can revoke the Concordance once its author answers your challenge. Wound his projection, and he will cross into the duel to protect the bond himself.",
          },
          {
            id: "FC.E13.POST.04",
            speaker: "PLAYER",
            text: "And then?",
          },
          {
            id: "FC.E13.POST.05",
            speaker: "LILIANA",
            text: "Keep fighting. His body can fall and return. His claim ends only when the duel is yours.",
          },
          {
            id: "FC.E13.POST.06",
            speaker: "HIGH_PRIEST",
            text: "The last witness has spoken. The throne awaits its challenger.",
            fx: "voice",
          },
        ],
        phase: "burning",
      },
      loss: {
        id: "FC.E13.LOSS",
        scenery: "names",
        lines: [
          {
            id: "FC.E13.LOSS.01",
            speaker: "LILIANA",
            text: "Get up. I did not say this was your last chance.",
          },
        ],
      },
      barks: [
        {
          id: "FC.E13.BARK.01",
          speaker: "LILIANA",
          text: "I said you would have to earn it.",
          trigger: "FIRST_BOSS_REANIMATION",
        },
        {
          id: "FC.E13.BARK.02",
          speaker: "LILIANA",
          text: "Do not hesitate now. He is listening for weakness.",
          trigger: "BOSS_LIFE_AT_OR_BELOW_10",
        },
      ],
    },
    "14": {
      number: 14,
      title: "The Throne of All Colors",
      pre: {
        id: "FC.E14.PRE",
        scenery: "throne",
        caption: {
          kicker: "The final duel",
          title: "The Throne of All Colors",
          sub: "Godlike | The central chamber | Final authorship",
        },
        intro:
          "The last door opens onto a chamber whose walls show the worlds you have saved. The freed communities remain visible; their recovery gives the fight stakes beyond the throne. The High Priest stands at the lower steps. The Sphinx rests above the battlefield, watching rather than fighting. He has always been the author of the arena, and for now he considers entering it beneath him.",
        lines: [
          {
            id: "FC.E14.PRE.01",
            speaker: "HIGH_PRIEST",
            text: "Thirteen seals. Thirteen victories. You have carried the argument farther than any who came before.",
          },
          {
            id: "FC.E14.PRE.02",
            speaker: "PLAYER",
            text: "I carried them here to revoke it.",
          },
          {
            id: "FC.E14.PRE.03",
            speaker: "SPHINX",
            text: "You have seen what ungoverned power produces. The cruel, the hungry, the frightened. I offered each a purpose.",
            fx: "reveal",
          },
          {
            id: "FC.E14.PRE.04",
            speaker: "KAYA",
            text: "You offered them a promise you intended to break.",
          },
          {
            id: "FC.E14.PRE.05",
            speaker: "SPHINX",
            text: "I intended to end the need for promises. No world would again depend on the mercy of its strongest inhabitant.",
          },
          {
            id: "FC.E14.PRE.06",
            speaker: "PLAYER",
            text: "Except yours.",
          },
          {
            id: "FC.E14.PRE.07",
            speaker: "SPHINX",
            text: "Mine would be sufficient.",
          },
          {
            id: "FC.E14.PRE.08",
            speaker: "LILIANA",
            text: "The seals are witnessed. The challenge is valid.",
          },
          {
            id: "FC.E14.PRE.09",
            speaker: "HIGH_PRIEST",
            text: "Then the final authority will answer.",
          },
          {
            id: "FC.E14.PRE.10",
            speaker: "SPHINX",
            text: "Call your commander, Wayfarer. Show me the freedom for which you would endanger every world.",
            fx: "shake",
          },
        ],
        phase: "intact",
      },
      story: "",
      counterplay: "",
      design: "",
    },
    "15": {
      number: 15,
      title: "The Unbound Court",
      bossSeat: 4,
      pre: {
        id: "FC.E15.PRE",
        scenery: "throne",
        phase: "fractured",
        caption: {
          kicker: "The court",
          title: "The Unbound Court",
          sub: "Godlike | The Archive's last court | Sovereignty",
        },
        intro:
          "Behind the throne the Archive keeps one room it never showed you: a round court of six seats under a cracked dome. The Sphinx takes the King's seat, his incarnation already standing beside it. Nicol Bolas sits at his right hand and Liliana at his left, each holding a deck still warm from his gift. Across the floor a King's seat waits for you, and two seats beside it for whoever answers your call.",
        lines: [
          {
            id: "FC.E15.PRE.01",
            speaker: "SPHINX",
            text: "A throne can be revoked. A court cannot. Here every seat answers to its King.",
            fx: "reveal",
          },
          {
            id: "FC.E15.PRE.02",
            speaker: "BOLAS",
            text: "He paid in advance, Wayfarer. I always honour a contract that pays in advance.",
          },
          {
            id: "FC.E15.PRE.03",
            speaker: "LILIANA",
            text: "My name is still on his page. Until it burns, I fight where he points.",
            fx: "chains",
          },
          {
            id: "FC.E15.PRE.04",
            speaker: "KAYA",
            text: "Three of them, and two seats at your side. Fill them with friends, or let the Archive lend you hands.",
          },
          {
            id: "FC.E15.PRE.05",
            speaker: "PLAYER",
            text: "Then I sit as King, and the court ends with him.",
          },
          {
            id: "FC.E15.PRE.06",
            speaker: "SPHINX",
            text: "Kings do not strike one another here. You will have to cut through my Generals first. Begin.",
            fx: "shake",
          },
        ],
      },
      loss: {
        id: "FC.E15.LOSS",
        scenery: "throne",
        phase: "intact",
        lines: [
          {
            id: "FC.E15.LOSS.01",
            speaker: "SPHINX",
            text: "A court is not won by one victory. Go back to the throne, and earn the door again.",
          },
          {
            id: "FC.E15.LOSS.02",
            speaker: "KAYA",
            text: "The tether pulled you clear, back to the throne room. He has taken his seat there again.",
          },
          {
            id: "FC.E15.LOSS.03",
            speaker: "NARRATOR",
            text: "The court closes behind you. The throne's ward seals itself, and The Sphinx waits on it once more.",
          },
        ],
      },
      barks: [
        {
          id: "FC.E15.BARK.01",
          speaker: "BOLAS",
          text: "Your Generals are brave. I collect brave things.",
          trigger: "FIRST_PLAYER_CREATURE",
        },
        {
          id: "FC.E15.BARK.02",
          speaker: "SPHINX",
          text: "That possibility is closed.",
          trigger: "BOSS_COUNTERS_A_SPELL",
        },
        {
          id: "FC.E15.BARK.03",
          speaker: "LILIANA",
          text: "He kept a deck that would not stay buried. So did I.",
          trigger: "FIRST_BOSS_REANIMATION",
        },
        {
          id: "FC.E15.BARK.04",
          speaker: "BOLAS",
          text: "An army, and he still sends me to do the work.",
          trigger: "BOSS_ARMY",
        },
        {
          id: "FC.E15.BARK.05",
          speaker: "LILIANA",
          text: "Your King is bleeding, Sphinx. Do you still want me facing the wrong way?",
          trigger: "BOSS_LIFE_AT_OR_BELOW_10",
        },
        {
          id: "FC.E15.BARK.06",
          speaker: "SPHINX",
          text: "I offered them an end to fear. I offer it to you, one last time.",
          trigger: "BOSS_LIFE_AT_OR_BELOW_5",
        },
        {
          id: "FC.E15.BARK.07",
          speaker: "KAYA",
          text: "He has enough loyalty to end this. Watch the next activation.",
          trigger: "INCARNATION_LOYALTY_AT_LEAST_10",
        },
      ],
      story:
        "The Sphinx kept a court behind his throne, and bound Liliana and Nicol Bolas to it by the names they signed. Beating it breaks the last claim: the court's seats empty, and the gifted decks are yours with his.",
      counterplay:
        "Kings cannot attack here, so the court falls General by General: break Nicol Bolas or Liliana first and the path to The Sphinx opens. His incarnation returns at each of his upkeeps, so spend removal on it only when it threatens to end the game, and keep your Generals alive: a General out leaves your King open.",
      design:
        "A King's Table game (v0.9.6): the player is King A, with friends or bots as Generals; team B is The Sphinx as King and the two Generals he recalled, every one at the highest skill.",
    },
  },
  finale: {
    phase1: [
      {
        id: "FC.E14.PHASE1.01",
        speaker: "SPHINX",
        text: "Your commander returns because the bond remembers. I can give every life such certainty.",
      },
      {
        id: "FC.E14.PHASE1.02",
        speaker: "PLAYER",
        text: "You would decide what they are allowed to remember.",
      },
      {
        id: "FC.E14.PHASE1.03",
        speaker: "SPHINX",
        text: "I would remove what makes them suffer.",
      },
      {
        id: "FC.E14.PHASE1.04",
        speaker: "KAYA",
        text: "He means the part that can refuse.",
      },
    ],
    arrival: [
      {
        id: "FC.E14.ARRIVAL.01",
        speaker: "SPHINX",
        text: "Enough.",
        fx: "fracture",
      },
      {
        id: "FC.E14.ARRIVAL.02",
        speaker: "HIGH_PRIEST",
        text: "My lord, the chamber was built to contain the contest.",
      },
      {
        id: "FC.E14.ARRIVAL.03",
        speaker: "SPHINX",
        text: "Then the chamber will learn what it contains.",
      },
      {
        id: "FC.E14.ARRIVAL.04",
        speaker: "KAYA",
        text: "He is crossing. Keep your eyes on the battlefield.",
      },
      {
        id: "FC.E14.ARRIVAL.05",
        speaker: "SPHINX",
        text: "You have disputed my servants, my instruments, my law. Now dispute me.",
        fx: "shake",
      },
      {
        id: "FC.E14.ARRIVAL.06",
        speaker: "PLAYER",
        text: "That was what I came to do.",
      },
    ],
    removed: [
      {
        id: "FC.E14.REMOVED.01",
        speaker: "SPHINX",
        text: "You have broken a vessel.",
      },
      {
        id: "FC.E14.REMOVED.02",
        speaker: "KAYA",
        text: "His body is gone. His life is not. Keep the pressure on.",
      },
      {
        id: "FC.E14.REMOVED.03",
        speaker: "LILIANA",
        text: "He can return. Make him pay for every step.",
      },
    ],
    recast: [
      {
        id: "FC.E14.RECAST.01",
        speaker: "SPHINX",
        text: "I did not yield the floor.",
      },
      {
        id: "FC.E14.RECAST.02",
        speaker: "PLAYER",
        text: "Then I will take it again.",
      },
    ],
    countered: {
      id: "FC.E14.COUNTERED.01",
      speaker: "SPHINX",
      text: "Even refusal will be accounted for.",
    },
    escalation: [
      {
        id: "FC.E14.BARK.01",
        speaker: "SPHINX",
        text: "There is an answer. I have kept it.",
        trigger: "BOSS_TUTOR_FROM_INCARNATION",
      },
      {
        id: "FC.E14.BARK.02",
        speaker: "SPHINX",
        text: "That possibility is closed.",
        trigger: "BOSS_COUNTERS_A_SPELL",
      },
      {
        id: "FC.E14.BARK.03",
        speaker: "HIGH_PRIEST",
        text: "Another veil falls. The bond remains.",
        trigger: "BOSS_COMMANDER_REGENERATES",
      },
      {
        id: "FC.E14.BARK.04",
        speaker: "HIGH_PRIEST",
        text: "The throne does not stand alone.",
        trigger: "BOSS_ARMY",
      },
      {
        id: "FC.E14.BARK.05",
        speaker: "KAYA",
        text: "He has enough loyalty to end this. Watch the next activation.",
        trigger: "INCARNATION_LOYALTY_AT_LEAST_10",
      },
      {
        id: "FC.E14.BARK.06",
        speaker: "SPHINX",
        text: "You were not meant to find that.",
        trigger: "PLAYER_STOPS_FIRST_COMBO",
      },
      {
        id: "FC.E14.BARK.07",
        speaker: "SPHINX",
        text: "I offered them an end to fear.",
        trigger: "BOSS_LIFE_AT_OR_BELOW_5",
      },
    ],
    loss: {
      id: "FC.E14.LOSS",
      scenery: "throne",
      phase: "intact",
      lines: [
        {
          id: "FC.E14.LOSS.01",
          speaker: "SPHINX",
          text: "Rest. The burden of choice is over.",
        },
        {
          id: "FC.E14.LOSS.02",
          speaker: "KAYA",
          text: "The tether is still open. This ending does not have to stand.",
        },
        {
          id: "FC.E14.LOSS.03",
          speaker: "NARRATOR",
          text: "The refuge catches you before the gold closes. The seals remain in your hands.",
        },
      ],
    },
    arrivalTip:
      "The Sphinx is now a planeswalker on the battlefield. Removing this form buys time. Win the duel to end his claim.",
  },
  endings: {
    win: {
      id: "FC.END.WIN",
      scenery: "throne",
      phase: "fractured",
      caption: {
        kicker: "The Final Concordance",
        title: "The Claim Ends",
      },
      lines: [
        {
          id: "FC.END.WIN.01",
          speaker: "SPHINX",
          text: "Without my order, they will hurt one another again.",
          fx: "fracture",
        },
        {
          id: "FC.END.WIN.02",
          speaker: "PLAYER",
          text: "Some will. You never had the right to make that choice for all of them.",
        },
        {
          id: "FC.END.WIN.03",
          speaker: "HIGH_PRIEST",
          text: "The seals have no master.",
          fx: "staff-dims",
        },
        {
          id: "FC.END.WIN.04",
          speaker: "LILIANA",
          text: "They have a victor. That is enough to end a claim.",
        },
        {
          id: "FC.END.WIN.05",
          speaker: "KAYA",
          text: "The names are free. Tell the Engine where to send them.",
        },
        {
          id: "FC.END.WIN.06",
          speaker: "PLAYER",
          text: "Home. And release every incarnation that chooses to leave.",
        },
        {
          id: "FC.END.WIN.07",
          speaker: "SPHINX",
          text: "You would surrender this power?",
        },
        {
          id: "FC.END.WIN.08",
          speaker: "PLAYER",
          text: "Yes.",
        },
        {
          id: "FC.END.WIN.09",
          speaker: "NARRATOR",
          text: "Across the connected worlds, small lights return. A healer's charm warms in her hand. A shadow catches up with the child who casts it.",
          fx: "lights-return",
          scenery: "dawn",
        },
        {
          id: "FC.END.WIN.10",
          speaker: "KAYA",
          text: "The refuge can hold the incarnations who stay. They will have to decide what to become.",
          scenery: "refuge",
        },
        {
          id: "FC.END.WIN.11",
          speaker: "LILIANA",
          text: "A decision without a contract. I had almost forgotten the feeling.",
        },
        {
          id: "FC.END.WIN.12",
          speaker: "PLAYER",
          text: "Keep the doors open.",
        },
      ],
      outro:
        "The throne remains empty. Its light is gone. One blank page survives in the Archive, and you write no name on it. In the refuge, freed incarnations argue, laugh, and choose different doors.",
    },
    early: {
      id: "FC.END.EARLY",
      scenery: "throne",
      phase: "intact",
      caption: {
        kicker: "The Final Concordance",
        title: "The Bond Breaks",
      },
      lines: [
        {
          id: "FC.END.EARLY.01",
          speaker: "SPHINX",
          text: "The bond has broken before I could cross.",
          fx: "fracture",
          phase: "fractured",
        },
        {
          id: "FC.END.EARLY.02",
          speaker: "KAYA",
          text: "He cannot hold the connection. Use the seals now.",
        },
        {
          id: "FC.END.EARLY.03",
          speaker: "PLAYER",
          text: "The Concordance is revoked.",
        },
        {
          id: "FC.END.WIN.09",
          speaker: "NARRATOR",
          text: "Across the connected worlds, small lights return. A healer's charm warms in her hand. A shadow catches up with the child who casts it.",
          fx: "lights-return",
          scenery: "dawn",
        },
        {
          id: "FC.END.WIN.10",
          speaker: "KAYA",
          text: "The refuge can hold the incarnations who stay. They will have to decide what to become.",
          scenery: "refuge",
        },
        {
          id: "FC.END.WIN.11",
          speaker: "LILIANA",
          text: "A decision without a contract. I had almost forgotten the feeling.",
        },
        {
          id: "FC.END.WIN.12",
          speaker: "PLAYER",
          text: "Keep the doors open.",
        },
      ],
      outro:
        "The throne remains empty. Its light is gone. One blank page survives in the Archive, and you write no name on it. In the refuge, freed incarnations argue, laugh, and choose different doors.",
    },
  },
  flight: {
    id: "FC.E14.FLIGHT",
    scenery: "throne",
    phase: "fractured",
    lines: [
      {
        id: "FC.E14.FLIGHT.01",
        speaker: "SPHINX",
        text: "No. Not to a Wayfarer. Not in my own chamber.",
        fx: "shake",
      },
      {
        id: "FC.E14.FLIGHT.02",
        speaker: "HIGH_PRIEST",
        text: "My lord, the seals have spoken. The claim is broken.",
      },
      {
        id: "FC.E14.FLIGHT.03",
        speaker: "SPHINX",
        text: "The seals bind wardens. I was never a warden.",
        fx: "fracture",
      },
      {
        id: "FC.E14.FLIGHT.04",
        speaker: "SPHINX",
        text: "Liliana. Nicol Bolas. By the names you signed, attend me.",
        fx: "chains",
      },
      {
        id: "FC.E14.FLIGHT.05",
        speaker: "LILIANA",
        text: "He invokes the contract. I cannot refuse a summons written in my own name.",
      },
      {
        id: "FC.E14.FLIGHT.06",
        speaker: "BOLAS",
        text: "Spare me the pageant. If he pays, I play.",
      },
      {
        id: "FC.E14.FLIGHT.07",
        speaker: "KAYA",
        text: "He's running, and he's taking them with him!",
      },
      {
        id: "FC.E14.FLIGHT.08",
        speaker: "SPHINX",
        text: "Follow, if you dare. My court is older than this throne.",
        fx: "flash",
      },
      {
        id: "FC.E14.FLIGHT.09",
        speaker: "NARRATOR",
        text: "The throne stands empty. A gold seam tears the chamber open behind it, and the tether pulls you through after him.",
        fx: "gold-thread",
      },
    ],
    outro:
      "Ward 14's seal stays unclaimed: the throne was fled, not surrendered. Its spoils wait with the court's.",
  },
  court: {
    arrival: [
      {
        id: "FC.E15.ARRIVAL.01",
        speaker: "SPHINX",
        text: "I did not come here to cross. I came here already standing.",
        fx: "fracture",
      },
      {
        id: "FC.E15.ARRIVAL.02",
        speaker: "KAYA",
        text: "His incarnation is on the battlefield from the start. It will keep coming back.",
      },
    ],
    removed: [
      {
        id: "FC.E15.REMOVED.01",
        speaker: "SPHINX",
        text: "You have broken a vessel. The court keeps another.",
      },
      {
        id: "FC.E15.REMOVED.02",
        speaker: "KAYA",
        text: "It returns at his next upkeep. Use the time.",
      },
    ],
    returned: [
      {
        id: "FC.E15.RETURNED.01",
        speaker: "SPHINX",
        text: "I did not yield the floor.",
      },
    ],
    post: {
      id: "FC.E15.POST",
      scenery: "throne",
      phase: "fractured",
      caption: {
        kicker: "The court",
        title: "The Last Seat Empties",
      },
      lines: [
        {
          id: "FC.E15.POST.01",
          speaker: "BOLAS",
          text: "Keep the deck. I have no use for a gift that lost.",
        },
        {
          id: "FC.E15.POST.02",
          speaker: "LILIANA",
          text: "The page burns. My name is my own again.",
          fx: "burn",
        },
        {
          id: "FC.E15.POST.03",
          speaker: "SPHINX",
          text: "Then I have no court, and no one left to rule.",
          fx: "fracture",
        },
        {
          id: "FC.E15.POST.04",
          speaker: "KAYA",
          text: "Both seals are yours, the throne's and the court's. Finish it.",
        },
      ],
    },
    arrivalTip:
      "The Sphinx's incarnation starts on the battlefield. Destroyed, it returns at the beginning of his next upkeep, every time. Kings cannot attack: beat his Generals to reach him.",
  },
  tutorial: [
    {
      id: "T01",
      when: "Board loaded; life and command zone",
      text: "This is a Commander duel. Your commander begins in the command zone. Win the game by defeating your opponent; removing their commander alone is not enough.",
    },
    {
      id: "T02",
      when: "Opening hand visible; hand controls",
      text: "Look for lands and spells you can cast early. You can keep this hand or use the mulligan controls. The training hand already gives you a useful start.",
    },
    {
      id: "T03",
      when: "Own main phase; legal land available",
      text: "Play a land from your hand. You normally get one land play each turn. Lands supply the mana used to cast spells.",
    },
    {
      id: "T04",
      when: "First affordable spell selected; cost preview",
      text: "Match the spell's colored symbols with the mana you can produce. A numbered cost can be paid with any type of mana. Review the payment before confirming.",
    },
    {
      id: "T05",
      when: "Commander legally castable; command zone",
      text: "You can cast your commander from here. Its abilities help define your deck's plan. Select it to inspect the cost and available actions.",
    },
    {
      id: "T06",
      when: "First new creature enters; creature card",
      text: "A creature usually cannot attack or use its own tap-symbol abilities until you have controlled it since your turn began. Haste is an exception.",
    },
    {
      id: "T07",
      when: "First declare attackers step; legal attackers",
      text: "Choose which ready creatures will attack. Keeping one back can give you a blocker for the opponent's next turn.",
    },
    {
      id: "T08",
      when: "First opposing attack with a legal blocker",
      text: "Untapped creatures can usually block. Compare power and toughness before assigning a blocker. You may also choose to take the damage.",
    },
    {
      id: "T09",
      when: "First relevant priority window; stack panel",
      text: "This spell is waiting to resolve. If you have a legal instant or ability, you can respond now. Passing is also a valid choice.",
    },
    {
      id: "T10",
      when: "Commander can return to command zone",
      text: "You can choose to return your commander to the command zone when the rules allow it. Later casts from there cost two extra mana for each previous cast from that zone.",
    },
    {
      id: "T11",
      when: "Opponent low on life or lethal attack available",
      text: "Review your attack and the opponent's possible blocks. Life reaching zero is one way to win. Some cards and Commander rules provide other ways.",
    },
    {
      id: "T12",
      when: "Victory result committed; results controls",
      text: "You broke the first ward. Your progress is saved. Review your deck, replay the lesson, or continue to the foundry.",
    },
  ],
};
