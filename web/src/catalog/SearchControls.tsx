import { useEffect, useRef, useState } from "react";
import { client } from "../api";
import {
  emptySearch,
  searchQuery,
  type CardPage,
  type Search,
} from "./catalog";
import styles from "./catalog.module.css";

const COLORS = [
  ["W", "White"],
  ["U", "Blue"],
  ["B", "Black"],
  ["R", "Red"],
  ["G", "Green"],
] as const;

/** Searches as the filters change, a moment after the last keystroke. `answered` is the search
 * the shown results answer, which lags behind `search` while a new one is on its way. */
export function useCardSearch(
  search: Search,
  page: number,
  pageSize: number,
  fixed?: Partial<Record<string, string>>,
) {
  const [results, setResults] = useState<CardPage>();
  const [answered, setAnswered] = useState<Search>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const fixedKey = JSON.stringify(fixed ?? {});
  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      const query = { ...searchQuery(search, page, pageSize) };
      const extra = JSON.parse(fixedKey) as Record<string, string>;
      if (extra.q) query.q = [extra.q, query.q].filter(Boolean).join(" ");
      for (const [key, value] of Object.entries(extra))
        if (key !== "q") query[key] = value;
      void client
        .GET("/api/v1/cards", { params: { query: query as never } })
        .then(({ data, error: failure }) => {
          if (!active) return;
          setLoading(false);
          if (data) {
            setResults(data);
            setAnswered(search);
            setError("");
          } else {
            setError(
              (failure as { message?: string } | undefined)?.message ??
                "The card search is unavailable. Try again.",
            );
          }
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [search, page, pageSize, fixedKey]);
  return { results, answered, error, loading };
}

export function SearchControls({
  search,
  onChange,
  compact = false,
  defaults = emptySearch,
  library = false,
}: {
  search: Search;
  onChange: (search: Search) => void;
  compact?: boolean;
  /** What "Clear filters" goes back to: the screen's own starting search. */
  defaults?: Search;
  /** The account builds from a library of its own, so "In my library" is offered beside the
   * search, never folded away under Filters. */
  library?: boolean;
}) {
  const [more, setMore] = useState(false);
  const help = useRef<HTMLDialogElement>(null);
  const set = <K extends keyof Search>(key: K, value: Search[K]) =>
    onChange({ ...search, [key]: value });
  const toggle = (letters: string, letter: string) =>
    letters.includes(letter) ? letters.replace(letter, "") : letters + letter;
  return (
    <div className={styles.controls} data-compact={compact}>
      <div className={styles.queryRow}>
        <label className={styles.query}>
          <span className={styles.visuallyHidden}>Search cards</span>
          <input
            type="search"
            value={search.q}
            placeholder='Name, or try t:dragon c:r mv<=4 o:"draw a card"'
            onChange={(event) => set("q", event.target.value)}
          />
        </label>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => help.current?.showModal()}
        >
          Search help
        </button>
        <button
          type="button"
          className={styles.secondary}
          aria-expanded={more}
          onClick={() => setMore((value) => !value)}
        >
          Filters
        </button>
        {library && (
          <label className={styles.inline}>
            <input
              type="checkbox"
              checked={search.owned}
              onChange={(event) => set("owned", event.target.checked)}
            />
            <span>In my library</span>
          </label>
        )}
      </div>
      {more && (
        <div className={styles.filters}>
          <fieldset>
            <legend>Colors</legend>
            {COLORS.map(([letter, name]) => (
              <label key={letter} className={styles.pip} data-color={letter}>
                <input
                  type="checkbox"
                  checked={search.colors.includes(letter)}
                  onChange={() => set("colors", toggle(search.colors, letter))}
                />
                <span title={name}>{letter}</span>
                <span className={styles.visuallyHidden}>{name}</span>
              </label>
            ))}
            <select
              aria-label="How colors match"
              value={search.colorsMode}
              onChange={(event) =>
                set("colorsMode", event.target.value as Search["colorsMode"])
              }
            >
              <option value="including">including these</option>
              <option value="exact">exactly these</option>
              <option value="within">at most these</option>
            </select>
          </fieldset>
          <fieldset>
            <legend>Color identity within</legend>
            {COLORS.map(([letter, name]) => (
              <label key={letter} className={styles.pip} data-color={letter}>
                <input
                  type="checkbox"
                  checked={search.identity.includes(letter)}
                  onChange={() =>
                    set("identity", toggle(search.identity, letter))
                  }
                />
                <span title={name}>{letter}</span>
                <span className={styles.visuallyHidden}>{name}</span>
              </label>
            ))}
          </fieldset>
          <label className={styles.field}>
            <span>Type</span>
            <input
              value={search.type}
              placeholder="creature, legendary, elf"
              onChange={(event) => set("type", event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>Mana value from</span>
            <input
              type="number"
              min={0}
              max={20}
              value={search.mvMin}
              onChange={(event) => set("mvMin", event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>to</span>
            <input
              type="number"
              min={0}
              max={20}
              value={search.mvMax}
              onChange={(event) => set("mvMax", event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>Rarity</span>
            <select
              value={search.rarity}
              onChange={(event) => set("rarity", event.target.value)}
            >
              <option value="">Any</option>
              <option value="common">Common</option>
              <option value="uncommon">Uncommon</option>
              <option value="rare">Rare</option>
              <option value="mythic">Mythic</option>
            </select>
          </label>
          <label className={styles.field}>
            <span>Set code</span>
            <input
              value={search.set}
              placeholder="lea, m10"
              maxLength={8}
              onChange={(event) => set("set", event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>Legal in</span>
            <select
              value={search.legal}
              onChange={(event) => set("legal", event.target.value)}
            >
              <option value="">Any format</option>
              <option value="commander">Commander</option>
              <option value="legacy">Legacy</option>
            </select>
          </label>
          <label className={styles.field}>
            <span>Sort by</span>
            <select
              value={search.sort}
              onChange={(event) =>
                set("sort", event.target.value as Search["sort"])
              }
            >
              <option value="name">Name</option>
              <option value="mana_value">Mana value</option>
              <option value="released">Release date</option>
              <option value="popularity">Popularity (EDHREC)</option>
              <option value="color">Color</option>
            </select>
          </label>
          <label className={styles.inline}>
            <input
              type="checkbox"
              checked={search.descending}
              onChange={(event) => set("descending", event.target.checked)}
            />
            <span>Descending</span>
          </label>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => onChange({ ...defaults })}
          >
            Clear filters
          </button>
        </div>
      )}
      <dialog
        ref={help}
        className={styles.dialog}
        aria-labelledby="search-help-title"
      >
        <h2 id="search-help-title">Searching cards</h2>
        <p>
          Words search card names. Combine terms with spaces (all must match),{" "}
          <code>or</code> (either), a leading <code>-</code> (not) and
          parentheses. A subset of Scryfall's syntax works:
        </p>
        <dl className={styles.syntax}>
          <dt>
            <code>t:legendary</code>
          </dt>
          <dd>Type line contains</dd>
          <dt>
            <code>o:"draw a card"</code>
          </dt>
          <dd>Oracle text contains</dd>
          <dt>
            <code>c:rg</code> <code>c=u</code> <code>c&gt;=w</code>
          </dt>
          <dd>Colors (c, m for multicolor)</dd>
          <dt>
            <code>id:wub</code>
          </dt>
          <dd>Color identity within</dd>
          <dt>
            <code>mv&lt;=3</code> <code>mv:even</code>
          </dt>
          <dd>Mana value</dd>
          <dt>
            <code>r:mythic</code> <code>r&gt;=rare</code>
          </dt>
          <dd>Rarity of any printing</dd>
          <dt>
            <code>s:lea</code>
          </dt>
          <dd>Printed in a set</dd>
          <dt>
            <code>f:commander</code> <code>banned:legacy</code>
          </dt>
          <dd>Legal or banned in a format</dd>
          <dt>
            <code>is:commander</code> <code>is:companion</code>{" "}
            <code>is:partner</code>
          </dt>
          <dd>Deck-building roles</dd>
          <dt>
            <code>is:mdfc</code> <code>is:split</code> <code>is:adventure</code>{" "}
            <code>is:prepare</code>
          </dt>
          <dd>Card layouts</dd>
          <dt>
            <code>k:flying</code>
          </dt>
          <dd>Keyword abilities</dd>
          <dt>
            <code>otag:ramp</code> <code>function:removal</code>
          </dt>
          <dd>Scryfall Tagger's tags</dd>
          <dt>
            <code>year&gt;=2020</code>
          </dt>
          <dd>First printed</dd>
          <dt>
            <code>!"Lightning Bolt"</code>
          </dt>
          <dd>The exact name</dd>
        </dl>
        <p>Anything else is refused with an explanation, never guessed at.</p>
        <button
          type="button"
          className={styles.primary}
          onClick={() => help.current?.close()}
        >
          Close
        </button>
      </dialog>
    </div>
  );
}
