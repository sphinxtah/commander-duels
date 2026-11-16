import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { client, describe } from "../api";
import { formatLabels } from "../catalog/catalog";
import {
  locationNames,
  type DeckDetail,
  type Location,
  type RevisionSummary,
} from "./decks";
import { MissingCards } from "./MissingCards";
import {
  diffWords,
  lineChange,
  oppositionWords,
  recordWords,
  sideWords,
  splitFormat,
  splitMode,
  winRate,
  type DeckDiff,
  type DeckRecord,
  type Performance,
  type Side,
  type Split,
} from "./workshop";
import styles from "./decks.module.css";

// A deck's Workshop (v1.0.0, docs/decks.md; the owner's decision 26: a page of its own, beside
// the editor, at #deck/<id>/workshop). Three parts: its saved versions compared and restored
// into the draft; its results, in all and by the version played, each with its sample size; and
// the cards its player's library lacks, with where each might be had and the owned cards that
// could take its place. Restoring makes a new draft: no version and no game's record changes.

type Part = "versions" | "results" | "missing";
const PARTS: [Part, string][] = [
  ["versions", "Versions"],
  ["results", "Results"],
  ["missing", "Missing cards"],
];

export type Draft = DeckDetail["draft"];

function when(value: string): string {
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function DeckWorkshop({
  deckId,
  heading,
}: {
  deckId: string;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const [deck, setDeck] = useState<DeckDetail>();
  const [missing, setMissing] = useState(false);
  const [part, setPart] = useState<Part>("versions");
  // The draft as this page last saw it: a restore or a swap sends its version, and takes the
  // one the server answers with.
  const [draft, setDraft] = useState<Draft>();

  const load = useCallback(async () => {
    const { data, response } = await client
      .GET("/api/v1/decks/{deck_id}", {
        params: { path: { deck_id: deckId } },
      })
      .catch(() => ({ data: undefined, response: undefined }));
    if (data) {
      setDeck(data);
      setDraft(data.draft);
    } else setMissing(response?.status === 404 || response?.status === 403);
    return data;
  }, [deckId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (missing)
    return (
      <>
        <h1 ref={heading} tabIndex={-1}>
          There is no such deck.
        </h1>
        <p className={styles.lead}>
          It may have been deleted, or it is another player&apos;s.{" "}
          <a href="#decks">Back to your decks</a>
        </p>
      </>
    );
  if (!deck || !draft) return <p role="status">Opening the workshop…</p>;

  return (
    <>
      <span className={styles.eyebrow}>DECK WORKSHOP</span>
      <h1 ref={heading} tabIndex={-1}>
        {deck.title}
      </h1>
      <p className={styles.lead}>
        {formatLabels[deck.format]} · {deck.card_count} cards. Its versions
        compared and restored, its results by the version played, and the cards
        it lacks. <a href={`#deck/${deck.id}`}>Open it in the editor</a> ·{" "}
        <a href="#decks">All decks</a>
      </p>
      <div
        className={styles.tabs}
        role="tablist"
        aria-label="The workshop's parts"
      >
        {PARTS.map(([id, name]) => (
          <button
            key={id}
            role="tab"
            type="button"
            id={`workshop-tab-${id}`}
            aria-selected={part === id}
            aria-controls="workshop-panel"
            onClick={() => setPart(id)}
          >
            {name}
          </button>
        ))}
      </div>
      <div
        id="workshop-panel"
        role="tabpanel"
        aria-labelledby={`workshop-tab-${part}`}
      >
        {part === "versions" ? (
          <Versions deck={deck} draft={draft} onChanged={load} />
        ) : part === "results" ? (
          <Results deckId={deck.id} />
        ) : (
          <MissingCards
            deck={deck}
            draft={draft}
            onDraft={setDraft}
            onStale={() => void load()}
          />
        )}
      </div>
    </>
  );
}

/** A side's value in a select: "draft", or a version's number. */
function sideOf(value: string): Side {
  return value === "draft" ? "draft" : Number(value);
}

function useDiff(
  deckId: string,
  before: Side | null,
  after: Side,
  stamp: number,
): { diff: DeckDiff | null; error: string } {
  const [state, setState] = useState<{ diff: DeckDiff | null; error: string }>({
    diff: null,
    error: "",
  });
  useEffect(() => {
    if (before === null) return;
    let active = true;
    void client
      .GET("/api/v1/decks/{deck_id}/diff", {
        params: {
          path: { deck_id: deckId },
          query: { before: String(before), after: String(after) },
        },
      })
      .catch(() => ({ data: undefined, error: undefined }))
      .then(({ data, error }) => {
        if (!active) return;
        setState(
          data
            ? { diff: data, error: "" }
            : { diff: null, error: describe(error) },
        );
      });
    return () => {
      active = false;
    };
  }, [deckId, before, after, stamp]);
  return state;
}

/** Two sides compared card by card, by the place each card is in. */
export function DiffTable({ diff }: { diff: DeckDiff }) {
  const places = [...new Set(diff.lines.map((line) => line.location))];
  return (
    <div className={styles.diffScroll}>
      <table className={styles.diffTable}>
        <caption className={styles.visuallyHidden}>
          {sideWords(diff.before)} compared with {sideWords(diff.after)}
        </caption>
        <thead>
          <tr>
            <th scope="col">Card</th>
            <th scope="col">{sideWords(diff.before)}</th>
            <th scope="col">{sideWords(diff.after)}</th>
            <th scope="col">Change</th>
          </tr>
        </thead>
        {places.map((place) => (
          <tbody key={place}>
            <tr>
              <th colSpan={4} scope="colgroup" className={styles.diffPlace}>
                {locationNames[place as Location] ?? place}
              </th>
            </tr>
            {diff.lines
              .filter((line) => line.location === place)
              .map((line) => {
                const change = lineChange(line);
                return (
                  <tr
                    key={`${line.card_id}-${line.location}`}
                    data-change={change > 0 ? "added" : "removed"}
                  >
                    <th scope="row">{line.name}</th>
                    <td>{line.before || "–"}</td>
                    <td>{line.after || "–"}</td>
                    {/* Said in words and by its sign, never by colour alone. */}
                    <td>
                      {change > 0 ? `+${change} added` : `−${-change} removed`}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function Versions({
  deck,
  draft,
  onChanged,
}: {
  deck: DeckDetail;
  draft: Draft;
  /** The deck again, after a restore changed its draft and perhaps its versions. */
  onChanged: () => Promise<DeckDetail | undefined>;
}) {
  const versions = [...deck.revisions].sort((a, b) => b.number - a.number);
  const latest = versions[0]?.number ?? null;
  const [before, setBefore] = useState<Side | null>(latest);
  const [after, setAfter] = useState<Side>("draft");
  // Asked again once a restore changed the draft.
  const [stamp, setStamp] = useState(0);
  const { diff, error } = useDiff(deck.id, before, after, stamp);
  const [restoring, setRestoring] = useState<RevisionSummary | null>(null);
  const [message, setMessage] = useState("");

  if (latest === null)
    return (
      <p className={styles.hint}>
        This deck has no saved version yet. A version is the deck as a game
        plays it, and what you compare and go back to: save one from the editor
        (&quot;Save a version&quot;), and it is listed here.
      </p>
    );

  return (
    <>
      {message && (
        <p role="status" className={styles.message}>
          {message}{" "}
          <a href={`#deck/${deck.id}`}>Open the draft in the editor</a>
        </p>
      )}
      <section aria-labelledby="compare-title">
        <h2 id="compare-title" className={styles.workshopHead}>
          Compare
        </h2>
        <div className={styles.compare}>
          <label className={styles.field}>
            <span>From</span>
            <select
              value={String(before)}
              onChange={(event) => setBefore(sideOf(event.target.value))}
            >
              {versions.map((version) => (
                <option key={version.number} value={version.number}>
                  Version {version.number}, saved {when(version.created_at)}
                </option>
              ))}
              <option value="draft">The draft</option>
            </select>
          </label>
          <label className={styles.field}>
            <span>To</span>
            <select
              value={String(after)}
              onChange={(event) => setAfter(sideOf(event.target.value))}
            >
              <option value="draft">The draft</option>
              {versions.map((version) => (
                <option key={version.number} value={version.number}>
                  Version {version.number}, saved {when(version.created_at)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && (
          <p role="alert" className={styles.refusal}>
            {error}
          </p>
        )}
        {diff && (
          <>
            <p role="status" className={styles.diffLine}>
              From {sideWords(diff.before).toLowerCase()} to{" "}
              {sideWords(diff.after).toLowerCase()}: {diffWords(diff)}
              {diff.same ? "" : "."} Another edition of the same card is no
              difference.
            </p>
            {!diff.same && <DiffTable diff={diff} />}
          </>
        )}
      </section>
      <section aria-labelledby="versions-title">
        <h2 id="versions-title" className={styles.workshopHead}>
          Saved versions
        </h2>
        <p className={styles.hint}>
          A saved version never changes: a game that played it keeps it.
          Restoring one makes its cards the draft, to go on from.
        </p>
        <ul className={styles.versionList}>
          {versions.map((version) => (
            <li key={version.number}>
              <div>
                <strong>Version {version.number}</strong>
                <span className={styles.deckMeta}>
                  {version.title} · saved {when(version.created_at)} ·{" "}
                  {version.playable
                    ? "Playable"
                    : version.legal
                      ? "Legal, not playable"
                      : "Not legal"}
                </span>
              </div>
              <div className={styles.rowActions}>
                <button
                  type="button"
                  className={styles.secondary}
                  aria-label={`Compare version ${version.number} with the draft`}
                  onClick={() => {
                    setBefore(version.number);
                    setAfter("draft");
                  }}
                >
                  Compare with the draft
                </button>
                <button
                  type="button"
                  className={styles.secondary}
                  aria-label={`Restore version ${version.number} into the draft`}
                  onClick={() => setRestoring(version)}
                >
                  Restore into the draft
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
      {restoring && (
        <RestoreDialog
          deck={deck}
          draft={draft}
          version={restoring}
          latest={latest}
          onClose={() => setRestoring(null)}
          onRestored={async (number) => {
            setRestoring(null);
            await onChanged();
            setStamp((n) => n + 1);
            setMessage(
              `Version ${number} is the draft now. No saved version and no game's record changed.`,
            );
          }}
        />
      )}
    </>
  );
}

/**
 * Restoring asks first, and says what it means: the draft becomes the version's cards; no saved
 * version is rewritten and every game keeps the version it played. The draft as it stands is
 * replaced, so where it differs from the latest version the dialog offers to save it as a
 * version first, ticked.
 */
function RestoreDialog({
  deck,
  draft,
  version,
  latest,
  onClose,
  onRestored,
}: {
  deck: DeckDetail;
  draft: Draft;
  version: RevisionSummary;
  /** The newest saved version's number. */
  latest: number;
  onClose: () => void;
  onRestored: (number: number) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  // What the restore would change in the draft, and whether the draft holds anything the
  // newest version does not.
  const change = useDiff(deck.id, "draft", version.number, 0);
  const unsaved = useDiff(deck.id, latest, "draft", 0);
  const differs = unsaved.diff ? !unsaved.diff.same : false;
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!dialog.current?.open) dialog.current?.showModal?.();
  }, []);

  async function restore() {
    setBusy(true);
    setError("");
    const path = { deck_id: deck.id };
    if (differs && keep) {
      const saved = await client
        .POST("/api/v1/decks/{deck_id}/revisions", { params: { path } })
        .catch(() => ({ data: undefined, error: undefined }));
      if (!saved.data) {
        setBusy(false);
        return setError(
          `The draft was not saved as a version: ${describe(saved.error)} Nothing was restored.`,
        );
      }
    }
    const {
      data,
      error: failure,
      response,
    } = await client
      .POST("/api/v1/decks/{deck_id}/revisions/{number}/restore", {
        params: { path: { ...path, number: version.number } },
        body: { version: draft.version },
      })
      .catch(() => ({
        data: undefined,
        error: undefined,
        response: undefined,
      }));
    setBusy(false);
    if (!data)
      return setError(
        response?.status === 409
          ? "This deck changed somewhere else since this page opened. Close this, reload the page and try again."
          : describe(failure),
      );
    await onRestored(version.number);
  }

  return (
    <dialog
      ref={dialog}
      className={styles.dialog}
      aria-labelledby="restore-title"
      onClose={onClose}
    >
      <h2 id="restore-title">
        Restore version {version.number} into the draft?
      </h2>
      <p>
        The draft becomes the cards of version {version.number}, to go on from
        in the editor.
      </p>
      <ul className={styles.restoreMeans}>
        <li>No saved version is rewritten.</li>
        <li>Every game keeps the version it played, and its result.</li>
        <li>The draft as it is now is replaced.</li>
      </ul>
      {change.diff && (
        <p className={styles.hint}>
          In the draft this changes: {diffWords(change.diff)}
          {change.diff.same ? "" : "."}
        </p>
      )}
      {differs && (
        <label className={styles.inline}>
          <input
            type="checkbox"
            checked={keep}
            onChange={(event) => setKeep(event.target.checked)}
          />
          Save the draft as a version first: it holds changes no version has
        </label>
      )}
      {error && (
        <p role="alert" className={styles.refusal}>
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.secondary}
          autoFocus
          disabled={busy}
          onClick={() => dialog.current?.close()}
        >
          Keep the draft
        </button>
        <button
          type="button"
          className={styles.primary}
          disabled={busy}
          onClick={() => void restore()}
        >
          {busy ? "Restoring…" : `Restore version ${version.number}`}
        </button>
      </div>
    </dialog>
  );
}

/** A record's games, with what a small sample is worth said beside it. */
function Sample({ record }: { record: DeckRecord }) {
  return (
    <>
      {record.games}
      {record.small_sample && record.games > 0 && (
        <small className={styles.smallSample}> few games</small>
      )}
    </>
  );
}

function RecordCells({ record }: { record: DeckRecord }) {
  return (
    <>
      <td>
        <Sample record={record} />
      </td>
      <td>{recordWords(record)}</td>
      <td>{winRate(record)}</td>
    </>
  );
}

function Results({ deckId }: { deckId: string }) {
  const [results, setResults] = useState<Performance>();
  const [error, setError] = useState("");
  // The splits shown: of every version, or of one.
  const [of, setOf] = useState<number | "all">("all");
  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/decks/{deck_id}/performance", {
        params: { path: { deck_id: deckId } },
      })
      .catch(() => ({ data: undefined, error: undefined }))
      .then(({ data, error: failure }) => {
        if (!active) return;
        if (data) setResults(data);
        else setError(describe(failure));
      });
    return () => {
      active = false;
    };
  }, [deckId]);

  if (error)
    return (
      <p role="alert" className={styles.refusal}>
        {error}
      </p>
    );
  if (!results) return <p role="status">Counting the games…</p>;
  if (results.record.games === 0)
    return (
      <p className={styles.hint}>
        No game has ended with a saved version of this deck yet. A game counts
        for the version it played, so the results stay true to the cards that
        were on the table.
      </p>
    );
  const chosen = results.versions.find((version) => version.number === of);
  const splits: Split[] = chosen ? chosen.splits : results.splits;
  return (
    <>
      <section aria-labelledby="record-title">
        <h2 id="record-title" className={styles.workshopHead}>
          In all
        </h2>
        <dl className={styles.recordFacts}>
          <div>
            <dt>Games</dt>
            <dd>{results.record.games}</dd>
          </div>
          <div>
            <dt>Record</dt>
            <dd>{recordWords(results.record)}</dd>
          </div>
          <div>
            <dt>Win rate</dt>
            <dd>{winRate(results.record)}</dd>
          </div>
        </dl>
        {results.record.small_sample && (
          <p className={styles.hint}>
            Fewer than ten games: a record this short says little.
          </p>
        )}
      </section>
      <section aria-labelledby="by-version-title">
        <h2 id="by-version-title" className={styles.workshopHead}>
          By the version played
        </h2>
        <div className={styles.diffScroll}>
          <table
            className={styles.diffTable}
            aria-labelledby="by-version-title"
          >
            <thead>
              <tr>
                <th scope="col">Version</th>
                <th scope="col">Saved</th>
                <th scope="col">Games</th>
                <th scope="col">Record</th>
                <th scope="col">Win rate</th>
              </tr>
            </thead>
            <tbody>
              {results.versions.map((version) => (
                <tr key={version.number}>
                  <th scope="row">Version {version.number}</th>
                  <td>{when(version.created_at)}</td>
                  <RecordCells record={version.record} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.hint}>
          A version never played is not listed. &quot;Few games&quot; marks a
          record of fewer than ten, which says little.
        </p>
      </section>
      <section aria-labelledby="splits-title">
        <h2 id="splits-title" className={styles.workshopHead}>
          Told apart
        </h2>
        <label className={styles.field}>
          <span>Games of</span>
          <select
            value={String(of)}
            onChange={(event) =>
              setOf(
                event.target.value === "all"
                  ? "all"
                  : Number(event.target.value),
              )
            }
          >
            <option value="all">Every version</option>
            {results.versions.map((version) => (
              <option key={version.number} value={version.number}>
                Version {version.number}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.diffScroll}>
          <table className={styles.diffTable} aria-labelledby="splits-title">
            <thead>
              <tr>
                <th scope="col">Format</th>
                <th scope="col">Mode</th>
                <th scope="col">Against</th>
                <th scope="col">Games</th>
                <th scope="col">Record</th>
                <th scope="col">Win rate</th>
              </tr>
            </thead>
            <tbody>
              {splits.map((split) => (
                <tr
                  key={`${split.format}-${split.mode}-${split.opposition}-${split.bot_skill}`}
                >
                  <th scope="row">{splitFormat(split)}</th>
                  <td>{splitMode(split)}</td>
                  <td>{oppositionWords(split)}</td>
                  <RecordCells record={split} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.hint}>
          Games against bots, against players and against both are counted
          apart, and so is each skill of the bots. A result given for testing
          names no game, and is counted nowhere.
        </p>
      </section>
    </>
  );
}
