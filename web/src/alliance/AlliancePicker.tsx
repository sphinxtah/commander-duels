import { useId, useState } from "react";
import type { Planeswalker } from "../api";
import { byTier, playableWords, tierNames, wins } from "./alliance";
import { AlliancePreview } from "./AlliancePreview";
import { Portrait } from "./Portrait";
import { TierBadge } from "./TierBadge";
import styles from "./alliance.module.css";

/**
 * Every Planeswalker, grouped by tier (v0.3.1). The current alliance is marked; the locked ones
 * show the wins that open them. Since v0.6.2 every tile is a button ("See Rowan's cards") that
 * opens the Planeswalker's cards, where "Begin Alliance with Rowan" allies with an open one.
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
  const [shown, setShown] = useState<Planeswalker | null>(null);
  return (
    <div className={styles.tiers}>
      <AlliancePreview
        planeswalker={shown}
        current={current}
        busy={busy}
        onAlly={onAlly}
        onClose={() => setShown(null)}
      />
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
                const allied = planeswalker.id === current;
                const locked = !planeswalker.open && !allied;
                return (
                  <li key={planeswalker.id}>
                    {/* The notes, then the portrait's description, are read after the name. */}
                    <button
                      type="button"
                      className={styles.tile}
                      data-current={allied ? "" : undefined}
                      data-locked={locked ? "" : undefined}
                      aria-label={`See ${planeswalker.name}'s cards`}
                      aria-haspopup="dialog"
                      aria-describedby={
                        planeswalker.description
                          ? `${about} ${about}-portrait`
                          : about
                      }
                      onClick={() => setShown(planeswalker)}
                    >
                      <Portrait
                        id={planeswalker.id}
                        name={planeswalker.name}
                        description={planeswalker.description}
                        portrait={planeswalker.portrait}
                        size={96}
                        thumbnail
                        decorative
                      />
                      <strong>{planeswalker.name}</strong>
                      <span id={about} className={styles.tileNotes}>
                        {allied ? (
                          <small>Your alliance</small>
                        ) : locked ? (
                          <>
                            <small>Opens at {wins(planeswalker.wins)}</small>{" "}
                            <small>{playableWords(planeswalker)}</small>
                          </>
                        ) : (
                          <small>{playableWords(planeswalker)}</small>
                        )}
                      </span>
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
