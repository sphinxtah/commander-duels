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
};
export function comingSoon(format: Format | undefined): boolean {
  return Boolean(
    format && !format.available && !(format.id in practiceFormats),
  );
}
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
 * Play (v0.4.5; the first page until then): the owner's banner, the practice table against the
 * bots, and the formats, those not built yet marked "Coming soon".
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
      <section className={styles.playHero} aria-labelledby="page-title">
        <picture className={styles.playBanner}>
          <source
            media="(max-width: 600px)"
            srcSet="/brand/banner-logo-640.webp"
            width={640}
            height={584}
          />
          <source
            media="(max-width: 1100px)"
            srcSet="/brand/banner-960.webp"
            width={960}
            height={411}
          />
          <img
            src="/brand/banner-1600.webp"
            alt="Commander Duels: an armoured warrior with an axe on a battlefield, beside the Commander Duels logo"
            width={1600}
            height={686}
          />
        </picture>
        <div className={styles.playCopy}>
          <div>
            <span className={styles.kicker}>Battle mode</span>
            <h1 id="page-title" ref={heading} tabIndex={-1}>
              Gather your cards. <em>Make your mark.</em>
            </h1>
            <p>
              Practice against the bots in Legacy or Commander with your own
              decks, or sit down with other players at a table.
            </p>
          </div>
          <div className={styles.playActions}>
            <a className={shell.primary} href="#practice" onClick={selectSound}>
              Battle the bots <span aria-hidden="true">↓</span>
            </a>
            <a className={shell.secondary} href="#tables" onClick={selectSound}>
              Play other players
            </a>
          </div>
        </div>
      </section>
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
          {comingSoon(selected) ? "COMING SOON" : "OPEN TO PLAY"}
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
            : "Start a practice game against the bots from the practice table, or open a table for other players from Tables."}
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
