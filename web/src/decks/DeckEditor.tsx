import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { client, describe } from "../api";
import { ManaCost } from "../game/Card";
import { CardDetails, StatusBadge } from "../catalog/CardViews";
import { SearchControls, useCardSearch } from "../catalog/SearchControls";
import {
  colorWords,
  emptySearch,
  formatLabels,
  type CardSummary,
  type Search,
} from "../catalog/catalog";
import { IdentityPips } from "./DecksPage";
import { ProblemList } from "./ProblemList";
import {
  atLeast,
  combine,
  differences,
  exactly,
  locationNames,
  locationsFor,
  merge,
  sampleHand,
  stats,
  typeGroup,
  typeOrder,
  type DeckDetail,
  type DeckEntry,
  type Location,
  type Validation,
} from "./decks";
import styles from "./decks.module.css";

type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
const SAVE_DELAY_MS = 1200;

export function DeckEditor({
  deckId,
  heading,
}: {
  deckId: string;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const [deck, setDeck] = useState<DeckDetail>();
  const [missing, setMissing] = useState(false);
  const [entries, setEntries] = useState<DeckEntry[]>([]);
  const [cards, setCards] = useState<Record<string, CardSummary>>({});
  const [validation, setValidation] = useState<Validation>();
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState<DeckDetail>();
  const [highlight, setHighlight] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<{
    card: CardSummary;
    entry?: DeckEntry;
  }>();
  const [message, setMessage] = useState("");
  const version = useRef(1);
  const changes = useRef(0);
  const patches = useRef(0);
  const cardDialog = useRef<HTMLDialogElement>(null);
  const conflictDialog = useRef<HTMLDialogElement>(null);

  const load = useCallback(async () => {
    const { data, response } = await client.GET("/api/v1/decks/{deck_id}", {
      params: { path: { deck_id: deckId } },
    });
    if (!data) {
      setMissing(response.status === 404);
      return undefined;
    }
    return data;
  }, [deckId]);

  useEffect(() => {
    // StrictMode (pnpm dev, and so the browser journeys) opens the editor twice. Only the
    // mount that stays may fill it: the other's answer, landing after the first edit, would
    // put the deck back as it opened, and the autosave would then save that.
    let active = true;
    void load().then((data) => {
      if (!active || !data) return;
      setDeck(data);
      setEntries(data.draft.entries);
      setCards(data.cards);
      setValidation(data.validation);
      version.current = data.draft.version;
    });
    return () => {
      active = false;
    };
  }, [load]);

  const save = useCallback(async () => {
    const sent = changes.current;
    setSaveState("saving");
    const { data, error, response } = await client.PUT(
      "/api/v1/decks/{deck_id}/draft",
      {
        params: { path: { deck_id: deckId } },
        body: { version: version.current, entries },
      },
    );
    if (data) {
      version.current = data.version;
      setValidation(data.validation);
      setCards((current) => ({ ...current, ...data.cards }));
      setSaveState(changes.current === sent ? "saved" : "dirty");
      setSaveError("");
      return;
    }
    if (response.status === 409) {
      const server = await load();
      if (server) {
        setConflict(server);
        setSaveState("conflict");
        conflictDialog.current?.showModal();
      }
      return;
    }
    setSaveState("error");
    setSaveError(describe(error));
  }, [deckId, entries, load]);

  useEffect(() => {
    if (saveState !== "dirty") return;
    const timer = window.setTimeout(() => void save(), SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [saveState, save, entries]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (saveState === "dirty" || saveState === "saving")
        event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveState]);

  useEffect(() => {
    if (opened) cardDialog.current?.showModal();
  }, [opened]);

  function change(next: DeckEntry[], added?: CardSummary) {
    changes.current += 1;
    setEntries(merge(next.filter((entry) => entry.quantity > 0)));
    if (added) setCards((current) => ({ ...current, [added.id]: added }));
    if (saveState !== "conflict") setSaveState("dirty");
  }

  function add(card: CardSummary, location: Location) {
    change(
      [
        ...entries,
        { card_id: card.id, printing_id: null, quantity: 1, location },
      ],
      card,
    );
    setMessage(
      `Added ${card.name} to the ${locationNames[location].toLowerCase()}.`,
    );
  }

  function update(entry: DeckEntry, patch: Partial<DeckEntry>) {
    change(
      entries.map((item) => (item === entry ? { ...item, ...patch } : item)),
    );
  }

  async function patch(body: {
    title?: string;
    notes?: string;
    visibility?: "private" | "link";
  }) {
    // Notes save on blur, so a click on the share box sends two changes at once: only the
    // newest answer, which holds both, may show.
    const ticket = ++patches.current;
    const { data, error } = await client.PATCH("/api/v1/decks/{deck_id}", {
      params: { path: { deck_id: deckId } },
      body,
    });
    if (ticket !== patches.current) {
      if (error) setMessage(describe(error));
      return;
    }
    if (data)
      setDeck((current) =>
        current ? { ...current, ...pickMeta(data) } : data,
      );
    else setMessage(describe(error));
  }

  async function saveVersion() {
    if (saveState === "dirty" || saveState === "saving") await save();
    const { data, error } = await client.POST(
      "/api/v1/decks/{deck_id}/revisions",
      {
        params: { path: { deck_id: deckId } },
      },
    );
    if (!data) {
      setMessage(describe(error));
      return;
    }
    setMessage(`Saved as version ${data.number}.`);
    const fresh = await load();
    if (fresh)
      setDeck((current) =>
        current
          ? {
              ...current,
              revisions: fresh.revisions,
              latest_revision: fresh.latest_revision,
            }
          : fresh,
      );
  }

  function resolve(choice: "mine" | "theirs" | "both") {
    if (!conflict) return;
    version.current = conflict.draft.version;
    const next =
      choice === "mine"
        ? entries
        : choice === "theirs"
          ? conflict.draft.entries
          : combine(entries, conflict.draft.entries);
    setCards((current) => ({ ...current, ...conflict.cards }));
    setConflict(undefined);
    conflictDialog.current?.close();
    if (choice === "theirs") {
      setEntries(next);
      setValidation(conflict.validation);
      setSaveState("saved");
    } else {
      changes.current += 1;
      setEntries(merge(next));
      setSaveState("dirty");
    }
  }

  if (missing)
    return (
      <>
        <h1 ref={heading} tabIndex={-1}>
          No such deck.
        </h1>
        <p className={styles.lead}>
          It may be in the trash, or it is not one of yours.
        </p>
        <a className={styles.primary} href="#decks">
          Back to your decks
        </a>
      </>
    );
  if (!deck || !validation) return <p role="status">Opening the deck…</p>;
  return (
    <div className={styles.editor}>
      <div className={styles.editorHead}>
        <a href="#decks" className={styles.back}>
          ← Your decks
        </a>
        <span className={styles.eyebrow}>{formatLabels[deck.format]} deck</span>
        <h1 ref={heading} tabIndex={-1} className={styles.visuallyHidden}>
          {deck.title}
        </h1>
        <label className={styles.titleField}>
          <span className={styles.visuallyHidden}>Deck name</span>
          <input
            defaultValue={deck.title}
            maxLength={80}
            onBlur={(event) => {
              const title = event.target.value.trim();
              if (title && title !== deck.title) void patch({ title });
            }}
          />
        </label>
        <SaveStatus
          state={saveState}
          error={saveError}
          onRetry={() => void save()}
        />
      </div>
      <div className={styles.columns}>
        <CardFinder
          format={deck.format}
          identity={commanderIdentity(entries, cards, deck.format)}
          onAdd={add}
          onOpen={(card) => setOpened({ card })}
        />
        <div className={styles.deckColumn}>
          <ProblemList
            validation={validation}
            cards={cards}
            onSelect={(ids) => {
              setHighlight(new Set(ids));
              document
                .getElementById(`entry-${ids[0]}`)
                ?.scrollIntoView({ block: "center" });
            }}
          />
          {message && (
            <p role="status" className={styles.message}>
              {message}
            </p>
          )}
          <DeckSections
            format={deck.format}
            entries={entries}
            cards={cards}
            highlight={highlight}
            onUpdate={update}
            onOpen={(card, entry) => setOpened({ card, entry })}
          />
          <Statistics entries={entries} cards={cards} format={deck.format} />
          <DeckMeta
            deck={deck}
            onPatch={patch}
            onSaveVersion={() => void saveVersion()}
            onMessage={setMessage}
          />
        </div>
      </div>
      <dialog
        ref={cardDialog}
        className={styles.cardDialog}
        aria-label={opened?.card.name ?? "Card"}
        onClose={() => setOpened(undefined)}
      >
        <button
          type="button"
          className={styles.close}
          aria-label="Close the card"
          onClick={() => cardDialog.current?.close()}
        >
          ×
        </button>
        {opened && (
          <CardDetails
            cardId={opened.card.id}
            chosenPrinting={opened.entry?.printing_id ?? null}
            onChoosePrinting={
              opened.entry
                ? (printingId) => {
                    update(opened.entry!, { printing_id: printingId });
                    setOpened({
                      ...opened,
                      entry: { ...opened.entry!, printing_id: printingId },
                    });
                  }
                : undefined
            }
            actions={
              <div className={styles.actions}>
                {locationsFor(deck.format).map((location) => (
                  <button
                    key={location}
                    type="button"
                    className={styles.secondary}
                    onClick={() => {
                      if (opened.entry) {
                        update(opened.entry, { location });
                        setMessage(
                          `Moved ${opened.card.name} to the ${locationNames[location].toLowerCase()}.`,
                        );
                      } else add(opened.card, location);
                      cardDialog.current?.close();
                    }}
                  >
                    {opened.entry
                      ? `Move to ${locationNames[location].toLowerCase()}`
                      : `Add to ${locationNames[location].toLowerCase()}`}
                  </button>
                ))}
              </div>
            }
          />
        )}
      </dialog>
      <dialog
        ref={conflictDialog}
        className={styles.dialog}
        aria-labelledby="conflict-title"
      >
        <h2 id="conflict-title">This deck changed somewhere else</h2>
        <p>
          While you edited, the deck was saved from another tab or window.
          Nothing is lost: choose what to keep.
        </p>
        {conflict && (
          <ul className={styles.diff}>
            {differences(entries, conflict.draft.entries).map((item) => (
              <li key={item.key}>
                <span>
                  {(
                    cards[item.entry.card_id] ??
                    conflict.cards[item.entry.card_id]
                  )?.name ?? "A card"}
                </span>
                <span>
                  here {item.mine}, saved {item.theirs} (
                  {locationNames[item.entry.location].toLowerCase()})
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            onClick={() => resolve("mine")}
          >
            Keep this version
          </button>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => resolve("theirs")}
          >
            Use the saved version
          </button>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => resolve("both")}
          >
            Combine (the larger count of each card)
          </button>
        </div>
      </dialog>
    </div>
  );
}

function pickMeta(data: DeckDetail): Partial<DeckDetail> {
  return {
    title: data.title,
    notes: data.notes,
    visibility: data.visibility,
    share_code: data.share_code,
    updated_at: data.updated_at,
  };
}

function commanderIdentity(
  entries: DeckEntry[],
  cards: Record<string, CardSummary>,
  format: string,
): string | null {
  if (format !== "commander") return null;
  const leaders = entries.filter((entry) => entry.location === "commander");
  if (leaders.length === 0) return null;
  const colors = new Set<string>();
  for (const entry of leaders)
    for (const color of cards[entry.card_id]?.color_identity ?? [])
      colors.add(color);
  return (
    ["W", "U", "B", "R", "G"].filter((color) => colors.has(color)).join("") ||
    "c"
  );
}

function SaveStatus({
  state,
  error,
  onRetry,
}: {
  state: SaveState;
  error: string;
  onRetry: () => void;
}) {
  const text = {
    saved: "All changes saved",
    dirty: "Unsaved changes…",
    saving: "Saving…",
    error: `Not saved: ${error}`,
    conflict: "Changed in another tab: choose what to keep",
  }[state];
  return (
    <span className={styles.save} data-state={state} role="status">
      {text}
      {state === "error" && (
        <button type="button" className={styles.link} onClick={onRetry}>
          Try again
        </button>
      )}
    </span>
  );
}

function CardFinder({
  format,
  identity,
  onAdd,
  onOpen,
}: {
  format: DeckDetail["format"];
  identity: string | null;
  onAdd: (card: CardSummary, location: Location) => void;
  onOpen: (card: CardSummary) => void;
}) {
  const [search, setSearch] = useState<Search>({
    ...emptySearch,
    sort: "popularity",
  });
  const [fits, setFits] = useState(true);
  const [page, setPage] = useState(1);
  const fixed = useMemo(() => {
    if (!fits) return undefined;
    const found: Record<string, string> = { legal: format, playable: "true" };
    if (identity) found.identity = identity === "c" ? "" : identity;
    if (identity === "c") found.q = "id:c";
    return found;
  }, [fits, format, identity]);
  const { results, error } = useCardSearch(search, page, 24, fixed);
  useEffect(() => setPage(1), [search, fixed]);
  return (
    <section className={styles.finder} aria-labelledby="finder-title">
      <h2 id="finder-title">Add cards</h2>
      <SearchControls search={search} onChange={setSearch} compact />
      <label className={styles.inline}>
        <input
          type="checkbox"
          checked={fits}
          onChange={(event) => setFits(event.target.checked)}
        />
        <span>
          Only cards this deck can use
          {format === "commander" && identity && identity !== "c"
            ? ` (${colorWords(identity.split(""))} identity)`
            : ""}
        </span>
      </label>
      {error && (
        <p role="alert" className={styles.refusal}>
          {error}
        </p>
      )}
      <ul className={styles.found}>
        {(results?.items ?? []).map((card) => (
          <li key={card.id}>
            <button
              type="button"
              className={styles.foundName}
              onClick={() => onOpen(card)}
            >
              <span>{card.name}</span> <ManaCost cost={card.mana_cost} />
              <small>{card.type_line}</small>
            </button>
            <StatusBadge card={card} />
            <div className={styles.foundActions}>
              {format === "commander" &&
                (card.commander || card.partner === "background") && (
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => onAdd(card, "commander")}
                  >
                    Commander
                  </button>
                )}
              {card.companion && (
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => onAdd(card, "companion")}
                >
                  Companion
                </button>
              )}
              <button
                type="button"
                className={styles.secondary}
                onClick={() => onAdd(card, "main")}
              >
                Add
              </button>
            </div>
          </li>
        ))}
      </ul>
      {results && results.total > 24 && (
        <div className={styles.pager}>
          <button
            type="button"
            className={styles.secondary}
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </button>
          <span>
            {page} / {Math.ceil(results.total / 24)}
          </span>
          <button
            type="button"
            className={styles.secondary}
            disabled={page >= Math.ceil(results.total / 24)}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}

function DeckSections({
  format,
  entries,
  cards,
  highlight,
  onUpdate,
  onOpen,
}: {
  format: DeckDetail["format"];
  entries: DeckEntry[];
  cards: Record<string, CardSummary>;
  highlight: Set<string>;
  onUpdate: (entry: DeckEntry, patch: Partial<DeckEntry>) => void;
  onOpen: (card: CardSummary, entry: DeckEntry) => void;
}) {
  return (
    <div className={styles.sections}>
      {locationsFor(format).map((location) => {
        const here = entries.filter((entry) => entry.location === location);
        const count = here.reduce((sum, entry) => sum + entry.quantity, 0);
        if (
          here.length === 0 &&
          location !== "main" &&
          location !== "commander"
        )
          return null;
        const groups = new Map<string, DeckEntry[]>();
        for (const entry of here) {
          const card = cards[entry.card_id];
          const group = location === "main" && card ? typeGroup(card) : "";
          groups.set(group, [...(groups.get(group) ?? []), entry]);
        }
        const ordered = [...groups.entries()].sort(
          ([a], [b]) =>
            typeOrder.indexOf(a as never) - typeOrder.indexOf(b as never),
        );
        return (
          <section
            key={location}
            className={styles.section}
            aria-label={locationNames[location]}
          >
            <h2>
              {locationNames[location]} <small>{count}</small>
            </h2>
            {here.length === 0 && (
              <p className={styles.hint}>
                {location === "commander"
                  ? "Choose a commander from the search: its button says Commander."
                  : "Add cards from the search."}
              </p>
            )}
            {ordered.map(([group, list]) => (
              <div key={group}>
                {group && (
                  <h3>
                    {group === "Other"
                      ? "Other"
                      : `${group}s`.replace("Sorcerys", "Sorceries")}{" "}
                    <small>
                      {list.reduce((sum, entry) => sum + entry.quantity, 0)}
                    </small>
                  </h3>
                )}
                <ul className={styles.entries}>
                  {list
                    .slice()
                    .sort(
                      (a, b) =>
                        (cards[a.card_id]?.mana_value ?? 0) -
                          (cards[b.card_id]?.mana_value ?? 0) ||
                        (cards[a.card_id]?.name ?? "").localeCompare(
                          cards[b.card_id]?.name ?? "",
                        ),
                    )
                    .map((entry) => {
                      const card = cards[entry.card_id];
                      return (
                        <li
                          key={`${entry.card_id}|${entry.printing_id ?? ""}`}
                          id={`entry-${entry.card_id}`}
                          data-highlight={highlight.has(entry.card_id)}
                          data-playable={card?.playable ?? false}
                        >
                          <div className={styles.quantity}>
                            <button
                              type="button"
                              aria-label={`One fewer ${card?.name ?? "card"}`}
                              onClick={() =>
                                onUpdate(entry, {
                                  quantity: entry.quantity - 1,
                                })
                              }
                            >
                              −
                            </button>
                            <span aria-label={`${entry.quantity} copies`}>
                              {entry.quantity}
                            </span>
                            <button
                              type="button"
                              aria-label={`One more ${card?.name ?? "card"}`}
                              disabled={
                                location === "commander" ||
                                location === "companion"
                              }
                              onClick={() =>
                                onUpdate(entry, {
                                  quantity: entry.quantity + 1,
                                })
                              }
                            >
                              +
                            </button>
                          </div>
                          <button
                            type="button"
                            className={styles.entryName}
                            onClick={() => card && onOpen(card, entry)}
                          >
                            {card?.name ?? "Loading…"}
                            {entry.printing_id && (
                              <small> · chosen printing</small>
                            )}
                          </button>
                          {card && <ManaCost cost={card.mana_cost} />}
                          {card && !card.playable && (
                            <StatusBadge card={card} />
                          )}
                          <button
                            type="button"
                            className={styles.remove}
                            aria-label={`Remove ${card?.name ?? "the card"}`}
                            onClick={() => onUpdate(entry, { quantity: 0 })}
                          >
                            ×
                          </button>
                        </li>
                      );
                    })}
                </ul>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function Statistics({
  entries,
  cards,
  format,
}: {
  entries: DeckEntry[];
  cards: Record<string, CardSummary>;
  format: DeckDetail["format"];
}) {
  const figures = useMemo(() => stats(entries, cards), [entries, cards]);
  const [hand, setHand] = useState<string[]>();
  const library = figures.counts.main;
  const peak = Math.max(1, ...figures.curve);
  return (
    <details className={styles.stats} open>
      <summary>Statistics</summary>
      <p className={styles.hint}>
        Numbers and odds describe the cards, not how well the deck plays: they
        are guides, not advice.
      </p>
      <dl className={styles.totals}>
        {(Object.keys(figures.counts) as Location[])
          .filter(
            (location) => figures.counts[location] > 0 || location === "main",
          )
          .map((location) => (
            <div key={location}>
              <dt>{locationNames[location]}</dt>
              <dd>{figures.counts[location]}</dd>
            </div>
          ))}
        <div>
          <dt>Lands</dt>
          <dd>{figures.lands}</dd>
        </div>
        <div>
          <dt>Average mana value</dt>
          <dd>{figures.averageValue.toFixed(2)}</dd>
        </div>
      </dl>
      <h3>Mana curve</h3>
      <ol className={styles.curve} aria-label="Spells by mana value">
        {figures.curve.map((count, value) => (
          <li key={value}>
            <span
              className={styles.bar}
              style={{ height: `${(count / peak) * 100}%` }}
            />
            <span>{count}</span>
            <small>{value === 7 ? "7+" : value}</small>
            <span className={styles.visuallyHidden}>
              {count} spells of mana value {value === 7 ? "7 or more" : value}
            </span>
          </li>
        ))}
      </ol>
      <h3>Colors</h3>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Color</th>
            <th scope="col">Symbols in costs</th>
            <th scope="col">Lands that make it</th>
          </tr>
        </thead>
        <tbody>
          {["W", "U", "B", "R", "G"]
            .filter(
              (color) =>
                (figures.demand[color] ?? 0) > 0 ||
                (figures.sources[color] ?? 0) > 0,
            )
            .map((color) => (
              <tr key={color}>
                <th scope="row">
                  <IdentityPips identity={color} /> {colorWords(color)}
                </th>
                <td>{figures.demand[color] ?? 0}</td>
                <td>{figures.sources[color] ?? 0}</td>
              </tr>
            ))}
        </tbody>
      </table>
      <h3>Card types</h3>
      <p>
        {Object.entries(figures.types)
          .map(
            ([type, count]) =>
              `${count} ${type === "Other" ? "other" : type.toLowerCase()}`,
          )
          .join(" · ") || "No cards yet."}
      </p>
      {library >= 7 && (
        <>
          <h3>Opening hand</h3>
          <p>
            Lands in seven cards from {library}:{" "}
            {[0, 1, 2, 3, 4, 5]
              .map(
                (k) =>
                  `${k}: ${percent(exactly(library, figures.lands, 7, k))}`,
              )
              .join(", ")}
            . Two to four lands:{" "}
            {percent(
              atLeast(library, figures.lands, 7, 2) -
                atLeast(library, figures.lands, 7, 5),
            )}
            .
          </p>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => setHand(sampleHand(entries))}
          >
            {hand ? "Draw another sample hand" : "Draw a sample hand"}
          </button>
          {hand && (
            <ul className={styles.hand} aria-label="A sample opening hand">
              {hand.map((id, index) => (
                <li key={`${id}-${index}`}>{cards[id]?.name ?? "A card"}</li>
              ))}
            </ul>
          )}
          {format === "commander" && (
            <p className={styles.hint}>
              Your commander starts in the command zone, not in the hand.
            </p>
          )}
        </>
      )}
    </details>
  );
}

function DeckMeta({
  deck,
  onPatch,
  onSaveVersion,
  onMessage,
}: {
  deck: DeckDetail;
  onPatch: (body: {
    title?: string;
    notes?: string;
    visibility?: "private" | "link";
  }) => Promise<void>;
  onSaveVersion: () => void;
  onMessage: (message: string) => void;
}) {
  const shareUrl = deck.share_code
    ? `${window.location.origin}/#shared/${deck.share_code}`
    : "";
  return (
    <section className={styles.meta} aria-labelledby="meta-title">
      <h2 id="meta-title">This deck</h2>
      <div className={styles.actions}>
        <a className={styles.primary} href={`#play?deck=${deck.id}`}>
          Play it at the practice table
        </a>
        <button
          type="button"
          className={styles.secondary}
          onClick={onSaveVersion}
        >
          Save a version
        </button>
        <a
          className={styles.secondary}
          href={`/api/v1/decks/${deck.id}/export?kind=text`}
          download
        >
          Export as text
        </a>
        <a
          className={styles.secondary}
          href={`/api/v1/decks/${deck.id}/export?kind=json`}
          download
        >
          Export as a deck file
        </a>
      </div>
      <label className={styles.inline}>
        <input
          type="checkbox"
          checked={deck.visibility === "link"}
          onChange={(event) =>
            void onPatch({
              visibility: event.target.checked ? "link" : "private",
            })
          }
        />
        <span>
          Share by link with signed-in players (they see the cards, never your
          notes)
        </span>
      </label>
      {shareUrl && (
        <p className={styles.share}>
          <input
            readOnly
            value={shareUrl}
            aria-label="Share link"
            onFocus={(event) => event.target.select()}
          />
          <button
            type="button"
            className={styles.secondary}
            onClick={() =>
              void navigator.clipboard
                ?.writeText(shareUrl)
                .then(() => onMessage("Link copied."))
            }
          >
            Copy
          </button>
        </p>
      )}
      <label className={styles.field}>
        <span>Notes (only you see these)</span>
        <textarea
          rows={4}
          defaultValue={deck.notes}
          maxLength={10000}
          onBlur={(event) => {
            if (event.target.value !== deck.notes)
              void onPatch({ notes: event.target.value });
          }}
        />
      </label>
      {deck.revisions.length > 0 && (
        <details>
          <summary>Versions ({deck.revisions.length})</summary>
          <ul className={styles.revisions}>
            {deck.revisions.map((revision) => (
              <li key={revision.number}>
                Version {revision.number} ·{" "}
                {new Date(revision.created_at).toLocaleString()} ·{" "}
                {revision.playable
                  ? "playable"
                  : revision.legal
                    ? "legal"
                    : "not legal"}
              </li>
            ))}
          </ul>
          <p className={styles.hint}>
            A game keeps the version it started with, whatever you change later.
          </p>
        </details>
      )}
    </section>
  );
}
