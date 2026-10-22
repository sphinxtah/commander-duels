import { useCallback, useEffect, useState } from "react";
import { client, describe } from "../api";
import styles from "../Account.module.css";
import shell from "../App.module.css";
import {
  emptySearch,
  formatLabels,
  reasonLabels,
  type CardSummary,
  type CatalogStatus,
} from "./catalog";
import { catalogLine } from "./CardsPage";
import { useCardSearch } from "./SearchControls";
import type { components } from "../generated/api";

type SyncRun = components["schemas"]["SyncRunInfo"];
type Coverage = components["schemas"]["Coverage"];
type ReviewCard = components["schemas"]["ReviewCard"];
type ReviewAction = components["schemas"]["ReviewAction"]["action"];

const runNames: Record<string, string> = {
  running: "Running",
  succeeded: "New revision",
  unchanged: "Nothing changed",
  failed: "Failed",
  fenced: "Stopped (another run took over)",
};

const statusNames: Record<string, string> = {
  certified: "Playable",
  implemented: "Held back by the checks",
  mapped: "Mapped to the engine",
  catalog_only: "Catalog only",
  suspended: "Suspended",
  unsupported: "Unsupported",
};

function when(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
}

function took(run: SyncRun) {
  if (!run.finished_at) return "—";
  const seconds = Math.round(
    (new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) /
      1000,
  );
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

function list(value: unknown) {
  return Array.isArray(value) && value.length > 0 ? value.join(", ") : "none";
}

type Change = {
  revision?: number;
  before?: { oracle_text?: string | null };
  after?: { oracle_text?: string | null };
};

/** The catalog's state for administrators: the sync, the engine's coverage, and the cards to
 * review: those whose Oracle text changed since they were certified (CAT02, CAT07, CAT08), and
 * since v0.4.5 those the engine's automatic checks held back, the only cards outside the game the
 * site lists, since accepting one is how it comes into the game. */
export function CatalogAdmin() {
  const [status, setStatus] = useState<CatalogStatus>();
  const [runs, setRuns] = useState<SyncRun[]>([]);
  const [coverage, setCoverage] = useState<Coverage>();
  const [reviews, setReviews] = useState<ReviewCard[]>([]);
  const [message, setMessage] = useState("");
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  // Bare words search card names; the results show only once a name is typed.
  const found = useCardSearch({ ...emptySearch, q: name.trim() }, 1, 6);

  const load = useCallback(async () => {
    const [current, recent, covered, waiting] = await Promise.all([
      client.GET("/api/v1/catalog"),
      client.GET("/api/v1/admin/catalog/runs"),
      client.GET("/api/v1/catalog/coverage"),
      client.GET("/api/v1/admin/catalog/reviews"),
    ]);
    if (current.data) setStatus(current.data);
    if (recent.data) setRuns(recent.data);
    if (covered.data) setCoverage(covered.data);
    if (waiting.data) setReviews(waiting.data);
    const failed = [current, recent, covered, waiting].find(
      (result) => !result.data,
    );
    if (failed) setMessage(describe(failed.error));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function runNow() {
    const { data, error } = await client.POST("/api/v1/admin/catalog/sync");
    setMessage(
      data
        ? "The catalog sync is queued. The worker starts it within a minute; refresh to follow it."
        : describe(error),
    );
    if (data) void load();
  }

  async function review(card: CardSummary, action: ReviewAction) {
    const { data, error } = await client.POST(
      "/api/v1/admin/catalog/cards/{card_id}/review",
      {
        params: { path: { card_id: card.id } },
        body: { action, reason: action === "suspend" ? reason.trim() : "" },
      },
    );
    if (!data) return setMessage(describe(error));
    setMessage(
      {
        accept:
          card.status === "implemented"
            ? `${card.name} is accepted: it is in the game from now on, as the engine plays it.`
            : `${card.name}: the engine's version is accepted for today's text.`,
        suspend: `${card.name} is suspended: it has left the game, and every deck's draft.`,
        restore: `${card.name} is restored.`,
      }[action],
    );
    setReason("");
    void load();
  }

  return (
    <>
      <section className={styles.panel} aria-labelledby="sync-title">
        <h2 id="sync-title">Catalog sync</h2>
        <p>{catalogLine(status)}</p>
        {status && (
          <p className={styles.fine}>
            Last run: {status.last_run ? when(status.last_run.started_at) : "—"}
            {status.last_run &&
              ` · ${runNames[status.last_run.status] ?? status.last_run.status}`}{" "}
            · next scheduled run {when(status.next_run_at)}
            {status.revision?.engine_build &&
              ` · engine ${status.revision.engine_build}`}
            {Object.entries(status.format_versions).map(
              ([format, version]) =>
                ` · ${formatLabels[format] ?? format} banned list v${version}`,
            )}
          </p>
        )}
        <div className={styles.actions}>
          <button className={shell.primary} onClick={() => void runNow()}>
            Run the catalog sync now
          </button>
          <button className={styles.secondary} onClick={() => void load()}>
            Refresh
          </button>
        </div>
        <p role="status" className={styles.fine}>
          {message}
        </p>
        <div className={styles.tableWrap}>
          <table className={styles.audit} aria-label="Recent catalog runs">
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">By</th>
                <th scope="col">Result</th>
                <th scope="col">Took</th>
                <th scope="col">Revision</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td>{when(run.started_at)}</td>
                  <td>{run.trigger === "manual" ? "Run now" : "Schedule"}</td>
                  <td>{runNames[run.status] ?? run.status}</td>
                  <td>{took(run)}</td>
                  <td>{run.revision_id ?? "—"}</td>
                  <td>
                    {run.error_code
                      ? `${run.error_code}: ${run.error_message ?? ""}${run.next_attempt_at ? ` · retries ${when(run.next_attempt_at)}` : ""}`
                      : `downloaded ${list(run.stats.downloaded)} · reused ${list(run.stats.reused)}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className={styles.panel} aria-labelledby="coverage-title">
        <h2 id="coverage-title">What the engine can play</h2>
        <p className={styles.fine}>
          Format-legal deck cards by status
          {coverage?.engine_build ? `, engine ${coverage.engine_build}` : ""}.
        </p>
        {coverage &&
          Object.entries(coverage.formats).map(([format, rows]) => (
            <div key={format} className={styles.tableWrap}>
              <table
                className={styles.audit}
                aria-label={`${formatLabels[format] ?? format} coverage`}
              >
                <caption>{formatLabels[format] ?? format}</caption>
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col">Why</th>
                    <th scope="col">Cards</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.status}|${row.reason ?? ""}`}>
                      <td>{statusNames[row.status] ?? row.status}</td>
                      <td>
                        {row.reason
                          ? (reasonLabels[row.reason] ?? row.reason)
                          : "—"}
                      </td>
                      <td>{row.cards.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </section>
      <section className={styles.panel} aria-labelledby="reviews-title">
        <h2 id="reviews-title">Cards to review</h2>
        <p className={styles.fine}>
          A playable card whose Oracle text changed stays playable until
          reviewed. Accept it when the engine still plays it as written, or
          suspend it until the engine catches up. A card the engine's automatic
          checks held back is not in the game: accept it when the engine plays
          it right, and it stays in the game through later syncs. A suspended
          card leaves the game, and every deck's draft, until it is restored.
        </p>
        <label className={styles.field}>
          <span>
            Reason for a suspension (shown to the players whose decks it leaves)
          </span>
          <input
            value={reason}
            maxLength={500}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {reviews.length === 0 ? (
          <p className={styles.fine}>Nothing waits for a review.</p>
        ) : (
          <ul className={styles.users}>
            {reviews.map(({ card, changed }) => {
              const latest = changed[0] as Change | undefined;
              return (
                <li key={card.id} aria-label={card.name}>
                  <div className={styles.userHead}>
                    <div>
                      <strong>{card.name}</strong>
                      <span>{card.type_line}</span>
                      {latest && (
                        <small>
                          Changed in revision {latest.revision ?? "—"}: “
                          {latest.before?.oracle_text ?? ""}” → “
                          {latest.after?.oracle_text ?? ""}”
                        </small>
                      )}
                      {card.status === "implemented" && card.status_detail && (
                        <small>{card.status_detail}</small>
                      )}
                    </div>
                    <span className={shell.tag}>
                      {(statusNames[card.status] ?? card.status).toUpperCase()}
                    </span>
                  </div>
                  <div className={styles.actions}>
                    {card.status === "suspended" ? (
                      <button
                        className={styles.secondary}
                        onClick={() => void review(card, "restore")}
                      >
                        Restore {card.name}
                      </button>
                    ) : card.status === "implemented" ? (
                      <button
                        className={shell.primary}
                        onClick={() => void review(card, "accept")}
                      >
                        Accept {card.name}
                      </button>
                    ) : (
                      <>
                        {card.status === "certified" && (
                          <button
                            className={shell.primary}
                            onClick={() => void review(card, "accept")}
                          >
                            Accept {card.name}
                          </button>
                        )}
                        <button
                          className={styles.danger}
                          onClick={() => void review(card, "suspend")}
                        >
                          Suspend {card.name}
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <h3>Suspend another card</h3>
        <label className={styles.field}>
          <span>Card name</span>
          <input
            type="search"
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {name.trim() && (
          <ul className={styles.users} aria-label="Cards found">
            {(found.results?.items ?? []).map((card) => (
              <li key={card.id} aria-label={card.name}>
                <div className={styles.userHead}>
                  <div>
                    <strong>{card.name}</strong>
                    <span>{card.type_line}</span>
                  </div>
                  <span className={shell.tag}>
                    {(statusNames[card.status] ?? card.status).toUpperCase()}
                  </span>
                </div>
                <div className={styles.actions}>
                  {card.status === "suspended" ? (
                    <button
                      className={styles.secondary}
                      onClick={() => void review(card, "restore")}
                    >
                      Restore {card.name}
                    </button>
                  ) : (
                    <button
                      className={styles.danger}
                      onClick={() => void review(card, "suspend")}
                    >
                      Suspend {card.name}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
