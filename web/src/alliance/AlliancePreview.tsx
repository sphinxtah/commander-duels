import { useEffect, useId, useRef, useState } from "react";
import { client, describe, type Planeswalker } from "../api";
import shell from "../App.module.css";
import { CardTile } from "../catalog/CardViews";
import { CardZoom, zoomOf, type Zoomed } from "../catalog/CardZoom";
import type { AllianceCards } from "../catalog/catalog";
import catalog from "../catalog/catalog.module.css";
import { playableWords, tierNames, wins } from "./alliance";
import { Portrait } from "./Portrait";
import { TierBadge } from "./TierBadge";
import styles from "./alliance.module.css";

/**
 * An alliance's cards before choosing it (v0.6.2, the owner's request): a Planeswalker clicked in
 * the picker opens this tile, with their portrait and every card the alliance brings, each picture
 * opening large as on the Cards page, and "Begin Alliance with <name>", which allies as the
 * picker's click did before. A locked Planeswalker shows their cards too, with the wins that open
 * them instead of the button. The Godlike tier's custom cards stay private: The Sphinx's tile says
 * so and lists none (`GET /api/v1/planeswalkers/{id}/cards`).
 */
export function AlliancePreview({
  planeswalker,
  current,
  busy,
  onAlly,
  onClose,
}: {
  planeswalker: Planeswalker | null;
  /** The allied Planeswalker's ID, if any. */
  current: string | null | undefined;
  busy: boolean;
  onAlly: (planeswalker: Planeswalker) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [cards, setCards] = useState<AllianceCards>();
  const [error, setError] = useState("");
  const [zoomed, setZoomed] = useState<Zoomed>();
  const id = planeswalker?.id;

  useEffect(() => {
    if (planeswalker && !dialog.current?.open) dialog.current?.showModal();
  }, [planeswalker]);

  useEffect(() => {
    setCards(undefined);
    setError("");
    if (!id) return;
    let active = true;
    void client
      .GET("/api/v1/planeswalkers/{planeswalker_id}/cards", {
        params: { path: { planeswalker_id: id } },
      })
      .then(({ data, error: refused }) => {
        if (!active) return;
        if (data) setCards(data);
        else setError(describe(refused));
      })
      .catch(() => {
        if (active) setError(describe(undefined));
      });
    return () => {
      active = false;
    };
  }, [id]);

  const close = () => dialog.current?.close();
  const titleId = `preview${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const allied = planeswalker !== null && planeswalker.id === current;
  return (
    <dialog
      ref={dialog}
      className={styles.preview}
      aria-labelledby={titleId}
      // React passes a dialog's close up its tree: the enlarged card's closing is not this one's,
      // and this one's must not close a dialog it sits in (the setup wizard's).
      onClose={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      // A click on the backdrop (the dialog itself, not its contents) closes it.
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      {planeswalker && (
        <div className={styles.previewBody}>
          <button
            type="button"
            className={styles.previewClose}
            aria-label="Close"
            onClick={close}
          >
            ×
          </button>
          <header className={styles.previewHead}>
            <Portrait
              id={planeswalker.id}
              name={planeswalker.name}
              description={planeswalker.description}
              portrait={planeswalker.portrait}
              size={160}
            />
            <div>
              <h2 id={titleId}>{planeswalker.name}</h2>
              <p className={styles.previewTier}>
                <TierBadge tier={planeswalker.tier} size={22} decorative />
                <span>{tierNames[planeswalker.tier]} tier</span>
                <span>· {playableWords(planeswalker)}</span>
              </p>
              {allied ? (
                <p className={styles.previewNote} data-current="">
                  Your alliance
                </p>
              ) : planeswalker.open ? (
                <button
                  type="button"
                  className={shell.primary}
                  aria-disabled={busy}
                  onClick={() => {
                    if (busy) return;
                    onAlly(planeswalker);
                    close();
                  }}
                >
                  Begin Alliance with {planeswalker.name}
                </button>
              ) : (
                <p className={styles.previewNote} data-locked="">
                  Locked: {planeswalker.name} opens at {wins(planeswalker.wins)}
                  . Win games to reach the {tierNames[planeswalker.tier]} tier.
                </p>
              )}
            </div>
          </header>
          <PreviewCards
            planeswalker={planeswalker}
            cards={cards?.alliance === planeswalker.id ? cards : undefined}
            error={error}
            onZoom={setZoomed}
          />
          <CardZoom zoomed={zoomed} onClose={() => setZoomed(undefined)} />
        </div>
      )}
    </dialog>
  );
}

function PreviewCards({
  planeswalker,
  cards,
  error,
  onZoom,
}: {
  planeswalker: Planeswalker;
  cards: AllianceCards | undefined;
  error: string;
  onZoom: (zoomed: Zoomed | undefined) => void;
}) {
  if (error)
    return (
      <p role="alert" className={styles.previewNote}>
        {error}
      </p>
    );
  if (!cards)
    return (
      <p role="status" className={styles.previewNote}>
        Opening {planeswalker.name}'s cards…
      </p>
    );
  if (cards.custom)
    return (
      <p className={styles.previewNote}>
        {planeswalker.name}'s cards are the owner's own custom cards, kept
        private: they show on the Cards page once you are allied with{" "}
        {planeswalker.name}.
      </p>
    );
  if (cards.cards.length === 0)
    return (
      <p className={styles.previewNote}>
        None of {planeswalker.name}'s cards can be played here yet.
      </p>
    );
  const count = cards.cards.length;
  return (
    <div>
      <p className={styles.previewNote}>
        {count} {count === 1 ? "card" : "cards"}: the alliance puts a playset
        (4) of each in your library while it lasts. Click a card to see it
        larger.
      </p>
      <ul className={catalog.grid} aria-label={`${planeswalker.name}'s cards`}>
        {cards.cards.map((card) => (
          <CardTile
            key={card.id}
            card={card}
            onOpen={(chosen) => onZoom(zoomOf(chosen))}
            onZoom={(chosen) => onZoom(zoomOf(chosen))}
          />
        ))}
      </ul>
    </div>
  );
}
