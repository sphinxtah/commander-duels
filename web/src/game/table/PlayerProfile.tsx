import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { client, describe } from "../../api";
import { reportContext } from "../../app/ReportProblem";
import type { components } from "../../generated/api";
import { OFFICIAL_BACK } from "../cardBack";
import styles from "./profile.module.css";

type Profile = components["schemas"]["PlayerProfile"];

/**
 * Another player's profile at the table (v0.8.9): a click on their name opens it small, over the
 * game, with the card sleeve their deck shows here, which anyone at the table may report (the
 * owner, 2026-11-06: "a simple way to click on another player and get a small popup of their
 * profile, where the inappropriate images can be reported").
 */
export function PlayerProfileButton({
  name,
  playerId,
  sleeve,
  gameId,
  className,
  style,
  title,
  align,
}: {
  name: string;
  playerId: string;
  sleeve: string | null;
  gameId: string | null;
  className?: string;
  style?: CSSProperties;
  title?: string;
  align?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<Profile>();
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const sleeveId = sleeve?.match(/^\/api\/v1\/sleeves\/([^/]+)\/image$/)?.[1];

  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    if (element && !element.open) element.showModal?.();
    let active = true;
    void client
      .GET("/api/v1/players/{player_id}", {
        params: { path: { player_id: playerId } },
      })
      .then(({ data }) => active && data && setProfile(data))
      .catch(() => {
        // The name and the sleeve still show.
      });
    return () => {
      active = false;
    };
  }, [open, playerId]);

  function close() {
    dialog.current?.close();
  }

  async function report(event: FormEvent) {
    event.preventDefault();
    if (!sleeveId) return;
    setBusy(true);
    setError("");
    try {
      const { data, error: refused } = await client.POST("/api/v1/reports", {
        body: {
          summary: `Card sleeve reported: ${name}`,
          description:
            reason.trim() || "This card sleeve does not belong at a table.",
          context: reportContext(gameId ? { id: gameId, turn: null } : null),
          sleeve: sleeveId,
        },
      });
      if (!data) return setError(describe(refused));
      setReporting(false);
      setReason("");
      setMessage("Reported. A moderator will look at the sleeve.");
    } catch {
      setError(describe(undefined));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={className}
        style={style}
        title={title}
        data-align={align}
        aria-haspopup="dialog"
        onClick={() => {
          setMessage("");
          setError("");
          setOpen(true);
        }}
      >
        {name}
      </button>
      {open && (
        <dialog
          ref={dialog}
          className={styles.profile}
          aria-labelledby="table-profile-title"
          onClose={() => {
            setOpen(false);
            setReporting(false);
          }}
        >
          <button
            type="button"
            className={styles.close}
            aria-label="Close"
            onClick={close}
          >
            ×
          </button>
          <h2 id="table-profile-title">{profile?.handle ?? name}</h2>
          {profile?.title && <p className={styles.title}>{profile.title}</p>}
          {profile && (
            <p className={styles.fine}>
              {profile.wins.toLocaleString("en-US")}{" "}
              {profile.wins === 1 ? "win" : "wins"} · playing since{" "}
              {new Date(profile.member_since).toLocaleDateString()}
            </p>
          )}
          <figure className={styles.sleeve}>
            <img
              src={sleeve ?? OFFICIAL_BACK}
              alt={sleeve ? `${name}'s card sleeve` : "The official card back"}
              width={126}
              height={176}
            />
            <figcaption>
              {sleeveId
                ? "Their card sleeve"
                : sleeve?.startsWith("/brand/sleeves/")
                  ? "A default sleeve"
                  : sleeve
                    ? "A campaign card back"
                    : "The official card back"}
            </figcaption>
          </figure>
          <p className={styles.actions}>
            <a href={`#player/${playerId}`} onClick={close}>
              Open their profile
            </a>
            {sleeveId && !reporting && (
              <button
                type="button"
                className={styles.report}
                onClick={() => setReporting(true)}
              >
                Report this sleeve
              </button>
            )}
          </p>
          {reporting && (
            <form onSubmit={(event) => void report(event)}>
              <label className={styles.field}>
                <span>What is wrong with it? (optional)</span>
                <textarea
                  rows={3}
                  maxLength={4000}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <p className={styles.actions}>
                <button type="submit" className={styles.report} disabled={busy}>
                  {busy ? "Sending…" : "Send the report"}
                </button>
                <button type="button" onClick={() => setReporting(false)}>
                  Cancel
                </button>
              </p>
            </form>
          )}
          {message && (
            <p role="status" className={styles.fine}>
              {message}
            </p>
          )}
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
        </dialog>
      )}
    </>
  );
}
