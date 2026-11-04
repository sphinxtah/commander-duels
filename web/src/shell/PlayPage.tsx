import { useEffect, useRef, useState, type RefObject } from "react";
import type { Format, Me, PracticeFormat } from "../api";
import { PracticeTable } from "../game/PracticeTable";
import shell from "../App.module.css";
import type { Connection } from "./TopBar";
import { hoverSound, selectSound } from "./menuSound";
import styles from "./shell.module.css";

// Practice games against the bots cover these; a format that is neither one of them nor marked
// available by the server is still to come. Keyed by the API's practice formats, so a new one
// fails the type check until it is listed here.
const practiceFormats: Record<PracticeFormat["id"], true> = {
  commander: true,
  legacy: true,
  two_headed_giant: true,
};
export function comingSoon(format: Format | undefined): boolean {
  return Boolean(
    format && !format.available && !(format.id in practiceFormats),
  );
}
/** A playable version with known gaps, marked "Early": Two-Headed Giant from v0.5.0 until v0.6.1,
 * which gave teams their priority and their choices; no format since. */
export function early(format: Format | undefined): boolean {
  return Boolean(format?.early) && !comingSoon(format);
}
/** What a format's details say of how to play it, beyond the general way in. */
const howToPlay: Record<string, string> = {
  two_headed_giant:
    "Two teams of two, with Legacy decks: with a bot teammate at the practice table here; or, from Tables, in the queue, alone or with a friend, and at a table for four players, or players with bots as teammates or opponents. Your team takes its turns together, holds priority together, attacks and blocks together, shares one life total and wins together.",
};
const symbols: Record<string, string> = {
  commander: "♜",
  legacy: "⚔",
  two_headed_giant: "♜♜",
};
const players: Record<string, string> = {
  commander: "2–4 PLAYERS",
  legacy: "2 PLAYERS",
  two_headed_giant: "2 × 2 PLAYERS",
};

/**
 * Play (v0.4.5; the first page until then): since v0.8.7 for the bots alone, the practice table
 * and the formats, those not built yet marked "Coming soon". The owner's banner left it in
 * v0.8.7, and "Find a game" in the public queues moved to Tables.
 */
export function PlayPage({
  me,
  formats,
  connection,
  onRetry,
  heading,
}: {
  me: Me;
  formats: Format[];
  connection: Connection;
  onRetry: () => void;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState<Format>();
  useEffect(() => {
    if (selected) dialog.current?.showModal();
  }, [selected]);
  return (
    <>
      <header className={styles.playHead}>
        <span className={styles.kicker}>Versus the bots</span>
        <h1 id="page-title" ref={heading} tabIndex={-1}>
          Battle the bots.
        </h1>
        <p>
          Practice against the bots in Legacy, Commander or Two-Headed Giant,
          with your own decks, at the skill you choose. To play other people,
          find a game or sit down at a table in{" "}
          <a href="#tables" onClick={selectSound}>
            Tables
          </a>
          .
        </p>
      </header>
      <div id="practice" className={styles.practice}>
        <PracticeTable me={me} />
      </div>
      <section
        id="formats"
        className={styles.formats}
        aria-labelledby="formats-title"
      >
        <div className={styles.sectionHeading}>
          <span className={styles.kicker}>Find your way to play</span>
          <h2 id="formats-title">Formats</h2>
        </div>
        {connection === "loading" && (
          <p role="status">Loading format information…</p>
        )}
        {connection === "unavailable" && (
          <div className={shell.notice}>
            <strong>The application service is unavailable.</strong>
            <p>Format information will appear when the service reconnects.</p>
            <button onClick={onRetry}>Retry connection</button>
          </div>
        )}
        {connection === "connected" && (
          <div className={styles.formatGrid}>
            {formats.map((format) => (
              <article
                key={format.id}
                className={styles.formatCard}
                data-format={format.id}
                onPointerEnter={() => hoverSound()}
              >
                <div className={styles.formatTop}>
                  <span className={styles.formatSymbol} aria-hidden="true">
                    {symbols[format.id] ?? "◇"}
                  </span>
                  <span>{players[format.id] ?? ""}</span>
                </div>
                <h3>{format.name}</h3>
                <p>{format.description}</p>
                <div className={styles.formatFoot}>
                  {comingSoon(format) ? (
                    <span className={shell.tag} data-tone="soon">
                      Coming soon
                    </span>
                  ) : early(format) ? (
                    <span className={shell.tag} data-tone="early">
                      Early
                    </span>
                  ) : (
                    <span className={shell.tag} data-tone="open">
                      Open to play
                    </span>
                  )}
                  <button onClick={() => setSelected(format)}>
                    About this format <span aria-hidden="true">↗</span>
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
      <dialog
        ref={dialog}
        className={shell.dialog}
        onClose={() => setSelected(undefined)}
        aria-labelledby="format-dialog-title"
      >
        <button
          className={shell.close}
          aria-label="Close format details"
          onClick={() => dialog.current?.close()}
        >
          ×
        </button>
        <span className={shell.eyebrow}>
          {comingSoon(selected)
            ? "COMING SOON"
            : early(selected)
              ? "EARLY"
              : "OPEN TO PLAY"}
        </span>
        <h2 id="format-dialog-title">{selected?.name}</h2>
        <p>{selected?.description}</p>
        <p>
          {selected?.seats.join(", ")} seats. Default table:{" "}
          {selected?.default_seats} players.
        </p>
        <p>
          {comingSoon(selected)
            ? `${selected?.name} is coming soon.`
            : ((selected && howToPlay[selected.id]) ??
              "Start a practice game against the bots from the practice table here, or play other people from Tables: find a game in the queue, or open a table.")}
        </p>
        <button
          className={shell.primary}
          onClick={() => dialog.current?.close()}
        >
          Back to Play
        </button>
      </dialog>
    </>
  );
}
