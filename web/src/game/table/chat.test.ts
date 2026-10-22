import { describe, expect, it } from "vitest";
import type { ChatLine, PresenceSeat } from "../types";
import {
  allianceActions,
  allianceSeats,
  alliesOf,
  eventText,
  lineText,
  listed,
  ownLine,
  standing,
  type ChatPeople,
} from "./chat";
import type { SummarySeat } from "./types";

const handles = ["ada", "bob", "cara", "dan"];
const people = (seat: number | null, userId: string | null = null) =>
  ({
    seat,
    userId,
    handle: (s: number) => handles[s] ?? `Seat ${s + 1}`,
  }) satisfies ChatPeople;

function line(fields: Partial<ChatLine>): ChatLine {
  return {
    id: "l1",
    channel: "table",
    kind: "text",
    seat: 1,
    sender: { id: "u-bob", handle: "bob" },
    body: "Hello there",
    seats: [],
    client_id: null,
    created_at: "2026-10-22T10:00:00+00:00",
    ...fields,
  };
}

describe("the table's chat in words", () => {
  it("says who wrote a line, to whom an allies-only one went, and marks SysOp watching", () => {
    expect(lineText(line({}), people(0))).toBe("bob: Hello there");
    expect(
      lineText(line({ channel: "allies", seats: [0, 2] }), people(0)),
    ).toBe("bob to you and cara: Hello there");
    expect(
      lineText(
        line({ seat: null, sender: { id: "u-sys", handle: "sphinx" } }),
        people(0),
      ),
    ).toBe("sphinx (watching): Hello there");
    // Your own lines are yours, from any of your tabs.
    expect(lineText(line({ seat: 0 }), people(0))).toBe("You: Hello there");
    expect(
      lineText(line({ kind: "emote", body: "good_game" }), people(0)),
    ).toBe("bob: Good game!");
    expect(listed(["a", "b", "c"])).toBe("a, b and c");
  });

  it("knows SysOp's own lines while watching by its account", () => {
    const sysop = people(null, "u-sys");
    const watching = line({
      seat: null,
      sender: { id: "u-sys", handle: "sphinx" },
    });
    expect(ownLine(watching, sysop)).toBe(true);
    expect(ownLine(line({}), sysop)).toBe(false);
    // An alliance ended by a player leaving has no sender, and is nobody's own.
    expect(
      ownLine(
        line({ kind: "event", seat: null, sender: null, seats: [1, 2] }),
        sysop,
      ),
    ).toBe(false);
  });

  it("says an alliance's start and end as sentences", () => {
    const event = (fields: Partial<ChatLine>) =>
      line({ kind: "event", body: "allied", seats: [0, 1], ...fields });
    expect(eventText(event({ seats: [2, 3], seat: 3 }), people(0))).toBe(
      "cara and dan are now allies.",
    );
    // Your seat comes first, whoever accepted.
    expect(eventText(event({ seats: [1, 0], seat: 0 }), people(0))).toBe(
      "You and bob are now allies.",
    );
    const ended = (fields: Partial<ChatLine>) =>
      event({ body: "alliance_ended", ...fields });
    expect(eventText(ended({ seat: 0, seats: [0, 1] }), people(2))).toBe(
      "ada ended the alliance with bob.",
    );
    expect(eventText(ended({ seat: 1, seats: [1, 0] }), people(0))).toBe(
      "bob ended the alliance with you.",
    );
    expect(
      eventText(ended({ seat: null, sender: null, seats: [0, 1] }), people(2)),
    ).toBe("The alliance between ada and bob ended.");
    expect(eventText(event({ body: "something_new" }), people(0))).toBeNull();
  });
});

describe("alliances", () => {
  const alliances = {
    alliances: [[0, 1]] as [number, number][],
    offers: [
      { from: 0, to: 2 },
      { from: 3, to: 0 },
    ],
  };

  it("give each seat's standing with the viewer, and its actions", () => {
    expect(standing(alliances, 0, 1)).toBe("allied");
    expect(standing(alliances, 0, 2)).toBe("offered");
    expect(standing(alliances, 0, 3)).toBe("offering");
    expect(standing(alliances, 1, 2)).toBe("none");
    expect(standing(alliances, null, 1)).toBe("none");
    expect(alliesOf(alliances, 1)).toEqual([0]);
    expect(
      (["allied", "offered", "offering", "none"] as const).map(allianceActions),
    ).toEqual([["end"], ["withdraw"], ["accept", "decline"], ["offer"]]);
  });

  it("are made only with other human players still in the game, by a player still in it", () => {
    const seat = (n: number, player: "human" | "bot" = "human") =>
      ({ seat: n, player, handle: handles[n], deck: null }) as SummarySeat;
    const seats = [seat(0), seat(1), seat(2, "bot"), seat(3)];
    const presence = (left: PresenceSeat["left"]) =>
      [{ seat: 3, left }] as PresenceSeat[];
    const base = {
      mine: 0,
      seats,
      presence: null,
      lost: new Set<number>(),
      finished: false,
    };
    expect([...allianceSeats(base)]).toEqual([1, 3]);
    expect([
      ...allianceSeats({ ...base, presence: presence("conceded") }),
    ]).toEqual([1]);
    expect([...allianceSeats({ ...base, lost: new Set([1]) })]).toEqual([3]);
    // Nobody out of the game, watching or at a finished game makes one.
    expect(allianceSeats({ ...base, lost: new Set([0]) }).size).toBe(0);
    expect(allianceSeats({ ...base, mine: null }).size).toBe(0);
    expect(allianceSeats({ ...base, finished: true }).size).toBe(0);
  });
});
