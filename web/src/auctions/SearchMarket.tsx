import { useCallback, useEffect, useState } from "react";
import { describe } from "../api";
import shell from "../App.module.css";
import { auctionApi } from "./api";
import {
  COLORS,
  colorNames,
  filtersSet,
  finishNames,
  marketQuery,
  noMarketFilters,
  rarityNames,
  sortNames,
  timeLeftChoices,
  type MarketFilters,
} from "./auctions";
import { ItemTile } from "./ItemViews";
import type { AuctionItem, AuctionPage, AuctionSort, Finish } from "./types";
import styles from "./auctions.module.css";

// Search the market (v0.6.0), Madden's transfer market search: the filters at the side (folded
// away on a phone), Search and Reset, and the results as item cards, a page at a time. The page
// shown is asked for again every few seconds while the tab is visible, so bids and endings show.

const POLL_MS = 5000;
const RARITIES = ["common", "uncommon", "rare", "mythic", "special", "bonus"];
const FINISHES: Finish[] = ["nonfoil", "foil", "etched"];

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value)
    ? list.filter((item) => item !== value)
    : [...list, value];
}

export function SearchMarket({
  now,
  viewer,
  refresh,
  onOpen,
  onWatch,
  onTotal,
  replaced,
}: {
  now: number;
  viewer?: string | null;
  /** Changes when something elsewhere changed the market (a bid, a listing): asks again. */
  refresh: number;
  onOpen: (item: AuctionItem) => void;
  onWatch: (item: AuctionItem, on: boolean) => void;
  /** How many live auctions the unfiltered market holds, for the banner. */
  onTotal?: (total: number) => void;
  /** An auction the panel changed, shown at once in the results. */
  replaced?: AuctionItem | null;
}) {
  const [form, setForm] = useState<MarketFilters>(noMarketFilters);
  const [applied, setApplied] = useState<MarketFilters>(noMarketFilters);
  // The cursors of the pages before this one; the last is this page's.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [result, setResult] = useState<AuctionPage>();
  const [error, setError] = useState("");
  const [folded, setFolded] = useState(true);
  const cursor = cursors[cursors.length - 1] ?? null;

  const load = useCallback(
    async (background: boolean) => {
      const { data, error: refused } = await auctionApi.search(
        marketQuery(applied, cursor),
        background,
      );
      if (data) {
        setResult(data);
        setError("");
        if (!filtersSet(applied) && cursor === null) onTotal?.(data.total);
      } else if (!background) setError(describe(refused));
    },
    [applied, cursor, onTotal],
  );
  useEffect(() => {
    void load(false);
  }, [load, refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void load(true);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);
  // The panel's answer (a bid, Watch) shows on the tile before the next poll.
  useEffect(() => {
    if (!replaced) return;
    setResult((current) =>
      current
        ? {
            ...current,
            items: current.items.map((item) =>
              item.id === replaced.id ? replaced : item,
            ),
          }
        : current,
    );
  }, [replaced]);

  function update<K extends keyof MarketFilters>(
    field: K,
    value: MarketFilters[K],
  ) {
    setForm((before) => ({ ...before, [field]: value }));
  }
  function search(filters = form) {
    setApplied(filters);
    setCursors([null]);
    setFolded(true);
  }
  const set = filtersSet(applied);
  const items = result?.items ?? [];
  const pageNumber = cursors.length;

  return (
    <div className={styles.market}>
      <section className={styles.filters} aria-labelledby="filters-title">
        <button
          type="button"
          className={styles.filtersToggle}
          aria-expanded={!folded}
          aria-controls="market-filters"
          onClick={() => setFolded(!folded)}
        >
          <span id="filters-title">Search filters</span>
          {set > 0 && <span className={styles.filterCount}>{set}</span>}
          <span aria-hidden="true" className={styles.chevron} />
        </button>
        <form
          id="market-filters"
          className={styles.filterForm}
          data-folded={folded || undefined}
          role="search"
          aria-label="Search the market"
          onSubmit={(event) => {
            event.preventDefault();
            search();
          }}
        >
          <label className={styles.field}>
            <span>Card name</span>
            <input
              type="search"
              value={form.q}
              maxLength={80}
              placeholder="Lightning Bolt"
              onChange={(event) => update("q", event.target.value)}
            />
          </label>
          <div className={styles.fieldPair}>
            <label className={styles.field}>
              <span>Set code</span>
              <input
                type="text"
                value={form.set}
                maxLength={8}
                placeholder="3ED"
                autoCapitalize="characters"
                onChange={(event) => update("set", event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span>Type</span>
              <input
                type="text"
                value={form.type}
                maxLength={40}
                placeholder="Creature"
                onChange={(event) => update("type", event.target.value)}
              />
            </label>
          </div>
          <fieldset className={styles.chips}>
            <legend>Rarity</legend>
            {RARITIES.map((rarity) => (
              <button
                key={rarity}
                type="button"
                aria-pressed={form.rarity.includes(rarity)}
                data-rarity={rarity}
                onClick={() => update("rarity", toggle(form.rarity, rarity))}
              >
                {rarityNames[rarity]}
              </button>
            ))}
          </fieldset>
          <fieldset className={styles.chips}>
            <legend>Finish</legend>
            {FINISHES.map((finish) => (
              <button
                key={finish}
                type="button"
                aria-pressed={form.finish.includes(finish)}
                data-finish={finish}
                onClick={() => update("finish", toggle(form.finish, finish))}
              >
                {finishNames[finish]}
              </button>
            ))}
          </fieldset>
          <fieldset className={styles.pips}>
            <legend>Colour</legend>
            {COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-pressed={form.color.includes(color)}
                aria-label={colorNames[color]}
                title={colorNames[color]}
                data-color={color}
                onClick={() => update("color", toggle(form.color, color))}
              >
                {color}
              </button>
            ))}
          </fieldset>
          <fieldset className={styles.range}>
            <legend>Bid price</legend>
            <label>
              <span className={styles.hidden}>Bid at least</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="Min"
                value={form.minBid}
                onChange={(event) => update("minBid", event.target.value)}
              />
            </label>
            <span aria-hidden="true">–</span>
            <label>
              <span className={styles.hidden}>Bid at most</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="Max"
                value={form.maxBid}
                onChange={(event) => update("maxBid", event.target.value)}
              />
            </label>
          </fieldset>
          <fieldset className={styles.range}>
            <legend>Buy Now price</legend>
            <label>
              <span className={styles.hidden}>Buy Now at least</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="Min"
                value={form.minBuyNow}
                onChange={(event) => update("minBuyNow", event.target.value)}
              />
            </label>
            <span aria-hidden="true">–</span>
            <label>
              <span className={styles.hidden}>Buy Now at most</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                placeholder="Max"
                value={form.maxBuyNow}
                onChange={(event) => update("maxBuyNow", event.target.value)}
              />
            </label>
          </fieldset>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={form.buyNowOnly}
              onChange={(event) => update("buyNowOnly", event.target.checked)}
            />
            <span>Only with Buy Now</span>
          </label>
          <div className={styles.fieldPair}>
            <label className={styles.field}>
              <span>Time left</span>
              <select
                value={form.maxTimeLeft}
                onChange={(event) => update("maxTimeLeft", event.target.value)}
              >
                <option value="">Any time</option>
                {timeLeftChoices.map((choice) => (
                  <option key={choice.seconds} value={String(choice.seconds)}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span>Sort</span>
              <select
                value={form.sort}
                onChange={(event) =>
                  update("sort", event.target.value as AuctionSort)
                }
              >
                {(Object.keys(sortNames) as AuctionSort[]).map((sort) => (
                  <option key={sort} value={sort}>
                    {sortNames[sort]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={styles.filterActions}>
            <button type="submit" className={shell.primary}>
              Search
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => {
                setForm(noMarketFilters);
                search(noMarketFilters);
              }}
            >
              Reset
            </button>
          </div>
        </form>
      </section>

      <section className={styles.results} aria-labelledby="results-title">
        <div className={styles.resultsHead}>
          <h2 id="results-title">
            {set ? "Search results" : "On the market"}
          </h2>
          <p role="status" className={styles.resultsCount}>
            {error
              ? ""
              : result
                ? `${result.total.toLocaleString("en-US")} ${result.total === 1 ? "auction" : "auctions"} · ${sortNames[applied.sort].toLowerCase()}${pageNumber > 1 ? ` · page ${pageNumber}` : ""}`
                : "Searching the market…"}
          </p>
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {result && items.length === 0 ? (
          <div className={styles.empty}>
            <strong>
              {set ? "No auction matches." : "The market is quiet."}
            </strong>
            <p>
              {set
                ? "Loosen a filter or two, or Reset to see every live auction."
                : "Nobody has listed a card yet. Be the first: Sell one from your library."}
            </p>
          </div>
        ) : (
          <ul className={styles.grid} aria-label="Auctions">
            {items.map((item) => (
              <ItemTile
                key={item.id}
                item={item}
                now={now}
                viewer={viewer}
                onOpen={onOpen}
                onWatch={onWatch}
              />
            ))}
          </ul>
        )}
        {(cursors.length > 1 || result?.next_cursor) && (
          <nav className={styles.pager} aria-label="Result pages">
            <button
              type="button"
              className={styles.secondary}
              disabled={cursors.length <= 1}
              onClick={() => setCursors(cursors.slice(0, -1))}
            >
              ◀ Previous
            </button>
            <span>Page {pageNumber}</span>
            <button
              type="button"
              className={styles.secondary}
              disabled={!result?.next_cursor}
              onClick={() =>
                result?.next_cursor &&
                setCursors([...cursors, result.next_cursor])
              }
            >
              Next ▶
            </button>
          </nav>
        )}
      </section>
    </div>
  );
}
