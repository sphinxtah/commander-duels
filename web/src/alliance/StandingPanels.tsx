import { useState, type RefObject } from "react";
import {
  client,
  describe,
  loadMe,
  type Me,
  type Planeswalker,
  type Progress,
} from "../api";
import { playableWords, wins } from "./alliance";
import { AlliancePicker } from "./AlliancePicker";
import { Portrait } from "./Portrait";
import type { useStanding } from "./useStanding";
import styles from "./alliance.module.css";
import account from "../Account.module.css";
import shell from "../App.module.css";

type Standing = ReturnType<typeof useStanding>;

function when(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" })
    : "";
}

/** The account's wins, its tier, and how far it has to go to the next one. */
export function ProgressPanel({ progress }: { progress: Progress }) {
  const next = progress.next_tier;
  const span = next ? next.wins - progress.tier.wins : 1;
  const done = next
    ? Math.max(0, Math.min(progress.wins - progress.tier.wins, span))
    : 1;
  const set = progress.set_wins;
  return (
    <section className={account.panel} aria-labelledby="progress-title">
      <h2 id="progress-title">Your progress</h2>
      <p className={styles.standing}>
        <strong>{progress.tier.name} tier</strong>
        <span>{wins(progress.wins)}</span>
      </p>
      {/* SysOp's settings are kept apart from the games won, and said apart here. */}
      {set !== 0 && (
        <p className={account.fine}>
          {wins(progress.counted_wins)} from games · {set > 0 ? "+" : "−"}
          {Math.abs(set).toLocaleString("en-US")} set by SysOp
        </p>
      )}
      {next ? (
        <>
          <div
            className={styles.bar}
            role="progressbar"
            aria-label={`Progress to ${next.name}`}
            aria-valuemin={0}
            aria-valuemax={span}
            aria-valuenow={done}
            aria-valuetext={`${wins(progress.wins)} of ${wins(next.wins)}`}
          >
            <span style={{ width: `${(done / span) * 100}%` }} />
          </div>
          <p className={account.fine}>
            {(next.wins - progress.wins).toLocaleString("en-US")} more{" "}
            {next.wins - progress.wins === 1 ? "win" : "wins"} to reach{" "}
            {next.name} at {wins(next.wins)}.
          </p>
        </>
      ) : (
        <p className={account.fine}>
          {progress.tier.name} is the highest tier: every Planeswalker is open
          to you.
        </p>
      )}
    </section>
  );
}

/** What an alliance does, said plainly wherever one is chosen. */
function AllianceRules() {
  return (
    <p className={account.fine}>
      An alliance brings that Planeswalker's own Planeswalker cards into your
      library: a playset, four copies of each. Leaving the alliance, or joining
      another, takes them out again, except copies you own another way, such as
      from your starter decks; a deck that needs them cannot start a game until
      you change it. You can switch at any time, and the Planeswalker's portrait
      becomes your picture.
    </p>
  );
}

/**
 * Joining, switching and leaving an alliance. One per account's page, so what it says stays when
 * the choice made right after the starter decks gives way to the profile.
 */
export function useAllianceChange(
  me: Me,
  onChange: (me: Me) => void,
  standing: Standing,
) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function change(planeswalker: Planeswalker | null): Promise<boolean> {
    if (busy) return false;
    const before = standing.roster?.find((found) => found.id === me.alliance);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const { data, error: refused } = planeswalker
        ? await client.PUT("/api/v1/me/alliance", {
            body: { planeswalker: planeswalker.id },
          })
        : await client.DELETE("/api/v1/me/alliance");
      if (!data) {
        setError(describe(refused));
        return false;
      }
      standing.setProgress(data);
      // The account's picture follows its alliance everywhere: the account is asked for again,
      // and if that fails the page goes on with the alliance the server just confirmed.
      let current: Me | null = null;
      try {
        current = await loadMe();
      } catch {
        // Kept below.
      }
      onChange(current ?? { ...me, alliance: data.alliance });
      setMessage(
        planeswalker
          ? planeswalker.playable_cards > 0
            ? `You are allied with ${planeswalker.name}. Their Planeswalker cards are in your library, four copies of each.`
            : `You are allied with ${planeswalker.name}. None of their cards can be played here yet.`
          : `You left the alliance${before ? ` with ${before.name}` : ""}. Their cards have left your library, except copies you own another way.`,
      );
      return true;
    } catch {
      setError(describe(undefined));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, message, error, change };
}

type AllianceChange = ReturnType<typeof useAllianceChange>;

/** Profile's alliance: the current one with its portrait, Leave, and the picker on request. */
export function AlliancePanel({
  me,
  standing,
  alliance,
  heading,
}: {
  me: Me;
  standing: Standing;
  alliance: AllianceChange;
  /** Focused when the page arrives here from the choice after the starter decks. */
  heading?: RefObject<HTMLHeadingElement | null>;
}) {
  const [picking, setPicking] = useState(false);
  const current = me.alliance
    ? standing.roster?.find((found) => found.id === me.alliance)
    : undefined;
  return (
    <section className={account.panel} aria-labelledby="alliance-title">
      <h2 id="alliance-title" ref={heading} tabIndex={-1}>
        Your alliance
      </h2>
      {me.alliance && current ? (
        <div className={styles.current}>
          <Portrait
            id={current.id}
            name={current.name}
            description={current.description}
            portrait={current.portrait}
            size={144}
          />
          <div>
            <strong>{current.name}</strong>
            <span>
              {playableWords(current)}
              {standing.progress?.alliance_since &&
                ` · allied since ${when(standing.progress.alliance_since)}`}
            </span>
            <button
              type="button"
              className={account.secondary}
              aria-disabled={alliance.busy}
              onClick={() => void alliance.change(null)}
            >
              Leave the alliance with {current.name}
            </button>
          </div>
        </div>
      ) : (
        !me.alliance && (
          <p className={account.fine}>
            You are in no alliance yet, so your profile shows your avatar.
          </p>
        )
      )}
      <AllianceRules />
      <p role="status" className={account.fine}>
        {alliance.message}
      </p>
      {/* A roster that did not arrive is said once, above, where Try again asks for it. */}
      {alliance.error && (
        <p role="alert" className={account.error}>
          {alliance.error}
        </p>
      )}
      {standing.roster && (
        <>
          <button
            type="button"
            className={account.secondary}
            aria-expanded={picking}
            aria-controls="alliance-picker"
            onClick={() => setPicking((value) => !value)}
          >
            {picking
              ? "Hide the Planeswalkers"
              : me.alliance
                ? "Change your alliance"
                : "Choose an alliance"}
          </button>
          <div id="alliance-picker" hidden={!picking}>
            {picking && (
              <AlliancePicker
                roster={standing.roster}
                current={me.alliance}
                busy={alliance.busy}
                onAlly={(planeswalker) => void alliance.change(planeswalker)}
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Right after the starter decks: an alliance to choose now, or Later. Skipping keeps nothing on
 * the server; the profile offers the choice again whenever the player wants it.
 */
export function AllianceOffer({
  standing,
  alliance,
  onDone,
  heading,
}: {
  standing: Standing;
  alliance: AllianceChange;
  onDone: () => void;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <section className={account.panel} aria-labelledby="offer-title">
      <h2 id="offer-title" ref={heading} tabIndex={-1}>
        Choose an alliance
      </h2>
      <p className={account.fine}>
        Your starter decks are in your library. Now ally with one of the
        Planeswalkers your tier has opened: their cards join your library while
        the alliance lasts, and their portrait becomes your picture. You can
        also choose later on your profile.
      </p>
      <AllianceRules />
      {alliance.error && (
        <p role="alert" className={account.error}>
          {alliance.error}
        </p>
      )}
      {standing.error && !standing.roster && (
        <>
          <p role="alert" className={account.error}>
            {standing.error}
          </p>
          <button
            type="button"
            className={account.secondary}
            onClick={standing.reload}
          >
            Try again
          </button>
        </>
      )}
      <div className={styles.offerActions}>
        <button type="button" className={shell.primary} onClick={onDone}>
          Later
        </button>
      </div>
      {standing.roster ? (
        <AlliancePicker
          roster={standing.roster}
          current={null}
          busy={alliance.busy}
          onAlly={(planeswalker) =>
            void alliance.change(planeswalker).then((done) => {
              if (done) onDone();
            })
          }
        />
      ) : (
        !standing.error && (
          <p role="status" className={account.fine}>
            Loading the Planeswalkers…
          </p>
        )
      )}
    </section>
  );
}
