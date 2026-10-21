import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import { client, describe, recentRequests, type ReportContext } from "../api";
import {
  base64Of,
  prepareScreenshot,
  ScreenshotError,
  SCREENSHOT_TYPES,
  sizeText,
  SMALL_BYTES,
  type Screenshot,
} from "./screenshot";
import styles from "./ReportProblem.module.css";

// "Report a problem" (v0.4.1): a summary, what happened, and an optional screenshot chosen as a
// file (a phone opens its photo library), pasted or dropped in. The page attaches the rest on
// its own and says so plainly: the page, the version, the game and turn at a table, the browser
// and screen size, and the IDs of the latest requests (docs/reports.md).

/** The game a report from the table names, and the turn it was on. */
export type ReportGame = { id: string; turn: number | null };

const ACCEPT = SCREENSHOT_TYPES.join(",");

/** What the page attaches on its own, as it is when the dialog opens. */
export function reportContext(game?: ReportGame | null): ReportContext {
  const page =
    window.location.hash.split("?")[0]?.replace(/[\u0000-\u001f]/g, "") || "#";
  const clamp = (value: number, high: number) =>
    Math.min(high, Math.max(1, Math.round(value) || 1));
  return {
    page: page.slice(0, 200),
    app_version: __APP_VERSION__,
    viewport_width: clamp(window.innerWidth, 100_000),
    viewport_height: clamp(window.innerHeight, 100_000),
    pixel_ratio: Math.min(16, window.devicePixelRatio || 1),
    game_id: game?.id ?? null,
    game_turn: game?.turn ?? null,
    requests: recentRequests(),
  };
}

/** The image a paste or a drop carries, if any. */
function imageIn(items: DataTransfer | null): File | undefined {
  if (!items) return undefined;
  for (const file of Array.from(items.files ?? []))
    if (file.type.startsWith("image/") || !file.type) return file;
  for (const item of Array.from(items.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return undefined;
}

/** A request the network never answered (api.ts's own 503), or that the proxy refused as too large. */
function refusedOnTheWay(response: Response) {
  return (
    response.status === 413 ||
    (response.status === 503 && !response.headers.has("X-Request-ID"))
  );
}

export function ReportDialog({
  open,
  onClose,
  game,
}: {
  open: boolean;
  onClose: () => void;
  /** At a table: the game and its current turn. */
  game?: ReportGame | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const done = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [context, setContext] = useState<ReportContext>();
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [shot, setShot] = useState<{ file: Blob; ready: Screenshot }>();
  const [preparing, setPreparing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  // Only the newest image counts: one chosen while another is still being read replaces it.
  const ticket = useRef(0);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement ? active : null;
      // The page as it was when the problem was seen: the game's turn of the render that opened
      // the dialog, not of a later one.
      setContext(reportContext(game));
      // A modal dialog: the page behind it is inert, Tab stays inside, Escape closes it.
      element.showModal();
    } else if (!open && element.open) element.close();
  }, [open]);
  useEffect(() => {
    if (sent) done.current?.focus();
  }, [sent]);

  function close() {
    dialog.current?.close();
  }
  function closed() {
    // A report sent leaves an empty form for the next one; one not sent keeps its draft.
    if (sent) {
      setSummary("");
      setDescription("");
      setShot(undefined);
      setSent(false);
      setNote("");
    }
    setError("");
    setDragging(false);
    // Focus goes back to what opened the dialog while that is still on screen; the caller's
    // onClose may choose another place (the table's Game menu closed as the dialog opened).
    const back = opener.current;
    opener.current = null;
    if (
      back &&
      back !== document.body &&
      back.isConnected &&
      !back.closest("[hidden]")
    )
      back.focus({ preventScroll: true });
    onClose();
  }

  async function attach(file: Blob | undefined) {
    if (!file) return;
    const mine = ++ticket.current;
    setError("");
    setPreparing(true);
    setNote("Preparing the screenshot…");
    try {
      const ready = await prepareScreenshot(file);
      if (mine !== ticket.current) return;
      setShot({ file, ready });
      setNote(
        `Screenshot attached: ${ready.width} × ${ready.height}, ${sizeText(ready.size)}.`,
      );
    } catch (failure) {
      if (mine !== ticket.current) return;
      setNote("");
      setError(
        failure instanceof ScreenshotError
          ? failure.message
          : "That image could not be read. Try another one.",
      );
    } finally {
      if (mine === ticket.current) setPreparing(false);
    }
  }
  function remove() {
    ticket.current += 1;
    setShot(undefined);
    setPreparing(false);
    setNote("Screenshot removed.");
  }

  function paste(event: ClipboardEvent<HTMLDialogElement>) {
    const file = imageIn(event.clipboardData);
    if (!file) return;
    // Text pasted with the image still goes into the field it was pasted in.
    if (!Array.from(event.clipboardData?.types ?? []).includes("text/plain"))
      event.preventDefault();
    void attach(file);
  }
  function dragOver(event: DragEvent<HTMLDialogElement>) {
    if (!Array.from(event.dataTransfer?.types ?? []).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragging(true);
  }
  function drop(event: DragEvent<HTMLDialogElement>) {
    const file = imageIn(event.dataTransfer);
    setDragging(false);
    if (!file) return;
    event.preventDefault();
    void attach(file);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending || preparing || !context) return;
    setSending(true);
    setError("");
    setNote("Sending your report…");
    const body = {
      summary: summary.trim(),
      description: description.trim(),
      context,
      screenshot: shot ? base64Of(shot.ready) : null,
    };
    let answer = await client.POST("/api/v1/reports", { body });
    // A proxy in front of the site may still take only 1 MB, or drop a large request outright:
    // the screenshot goes again, made smaller.
    if (
      !answer.data &&
      shot &&
      shot.ready.size > SMALL_BYTES &&
      refusedOnTheWay(answer.response)
    ) {
      try {
        const smaller = await prepareScreenshot(shot.file, SMALL_BYTES);
        setShot({ file: shot.file, ready: smaller });
        answer = await client.POST("/api/v1/reports", {
          body: { ...body, screenshot: base64Of(smaller) },
        });
      } catch {
        // The first answer stands.
      }
    }
    setSending(false);
    if (answer.data) {
      setSent(true);
      setNote("");
      return;
    }
    setNote("");
    setError(
      answer.response.status === 413
        ? "The screenshot is too large to send. Choose a smaller one, or send the report without it."
        : describe(answer.error),
    );
  }

  const attached = [
    "this page",
    "the version",
    ...(context?.game_id ? ["the game and turn"] : []),
    "your browser and screen size",
  ];
  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="report-title"
      data-dragging={dragging || undefined}
      onClose={closed}
      onPaste={paste}
      onDragOver={dragOver}
      onDragLeave={(event) => {
        if (event.target === dialog.current) setDragging(false);
      }}
      onDrop={drop}
    >
      {sent ? (
        <div className={styles.sent}>
          <h2 id="report-title" ref={done} tabIndex={-1}>
            Thank you. Your report was sent.
          </h2>
          <p className={styles.fine}>
            The site's administrators read every report. They may fix it in a
            later version; you will not get a reply here.
          </p>
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={close}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <h2 id="report-title">Report a problem</h2>
          <label className={styles.field}>
            <span>Summary</span>
            <input
              value={summary}
              maxLength={120}
              required
              placeholder="The board froze after I passed"
              onChange={(event) => setSummary(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>What happened? What did you expect?</span>
            <textarea
              value={description}
              maxLength={4000}
              rows={6}
              required
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <fieldset className={styles.screenshot}>
            <legend>Screenshot (optional)</legend>
            {shot ? (
              <div className={styles.preview}>
                <img
                  src={shot.ready.dataUrl}
                  alt="The screenshot to send"
                  width={shot.ready.width}
                  height={shot.ready.height}
                />
                <div>
                  <p className={styles.fine}>
                    {shot.ready.width} × {shot.ready.height} ·{" "}
                    {sizeText(shot.ready.size)}
                  </p>
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={remove}
                  >
                    Remove the screenshot
                  </button>
                </div>
              </div>
            ) : (
              <div className={styles.drop}>
                <p className={styles.fine}>
                  Choose an image, paste one (Ctrl+V or ⌘V) or drop it here.
                  PNG, JPEG or WebP; a large one is made smaller.
                </p>
                <label className={styles.choose}>
                  Choose an image…
                  <input
                    type="file"
                    accept={ACCEPT}
                    className={styles.visuallyHidden}
                    disabled={preparing}
                    onChange={(event) => {
                      void attach(event.target.files?.[0]);
                      // The same file chosen again is a change too.
                      event.target.value = "";
                    }}
                  />
                </label>
              </div>
            )}
          </fieldset>
          <p className={styles.fine}>
            We'll also send: {attached.join(", ")}, and the IDs of your last
            requests to the site. Only the site's administrators read reports.
          </p>
          <p role="status" className={styles.note}>
            {note}
          </p>
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <div className={styles.actions}>
            <button
              type="submit"
              className={styles.primary}
              disabled={sending || preparing}
            >
              {sending ? "Sending…" : "Send report"}
            </button>
            <button type="button" className={styles.secondary} onClick={close}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <button
        type="button"
        className={styles.close}
        aria-label="Close"
        onClick={close}
      >
        ×
      </button>
    </dialog>
  );
}

/** The app's way to the dialog, on every page. */
export function ReportButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        Report a problem
      </button>
      <ReportDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
