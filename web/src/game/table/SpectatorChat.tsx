import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReportedMessage } from "../../chat/ReportMessage";
import type { GameState } from "../connection";
import type { ChatPeople } from "./chat";
import { Composer, Line, Waiting } from "./TableChat";
import styles from "./chat.module.css";

// The spectators' chat (v1.0.0, docs/tables.md): what the people watching a table's game say
// among themselves, in the chat's drawer. No player of the game reads it or writes to it, and a
// spectator is sent nothing of the table's chat. It is the table chat's own list and box to
// write in, with one channel: no tabs, no emotes and no alliances. A line is shown as text,
// never as HTML or a link, and each one but the viewer's own can be reported.

const CHANNEL = "spectators";

export function SpectatorChat({
  state,
  people,
  open,
  connected,
  onSend,
  onRetry,
  onDiscard,
  onReport,
}: {
  state: Pick<GameState, "chat" | "outbox">;
  people: ChatPeople;
  /** The panel is unfolded: its box to write in takes focus. */
  open: boolean;
  connected: boolean;
  onSend(text: string): void;
  onRetry(clientId: string): void;
  onDiscard(clientId: string): void;
  onReport(message: ReportedMessage): void;
}) {
  const [draft, setDraft] = useState("");
  const box = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const lines = (state.chat ?? []).filter((line) => line.channel === CHANNEL);
  const waiting = state.outbox.filter((entry) => entry.channel === CHANNEL);

  useEffect(() => {
    if (open) box.current?.focus({ preventScroll: true });
    // Only as it unfolds.
  }, [open]);
  // The list stays at its newest line unless the reader scrolled up.
  useLayoutEffect(() => {
    const element = list.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [lines.length, state.outbox, open]);

  return (
    <div className={styles.chat} data-chat="spectators">
      <div className={styles.panel}>
        <ol
          ref={list}
          className={styles.lines}
          aria-label="Messages among the spectators"
          tabIndex={0}
          onScroll={(event) => {
            const element = event.currentTarget;
            stick.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              24;
          }}
        >
          {lines.length === 0 && waiting.length === 0 && (
            <li className={styles.empty}>No messages yet.</li>
          )}
          {lines.map((line) => (
            <Line
              key={line.id}
              line={line}
              people={people}
              onReport={onReport}
            />
          ))}
          {waiting.map((entry) => (
            <Waiting
              key={entry.client_id}
              entry={entry}
              allies={[]}
              connected={connected}
              onRetry={onRetry}
              onDiscard={onDiscard}
            />
          ))}
        </ol>
        <p className={styles.note}>
          Only the game&apos;s spectators read this. Its players read and write
          none of it, and you read none of their chat.
        </p>
        <Composer
          channel={CHANNEL}
          box={box}
          text={draft}
          onText={setDraft}
          to={null}
          teams={false}
          connected={connected}
          onSend={(text) => {
            onSend(text);
            stick.current = true;
            setDraft("");
          }}
        />
      </div>
    </div>
  );
}
