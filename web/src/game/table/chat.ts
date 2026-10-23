import type {
  AllianceAction,
  Alliances,
  ChatLine,
  EmoteName,
  PresenceSeat,
  Seat,
} from "../types";
import type { SummarySeat } from "./types";

// The table's chat and its alliances in words (v0.4.4, docs/chat.md): who wrote a line and to
// whom, an alliance's start and end as sentences, and which alliance actions a seat has. Every
// line is shown as text; nothing here makes HTML or a link of what a player wrote.

/** The emotes, in the order the panel shows them, with their words. */
export const EMOTES: { name: EmoteName; words: string }[] = [
  { name: "hello", words: "Hello!" },
  { name: "good_luck", words: "Good luck, have fun!" },
  { name: "your_turn", words: "Your turn." },
  { name: "thinking", words: "Thinking…" },
  { name: "nice_play", words: "Nice play!" },
  { name: "thanks", words: "Thanks!" },
  { name: "oops", words: "Oops!" },
  { name: "sorry", words: "Sorry!" },
  { name: "good_game", words: "Good game!" },
];
const EMOTE_WORDS = new Map<string, string>(
  EMOTES.map((emote) => [emote.name, emote.words]),
);

/** A message's limits, as the API checks them: characters, and lines. */
export const CHAT_LENGTH = 500;
export const CHAT_LINES = 13;

export type Channel = ChatLine["channel"];

/** A chat tab's name. At a Two-Headed Giant table (v0.5.1) the allies-only channel is the
 * team's. */
export function channelName(channel: Channel, teams: boolean): string {
  if (channel === "table") return "Table";
  return teams ? "Team" : "Allies";
}

/** Who reads the chat, and how it names the table's players. */
export interface ChatPeople {
  /** The viewer's seat; null for SysOp watching. */
  seat: Seat | null;
  /** The viewer's account: SysOp's own lines while watching have no seat to know them by. */
  userId: string | null;
  /** A seat's player, by handle. */
  handle(seat: Seat): string;
}

/** A line the viewer wrote, from this tab or another. */
export function ownLine(line: ChatLine, people: ChatPeople): boolean {
  if (people.seat !== null) return line.seat === people.seat;
  return (
    line.seat === null &&
    line.sender !== null &&
    people.userId !== null &&
    line.sender.id === people.userId
  );
}

/** A seat as a sentence names it: "you" for the viewer's own. */
function who(seat: Seat, people: ChatPeople, start = false): string {
  if (seat === people.seat) return start ? "You" : "you";
  return people.handle(seat);
}

/** "Bob", "Bob and Cara", "Ada, Bob and Cara". */
export function listed(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Two seats with the viewer's first: "You and Bob". */
function pair(seats: Seat[], people: ChatPeople): [Seat, Seat] | null {
  const [a, b] = seats;
  if (a === undefined || b === undefined) return null;
  return b === people.seat ? [b, a] : [a, b];
}

/** An alliance's start or end, as a sentence; null for an event this page does not know. */
export function eventText(line: ChatLine, people: ChatPeople): string | null {
  const two = pair(line.seats, people);
  if (!two) return null;
  const [first, second] = two;
  if (line.body === "allied")
    return `${who(first, people, true)} and ${who(second, people)} are now allies.`;
  if (line.body !== "alliance_ended") return null;
  // Nobody ended it: one of the two left the game.
  if (line.sender === null || line.seat === null)
    return `The alliance between ${who(first, people)} and ${who(second, people)} ended.`;
  const other = line.seats.find((seat) => seat !== line.seat) ?? second;
  return `${who(line.seat, people, true)} ended the alliance with ${who(other, people)}.`;
}

/** Who wrote a line, as the chat shows it. */
export function senderName(line: ChatLine, people: ChatPeople): string {
  if (ownLine(line, people)) return "You";
  return (
    line.sender?.handle ??
    (line.seat !== null ? people.handle(line.seat) : "Someone")
  );
}

/** Whom an allies-only line went to: "to Bob", "to you and Cara". */
export function recipients(line: ChatLine, people: ChatPeople): string {
  return `to ${listed(line.seats.map((seat) => who(seat, people)))}`;
}

/** What a line says: its text, or an emote's words. */
export function lineBody(line: Pick<ChatLine, "kind" | "body">): string {
  return line.kind === "emote"
    ? (EMOTE_WORDS.get(line.body) ?? line.body)
    : line.body;
}

/** A whole line in words, as it is announced: "Bob to you: Well played." */
export function lineText(line: ChatLine, people: ChatPeople): string | null {
  if (line.kind === "event") return eventText(line, people);
  const from = [senderName(line, people)];
  if (line.seat === null) from.push("(watching)");
  if (line.channel === "allies") from.push(recipients(line, people));
  return `${from.join(" ")}: ${lineBody(line)}`;
}

/* ---------- alliances ---------- */

/** The viewer's alliance with another seat: allies, an offer they made ("offered") or received
 * ("offering"), or none. */
export type Standing = "allied" | "offered" | "offering" | "none";

export function standing(
  alliances: Alliances | null,
  mine: Seat | null,
  seat: Seat,
): Standing {
  if (!alliances || mine === null || mine === seat) return "none";
  if (
    alliances.alliances.some(
      ([a, b]) => (a === mine && b === seat) || (a === seat && b === mine),
    )
  )
    return "allied";
  if (alliances.offers.some((o) => o.from === mine && o.to === seat))
    return "offered";
  if (alliances.offers.some((o) => o.from === seat && o.to === mine))
    return "offering";
  return "none";
}

/** A seat's allies, in seat order. */
export function alliesOf(alliances: Alliances | null, seat: Seat): Seat[] {
  if (!alliances) return [];
  return alliances.alliances
    .flatMap(([a, b]) => (a === seat ? [b] : b === seat ? [a] : []))
    .sort((a, b) => a - b);
}

/** What the viewer may do about an alliance with a seat, as things stand. */
export function allianceActions(now: Standing): AllianceAction[] {
  switch (now) {
    case "allied":
      return ["end"];
    case "offered":
      return ["withdraw"];
    case "offering":
      return ["accept", "decline"];
    default:
      return ["offer"];
  }
}

export const ACTION_WORDS: Record<AllianceAction, string> = {
  offer: "Offer an alliance",
  withdraw: "Withdraw the offer",
  accept: "Accept the alliance",
  decline: "Decline",
  end: "End the alliance",
};

/** The rest of an action's name, after its words and a space: "Offer an alliance" + "to Bob". */
export function actionTarget(action: AllianceAction, name: string): string {
  switch (action) {
    case "offer":
    case "withdraw":
      return `to ${name}`;
    case "decline":
      return `${name}’s offer`;
    default:
      return `with ${name}`;
  }
}

/** The other human players the viewer may make alliances with now: a player still in the game,
 * at a game not over, with players still in it. Bots, players out of the game, the viewer and
 * SysOp watching have none. */
export function allianceSeats(a: {
  mine: Seat | null;
  seats: SummarySeat[] | null;
  presence: PresenceSeat[] | null;
  /** Seats the view marks as having lost. */
  lost: ReadonlySet<Seat>;
  finished: boolean;
}): Set<Seat> {
  const { mine, seats } = a;
  if (mine === null || a.finished || !seats) return new Set();
  // Presence is live; the summary's seats are as they were when the screen loaded them.
  const out = (seat: Seat) =>
    a.lost.has(seat) ||
    Boolean(a.presence?.find((entry) => entry.seat === seat)?.left) ||
    Boolean(seats.find((entry) => entry.seat === seat)?.left);
  if (out(mine)) return new Set();
  return new Set(
    seats
      .filter(
        (entry) =>
          entry.player === "human" && entry.seat !== mine && !out(entry.seat),
      )
      .map((entry) => entry.seat),
  );
}
