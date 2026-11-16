import { useId, useState } from "react";
import type { DeckSummary } from "./decks";
import {
  FOLDER_LENGTH,
  NO_CHANGE,
  SORTS,
  UNFILED,
  foldersOf,
  organizeRequest,
  organizeWords,
  tagsOf,
  type DeckFilters,
  type DeckSort,
  type Organize,
  type OrganizeDraft,
} from "./workshop";
import styles from "./decks.module.css";

// The Decks page's shelves (v1.0.0, the deck workshop; the owner's decision 28): a filter bar
// over the one list (a search, a folder, tags with their counts, an order), and the organizer
// that files several decks at once, all of them or none, and says what it will change before it
// is sent.

/** The filters over the deck list: what is shown narrows as they are set. */
export function DeckFilterBar({
  decks,
  filters,
  onChange,
}: {
  /** Every deck of the view, before any filter. */
  decks: DeckSummary[];
  filters: DeckFilters;
  onChange: (filters: DeckFilters) => void;
}) {
  const folders = foldersOf(decks);
  const tags = tagsOf(decks);
  const unfiled = decks.filter((deck) => !deck.folder).length;
  const set = (change: Partial<DeckFilters>) =>
    onChange({ ...filters, ...change });
  return (
    <div className={styles.filterBar} role="search" aria-label="Find a deck">
      <label className={styles.field}>
        <span>Search</span>
        <input
          type="search"
          value={filters.search}
          maxLength={80}
          placeholder="A name, a commander, a folder or a tag"
          onChange={(event) => set({ search: event.target.value })}
        />
      </label>
      <label className={styles.field}>
        <span>Folder</span>
        <select
          value={filters.folder}
          onChange={(event) => set({ folder: event.target.value })}
        >
          <option value="">Every deck ({decks.length})</option>
          {folders.map((folder) => (
            <option key={folder.name} value={folder.name}>
              {folder.name} ({folder.decks})
            </option>
          ))}
          {folders.length > 0 && (
            <option value={UNFILED}>In no folder ({unfiled})</option>
          )}
        </select>
      </label>
      <label className={styles.field}>
        <span>Order</span>
        <select
          value={filters.sort}
          onChange={(event) => set({ sort: event.target.value as DeckSort })}
        >
          {SORTS.map(([sort, words]) => (
            <option key={sort} value={sort}>
              {words}
            </option>
          ))}
        </select>
      </label>
      {tags.length > 0 && (
        <fieldset className={styles.tagFilter}>
          <legend>Tags</legend>
          {tags.map((tag) => (
            <label key={tag.name} className={styles.tagChip}>
              <input
                type="checkbox"
                checked={filters.tags.includes(tag.name)}
                onChange={(event) =>
                  set({
                    tags: event.target.checked
                      ? [...filters.tags, tag.name]
                      : filters.tags.filter((other) => other !== tag.name),
                  })
                }
              />
              {tag.name}
              <small aria-label={`${tag.decks} decks`}>{tag.decks}</small>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

/** A deck's folder and tags on its row; nothing for a deck with neither. */
export function ShelfLine({ deck }: { deck: DeckSummary }) {
  const tags = deck.tags ?? [];
  if (!deck.folder && tags.length === 0) return null;
  return (
    <span className={styles.shelfLine}>
      {deck.folder && (
        <span className={styles.folderMark}>
          <span aria-hidden="true">▤</span> In {deck.folder}
        </span>
      )}
      {tags.map((tag) => (
        <span key={tag} className={styles.tagMark}>
          <span className={styles.visuallyHidden}>Tag: </span>
          {tag}
        </span>
      ))}
    </span>
  );
}

/**
 * The batch organizer: the decks ticked are moved into a folder or taken out of theirs, and
 * given or relieved of tags, in one request that changes all of them or none. What it will do
 * is said under the form as it is filled in, before its button sends anything.
 */
export function Organizer({
  chosen,
  folders,
  busy,
  error,
  onOrganize,
  onCancel,
}: {
  /** The decks ticked. */
  chosen: DeckSummary[];
  /** The folders the account already has, offered as it types. */
  folders: string[];
  busy: boolean;
  /** Why the last request changed nothing. */
  error: string;
  onOrganize: (request: Organize) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState<OrganizeDraft>(NO_CHANGE);
  const set = (change: Partial<OrganizeDraft>) =>
    setDraft((current) => ({ ...current, ...change }));
  const present = tagsOf(chosen);
  const request = organizeRequest(
    chosen.map((deck) => deck.id),
    // A tag ticked for removal and no longer on any chosen deck asks for nothing.
    {
      ...draft,
      remove: draft.remove.filter((tag) =>
        present.some((found) => found.name === tag),
      ),
    },
  );
  const count = `${chosen.length} ${chosen.length === 1 ? "deck" : "decks"}`;
  const names = chosen.slice(0, 3).map((deck) => deck.title);
  return (
    <section className={styles.organizer} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Organize {count}</h2>
      <p className={styles.hint}>
        {names.join(", ")}
        {chosen.length > 3 ? ` and ${chosen.length - 3} more` : ""}. A deck is
        kept in one folder and under any tags; neither changes its cards, its
        versions or its games.
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (request) onOrganize(request);
        }}
      >
        <label className={styles.field}>
          <span>Move to a folder</span>
          <input
            value={draft.folder}
            maxLength={FOLDER_LENGTH}
            list={`${id}-folders`}
            disabled={draft.unfile}
            placeholder="A folder's name: a new one is made by naming it"
            onChange={(event) => set({ folder: event.target.value })}
          />
          <datalist id={`${id}-folders`}>
            {folders.map((folder) => (
              <option key={folder} value={folder} />
            ))}
          </datalist>
        </label>
        <label className={styles.inline}>
          <input
            type="checkbox"
            checked={draft.unfile}
            onChange={(event) => set({ unfile: event.target.checked })}
          />
          Take them out of their folders
        </label>
        <label className={styles.field}>
          <span>Add tags</span>
          <input
            value={draft.add}
            maxLength={200}
            placeholder="Separated by commas: budget, tribal"
            onChange={(event) => set({ add: event.target.value })}
          />
        </label>
        {present.length > 0 && (
          <fieldset className={styles.tagFilter}>
            <legend>Remove tags</legend>
            {present.map((tag) => (
              <label key={tag.name} className={styles.tagChip}>
                <input
                  type="checkbox"
                  checked={draft.remove.includes(tag.name)}
                  onChange={(event) =>
                    set({
                      remove: event.target.checked
                        ? [...draft.remove, tag.name]
                        : draft.remove.filter((other) => other !== tag.name),
                    })
                  }
                />
                {tag.name}
                <small aria-label={`on ${tag.decks} of them`}>
                  {tag.decks}
                </small>
              </label>
            ))}
          </fieldset>
        )}
        <div className={styles.organizePreview} role="status">
          {request ? (
            <>
              <strong>This changes {count}, all of them or none:</strong>
              <ul>
                {organizeWords(request).map((words) => (
                  <li key={words}>{words}</li>
                ))}
              </ul>
            </>
          ) : (
            <p>Name a folder or tags. Nothing changes until you do.</p>
          )}
        </div>
        {error && (
          <p role="alert" className={styles.refusal}>
            {error} Nothing was changed.
          </p>
        )}
        <div className={styles.actions}>
          <button
            type="submit"
            className={styles.primary}
            disabled={busy || !request}
          >
            {busy ? "Organizing…" : `Organize ${count}`}
          </button>
          <button
            type="button"
            className={styles.secondary}
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}
