import { useEffect, useState } from "react";
import { client, describe } from "../api";
import account from "../Account.module.css";
import { hudChanged } from "../shell/hud";
import { tokens } from "../tokens/tokens";
import { Badge } from "./Badge";
import {
  groupNames,
  PINS,
  type Achievements,
  type AchievementView,
  type BadgeGroup,
} from "./records";
import styles from "./records.module.css";

// Profile's achievements (v0.5.0, PROG07): every one, earned or not, by group, with the way to
// each and its one-time reward. Earned ones are badges, and up to three are pinned to the
// profile, in the order chosen. Looking here earns what the account's games already qualify for,
// so the top bar's tokens are asked for again when it paid.

function when(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium" });
}

function pinnedOf(shown: Achievements): string[] {
  return shown.achievements
    .filter((item) => item.pin)
    .sort((one, other) => (one.pin ?? 0) - (other.pin ?? 0))
    .map((item) => item.id);
}

function Item({
  item,
  pinsFull,
  busy,
  onPin,
}: {
  item: AchievementView;
  pinsFull: boolean;
  busy: boolean;
  onPin: (item: AchievementView) => void;
}) {
  const earned = Boolean(item.earned_at);
  const pinned = Boolean(item.pin);
  return (
    <li
      className={styles.achievement}
      data-earned={earned || undefined}
      data-pinned={pinned || undefined}
    >
      <Badge group={item.group} earned={earned} size={48} />
      <span className={styles.achievementWords}>
        <strong>{item.name}</strong>
        <small>{item.description}</small>
        {earned ? (
          <small>
            Earned {when(item.earned_at!)} · {tokens(item.tokens)}
          </small>
        ) : (
          <>
            <small>
              {item.target > 1 &&
                `${item.progress.toLocaleString("en-US")} of ${item.target.toLocaleString("en-US")} · `}
              Pays {tokens(item.tokens)}
            </small>
            {item.target > 1 && (
              <span
                className={styles.progress}
                role="progressbar"
                aria-label={`${item.name}: progress`}
                aria-valuemin={0}
                aria-valuemax={item.target}
                aria-valuenow={item.progress}
              >
                <span
                  style={{ width: `${(item.progress / item.target) * 100}%` }}
                />
              </span>
            )}
          </>
        )}
        {item.addition && (
          <span className={styles.addition}>Commander and Legacy addition</span>
        )}
      </span>
      {earned && (
        <button
          type="button"
          className={styles.pin}
          aria-pressed={pinned}
          aria-label={`${pinned ? "Unpin" : "Pin"} ${item.name}`}
          disabled={busy || (!pinned && pinsFull)}
          onClick={() => onPin(item)}
        >
          {pinned ? `Pinned ${item.pin}` : "Pin"}
        </button>
      )}
    </li>
  );
}

export function AchievementsPanel() {
  const [shown, setShown] = useState<Achievements>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");

  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/me/achievements")
      .then(({ data, error: refused }) => {
        if (!active) return;
        if (!data) return setError(describe(refused));
        setShown(data);
        if (data.paid > 0) hudChanged();
      })
      .catch(() => active && setError(describe(undefined)));
    return () => {
      active = false;
    };
  }, []);

  async function pin(item: AchievementView) {
    if (!shown) return;
    const before = pinnedOf(shown);
    const wanted = item.pin
      ? before.filter((id) => id !== item.id)
      : [...before, item.id].slice(0, PINS);
    setBusy(true);
    setError("");
    setSaid("");
    try {
      const { data, error: refused } = await client.PUT(
        "/api/v1/me/achievements/pinned",
        { body: { achievements: wanted } },
      );
      if (!data) return setError(describe(refused));
      setShown(data);
      setSaid(
        item.pin
          ? `${item.name} is no longer pinned.`
          : `${item.name} is pinned to your profile.`,
      );
    } catch {
      setError(describe(undefined));
    } finally {
      setBusy(false);
    }
  }

  const groups: BadgeGroup[] = [];
  for (const item of shown?.achievements ?? [])
    if (!groups.includes(item.group)) groups.push(item.group);
  const pinsFull = shown ? pinnedOf(shown).length >= PINS : false;

  return (
    <section className={account.panel} aria-labelledby="achievements-title">
      <h2 id="achievements-title">Achievements</h2>
      {error && (
        <p role="alert" className={account.error}>
          {error}
        </p>
      )}
      {shown && (
        <>
          <p className={account.fine}>
            {shown.earned} of {shown.achievements.length} earned. Each pays its
            reward once, from the games the server recorded. Pin up to {PINS}{" "}
            badges to show them first on your profile.
          </p>
          {groups.map((group) => (
            <div key={group}>
              <p className={styles.group} aria-hidden="true">
                {groupNames[group]}
              </p>
              <ul
                className={styles.achievements}
                aria-label={groupNames[group]}
              >
                {shown.achievements
                  .filter((item) => item.group === group)
                  .map((item) => (
                    <Item
                      key={item.id}
                      item={item}
                      pinsFull={pinsFull}
                      busy={busy}
                      onPin={(chosen) => void pin(chosen)}
                    />
                  ))}
              </ul>
            </div>
          ))}
        </>
      )}
      <p className={account.fine} role="status">
        {said}
      </p>
    </section>
  );
}
