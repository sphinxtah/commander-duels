import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { client, type Me } from "../api";
import { CardDetails, CardTile } from "./CardViews";
import {
  catalogSearch,
  namesPlayability,
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

/** The result count, saying which cards it counts. */
export function resultWords(
  total: number,
  playable: Search["playable"],
): string {
  const count = total.toLocaleString();
  const cards = total === 1 ? "card" : "cards";
  if (playable === "true") return `${count} playable ${cards}`;
  if (playable === "false") return `${count} ${cards} not playable yet`;
  return `${count} ${cards}`;
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
  // Cards that cannot be played here yet are hidden until the player asks for them.
  const [search, setSearch] = useState<Search>({ ...catalogSearch });
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<CardSummary>();
  const dialog = useRef<HTMLDialogElement>(null);
  const status = useCatalogStatus();
  // A search that names playability itself (status:unsupported, is:playable) decides it, and the
  // "Playable here" filter steps aside rather than contradict it.
  const typed = namesPlayability(search.q);
  const setAside = typed && search.playable !== "";
  const effective = useMemo<Search>(
    () => (setAside ? { ...search, playable: "" } : search),
    [search, setAside],
  );
  const { results, answered, error, loading } = useCardSearch(
    effective,
    page,
    PAGE_SIZE,
  );
  // The result line describes the results on screen, so it follows the search they answer.
  const shown = answered ?? effective;
  const shownSetAside =
    setAside && shown.playable === "" && namesPlayability(shown.q);
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
      <SearchControls
        search={search}
        onChange={setSearch}
        defaults={catalogSearch}
      />
      <div className={styles.resultRow}>
        {/* The count names the cards the shown results hold (the search they answer, not one
            still on its way), and says when a typed term has set the filter aside, so screen
            readers hear both. */}
        <p role="status" className={styles.resultLine}>
          {error
            ? ""
            : results
              ? `${resultWords(results.total, shown.playable)}${shownSetAside ? " · your search names playability, so the “Playable here” filter is set aside" : ""}${loading ? " · searching…" : ""}`
              : "Searching…"}
        </p>
        {/* One button whose words change, so focus stays on it after a click. */}
        {!typed && search.playable !== "false" && (
          <button
            type="button"
            className={styles.textButton}
            onClick={() =>
              setSearch({
                ...search,
                playable: search.playable === "true" ? "" : "true",
              })
            }
          >
            {search.playable === "true"
              ? "Show cards not playable yet"
              : "Hide cards not playable yet"}
          </button>
        )}
      </div>
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
