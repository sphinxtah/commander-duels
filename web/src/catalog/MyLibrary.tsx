import { useCallback, useEffect, useMemo, useState } from "react";
import { client, describe } from "../api";
import { finishesWords } from "../auctions/auctions";
import { SellDialog, type SellRequest } from "../auctions/SellDialog";
import type { LibraryFinishes } from "../auctions/types";
import { ManaCost } from "../game/Card";
import { CardTile, ViewSwitch } from "./CardViews";
import { heldFinish } from "./foilGlow";
import {
  editionName,
  sourceLabels,
  type CardSummary,
  type LibraryCard,
  type LibraryView,
} from "./catalog";
import styles from "./catalog.module.css";
import type { CardView } from "./cardView";

type Source = LibraryCard["sources"][number];
/** A library item with its copies by finish and how many may be sold (v0.6.0); until the API's
 * contract is generated both are optional here. */
type LibraryItem = LibraryCard & Partial<LibraryFinishes>;

/** Each source in the order a player meets them, with what it gives. */
const sourceNotes: [Source, string][] = [
  ["starter", "Every copy of the two starter decks you chose, yours for good."],
  [
    "alliance",
    "A playset (4) of each of your allied Planeswalker's own cards, while the alliance lasts.",
  ],
  [
    "pack",
    "The cards of the packs you opened at Leng's counter, each in its own edition, yours for good.",
  ],
  [
    "grandfathered",
    "The cards your decks held when libraries began, so none of them stopped working.",
  ],
];
/** The sources every library names, whether or not they gave it anything yet. */
const alwaysNamed: Source[] = ["starter", "alliance"];

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/**
 * The player's card library (v0.3.1): the cards they build from, each with its copies and where
 * they came from. Copies are a limit per deck, not spent: two decks may each hold every copy. An
 * account that builds from the whole catalog has no library, and is told so. Since v0.5.0 it shows
 * the cards themselves, as the owner asked, with the list a switch away, and holds them by edition:
 * each item is one edition of a card, with that edition's picture, name and copies, and opening it
 * shows only the editions the library holds.
 */
export function MyLibrary({
  onOpen,
  onZoom,
  view,
  onView,
}: {
  /** Opens a card at the edition shown; `finish`, the finish its copies glow in (v0.6.0). */
  onOpen: (card: CardSummary, printingId: string, finish?: string) => void;
  /** Shows the edition's picture big (v0.5.1). */
  onZoom: (card: CardSummary, printingId: string, finish?: string) => void;
  view: CardView;
  onView: (view: CardView) => void;
}) {
  const [library, setLibrary] = useState<LibraryView>();
  const [error, setError] = useState("");
  const [find, setFind] = useState("");
  const [source, setSource] = useState<Source | "">("");
  // Sell (v0.6.0): an edition's copies listed in Tivit's Auction House, from its tile or row.
  const [sell, setSell] = useState<SellRequest | null>(null);
  const [said, setSaid] = useState("");
  const [loads, setLoads] = useState(0);
  const reload = useCallback(() => setLoads((count) => count + 1), []);
  useEffect(() => {
    let active = true;
    void client.GET("/api/v1/library").then(({ data, error: failure }) => {
      if (!active) return;
      if (data) setLibrary(data);
      else setError(describe(failure));
    });
    return () => {
      active = false;
    };
  }, [loads]);
  const sellItem = (item: LibraryItem) =>
    setSell({
      mode: "sell",
      preset: { printingId: item.edition.printing_id, name: item.card.name },
    });
  const sellDialog = (
    <SellDialog
      request={sell}
      onClose={() => setSell(null)}
      onListed={(_items, words) => {
        setSaid(`${words} See it on the auction house's transfer list.`);
        reload();
      }}
    />
  );
  // How many cards (not editions) each source gave.
  const counts = useMemo(() => {
    const found: Partial<Record<Source, Set<string>>> = {};
    for (const item of library?.cards ?? [])
      for (const from of item.sources)
        (found[from] ??= new Set()).add(item.card.id);
    return Object.fromEntries(
      Object.entries(found).map(([from, cards]) => [from, cards.size]),
    ) as Partial<Record<Source, number>>;
  }, [library]);
  const shown = useMemo(() => {
    const words = find.trim().toLowerCase();
    return (library?.cards ?? []).filter(
      (item) =>
        (!source || item.sources.includes(source)) &&
        (!words ||
          item.card.name.toLowerCase().includes(words) ||
          item.card.type_line.toLowerCase().includes(words) ||
          item.edition.set_name.toLowerCase().includes(words) ||
          item.edition.set_code.toLowerCase() === words),
    );
  }, [library, find, source]);

  if (error)
    return (
      <p role="alert" className={styles.refusal}>
        {error}
      </p>
    );
  if (!library) return <p role="status">Opening your library…</p>;
  if (library.unlimited)
    return (
      <section className={styles.library} aria-labelledby="library-title">
        <h2 id="library-title">Your library</h2>
        <p className={styles.lead}>
          You build from the whole catalog: administrators and SysOp have no
          library, and no limit on copies beyond each format's own.
        </p>
        <p className={styles.note}>
          To sell a card, use Sell in{" "}
          <a href="#auctions/list">Tivit's Auction House</a>: it offers what
          your account may list.
        </p>
      </section>
    );
  const copies = library.cards.reduce(
    (sum, item) => sum + (item.copies ?? 0),
    0,
  );
  const cards = new Set(library.cards.map((item) => item.card.id)).size;
  // The list's Sell column, when any edition has a copy to sell (v0.6.0).
  const selling = (library.cards as LibraryItem[]).some(
    (item) => (item.sellable ?? 0) > 0,
  );
  const editions = library.cards.length;
  return (
    <section className={styles.library} aria-labelledby="library-title">
      <h2 id="library-title">Your library</h2>
      <p className={styles.lead}>
        Your decks are built from these cards, each in the edition you own. A
        deck may hold an edition as many times as your library does; two decks
        may each hold them all. Sell puts a copy up in{" "}
        <a href="#auctions">Tivit's Auction House</a>.
      </p>
      <p className={styles.note} role="status">
        {said}
      </p>
      <dl className={styles.sources}>
        {sourceNotes
          .filter(([from]) => counts[from] || alwaysNamed.includes(from))
          .map(([from, note]) => (
            <div key={from}>
              <dt>
                {sourceLabels[from]}{" "}
                <small>{plural(counts[from] ?? 0, "card", "cards")}</small>
              </dt>
              <dd>
                {note}
                {from === "alliance" && (
                  <>
                    {" "}
                    {library.alliance
                      ? "Change it on "
                      : "You have no alliance yet: choose one on "}
                    <a href="#profile">your profile</a>.
                  </>
                )}
              </dd>
            </div>
          ))}
      </dl>
      <div className={styles.libraryFilters}>
        <label className={styles.field}>
          <span>Find in your library</span>
          <input
            type="search"
            value={find}
            placeholder="A name, a type or a set"
            onChange={(event) => setFind(event.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span>From</span>
          <select
            value={source}
            onChange={(event) => setSource(event.target.value as Source | "")}
          >
            <option value="">Anywhere</option>
            {sourceNotes
              .filter(([from]) => counts[from])
              .map(([from]) => (
                <option key={from} value={from}>
                  {sourceLabels[from]}
                </option>
              ))}
          </select>
        </label>
      </div>
      <div className={styles.resultRow}>
        <p role="status" className={styles.resultLine}>
          {shown.length === editions
            ? `${plural(cards, "card", "cards")} in ${plural(editions, "edition", "editions")}, ${plural(copies, "copy", "copies")}`
            : `${shown.length.toLocaleString()} of ${plural(editions, "edition", "editions")}`}
        </p>
        {editions > 0 && <ViewSwitch view={view} onChange={onView} />}
      </div>
      {editions === 0 ? (
        <p className={styles.note}>
          Nothing yet: your two starter decks and an alliance fill it.
        </p>
      ) : view === "pictures" ? (
        <ul className={styles.grid} aria-label="Your library">
          {(shown as LibraryItem[]).map((item) => {
            // The tile's own note says the edition's copies; the lines under it, its copies by
            // finish (v0.6.0) and where they came from. A foil or etched copy held glows.
            const finish = heldFinish(item.finishes);
            const byFinish = finishesWords(item.finishes);
            return (
              <CardTile
                key={item.edition.printing_id}
                card={{ ...item.card, owned: item.copies }}
                edition={editionName(item.edition)}
                finish={finish}
                onOpen={(card) =>
                  onOpen(card, item.edition.printing_id, finish)
                }
                onZoom={(card) =>
                  onZoom(card, item.edition.printing_id, finish)
                }
              >
                {/* Only nonfoil copies: the note above says it all. */}
                {byFinish && finish !== "nonfoil" && (
                  <span className={styles.tileFinishes} data-foil>
                    {byFinish}
                  </span>
                )}
                <span className={styles.tileSources}>
                  {item.sources.map((from) => sourceLabels[from]).join(", ")}
                </span>
                {(item.sellable ?? 0) > 0 && (
                  <button
                    type="button"
                    className={styles.sellLink}
                    aria-label={`Sell ${item.card.name} from ${editionName(item.edition)}`}
                    onClick={() => sellItem(item)}
                  >
                    Sell
                  </button>
                )}
              </CardTile>
            );
          })}
        </ul>
      ) : (
        <div className={styles.libraryScroll}>
          <table className={styles.libraryTable} aria-label="Your library">
            <thead>
              <tr>
                <th scope="col">Card</th>
                <th scope="col">Edition</th>
                <th scope="col">Type</th>
                <th scope="col">Copies</th>
                <th scope="col">From</th>
                {selling && (
                  <th scope="col">
                    <span className={styles.visuallyHidden}>Sell</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {(shown as LibraryItem[]).map((item) => (
                <tr key={item.edition.printing_id}>
                  <th scope="row">
                    <button
                      type="button"
                      className={styles.cardLink}
                      onClick={() =>
                        onOpen(
                          item.card,
                          item.edition.printing_id,
                          heldFinish(item.finishes),
                        )
                      }
                    >
                      {item.card.name}
                    </button>{" "}
                    <ManaCost cost={item.card.mana_cost} />
                  </th>
                  <td>{editionName(item.edition)}</td>
                  <td>{item.card.type_line}</td>
                  <td>
                    {finishesWords(item.finishes) ||
                      (item.copies ?? "Any number")}
                  </td>
                  <td>
                    {item.sources.map((from) => sourceLabels[from]).join(", ")}
                  </td>
                  {selling && (
                    <td>
                      {(item.sellable ?? 0) > 0 && (
                        <button
                          type="button"
                          className={styles.sellLink}
                          aria-label={`Sell ${item.card.name} from ${editionName(item.edition)}`}
                          onClick={() => sellItem(item)}
                        >
                          Sell
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sellDialog}
    </section>
  );
}
