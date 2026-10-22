import type { components } from "../generated/api";
import admin from "./admin.module.css";

// Chat lines as Administration shows them (v0.4.4): a reported message's excerpt in Reports, and
// a chat SysOp opens in Chats. Each line says who sent it, when and where: a friend's message,
// the whole table, or the sender's allies alone. Every text is shown as text, never as HTML.

export type ChatLine = components["schemas"]["ChatLine"];

// The table's emotes, by the name the line carries (api/table_chat.py's EMOTES).
export const emoteWords: Record<string, string> = {
  hello: "Hello!",
  good_luck: "Good luck, have fun!",
  your_turn: "Your turn.",
  thinking: "Thinking…",
  nice_play: "Nice play!",
  thanks: "Thanks!",
  oops: "Oops!",
  sorry: "Sorry!",
  good_game: "Good game!",
};

export function when(value: string) {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** "2", "2 and 3", "1, 2 and 3". */
function seatList(seats: number[]) {
  return seats.length < 2
    ? seats.join("")
    : `${seats.slice(0, -1).join(", ")} and ${seats.at(-1)}`;
}

/** What a line says: its text, an emote's words, or an alliance's start or end. */
export function lineWords(line: ChatLine) {
  if (line.kind === "emote") return emoteWords[line.body] ?? line.body;
  if (line.kind !== "event") return line.body;
  const [first, second] = line.seats ?? [];
  if (first === undefined || second === undefined) return line.body;
  if (line.body === "allied")
    return `Seats ${first} and ${second} became allies.`;
  if (line.body === "alliance_ended")
    return `The alliance between seats ${first} and ${second} ended.`;
  return line.body;
}

/** Where a line was said. At a table its seats start with the sender's; allies' lines then name
    the seats they went to. */
export function whereWords(line: ChatLine) {
  if (line.channel === "direct") return "Friend's message";
  if (line.channel === "table") return "To the table";
  const to = (line.seats ?? []).slice(1);
  if (to.length === 0) return "Allies only";
  return `Allies only, to ${to.length === 1 ? "seat" : "seats"} ${seatList(to)}`;
}

function senderName(line: ChatLine) {
  // An alliance that ended because a player left the game has no sender: the game said it.
  if (line.kind === "event" && !line.sender) return "The game";
  return line.sender?.handle ?? "Unknown account";
}

export function ChatLines({
  lines,
  label,
}: {
  lines: ChatLine[];
  label: string;
}) {
  return (
    <ol className={admin.chatLines} aria-label={label}>
      {lines.map((line) => {
        // The sender's seat, at a table; SysOp watching has none, and an event's seats are the
        // two allies.
        const seat =
          line.channel !== "direct" && line.kind !== "event"
            ? line.seats?.[0]
            : undefined;
        return (
          <li
            key={line.id}
            className={admin.chatLine}
            data-reported={line.reported || undefined}
          >
            <div className={admin.chatMeta}>
              <strong>{senderName(line)}</strong>
              <span>
                {seat !== undefined && `seat ${seat} · `}
                {whereWords(line)} ·{" "}
                <time dateTime={line.created_at}>{when(line.created_at)}</time>
              </span>
              {line.reported && (
                <span className={admin.chatReported}>Reported</span>
              )}
            </div>
            <p
              className={admin.chatBody}
              data-kind={line.kind === "text" ? undefined : line.kind}
            >
              {lineWords(line)}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
