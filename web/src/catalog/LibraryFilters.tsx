import { colorNames, finishNames, rarityNames } from "../auctions/auctions";
import {
  LIBRARY_COLOURS,
  LIBRARY_FINISHES,
  LIBRARY_RARITIES,
  librarySortNames,
  noLibraryFilters,
  type ColourMatch,
  type LibraryFilters,
  type LibrarySort,
} from "./libraryFilters";
import styles from "./catalog.module.css";

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value)
    ? list.filter((item) => item !== value)
    : [...list, value];
}

/**
 * My library's finer filters (v0.6.2), under its Filters button: set, type, mana value, rarity,
 * finish and colour, as the auction house's search has them, and the sort. They apply as they
 * change; Clear filters keeps the words and the source above.
 */
export function LibraryFilterPanel({
  filters,
  onChange,
  sets,
  rarities,
}: {
  filters: LibraryFilters;
  onChange: (filters: LibraryFilters) => void;
  /** The sets the library holds, by name. */
  sets: { code: string; name: string }[];
  /** The rarities the library holds: only those are offered. */
  rarities: string[];
}) {
  const set = <K extends keyof LibraryFilters>(
    key: K,
    value: LibraryFilters[K],
  ) => onChange({ ...filters, [key]: value });
  return (
    <div
      id="library-filters"
      className={styles.filters}
      role="group"
      aria-label="Filter your library"
    >
      <label className={styles.field}>
        <span>Set</span>
        <select
          value={filters.set}
          onChange={(event) => set("set", event.target.value)}
        >
          <option value="">Any set</option>
          {sets.map((found) => (
            <option key={found.code} value={found.code}>
              {found.name} ({found.code.toUpperCase()})
            </option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        <span>Type</span>
        <input
          value={filters.type}
          placeholder="legendary creature"
          maxLength={60}
          onChange={(event) => set("type", event.target.value)}
        />
      </label>
      <label className={styles.field} data-narrow>
        <span>Mana value from</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={20}
          value={filters.mvMin}
          onChange={(event) => set("mvMin", event.target.value)}
        />
      </label>
      <label className={styles.field} data-narrow>
        <span>to</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={20}
          value={filters.mvMax}
          onChange={(event) => set("mvMax", event.target.value)}
        />
      </label>
      <label className={styles.field}>
        <span>Sort by</span>
        <select
          value={filters.sort}
          onChange={(event) => set("sort", event.target.value as LibrarySort)}
        >
          {(Object.keys(librarySortNames) as LibrarySort[]).map((sort) => (
            <option key={sort} value={sort}>
              {librarySortNames[sort]}
            </option>
          ))}
        </select>
      </label>
      <fieldset className={styles.chips}>
        <legend>Rarity</legend>
        {LIBRARY_RARITIES.filter(
          (rarity) =>
            rarities.includes(rarity) || filters.rarity.includes(rarity),
        ).map((rarity) => (
          <button
            key={rarity}
            type="button"
            aria-pressed={filters.rarity.includes(rarity)}
            data-rarity={rarity}
            onClick={() => set("rarity", toggle(filters.rarity, rarity))}
          >
            {rarityNames[rarity]}
          </button>
        ))}
      </fieldset>
      <fieldset className={styles.chips}>
        <legend>Finish</legend>
        {LIBRARY_FINISHES.map((finish) => (
          <button
            key={finish}
            type="button"
            aria-pressed={filters.finish.includes(finish)}
            data-finish={finish}
            onClick={() => set("finish", toggle(filters.finish, finish))}
          >
            {finishNames[finish]}
          </button>
        ))}
      </fieldset>
      <fieldset>
        <legend>Colour</legend>
        {LIBRARY_COLOURS.map((letter) => {
          const name = colorNames[letter]!;
          return (
            <label key={letter} className={styles.pip} data-color={letter}>
              <input
                type="checkbox"
                checked={filters.colours.includes(letter)}
                onChange={() => set("colours", toggle(filters.colours, letter))}
              />
              <span title={name}>{letter}</span>
              <span className={styles.visuallyHidden}>{name}</span>
            </label>
          );
        })}
        <select
          aria-label="How colours match"
          value={filters.colourMatch}
          onChange={(event) =>
            set("colourMatch", event.target.value as ColourMatch)
          }
        >
          <option value="any">any of these</option>
          <option value="all">all of these</option>
          <option value="exactly">exactly these</option>
        </select>
      </fieldset>
      <button
        type="button"
        className={styles.secondary}
        onClick={() =>
          onChange({
            ...noLibraryFilters,
            find: filters.find,
            source: filters.source,
          })
        }
      >
        Clear filters
      </button>
    </div>
  );
}
