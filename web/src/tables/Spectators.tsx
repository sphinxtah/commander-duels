import { useEffect, useRef, useState, type FormEvent } from "react";
import { client, describe } from "../api";
import game from "../game/game.module.css";
import { delayWords } from "../game/spectating";
import { PlayerPicture } from "../social/PlayerBits";
import { FriendPicker, sentWords, useFriendList } from "./InviteFriends";
import { formatNames, type TableView } from "./tables";
import {
  WATCH_SETTINGS,
  useSpectators,
  watchSentence,
  type SpectatorView,
  type Spectators,
  type Watchable,
  type WatchSetting,
} from "./watching";
import styles from "./tables.module.css";

// Spectators at a table (v1.0.0, docs/tables.md): the host's "Who may watch" in the opening
// form and on the table's page, the friends its players invite to watch and their removal, and
// the lobby's list of games to watch. A spectator sees what every seat sees and no hand, and
// acts on nothing.

/** "Who may watch": the host's choice. Anyone is a public table's alone. */
export function WatchField({
  value,
  visibility,
  disabled = false,
  onChange,
}: {
  value: WatchSetting;
  visibility: TableView["visibility"];
  disabled?: boolean;
  onChange(next: WatchSetting): void;
}) {
  return (
    <label className={game.field}>
      <span>Who may watch</span>
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as WatchSetting)}
      >
        {WATCH_SETTINGS.map((setting) => (
          <option
            key={setting.value}
            value={setting.value}
            disabled={setting.value === "anyone" && visibility === "private"}
          >
            {setting.words}
            {setting.value === "anyone" && visibility === "private"
              ? " (public tables only)"
              : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The spectators of a table, on its page: who may watch, who is invited, and for its players
 * the way to invite friends. Shown to the table's players and to those who may watch it. */
export function SpectatorsPanel({
  table,
  host,
  seated,
  busy,
  onSetting,
}: {
  table: TableView;
  /** The viewer hosts the table: the setting is theirs while the table waits. */
  host: boolean;
  /** The viewer sits at the table. */
  seated: boolean;
  busy: boolean;
  onSetting(next: WatchSetting): void;
}) {
  const [list, refresh] = useSpectators(
    table.code,
    table.spectators !== "nobody",
  );
  const [shown, setShown] = useState<Spectators | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  useEffect(() => {
    if (list !== undefined) setShown(list);
  }, [list]);
  // The list as the table's setting stands: a setting changed to nobody empties it at once.
  const spectators = table.spectators === "nobody" ? null : shown;

  async function remove(spectator: SpectatorView) {
    setWorking(true);
    setError("");
    const { data, error: failure } = await client.DELETE(
      "/api/v1/tables/{code}/spectators/{player_id}",
      {
        params: { path: { code: table.code, player_id: spectator.player.id } },
      },
    );
    setWorking(false);
    if (!data) return setError(describe(failure));
    setShown(spectator.you ? null : data);
    refresh();
  }

  const changing = host && table.status === "open" && !table.campaign;
  return (
    <section className={styles.hostPanel} aria-labelledby="spectators-title">
      <h2 id="spectators-title">Spectators</h2>
      {changing ? (
        <WatchField
          value={table.spectators}
          visibility={table.visibility}
          disabled={busy}
          onChange={onSetting}
        />
      ) : (
        <p className={game.hint}>{watchSentence(table.spectators)}</p>
      )}
      <p className={game.hint}>
        A spectator sees the battlefield, the stack, the graveyards and the log,
        as every player does: never a hand, a library or a deck. They cannot
        act, and the table&apos;s chat is not shown to them.
      </p>
      {table.watching && (
        <p className={styles.notice} role="status">
          {table.status === "started" && table.game_id ? (
            <>
              You may watch this game, {delayWords(table.spectator_delay)}.
              <a href={`#game/${table.game_id}`}>Watch the game</a>
            </>
          ) : (
            "You may watch this table’s game once it starts: this page opens it."
          )}
        </p>
      )}
      {spectators && spectators.invited.length > 0 && (
        <ul className={styles.spectators} aria-label="Invited to watch">
          {spectators.invited.map((spectator) => (
            <li key={spectator.player.id}>
              <PlayerPicture player={spectator.player} size={30} />
              <span className={styles.watchName}>
                <strong>{spectator.player.handle}</strong>
                <small>
                  {spectator.you
                    ? `You, invited by ${spectator.invited_by}`
                    : `Invited by ${spectator.yours ? "you" : spectator.invited_by}`}
                </small>
              </span>
              {(spectators.can_remove || spectator.yours || spectator.you) && (
                <button
                  type="button"
                  className={game.secondaryButton}
                  disabled={working}
                  aria-label={
                    spectator.you
                      ? "Stop watching this table"
                      : `Remove ${spectator.player.handle} from the spectators`
                  }
                  onClick={() => void remove(spectator)}
                >
                  {spectator.you ? "Stop watching" : "Remove"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {spectators && spectators.invited.length === 0 && seated && (
        <p className={game.hint}>Nobody is invited to watch yet.</p>
      )}
      {error && (
        <p role="alert" className={game.refusal}>
          {error}
        </p>
      )}
      {spectators?.can_invite && (
        <InviteSpectators
          code={table.code}
          seated={table.players.flatMap((player) =>
            player.taken && player.handle ? [player.handle] : [],
          )}
          onInvited={(next) => {
            setShown(next);
            refresh();
          }}
        />
      )}
    </section>
  );
}

/** "Invite friends to watch": a seated player's own friends, each told by the bell. */
function InviteSpectators({
  code,
  seated,
  onInvited,
}: {
  code: string;
  /** The handles seated at the table: a player does not watch their own game. */
  seated: string[];
  onInvited(next: Spectators): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const { friends, error } = useFriendList(open);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState("");
  const [said, setSaid] = useState("");

  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal?.();
    if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy || selected.length === 0) return;
    setBusy(true);
    setRefusal("");
    const { data, error: failure } = await client.POST(
      "/api/v1/tables/{code}/spectators",
      { params: { path: { code } }, body: { players: selected } },
    );
    setBusy(false);
    if (!data) return setRefusal(describe(failure));
    const names = (friends ?? [])
      .filter((friend) => selected.includes(friend.id))
      .map((friend) => friend.handle);
    setSaid(`${sentWords(names, []).replace(/\.$/, "")} to watch.`);
    setSelected([]);
    setOpen(false);
    onInvited(data);
  }

  return (
    <div className={styles.actions}>
      <button
        type="button"
        className={game.secondaryButton}
        onClick={() => {
          setSaid("");
          setOpen(true);
        }}
      >
        Invite friends to watch
      </button>
      {said && (
        <span className={styles.status} role="status">
          {said}
        </span>
      )}
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-labelledby="invite-spectators-title"
        onClose={() => setOpen(false)}
      >
        {open && (
          <form onSubmit={(event) => void send(event)}>
            <div className={styles.dialogHead}>
              <h2 id="invite-spectators-title">Invite friends to watch</h2>
              <button
                type="button"
                className={styles.dialogClose}
                aria-label="Close"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
            <p className={game.hint}>
              They watch the game without playing in it, and never see a hand.
            </p>
            <FriendPicker
              friends={friends}
              error={error}
              selected={selected}
              onChange={setSelected}
              seated={seated}
            />
            <div className={game.startRow}>
              <button
                type="submit"
                className={game.primaryButton}
                disabled={busy || selected.length === 0}
              >
                {busy
                  ? "Inviting…"
                  : selected.length > 1
                    ? `Invite ${selected.length} friends to watch`
                    : "Invite to watch"}
              </button>
              {refusal && (
                <p role="alert" className={game.refusal}>
                  {refusal}
                </p>
              )}
            </div>
          </form>
        )}
      </dialog>
    </div>
  );
}

/** The lobby's "Watch a game": the tables the account was invited to watch, waiting or running,
 * and the running games of public tables open to anyone. Nothing is shown while there is none. */
export function WatchList({ tables }: { tables: Watchable[] }) {
  if (tables.length === 0) return null;
  return (
    <section className={game.table} aria-labelledby="watch-title">
      <span className={game.eyebrow}>SPECTATE</span>
      <h2 id="watch-title">Watch a game</h2>
      <ul className={styles.watchList}>
        {tables.map((table) => {
          const name = `${table.host || "a player"}'s ${formatNames[table.format]} table`;
          return (
            <li key={table.code}>
              <span className={styles.watchName}>
                <strong>{formatNames[table.format]}</strong>
                <small>
                  {table.players.filter(Boolean).join(", ") ||
                    `Hosted by ${table.host || "a player"}`}{" "}
                  · {table.invited ? "You were invited" : "Open to anyone"} ·{" "}
                  {delayWords(table.delay_seconds)}
                </small>
              </span>
              {table.game_id ? (
                <a
                  className={game.primaryButton}
                  href={`#game/${table.game_id}`}
                  aria-label={`Watch ${name}`}
                >
                  Watch
                </a>
              ) : (
                <a
                  className={game.secondaryButton}
                  href={`#tables/${table.code}`}
                  aria-label={`Open ${name}, which has not started`}
                >
                  Not started
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
