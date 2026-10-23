import { useEffect, useState, type RefObject } from "react";
import { client, describe } from "../api";
import { tierNames } from "../alliance/alliance";
import { TierBadge } from "../alliance/TierBadge";
import { useChatContext } from "../chat/chat";
import { PlayerRecord } from "../records/PlayerRecord";
import { PlayerPicture, PresenceLine } from "./PlayerBits";
import type { PlayerProfile } from "./social";
import styles from "./social.module.css";

// A player's profile (#player/<id>, v0.4.3): what every player may see of them, their handle,
// portrait, tier, wins and first day; their presence when they share it; and what is between the
// two accounts. Friends are mutual: Add friend sends a request that waits ("Pending") until the
// other player accepts it, here or from the bell, or adds back. Blocking ends any friendship or
// request, and the blocked player no longer sees this account's presence or finds it. Since
// v0.5.0 the page shows the player's badges and record too (records/PlayerRecord.tsx).

type Action =
  "add" | "accept" | "withdraw" | "decline" | "remove" | "block" | "unblock";

const done: Record<Action, (handle: string) => string> = {
  add: (handle) => `Friend request sent to ${handle}.`,
  accept: (handle) => `You and ${handle} are friends.`,
  withdraw: () => "Request withdrawn.",
  decline: () => "Request declined.",
  remove: (handle) => `You and ${handle} are no longer friends.`,
  block: (handle) => `${handle} is blocked.`,
  unblock: (handle) => `${handle} is no longer blocked.`,
};

export function PlayerPage({
  playerId,
  heading,
}: {
  playerId: string;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const [profile, setProfile] = useState<PlayerProfile | null>();
  const [error, setError] = useState("");
  const [said, setSaid] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<"remove" | "block" | null>(null);
  // Friends write to each other (v0.4.4): Message opens a docked window.
  const chat = useChatContext();

  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/players/{player_id}", {
        params: { path: { player_id: playerId } },
      })
      .then(({ data, error, response }) => {
        if (!active) return;
        if (data) setProfile(data);
        else if (response.status === 404) setProfile(null);
        else setError(describe(error));
      });
    return () => {
      active = false;
    };
  }, [playerId]);

  async function act(action: Action) {
    setBusy(true);
    setError("");
    setSaid("");
    setConfirming(null);
    const path = { params: { path: { player_id: playerId } } };
    const { data, error } =
      action === "add" || action === "accept"
        ? await client.PUT("/api/v1/friends/{player_id}", path)
        : action === "block"
          ? await client.PUT("/api/v1/blocks/{player_id}", path)
          : action === "unblock"
            ? await client.DELETE("/api/v1/blocks/{player_id}", path)
            : await client.DELETE("/api/v1/friends/{player_id}", path);
    setBusy(false);
    if (!data) return setError(describe(error));
    setProfile(data);
    setSaid(done[action](data.handle));
  }

  if (profile === undefined && !error)
    return (
      <>
        <span className={styles.eyebrow}>PLAYER</span>
        <h1 ref={heading} tabIndex={-1}>
          Loading player…
        </h1>
      </>
    );
  if (!profile)
    return (
      <>
        <span className={styles.eyebrow}>PLAYER</span>
        <h1 ref={heading} tabIndex={-1}>
          {profile === null ? "No such player" : "This player could not load"}
        </h1>
        <p className={styles.lead}>
          {profile === null
            ? "This player is not here: the link may be wrong, or the account was removed."
            : error}
        </p>
        <a className={styles.backLink} href="#friends">
          <span aria-hidden="true">←</span> Your friends
        </a>
      </>
    );

  const since = new Date(profile.member_since).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  return (
    <>
      <span className={styles.eyebrow}>PLAYER</span>
      <section className={styles.profile} aria-labelledby="player-title">
        <PlayerPicture player={profile} size={112} />
        <div className={styles.profileText}>
          <h1 id="player-title" ref={heading} tabIndex={-1}>
            {profile.handle}
          </h1>
          <p className={styles.tierLine}>
            <TierBadge tier={profile.tier.id} size={28} decorative />
            <span>
              {tierNames[profile.tier.id]} ·{" "}
              {profile.wins === 1
                ? "1 win"
                : `${profile.wins.toLocaleString("en-US")} wins`}{" "}
              · Playing since {since}
            </span>
          </p>
          <PresenceLine presence={profile.presence} />
          {profile.friendship === "friends" && (
            <p className={styles.friendsTag}>
              <span aria-hidden="true">✓</span> Friends
            </p>
          )}
        </div>
      </section>

      {profile.you ? (
        <p className={styles.lead}>
          This is your profile as other players see it. Your name, picture and
          privacy settings are on <a href="#profile">your Profile</a>.
        </p>
      ) : (
        <div className={styles.actions}>
          {profile.blocked ? (
            <>
              <p className={styles.quiet}>
                You have blocked {profile.handle}. They don't see whether you
                are online and can't find you in the search.
              </p>
              <button
                type="button"
                className={styles.secondary}
                disabled={busy}
                onClick={() => void act("unblock")}
              >
                Unblock
              </button>
            </>
          ) : (
            <>
              {profile.friendship === "none" && (
                <button
                  type="button"
                  className={styles.primary}
                  disabled={busy}
                  onClick={() => void act("add")}
                >
                  Add friend
                </button>
              )}
              {profile.friendship === "requested" && (
                <>
                  <span className={styles.pending}>Pending</span>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={busy}
                    onClick={() => void act("withdraw")}
                  >
                    Withdraw request
                  </button>
                </>
              )}
              {profile.friendship === "requested_you" && (
                <>
                  <span className={styles.quiet}>
                    {profile.handle} wants to be your friend.
                  </span>
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={busy}
                    onClick={() => void act("accept")}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className={styles.secondary}
                    disabled={busy}
                    onClick={() => void act("decline")}
                  >
                    Decline
                  </button>
                </>
              )}
              {profile.friendship === "friends" &&
                (confirming === "remove" ? (
                  <>
                    <span className={styles.quiet}>
                      Remove {profile.handle} from your friends?
                    </span>
                    <button
                      type="button"
                      className={styles.danger}
                      disabled={busy}
                      onClick={() => void act("remove")}
                    >
                      Remove friend
                    </button>
                    <button
                      type="button"
                      className={styles.secondary}
                      onClick={() => setConfirming(null)}
                    >
                      Keep
                    </button>
                  </>
                ) : (
                  <>
                    {chat && (
                      <button
                        type="button"
                        className={styles.primary}
                        onClick={() => chat.open(profile.id)}
                      >
                        Message
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() => setConfirming("remove")}
                    >
                      Remove friend
                    </button>
                  </>
                ))}
              {confirming === "block" ? (
                <div className={styles.confirm}>
                  <p>
                    Block {profile.handle}? Any friendship or request between
                    you ends. They won't see whether you are online or find you
                    in the search, and their requests won't reach you. You can
                    unblock them from here or from your Profile.
                  </p>
                  <button
                    type="button"
                    className={styles.danger}
                    disabled={busy}
                    onClick={() => void act("block")}
                  >
                    Block {profile.handle}
                  </button>
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => setConfirming(null)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                confirming !== "remove" && (
                  <button
                    type="button"
                    className={styles.quietButton}
                    disabled={busy}
                    onClick={() => setConfirming("block")}
                  >
                    Block
                  </button>
                )
              )}
            </>
          )}
        </div>
      )}
      {error && (
        <p className={styles.rowError} role="alert">
          {error}
        </p>
      )}
      <p className={styles.said} role="status">
        {said}
      </p>
      {/* Badges and totals for everyone, games one by one for the player and SysOp (v0.5.0). */}
      <PlayerRecord playerId={profile.id} handle={profile.handle} />
    </>
  );
}
