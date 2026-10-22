import { useEffect, useMemo, useState } from "react";
import { client, describe } from "../api";
import { ManaCost } from "../game/Card";
import {
  sourceLabels,
  type CardSummary,
  type LibraryCard,
  type LibraryView,
} from "./catalog";
import styles from "./catalog.module.css";

type Source = LibraryCard["sources"][number];

/** Each source in the order a player meets them, with what it gives. */
const sourceNotes: [Source, string][] = [
  ["starter", "Every copy of the two starter decks you chose, yours for good."],
  [
    "alliance",
    "A playset (4) of each of your allied Planeswalker's own cards, while the alliance lasts.",
  ],
  [
    "grandfathered",
    "The cards your decks held when libraries began, so none of them stopped working.",
  ],
];

/**
 * The player's card library (v0.3.1): the cards they build from, each with its copies and where
 * they came from. Copies are a limit per deck, not spent: two decks may each hold every copy. An
 * account that builds from the whole catalog has no library, and is told so.
 */
export function MyLibrary({ onOpen }: { onOpen: (card: CardSummary) => void }) {
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
  const counts = useMemo(() => {
    const found: Partial<Record<Source, number>> = {};
    for (const item of library?.cards ?? [])
      for (const from of item.sources) found[from] = (found[from] ?? 0) + 1;
    return found;
  }, [library]);
  const shown = useMemo(() => {
    const words = find.trim().toLowerCase();
    return (library?.cards ?? []).filter(
      (item) =>
        (!source || item.sources.includes(source)) &&
        (!words ||
          item.card.name.toLowerCase().includes(words) ||
          item.card.type_line.toLowerCase().includes(words)),
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
  return (
    <section className={styles.library} aria-labelledby="library-title">
      <h2 id="library-title">Your library</h2>
      <p className={styles.lead}>
        Your decks are built from these cards. A deck may hold as many copies of
        a card as your library does; two decks may each hold them all. Basic
        lands are yours without limit, so they are not listed.
      </p>
      <dl className={styles.sources}>
        {sourceNotes
          .filter(([from]) => counts[from] || from !== "grandfathered")
          .map(([from, note]) => (
            <div key={from}>
              <dt>
                {sourceLabels[from]}{" "}
                <small>
                  {counts[from] ?? 0} {counts[from] === 1 ? "card" : "cards"}
                </small>
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
            placeholder="A name or a type"
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
      <p role="status" className={styles.resultLine}>
        {shown.length === library.cards.length
          ? `${library.cards.length.toLocaleString()} ${library.cards.length === 1 ? "card" : "cards"}, ${copies.toLocaleString()} ${copies === 1 ? "copy" : "copies"}`
          : `${shown.length.toLocaleString()} of ${library.cards.length.toLocaleString()} cards`}
      </p>
      {library.cards.length === 0 ? (
        <p className={styles.note}>
          Nothing yet beyond basic lands: your two starter decks and an alliance
          fill it.
        </p>
      ) : (
        <div className={styles.libraryScroll}>
          <table className={styles.libraryTable} aria-label="Your library">
            <thead>
              <tr>
                <th scope="col">Card</th>
                <th scope="col">Type</th>
                <th scope="col">Copies</th>
                <th scope="col">From</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => (
                <tr key={item.card.id}>
                  <th scope="row">
                    <button
                      type="button"
                      className={styles.cardLink}
                      onClick={() => onOpen(item.card)}
                    >
                      {item.card.name}
                    </button>{" "}
                    <ManaCost cost={item.card.mana_cost} />
                  </th>
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
