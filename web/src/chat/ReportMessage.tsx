import { useEffect, useRef, useState, type FormEvent } from "react";
import { client, describe } from "../api";
import { reportContext, type ReportGame } from "../app/ReportProblem";
import styles from "../app/ReportProblem.module.css";

// Reporting a chat message (v0.4.4): from a friend's message or a line of a table's chat, the
// players' way to bring it to the administrators, who read a message only so (docs/chat.md). The
// server copies the message and the 20 before it that the reporter saw; the form asks only why.

/** The message a report is about, as the page shows it. */
export interface ReportedMessage {
  kind: "direct" | "table";
  id: string;
  /** Who sent it, as shown. */
  sender: string;
  body: string;
}

export function ReportMessageDialog({
  message,
  onClose,
  game,
}: {
  /** The message to report; null keeps the dialog closed. */
  message: ReportedMessage | null;
  onClose: () => void;
  /** At a table: the game and its current turn. */
  game?: ReportGame | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const done = useRef<HTMLHeadingElement>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const shown = useRef<ReportedMessage | null>(null);
  if (message) shown.current = message;
  const reported = shown.current;

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (message && !element.open) {
      setReason("");
      setError("");
      setSent(false);
      // A modal dialog: the page behind it is inert, Tab stays inside, Escape closes it.
      element.showModal?.();
    } else if (!message && element.open) element.close();
  }, [message]);
  useEffect(() => {
    if (sent) done.current?.focus();
  }, [sent]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending || !reported) return;
    setSending(true);
    setError("");
    const answer = await client.POST("/api/v1/reports", {
      body: {
        summary: `A message from ${reported.sender}`.slice(0, 120),
        description:
          reason.trim() || "Reported from the chat, with no reason given.",
        context: reportContext(game),
        message: { kind: reported.kind, id: reported.id },
      },
    });
    setSending(false);
    if (answer.data) setSent(true);
    else setError(describe(answer.error));
  }

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="report-message-title"
      onClose={onClose}
    >
      {sent ? (
        <div className={styles.sent}>
          <h2 id="report-message-title" ref={done} tabIndex={-1}>
            Thank you. The message was reported.
          </h2>
          <p className={styles.fine}>
            The site's administrators will read it. You can also block the
            player from their profile.
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              onClick={() => dialog.current?.close()}
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <h2 id="report-message-title">Report a message</h2>
          {reported && (
            <blockquote className={styles.fine} data-reported-message="">
              <strong>{reported.sender}:</strong> {reported.body}
            </blockquote>
          )}
          <label className={styles.field}>
            <span>Why are you reporting it? (optional)</span>
            <textarea
              value={reason}
              maxLength={4000}
              rows={4}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <p className={styles.fine}>
            We'll send the message and the 20 messages before it that you saw.
            Only the site's administrators read reports.
          </p>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <div className={styles.actions}>
            <button type="submit" className={styles.primary} disabled={sending}>
              {sending ? "Sending…" : "Report the message"}
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => dialog.current?.close()}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      <button
        type="button"
        className={styles.close}
        aria-label="Close"
        onClick={() => dialog.current?.close()}
      >
        ×
      </button>
    </dialog>
  );
}
