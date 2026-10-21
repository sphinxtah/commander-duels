import { useId } from "react";
import type { Planeswalker } from "../api";
import { byTier, playableWords, tierNames, wins } from "./alliance";
import { Portrait } from "./Portrait";
import { TierBadge } from "./TierBadge";
import styles from "./alliance.module.css";

/**
 * Every Planeswalker, grouped by tier (v0.3.1). The ones the account's tier has opened are
 * buttons, each named for what it does ("Ally with Rowan"); the current alliance is marked; the
 * locked ones show the wins that open them.
 */
export function AlliancePicker({
  roster,
  current,
  busy,
  onAlly,
}: {
  roster: Planeswalker[];
  /** The allied Planeswalker's ID, if any. */
  current: string | null | undefined;
  /** A change is on its way: the buttons wait for it. */
  busy: boolean;
  onAlly: (planeswalker: Planeswalker) => void;
}) {
  const prefix = `picker${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <div className={styles.tiers}>
      {byTier(roster).map(({ tier, planeswalkers }) => {
        const threshold = planeswalkers[0]!.wins;
        const open = planeswalkers.some((found) => found.open);
        const headingId = `${prefix}-${tier}`;
        return (
          <section
            key={tier}
            className={styles.tierGroup}
            aria-labelledby={headingId}
          >
            <h3 id={headingId} className={styles.tierHeading}>
              <TierBadge tier={tier} size={28} decorative />
              <span>{tierNames[tier]}</span>
              <small>
                {open
                  ? threshold === 0
                    ? "Open from the start"
                    : `Open · from ${wins(threshold)}`
                  : `Opens at ${wins(threshold)}`}
              </small>
            </h3>
            <ul className={styles.roster}>
              {planeswalkers.map((planeswalker) => {
                const about = `${prefix}-${planeswalker.id}`;
                const portrait = (
                  <Portrait
                    id={planeswalker.id}
                    name={planeswalker.name}
                    description={planeswalker.description}
                    portrait={planeswalker.portrait}
                    size={96}
                    thumbnail
                    decorative
                  />
                );
                if (planeswalker.id === current)
                  return (
                    <li key={planeswalker.id}>
                      <div className={styles.tile} data-current="">
                        {portrait}
                        <strong>{planeswalker.name}</strong>
                        <small>Your alliance</small>
                      </div>
                    </li>
                  );
                if (!planeswalker.open)
                  return (
                    <li key={planeswalker.id}>
                      <div className={styles.tile} data-locked="">
                        {portrait}
                        <strong>{planeswalker.name}</strong>
                        <small>Opens at {wins(planeswalker.wins)}</small>
                        <small>{playableWords(planeswalker)}</small>
                      </div>
                    </li>
                  );
                return (
                  <li key={planeswalker.id}>
                    {/* aria-disabled while a change is on its way: a disabled button loses
                        keyboard focus. The portrait's description is read after the name. */}
                    <button
                      type="button"
                      className={styles.tile}
                      aria-label={`Ally with ${planeswalker.name}`}
                      aria-describedby={
                        planeswalker.description
                          ? `${about} ${about}-portrait`
                          : about
                      }
                      aria-disabled={busy}
                      onClick={() => {
                        if (!busy) onAlly(planeswalker);
                      }}
                    >
                      {portrait}
                      <strong>{planeswalker.name}</strong>
                      <small id={about}>{playableWords(planeswalker)}</small>
                      {planeswalker.description && (
                        <span
                          id={`${about}-portrait`}
                          className={styles.visuallyHidden}
                        >
                          {planeswalker.description}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
