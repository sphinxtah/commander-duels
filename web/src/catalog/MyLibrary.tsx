import { useEffect, useMemo, useState } from "react";
import { client, describe } from "../api";
import { ManaCost } from "../game/Card";
import { CardTile, ViewSwitch } from "./CardViews";
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
  view,
  onView,
}: {
  /** Opens a card at the edition shown. */
  onOpen: (card: CardSummary, printingId: string) => void;
  view: CardView;
  onView: (view: CardView) => void;
}) {
  const [library, setLibrary] = useState<LibraryView>();
  const [error, setError] = useState("");
  const [find, setFind] = useState("");
  const [source, setSource] = useState<Source | "">("");
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
  }, []);
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
      </section>
    );
  const copies = library.cards.reduce(
    (sum, item) => sum + (item.copies ?? 0),
    0,
  );
  const cards = new Set(library.cards.map((item) => item.card.id)).size;
  const editions = library.cards.length;
  return (
    <section className={styles.library} aria-labelledby="library-title">
      <h2 id="library-title">Your library</h2>
      <p className={styles.lead}>
        Your decks are built from these cards, each in the edition you own. A
        deck may hold an edition as many times as your library does; two decks
        may each hold them all. Basic lands are yours without limit, in every
        edition, so they are not listed.
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
          Nothing yet beyond basic lands: your two starter decks and an alliance
          fill it.
        </p>
      ) : view === "pictures" ? (
        <ul className={styles.grid} aria-label="Your library">
          {shown.map((item) => (
            // The tile's own note says the edition's copies; the line under it, where they came
            // from.
            <CardTile
              key={item.edition.printing_id}
              card={{ ...item.card, owned: item.copies }}
              edition={editionName(item.edition)}
              onOpen={(card) => onOpen(card, item.edition.printing_id)}
            >
              <span className={styles.tileSources}>
                {item.sources.map((from) => sourceLabels[from]).join(", ")}
              </span>
            </CardTile>
          ))}
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
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => (
                <tr key={item.edition.printing_id}>
                  <th scope="row">
                    <button
                      type="button"
                      className={styles.cardLink}
                      onClick={() =>
                        onOpen(item.card, item.edition.printing_id)
                      }
                    >
                      {item.card.name}
                    </button>{" "}
                    <ManaCost cost={item.card.mana_cost} />
                  </th>
                  <td>{editionName(item.edition)}</td>
                  <td>{item.card.type_line}</td>
                  <td>{item.copies ?? "Any number"}</td>
                  <td>
                    {item.sources.map((from) => sourceLabels[from]).join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
