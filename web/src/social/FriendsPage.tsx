import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { client, describe } from "../api";
import { useChatContext } from "../chat/chat";
import { tierNames } from "../alliance/alliance";
import { PlayerPicture, PresenceLine } from "./PlayerBits";
import {
  playerLink,
  presenceRank,
  type FriendList,
  type PlayerSummary,
} from "./social";
import styles from "./social.module.css";

// Your friends (#friends, v0.4.3): requests waiting for your answer, your friends with what each
// is doing (in a game first, then online, idle and offline), and your requests waiting for
// theirs. Asked again every 30 seconds while the page is shown, as presence changes.

export const FRIENDS_REFRESH_MS = 30_000;

function PlayerRow({
  player,
  children,
}: {
  player: PlayerSummary;
  children?: ReactNode;
}) {
  return (
    <li className={styles.friend}>
      <a href={playerLink(player.id)} className={styles.friendLink}>
        <PlayerPicture player={player} size={44} />
        <span>
          <strong>{player.handle}</strong>
          <small>{tierNames[player.tier.id]}</small>
          <PresenceLine presence={player.presence} />
        </span>
      </a>
      {children && <span className={styles.answer}>{children}</span>}
    </li>
  );
}

export function FriendsPage({
  heading,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const [list, setList] = useState<FriendList>();
  const [error, setError] = useState("");
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState<string>();
  // Friends write to each other (v0.4.4): Message opens a docked window.
  const chat = useChatContext();

  const load = useCallback(async () => {
    const { data, error } = await client.GET("/api/v1/friends");
    if (data) {
      setList(data);
      setError("");
    } else setError(describe(error));
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, FRIENDS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  async function answer(player: PlayerSummary, accept: boolean) {
    setBusy(player.id);
    setSaid("");
    const path = { params: { path: { player_id: player.id } } };
    const { data, error } = accept
      ? await client.PUT("/api/v1/friends/{player_id}", path)
      : await client.DELETE("/api/v1/friends/{player_id}", path);
    setBusy(undefined);
    if (!data) return setError(describe(error));
    setSaid(
      accept
        ? `You and ${player.handle} are friends.`
        : player.friendship === "requested"
          ? `Request to ${player.handle} withdrawn.`
          : `Request from ${player.handle} declined.`,
    );
    await load();
  }

  const friends = [...(list?.friends ?? [])].sort(
    (one, other) =>
      presenceRank(one.presence) - presenceRank(other.presence) ||
      one.handle.localeCompare(other.handle),
  );
  return (
    <>
      <span className={styles.eyebrow}>YOUR FRIENDS</span>
      <h1 ref={heading} tabIndex={-1}>
        Friends
      </h1>
      <p className={styles.lead}>
        Find players with the search at the top of the page, then Add friend on
        their profile. Once they accept, you see each other online and in games.
      </p>
      {error && (
        <p className={styles.rowError} role="alert">
          {error}
        </p>
      )}
      <p className={styles.said} role="status">
        {said}
      </p>
      {!list && !error && <p className={styles.quiet}>Loading…</p>}
      {list && list.incoming.length > 0 && (
        <section className={styles.panel} aria-labelledby="requests-title">
          <h2 id="requests-title">Friend requests</h2>
          <ul className={styles.friends}>
            {list.incoming.map((player) => (
              <PlayerRow key={player.id} player={player}>
                <button
                  type="button"
                  className={styles.small}
                  disabled={busy === player.id}
                  onClick={() => void answer(player, true)}
                  aria-label={`Accept ${player.handle}'s request`}
                >
                  Accept
                </button>
                <button
                  type="button"
                  className={styles.smallQuiet}
                  disabled={busy === player.id}
                  onClick={() => void answer(player, false)}
                  aria-label={`Decline ${player.handle}'s request`}
                >
                  Decline
                </button>
              </PlayerRow>
            ))}
          </ul>
        </section>
      )}
      {list && (
        <section className={styles.panel} aria-labelledby="friends-title">
          <h2 id="friends-title">
            Your friends{friends.length > 0 && ` (${friends.length})`}
          </h2>
          {friends.length === 0 ? (
            <p className={styles.quiet}>No friends yet.</p>
          ) : (
            <ul className={styles.friends}>
              {friends.map((player) => (
                <PlayerRow key={player.id} player={player}>
                  {chat && (
                    <button
                      type="button"
                      className={styles.small}
                      onClick={() => chat.open(player.id)}
                      aria-label={`Message ${player.handle}`}
                    >
                      Message
                    </button>
                  )}
                </PlayerRow>
              ))}
            </ul>
          )}
        </section>
      )}
      {list && list.outgoing.length > 0 && (
        <section className={styles.panel} aria-labelledby="sent-title">
          <h2 id="sent-title">Requests you sent</h2>
          <ul className={styles.friends}>
            {list.outgoing.map((player) => (
              <PlayerRow key={player.id} player={player}>
                <span className={styles.pending}>Pending</span>
                <button
                  type="button"
                  className={styles.smallQuiet}
                  disabled={busy === player.id}
                  onClick={() => void answer(player, false)}
                  aria-label={`Withdraw your request to ${player.handle}`}
                >
                  Withdraw
                </button>
              </PlayerRow>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
