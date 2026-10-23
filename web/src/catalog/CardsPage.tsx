import { useEffect, useRef, useState, type RefObject } from "react";
import { client, type Me } from "../api";
import { CardDetails, CardTable, CardTile, ViewSwitch } from "./CardViews";
import { useCardView } from "./cardView";
import {
  AllianceCardsView,
  allianceTabName,
  useAllianceCards,
} from "./AllianceCards";
import { useCustomCards } from "./CustomCards";
import { MyLibrary } from "./MyLibrary";
import {
  emptySearch,
  type CatalogStatus,
  type CardSummary,
  type PrintingsShown,
  type Search,
} from "./catalog";
import { useCardSearch } from "./SearchControls";
import { SearchControls } from "./SearchControls";
import styles from "./catalog.module.css";

const PAGE_SIZE = 60;

/** The player's own library, every card in the game (since v0.4.5 only the cards the engine can
 * play), and the allied Planeswalker's cards (v0.4.2), which at the Godlike tier's Planeswalker
 * are its custom cards. Since v0.5.0 the library comes first, and opens the page (the owner's
 * request). */
type View = "catalog" | "library" | "alliance";
const VIEWS: View[] = ["library", "catalog", "alliance"];

export function catalogLine(status: CatalogStatus | undefined): string {
  if (!status) return "";
  if (!status.revision) return "The card catalog has not been imported yet.";
  const when = new Date(status.revision.created_at).toLocaleDateString();
  return `${status.playable.toLocaleString()} cards · catalog revision ${status.revision.id}, ${when}${status.stale ? " · not updated for two days" : ""}`;
}

/** The result count, saying which cards it counts. */
export function resultWords(total: number, owned = false): string {
  return `${total.toLocaleString()} ${total === 1 ? "card" : "cards"}${owned ? " in your library" : ""}`;
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
  return (
    <Browser
      heading={heading}
      library={!me.permissions.includes("library.unlimited")}
    />
  );
}

function Browser({
  heading,
  library,
}: {
  heading: RefObject<HTMLHeadingElement | null>;
  /** The account builds from a library of its own (v0.3.1), not the whole catalog. */
  library: boolean;
}) {
  // An account that builds from the whole catalog has no library to show, so it opens on every
  // card.
  const [view, setView] = useState<View>(library ? "library" : "catalog");
  const [search, setSearch] = useState<Search>({ ...emptySearch });
  const [page, setPage] = useState(1);
  // The card open, and which of its printings its details list (v0.5.0): from the library only
  // the editions it holds, starting at the one opened.
  const [open, setOpen] = useState<{
    card: CardSummary;
    printing?: string;
    printings: PrintingsShown;
  }>();
  const openCard = (card: CardSummary) => setOpen({ card, printings: "all" });
  // Pictures or a list (v0.5.0), the same on every tab and remembered in this browser.
  const [shownAs, setShownAs] = useCardView();
  const dialog = useRef<HTMLDialogElement>(null);
  const status = useCatalogStatus();
  const custom = useCustomCards();
  const alliance = useAllianceCards();
  const { results, answered, error, loading } = useCardSearch(
    search,
    page,
    PAGE_SIZE,
  );
  // The result line describes the results on screen, so it follows the search they answer.
  const shown = answered ?? search;
  useEffect(() => setPage(1), [search]);
  useEffect(() => {
    if (open) dialog.current?.showModal();
  }, [open]);
  const pages = results ? Math.max(1, Math.ceil(results.total / PAGE_SIZE)) : 1;
  return (
    <>
      <span className={styles.eyebrow}>CARD CATALOG</span>
      <h1 ref={heading} tabIndex={-1}>
        Discover your next centerpiece.
      </h1>
      <p className={styles.lead}>{catalogLine(status)}</p>
      <div className={styles.tabs} role="tablist" aria-label="Which cards">
        {VIEWS.map((item) => (
          <button
            key={item}
            role="tab"
            type="button"
            aria-selected={view === item}
            onClick={() => setView(item)}
          >
            {
              {
                catalog: "All cards",
                library: "My library",
                alliance: allianceTabName(alliance.cards),
              }[item]
            }
          </button>
        ))}
      </div>
      {view === "library" && (
        <MyLibrary
          onOpen={(card, printing) =>
            setOpen({ card, printing, printings: "owned" })
          }
          view={shownAs}
          onView={setShownAs}
        />
      )}
      {view === "alliance" && (
        <AllianceCardsView
          cards={alliance.cards}
          error={alliance.error}
          custom={custom}
          onOpen={openCard}
          view={shownAs}
          onView={setShownAs}
        />
      )}
      {view === "catalog" && (
        <>
          <SearchControls
            search={search}
            onChange={setSearch}
            library={library}
          />
          <div className={styles.resultRow}>
            {/* The count names the cards the shown results hold: the search they answer, not
                one still on its way. */}
            <p role="status" className={styles.resultLine}>
              {error
                ? ""
                : results
                  ? `${resultWords(results.total, shown.owned)}${loading ? " · searching…" : ""}`
                  : "Searching…"}
            </p>
            <ViewSwitch view={shownAs} onChange={setShownAs} />
          </div>
          {error && (
            <p role="alert" className={styles.refusal}>
              {error}
            </p>
          )}
          {results &&
            (shownAs === "pictures" ? (
              <ul className={styles.grid} aria-label="Cards">
                {results.items.map((card) => (
                  <CardTile key={card.id} card={card} onOpen={openCard} />
                ))}
              </ul>
            ) : (
              <CardTable
                cards={results.items}
                label="Cards"
                onOpen={openCard}
              />
            ))}
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
        </>
      )}
      <dialog
        ref={dialog}
        className={styles.cardDialog}
        aria-label={open?.card.name ?? "Card"}
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
        {open && (
          <CardDetails
            cardId={open.card.id}
            chosenPrinting={open.printing}
            printings={open.printings}
          />
        )}
      </dialog>
    </>
  );
}
