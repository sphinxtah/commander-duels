import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { client, describe } from "../api";
import { tierNames } from "../alliance/alliance";
import { PlayerPicture, PresenceDot } from "./PlayerBits";
import {
  looksLikeEmail,
  playerLink,
  presenceWords,
  type PlayerSummary,
} from "./social";
import styles from "./social.module.css";

// The player search in the middle of the top bar (v0.4.3), on every page of the app: a handle,
// or part of one, finds players as it is typed; an email address only when typed in full and
// sent with Enter, so an address typed letter by letter spends none of the day's email
// searches. A result opens the player's profile. The answers never hold an email address.

export const SEARCH_DELAY_MS = 300;
// Fewer letters than this find too many to be useful.
const MIN_HANDLE = 2;

type Found =
  | { state: "idle" }
  | { state: "searching" }
  | { state: "found"; players: PlayerSummary[]; byEmail: boolean }
  | { state: "error"; message: string };

export function PlayerSearch({ className }: { className?: string }) {
  const [text, setText] = useState("");
  const [found, setFound] = useState<Found>({ state: "idle" });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // Only the latest question's answer counts.
  const asked = useRef(0);
  const id = useId();
  const listId = `${id}-results`;
  const trimmed = text.trim();
  const email = looksLikeEmail(trimmed);
  const players = found.state === "found" ? found.players : [];

  async function search(query: string) {
    const question = ++asked.current;
    setFound({ state: "searching" });
    setActive(-1);
    const { data, error } = await client.GET("/api/v1/players", {
      params: { query: { q: query } },
    });
    if (question !== asked.current) return;
    if (data)
      setFound({
        state: "found",
        players: data.players,
        byEmail: data.by_email,
      });
    else setFound({ state: "error", message: describe(error) });
  }

  // A handle searches as it is typed, a moment after the last key.
  useEffect(() => {
    if (email || trimmed.length < MIN_HANDLE) {
      asked.current += 1;
      setFound({ state: "idle" });
      return;
    }
    const timer = window.setTimeout(
      () => void search(trimmed),
      SEARCH_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [trimmed, email]);

  // A click anywhere else closes the results.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  function go(player: PlayerSummary) {
    window.location.hash = playerLink(player.id);
    setOpen(false);
    setText("");
    input.current?.blur();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (active >= 0 && players[active]) return go(players[active]);
    if (email && trimmed.length > 2) {
      setOpen(true);
      void search(trimmed);
    } else if (players.length === 1) go(players[0]!);
  }

  function keys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (players.length === 0) return;
      event.preventDefault();
      setOpen(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((now) => (now + step + players.length) % players.length);
    } else if (event.key === "Escape") {
      if (open) setOpen(false);
      else setText("");
    }
  }

  const shown = open && trimmed.length > 0;
  const status =
    found.state === "searching"
      ? "Searching…"
      : found.state === "error"
        ? found.message
        : found.state === "found" && players.length === 0
          ? found.byEmail
            ? "No player found with that email address. Only a whole address finds a player, and only one who allows it."
            : "No player found with that handle."
          : found.state === "idle" && email
            ? "Press Enter to search for this email address."
            : found.state === "idle"
              ? "Type at least two letters of a handle, or a whole email address."
              : "";

  return (
    <div
      ref={box}
      className={[styles.search, className].filter(Boolean).join(" ")}
    >
      <form role="search" onSubmit={submit} aria-label="Find players">
        <span className={styles.searchIcon} aria-hidden="true">
          ⌕
        </span>
        <input
          ref={input}
          type="search"
          value={text}
          placeholder="Find players by handle or email"
          aria-label="Find players by handle or email"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={shown}
          aria-controls={listId}
          aria-activedescendant={
            shown && active >= 0 ? `${id}-player-${active}` : undefined
          }
          autoComplete="off"
          spellCheck={false}
          maxLength={320}
          onChange={(event) => {
            setText(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={keys}
        />
      </form>
      <div className={styles.results} hidden={!shown}>
        <ul id={listId} role="listbox" aria-label="Players found">
          {players.map((player, index) => (
            <li
              key={player.id}
              id={`${id}-player-${index}`}
              role="option"
              aria-selected={index === active}
              className={styles.result}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => go(player)}
            >
              <PlayerPicture player={player} size={34} />
              <span className={styles.resultText}>
                <strong>{player.handle}</strong>
                <small>
                  {tierNames[player.tier.id]}
                  {player.friendship === "friends" && " · Friend"}
                  {player.presence && " · "}
                  {player.presence && presenceWords(player.presence)}
                </small>
              </span>
              {player.presence && <PresenceDot presence={player.presence} />}
            </li>
          ))}
        </ul>
        <p className={styles.searchStatus} role="status">
          {status}
        </p>
      </div>
    </div>
  );
}
