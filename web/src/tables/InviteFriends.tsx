import { useEffect, useRef, useState, type FormEvent } from "react";
import { client, describe } from "../api";
import game from "../game/game.module.css";
import { PlayerPicture } from "../social/PlayerBits";
import {
  presenceRank,
  presenceWords,
  type PlayerSummary,
} from "../social/social";
import styles from "./tables.module.css";

// Friends invited to a table (v0.9.2, docs/tables.md): picked one by one when the table opens, or
// later from its page by any of its players. Each friend gets a notice in the bell that leads to
// the table, and sees it in the lobby even when it is private. No seat is held.

/** The most friends invited at once, as the server allows. */
export const INVITES_AT_ONCE = 20;

/** The account's friends, online first; null until they arrive. */
export function useFriendList(wanted = true): {
  friends: PlayerSummary[] | null;
  error: string;
} {
  const [friends, setFriends] = useState<PlayerSummary[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!wanted) return;
    let active = true;
    void client
      .GET("/api/v1/friends")
      .then(({ data, error: failure }) => {
        if (!active) return;
        if (!data) return setError(describe(failure));
        setError("");
        setFriends(
          [...data.friends].sort(
            (one, other) =>
              presenceRank(one.presence) - presenceRank(other.presence) ||
              one.handle.localeCompare(other.handle),
          ),
        );
      })
      .catch(() => {
        if (active) setError(describe(undefined));
      });
    return () => {
      active = false;
    };
  }, [wanted]);
  return { friends, error };
}

/** A checkbox for each friend, each picked on its own. Friends in `seated` sit at the table
 * already and can't be picked. */
export function FriendPicker({
  friends,
  error,
  selected,
  onChange,
  seated = [],
}: {
  friends: PlayerSummary[] | null;
  error: string;
  selected: string[];
  onChange: (next: string[]) => void;
  seated?: string[];
}) {
  if (error)
    return (
      <p role="alert" className={game.refusal}>
        {error}
      </p>
    );
  if (!friends) return <p role="status">Looking for your friends…</p>;
  if (friends.length === 0)
    return (
      <p className={game.hint}>
        You have no friends to invite yet. Find players in{" "}
        <a href="#friends">Friends</a>; you can still share the table&apos;s
        invite link.
      </p>
    );
  const full = selected.length >= INVITES_AT_ONCE;
  return (
    <fieldset className={styles.friendPicker}>
      <legend>
        Invite friends{" "}
        <small>
          {selected.length === 0
            ? "Each one picked gets a notice in their bell"
            : `${selected.length} picked`}
        </small>
      </legend>
      <ul>
        {friends.map((friend) => {
          const here = seated.includes(friend.handle);
          const picked = selected.includes(friend.id);
          return (
            <li key={friend.id}>
              <label className={styles.friendChoice} data-picked={picked}>
                <input
                  type="checkbox"
                  checked={picked}
                  disabled={here || (full && !picked)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...selected, friend.id]
                        : selected.filter((id) => id !== friend.id),
                    )
                  }
                />
                <PlayerPicture player={friend} size={30} />
                <span>
                  <strong>{friend.handle}</strong>
                  <small>
                    {here ? "At this table" : presenceWords(friend.presence)}
                  </small>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {full && (
        <p className={game.hint}>
          {INVITES_AT_ONCE} friends at a time: send these, then invite more.
        </p>
      )}
    </fieldset>
  );
}

/** "Invite friends" on a table's page (v0.9.2), for its players while it waits. */
export function InviteFriendsButton({
  code,
  seated,
}: {
  code: string;
  /** The handles seated at the table: they need no invitation. */
  seated: string[];
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
      "/api/v1/tables/{code}/invites",
      { params: { path: { code } }, body: { players: selected } },
    );
    setBusy(false);
    if (!data) return setRefusal(describe(failure));
    setSaid(sentWords(data.invited, data.already));
    setSelected([]);
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        className={game.secondaryButton}
        onClick={() => {
          setSaid("");
          setOpen(true);
        }}
      >
        Invite friends
      </button>
      {said && (
        <span className={styles.status} role="status">
          {said}
        </span>
      )}
      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-labelledby="invite-friends-title"
        onClose={() => setOpen(false)}
      >
        {open && (
          <form onSubmit={(event) => void send(event)}>
            <div className={styles.dialogHead}>
              <h2 id="invite-friends-title">Invite friends</h2>
              <button
                type="button"
                className={styles.dialogClose}
                aria-label="Close"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
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
                    ? `Invite ${selected.length} friends`
                    : "Invite"}
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
    </>
  );
}

/** What an invitation did, in a sentence. */
export function sentWords(invited: string[], already: string[]): string {
  const parts: string[] = [];
  if (invited.length) parts.push(`Invited ${listed(invited)}.`);
  if (already.length)
    parts.push(
      `${listed(already)} ${already.length === 1 ? "was" : "were"} invited or seated already.`,
    );
  return parts.join(" ") || "Nobody new to invite.";
}

function listed(names: string[]): string {
  return names.length === 1
    ? names[0]!
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
