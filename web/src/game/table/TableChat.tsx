import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import type { ReportedMessage } from "../../chat/ReportMessage";
import type { GameState, OutgoingChat } from "../connection";
import type { ChatLine, EmoteName, Seat } from "../types";
import { ActionMenu } from "./ActionMenu";
import { AllianceContext } from "./Alliance";
import {
  ACTION_WORDS,
  CHAT_LENGTH,
  CHAT_LINES,
  EMOTES,
  actionTarget,
  allianceActions,
  alliesOf,
  channelName,
  eventText,
  lineBody,
  lineText,
  listed,
  ownLine,
  recipients,
  senderName,
  standing,
  type Channel,
  type ChatPeople,
} from "./chat";
import gameStyles from "../game.module.css";
import styles from "./chat.module.css";

// The table's chat panel (v0.4.4, docs/chat.md), in its drawer at a human table's game: the
// Table and Allies tabs with their lines, the box to write in, the emotes and the alliances. A
// line is always shown as text, never as HTML or a link. A message sent waits greyed until the
// server sends it back; one refused says why, with Try again. The list is no live region: new
// lines from the other players are said through the table's own polite voice, folded or not. At a
// Two-Headed Giant table (v0.5.1) the Allies tab is the Team tab, the team's fixed channel, and
// the teams stand where the alliances would.

const CHANNELS: Channel[] = ["table", "allies"];

/** The lines not read yet in each channel, and the voice for what arrives. Lines count as read
 * once their tab is shown in the open panel; the history a tab finds as it opens is read
 * already, and so is everything the viewer wrote. */
export function useChatReading({
  chat,
  outbox,
  refusal,
  people,
  reading,
  say,
}: {
  chat: ChatLine[] | null;
  outbox: OutgoingChat[];
  /** Why an alliance request was refused. */
  refusal: string | null;
  people: ChatPeople;
  /** The channel shown in the open panel; null while it is folded. */
  reading: Channel | null;
  say(text: string): void;
}): Record<Channel, number> {
  const [seen, setSeen] = useState<ReadonlySet<string> | null>(null);
  const known = useRef<Set<string> | null>(null);
  const failed = useRef(new Set<string>());
  const latest = useRef({ people, say });
  useLayoutEffect(() => {
    latest.current = { people, say };
  });

  useEffect(() => {
    if (!chat) return;
    const { people, say } = latest.current;
    if (known.current === null) {
      known.current = new Set(chat.map((line) => line.id));
      setSeen(new Set(known.current));
      return;
    }
    const before = known.current;
    const fresh = chat.filter((line) => !before.has(line.id));
    for (const line of fresh) before.add(line.id);
    const said = fresh
      .filter((line) => !ownLine(line, people))
      .map((line) => lineText(line, people))
      .filter((text): text is string => Boolean(text));
    // A reconnect's history can bring several at once: they are counted, not read out.
    if (said.length === 1) say(said[0]);
    else if (said.length > 1) say(`${said.length} new messages in the chat.`);
  }, [chat]);

  // A message refused is said once each time it fails, since the panel may be folded.
  useEffect(() => {
    const now = new Set(
      outbox
        .filter((entry) => entry.status === "failed")
        .map((entry) => entry.client_id),
    );
    for (const entry of outbox)
      if (entry.status === "failed" && !failed.current.has(entry.client_id))
        latest.current.say(`Your message was not sent. ${entry.error ?? ""}`);
    failed.current = now;
  }, [outbox]);

  useEffect(() => {
    if (refusal) latest.current.say(refusal);
  }, [refusal]);

  useEffect(() => {
    if (!chat || reading === null || seen === null) return;
    const unseen = chat.filter(
      (line) => line.channel === reading && !seen.has(line.id),
    );
    if (unseen.length > 0)
      setSeen(new Set([...seen, ...unseen.map((line) => line.id)]));
  }, [chat, reading, seen]);

  return useMemo(() => {
    const count = (channel: Channel) =>
      chat && seen
        ? chat.filter(
            (line) =>
              line.channel === channel &&
              !seen.has(line.id) &&
              !ownLine(line, people),
          ).length
        : 0;
    return { table: count("table"), allies: count("allies") };
  }, [chat, seen, people]);
}

export interface TableChatProps {
  state: Pick<GameState, "chat" | "outbox" | "allianceRefusal">;
  people: ChatPeople;
  tab: Channel;
  onTab(tab: Channel): void;
  unread: Record<Channel, number>;
  /** The panel is unfolded: its box to write in takes focus. */
  open: boolean;
  connected: boolean;
  onSend(channel: Channel, text: string): void;
  onEmote(emote: EmoteName): void;
  onRetry(clientId: string): void;
  onDiscard(clientId: string): void;
  onReport(message: ReportedMessage): void;
}

export function TableChat({
  state,
  people,
  tab,
  onTab,
  unread,
  open,
  connected,
  onSend,
  onEmote,
  onRetry,
  onDiscard,
  onReport,
}: TableChatProps) {
  const alliances = useContext(AllianceContext);
  const [drafts, setDrafts] = useState<Record<Channel, string>>({
    table: "",
    allies: "",
  });
  const tabs = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const id = useId();

  const lines = (state.chat ?? []).filter((line) => line.channel === tab);
  const waiting = state.outbox.filter((entry) => entry.channel === tab);
  const allies =
    people.seat !== null
      ? alliesOf(alliances?.alliances ?? null, people.seat)
      : [];
  const watching = people.seat === null;
  // Two-Headed Giant (v0.5.1): the allies are the team, fixed.
  const teams = alliances?.alliances?.fixed ?? false;
  // Everyone writes to the table; to allies, a player who has some (SysOp watching has none).
  const writable = tab === "table" || allies.length > 0;

  // Unfolding the panel puts focus in its box to write in, after the drawer took it (a child's
  // effect runs after the drawer's layout effect).
  useEffect(() => {
    if (!open) return;
    if (box.current) box.current.focus({ preventScroll: true });
    else
      tabs.current
        ?.querySelector<HTMLElement>('[aria-selected="true"]')
        ?.focus({ preventScroll: true });
    // Only as it unfolds.
  }, [open]);

  // The list stays at its newest line unless the player scrolled up to read; a tab shown afresh
  // starts at its newest.
  const shownTab = useRef(tab);
  useLayoutEffect(() => {
    if (shownTab.current !== tab) {
      shownTab.current = tab;
      stick.current = true;
    }
    const element = list.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [lines.length, state.outbox, tab, open]);

  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const at = CHANNELS.indexOf(tab);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? CHANNELS.length - 1
          : (at + (event.key === "ArrowRight" ? 1 : -1) + CHANNELS.length) %
            CHANNELS.length;
    onTab(CHANNELS[next]);
    tabs.current
      ?.querySelector<HTMLElement>(`[data-channel="${CHANNELS[next]}"]`)
      ?.focus();
  }

  const note = watching
    ? tab === "allies"
      ? teams
        ? "You are watching: you read every team’s messages, and write to the table only."
        : "You are watching: you read every message to allies, and write to the table only."
      : null
    : tab === "allies" && allies.length === 0
      ? teams
        ? "Your teammate is a bot, so nobody reads this tab."
        : "Only your allies read what you write here. You have no allies yet: offer an alliance from another player’s plate, or from the list below."
      : null;

  return (
    <div className={styles.chat} data-chat="">
      <div
        ref={tabs}
        role="tablist"
        aria-label="Chat"
        className={styles.tabs}
        onKeyDown={onTabKey}
      >
        {CHANNELS.map((channel) => {
          const count = channel === tab ? 0 : unread[channel];
          return (
            <button
              key={channel}
              type="button"
              role="tab"
              id={`${id}-${channel}`}
              data-channel={channel}
              aria-selected={channel === tab}
              aria-controls={`${id}-panel`}
              tabIndex={channel === tab ? 0 : -1}
              className={styles.tab}
              onClick={() => onTab(channel)}
            >
              {channelName(channel, teams)}
              {count > 0 && " "}
              {count > 0 && (
                <span className={styles.count}>
                  {count}{" "}
                  <span className={gameStyles.visuallyHidden}>unread</span>
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${tab}`}
        className={styles.panel}
      >
        <ol
          ref={list}
          className={styles.lines}
          aria-label={
            tab === "table"
              ? "Messages to the table"
              : teams
                ? "Messages to your team"
                : "Messages to allies"
          }
          tabIndex={0}
          onScroll={(event) => {
            const element = event.currentTarget;
            stick.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              24;
          }}
        >
          {lines.length === 0 && waiting.length === 0 && (
            <li className={styles.empty}>
              {tab === "table"
                ? "No messages yet."
                : teams
                  ? "No messages to your team yet."
                  : "No messages to allies yet."}
            </li>
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
              allies={allies.map(people.handle)}
              connected={connected}
              onRetry={onRetry}
              onDiscard={onDiscard}
            />
          ))}
        </ol>
        {note && <p className={styles.note}>{note}</p>}
        {writable && (
          <Composer
            key={tab}
            channel={tab}
            box={box}
            text={drafts[tab]}
            onText={(text) =>
              setDrafts((current) => ({ ...current, [tab]: text }))
            }
            to={tab === "allies" ? listed(allies.map(people.handle)) : null}
            teams={teams}
            connected={connected}
            onSend={(text) => {
              onSend(tab, text);
              stick.current = true;
              setDrafts((current) => ({ ...current, [tab]: "" }));
            }}
          />
        )}
        {tab === "table" && (
          <div
            role="group"
            aria-label="Emotes to the table"
            className={styles.emotes}
          >
            {EMOTES.map((emote) => (
              <button
                key={emote.name}
                type="button"
                className={styles.emote}
                data-emote={emote.name}
                disabled={!connected}
                onClick={() => {
                  stick.current = true;
                  onEmote(emote.name);
                }}
              >
                {emote.words}
              </button>
            ))}
          </div>
        )}
      </div>

      {teams ? <TeamList /> : <AllianceList refusal={state.allianceRefusal} />}
    </div>
  );
}

/** A line the server sent: a player's text or emote, or an alliance's event. */
function Line({
  line,
  people,
  onReport,
}: {
  line: ChatLine;
  people: ChatPeople;
  onReport(message: ReportedMessage): void;
}) {
  if (line.kind === "event") {
    const text = eventText(line, people);
    return text ? (
      <li className={styles.event} data-kind="event" data-line={line.id}>
        {text}
      </li>
    ) : null;
  }
  const own = ownLine(line, people);
  const sender = senderName(line, people);
  const body = lineBody(line);
  return (
    <li
      className={styles.line}
      data-kind={line.kind}
      data-own={own || undefined}
      data-line={line.id}
    >
      <span className={styles.from}>
        <span className={styles.sender}>{sender}</span>
        {line.seat === null && <span className={styles.meta}> (watching)</span>}
        {line.channel === "allies" && (
          <span className={styles.meta}> {recipients(line, people)}</span>
        )}
        <span className={gameStyles.visuallyHidden}>: </span>
      </span>
      <span className={styles.body}>{body}</span>
      {!own && line.sender !== null && (
        <LineMenu
          name={sender}
          onReport={() =>
            onReport({ kind: "table", id: line.id, sender, body })
          }
        />
      )}
    </li>
  );
}

/** A line's ⋯ menu, with Report. Near the bottom of the list it opens upwards, so the list does
 * not cut it off. */
function LineMenu({ name, onReport }: { name: string; onReport(): void }) {
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);
  return (
    <span className={styles.more}>
      <button
        ref={button}
        type="button"
        className={styles.moreButton}
        aria-label={`More for ${name}’s message`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          if (open) return close(false);
          const at = event.currentTarget.getBoundingClientRect();
          const box = event.currentTarget
            .closest("ol")
            ?.getBoundingClientRect();
          setAbove(box ? at.bottom > box.top + box.height / 2 : false);
          setOpen(true);
        }}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open && (
        <ActionMenu
          label={`${name}’s message`}
          toggle={button}
          placement={above ? "above" : "below"}
          align="end"
          onClose={close}
          actions={[
            {
              key: "report",
              label: "Report",
              onSelect: () => {
                close(true);
                onReport();
              },
            },
          ]}
        />
      )}
    </span>
  );
}

/** A message of this tab's that the server has not sent back: greyed while it waits, and with
 * why and Try again once it was refused. */
function Waiting({
  entry,
  allies,
  connected,
  onRetry,
  onDiscard,
}: {
  entry: OutgoingChat;
  allies: string[];
  connected: boolean;
  onRetry(clientId: string): void;
  onDiscard(clientId: string): void;
}) {
  const failed = entry.status === "failed";
  return (
    <li
      className={styles.line}
      data-kind={entry.kind}
      data-own=""
      data-status={entry.status}
      data-client-id={entry.client_id}
    >
      <span className={styles.from}>
        <span className={styles.sender}>You</span>
        {entry.channel === "allies" && allies.length > 0 && (
          <span className={styles.meta}> to {listed(allies)}</span>
        )}
        <span className={gameStyles.visuallyHidden}>: </span>
      </span>
      <span className={styles.body}>{lineBody(entry)}</span>
      {failed ? (
        <span className={styles.failure}>
          <span>{entry.error ?? "Not sent."}</span>
          <span className={styles.actions}>
            <button
              type="button"
              className={styles.small}
              disabled={!connected}
              onClick={() => onRetry(entry.client_id)}
            >
              Try again
            </button>
            <button
              type="button"
              className={styles.small}
              onClick={() => onDiscard(entry.client_id)}
            >
              Discard
            </button>
          </span>
        </span>
      ) : (
        <span className={styles.state}>Sending…</span>
      )}
    </li>
  );
}

/** The box to write in: Enter sends, Shift+Enter starts a new line. */
function Composer({
  channel,
  box,
  text,
  onText,
  to,
  teams,
  connected,
  onSend,
}: {
  channel: Channel;
  box: RefObject<HTMLTextAreaElement | null>;
  text: string;
  onText(text: string): void;
  /** Allies only: whom it goes to. */
  to: string | null;
  /** Two-Headed Giant (v0.5.1): the allies are the team. */
  teams: boolean;
  connected: boolean;
  onSend(text: string): void;
}) {
  const id = useId();
  const trimmed = text.trim();
  const tooManyLines = trimmed.split("\n").length > CHAT_LINES;
  const sendable = connected && trimmed.length > 0 && !tooManyLines;
  const send = () => {
    if (sendable) onSend(trimmed);
  };
  const label =
    channel === "table"
      ? "Message to the table"
      : teams
        ? "Message to your team"
        : "Message to your allies";
  return (
    <form
      className={styles.compose}
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <label htmlFor={`${id}-text`} className={gameStyles.visuallyHidden}>
        {label}
      </label>
      <textarea
        ref={box}
        id={`${id}-text`}
        className={styles.text}
        rows={2}
        maxLength={CHAT_LENGTH}
        value={text}
        placeholder={
          channel === "table" ? "Write to the table" : `Write to ${to}`
        }
        aria-describedby={`${id}-hint`}
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div className={styles.composeRow}>
        <span id={`${id}-hint`} className={styles.hint}>
          {tooManyLines
            ? `A message may have at most ${CHAT_LINES} lines.`
            : !connected
              ? "Reconnecting… You can send again once the table is back."
              : to
                ? `Only ${to} will read it. Enter sends.`
                : "Enter sends, Shift+Enter starts a new line."}
        </span>
        <span className={styles.counter} aria-hidden="true">
          {text.length}/{CHAT_LENGTH}
        </span>
        <button
          type="submit"
          className={gameStyles.primaryButton}
          disabled={!sendable}
        >
          Send
        </button>
      </div>
    </form>
  );
}

/** Two-Headed Giant's teams in words (v0.5.1), where the alliances would be: the viewer's own,
 * and who reads its tab; for SysOp watching, each team of two players. */
function TeamList() {
  const table = useContext(AllianceContext);
  if (!table) return null;
  const { mine, alliances, handle } = table;
  const pairs = alliances?.alliances ?? [];
  const mates = mine !== null ? alliesOf(alliances, mine) : [];
  return (
    <section className={styles.alliances} aria-labelledby="chat-teams">
      <h3 id="chat-teams">{mine === null ? "Teams" : "Your team"}</h3>
      {mine !== null ? (
        <p className={styles.hint} data-team="">
          {mates.length > 0
            ? `You and ${listed(mates.map(handle))}: only the two of you read the Team tab, never the other team.`
            : "You and a bot: nobody reads the Team tab."}
        </p>
      ) : pairs.length === 0 ? (
        <p className={styles.hint}>No team at this table has two players.</p>
      ) : (
        <ul>
          {pairs.map(([a, b]) => (
            <li key={`${a}:${b}`}>
              {handle(a)} and {handle(b)} are a team.
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The alliances in words: the viewer's own with each other player, with their actions, then
 * the others' (and, for SysOp watching, every offer). */
function AllianceList({ refusal }: { refusal: string | null }) {
  const table = useContext(AllianceContext);
  if (!table) return null;
  const { mine, alliances, handle } = table;
  const mineToo = new Set<Seat>(table.open);
  if (mine !== null) {
    for (const seat of alliesOf(alliances, mine)) mineToo.add(seat);
    for (const offer of alliances?.offers ?? [])
      if (offer.from === mine) mineToo.add(offer.to);
      else if (offer.to === mine) mineToo.add(offer.from);
  }
  mineToo.delete(mine as Seat);
  const rows = [...mineToo].sort((a, b) => a - b);
  const others = (alliances?.alliances ?? []).filter(
    ([a, b]) => a !== mine && b !== mine,
  );
  const offers = mine === null ? (alliances?.offers ?? []) : [];
  const empty = rows.length + others.length + offers.length === 0;
  return (
    <section className={styles.alliances} aria-labelledby="chat-alliances">
      <h3 id="chat-alliances">Alliances</h3>
      {refusal && <p className={styles.refusal}>{refusal}</p>}
      {empty ? (
        <p className={styles.hint}>
          {mine === null
            ? "No alliances at this table."
            : "There is no other player to make an alliance with."}
        </p>
      ) : (
        <ul>
          {rows.map((seat) => {
            const name = handle(seat);
            const now = standing(alliances, mine, seat);
            const words =
              now === "allied"
                ? `${name} is your ally.`
                : now === "offered"
                  ? `You offered ${name} an alliance.`
                  : now === "offering"
                    ? `${name} offers you an alliance.`
                    : name;
            return (
              <li key={seat} data-seat={seat} data-standing={now}>
                <span>{words}</span>
                {table.open.has(seat) && (
                  <span className={styles.actions}>
                    {allianceActions(now).map((action) => (
                      <button
                        key={action}
                        type="button"
                        className={styles.small}
                        data-action={action}
                        onClick={() => table.act(action, seat)}
                      >
                        {ACTION_WORDS[action]}{" "}
                        <span className={gameStyles.visuallyHidden}>
                          {actionTarget(action, name)}
                        </span>
                      </button>
                    ))}
                  </span>
                )}
              </li>
            );
          })}
          {others.map(([a, b]) => (
            <li key={`${a}:${b}`}>
              {handle(a)} and {handle(b)} are allies.
            </li>
          ))}
          {offers.map((offer) => (
            <li key={`${offer.from}>${offer.to}`}>
              {handle(offer.from)} offered {handle(offer.to)} an alliance.
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
