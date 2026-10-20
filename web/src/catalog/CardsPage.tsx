import { useEffect, useRef, useState, type RefObject } from "react";
import { client, type Me } from "../api";
import { CardDetails, CardTile } from "./CardViews";
import {
  emptySearch,
  type CatalogStatus,
  type CardSummary,
  type Search,
} from "./catalog";
import { useCardSearch } from "./SearchControls";
import { SearchControls } from "./SearchControls";
import styles from "./catalog.module.css";

const PAGE_SIZE = 60;

export function catalogLine(status: CatalogStatus | undefined): string {
  if (!status) return "";
  if (!status.revision) return "The card catalog has not been imported yet.";
  const when = new Date(status.revision.created_at).toLocaleDateString();
  return `${status.cards.toLocaleString()} cards from Scryfall, ${status.playable.toLocaleString()} playable here · catalog revision ${status.revision.id}, ${when}${status.stale ? " · not updated for two days" : ""}`;
}

export function useCatalogStatus(): CatalogStatus | undefined {
  const [status, setStatus] = useState<CatalogStatus>();
  useEffect(() => {
    void client
      .GET("/api/v1/catalog")
      .then(({ data }) => data && setStatus(data));
  }, []);
  return status;
}

export function CardsPage({
  me,
  heading,
}: {
  me: Me | null | undefined;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  if (me === undefined) return null;
  if (!me || me.status !== "active")
    return (
      <>
        <h1 ref={heading} tabIndex={-1}>
          Discover your next centerpiece.
        </h1>
        <p className={styles.lead}>
          {me
            ? "Your account is waiting for approval."
            : "Sign in to browse the card catalog."}
        </p>
        {!me && (
          <a className={styles.primary} href="#profile">
            Sign in
          </a>
        )}
      </>
    );
  return <Browser heading={heading} />;
}

function Browser({
  heading,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const [search, setSearch] = useState<Search>({ ...emptySearch });
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<CardSummary>();
  const dialog = useRef<HTMLDialogElement>(null);
  const status = useCatalogStatus();
  const { results, error, loading } = useCardSearch(search, page, PAGE_SIZE);
  useEffect(() => setPage(1), [search]);
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);
  const pages = results ? Math.max(1, Math.ceil(results.total / PAGE_SIZE)) : 1;
  return (
    <>
      <span className={styles.eyebrow}>M1 · CARD CATALOG</span>
      <h1 ref={heading} tabIndex={-1}>
        Discover your next centerpiece.
      </h1>
      <p className={styles.lead}>{catalogLine(status)}</p>
      <SearchControls search={search} onChange={setSearch} />
      <p role="status" className={styles.resultLine}>
        {error
          ? ""
          : results
            ? `${results.total.toLocaleString()} card${results.total === 1 ? "" : "s"}${loading ? " · searching…" : ""}`
            : "Searching…"}
      </p>
      {error && (
        <p role="alert" className={styles.refusal}>
          {error}
        </p>
      )}
      {results && (
        <ul className={styles.grid} aria-label="Cards">
          {results.items.map((card) => (
            <CardTile key={card.id} card={card} onOpen={setOpen} />
          ))}
        </ul>
      )}
      {results && results.total > PAGE_SIZE && (
        <nav className={styles.pager} aria-label="Result pages">
          <button
            type="button"
            className={styles.secondary}
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </button>
          <span>
            Page {page} of {pages}
          </span>
          <button
            type="button"
            className={styles.secondary}
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </nav>
      )}
      <dialog
        ref={dialog}
        className={styles.cardDialog}
        aria-label={open?.name ?? "Card"}
        onClose={() => setOpen(undefined)}
      >
        <button
          type="button"
          className={styles.close}
          aria-label="Close the card"
          onClick={() => dialog.current?.close()}
        >
          ×
        </button>
        {open && <CardDetails cardId={open.id} />}
      </dialog>
    </>
  );
}
