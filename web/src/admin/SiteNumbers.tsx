import { useEffect, useState } from "react";
import { client, describe } from "../api";
import type { components } from "../generated/api";
import styles from "../Account.module.css";
import admin from "./admin.module.css";

// Administration's Numbers tab (v1.0.0): the site's numbers (docs/operations.md), read from
// `GET /api/v1/admin/operations`, for SysOp and administrators (admin.audit.read). Counts,
// codes and ids, and nothing concealed. It begins with the games' record and with how tables
// fit what they described (Rule Zero, the owner's decision 25): the players' answers are tallied
// here and shown nowhere else, to no player and no host. Then the gates: each unfinished
// workflow's stage, which SysOp sets here (rollout.manage) instead of at the console.

type Operations = components["schemas"]["Operations"];
type FitCount = components["schemas"]["FitCount"];
type Rollout = components["schemas"]["Rollout"];
type Staged = components["schemas"]["Staged"];
type Stage = Staged["stage"];

const STAGES: Stage[] = ["off", "staff", "on"];
/** Who reaches a workflow at each stage (docs/operations.md). */
const STAGE_WORDS: Record<Stage, string> = {
  off: "Nobody",
  staff: "SysOp and administrators",
  on: "Everyone",
};
const STAGE_SENTENCES: Record<Stage, string> = {
  off: "nobody reaches it",
  staff: "SysOp and administrators reach it",
  on: "everyone reaches it",
};

/** The kinds of game a table's profile names, as the API does. */
const INTENT_NAMES: Record<string, string> = {
  learning: "Learning game",
  precon: "Preconstructed decks",
  upgraded: "Upgraded casual",
  high_power: "High power",
  competitive: "Competitive",
  custom: "Custom",
};

function when(value: string) {
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function answers(count: FitCount): number {
  return count.as_described + count.stronger + count.weaker;
}

/** A share of the answers, in whole percent. */
function share(part: number, whole: number): string {
  return whole ? `${Math.round((part / whole) * 100)}%` : "–";
}

/**
 * The gates: every unfinished workflow with its stage and who reaches it. SysOp chooses another
 * stage and sets it, two steps, since a stage decides who meets a workflow on the live site; the
 * change is in the audit log. An administrator reads the stages.
 */
function Gates({
  rollout,
  canStage,
  onChanged,
}: {
  rollout: Rollout;
  canStage: boolean;
  onChanged: (rollout: Rollout) => void;
}) {
  const [chosen, setChosen] = useState<Record<string, Stage>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ refused: boolean; text: string } | null>(
    null,
  );

  async function set(workflow: Staged, stage: Stage) {
    setBusy(true);
    setNote(null);
    const { data, error } = await client
      .PUT("/api/v1/admin/rollout/{workflow}", {
        params: { path: { workflow: workflow.id } },
        body: { stage },
      })
      .catch(() => ({ data: undefined, error: undefined }));
    setBusy(false);
    if (!data) return setNote({ refused: true, text: describe(error) });
    onChanged(data);
    setChosen((current) => {
      const { [workflow.id]: _set, ...rest } = current;
      return rest;
    });
    setNote({
      refused: false,
      text: `${workflow.name} is ${stage} now: ${STAGE_SENTENCES[stage]}.`,
    });
  }

  return (
    <>
      <h3 className={admin.numbersHead} id="gates-title">
        The gates
      </h3>
      <p className={styles.fine}>
        A workflow that is not finished for everyone has a stage: off (nobody
        reaches it, and its pages show no way in), staff (SysOp and
        administrators, to try it on the live site) or on (everyone).{" "}
        {canStage
          ? "Choose a stage and set it; the change is in the audit log."
          : "SysOp sets a stage."}
      </p>
      <div className={styles.tableWrap}>
        <table className={styles.audit} aria-labelledby="gates-title">
          <thead>
            <tr>
              <th scope="col">Workflow</th>
              <th scope="col">Stage</th>
              <th scope="col">Who reaches it</th>
              <th scope="col">Set</th>
              {canStage && <th scope="col">Change</th>}
            </tr>
          </thead>
          <tbody>
            {rollout.workflows.map((workflow) => {
              const next = chosen[workflow.id] ?? workflow.stage;
              return (
                <tr key={workflow.id}>
                  <th scope="row">
                    {workflow.name} <code>{workflow.id}</code>
                  </th>
                  <td>{workflow.stage}</td>
                  <td>{STAGE_WORDS[workflow.stage]}</td>
                  <td>
                    {workflow.changed_at ? when(workflow.changed_at) : "Never"}
                  </td>
                  {canStage && (
                    <td>
                      <span className={admin.gateSet}>
                        <select
                          aria-label={`Stage of ${workflow.name}`}
                          value={next}
                          disabled={busy}
                          onChange={(event) =>
                            setChosen((current) => ({
                              ...current,
                              [workflow.id]: event.target.value as Stage,
                            }))
                          }
                        >
                          {STAGES.map((stage) => (
                            <option key={stage} value={stage}>
                              {stage}: {STAGE_WORDS[stage]}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className={styles.secondary}
                          disabled={busy || next === workflow.stage}
                          aria-label={`Set ${workflow.name} to ${next}`}
                          onClick={() => void set(workflow, next)}
                        >
                          Set
                        </button>
                      </span>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {note && (
        <p
          role={note.refused ? "alert" : "status"}
          className={note.refused ? styles.error : styles.fine}
        >
          {note.text}
        </p>
      )}
    </>
  );
}

export function SiteNumbers({
  canStage = false,
}: {
  /** Whether the account sets the gates' stages (rollout.manage, SysOp's alone). */
  canStage?: boolean;
}) {
  const [numbers, setNumbers] = useState<Operations | null>(null);
  const [message, setMessage] = useState("");
  const [asked, setAsked] = useState(0);
  const [busy, setBusy] = useState(true);
  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/admin/operations")
      .catch(() => ({ data: undefined, error: undefined }))
      .then(({ data, error }) => {
        if (!active) return;
        setBusy(false);
        if (data) {
          setNumbers(data);
          setMessage("");
        } else setMessage(describe(error));
      });
    return () => {
      active = false;
    };
  }, [asked]);

  const fit = numbers?.table_fit ?? [];
  const total = fit.reduce((sum, count) => sum + answers(count), 0);
  return (
    <section className={styles.panel} aria-labelledby="numbers-title">
      <h2 id="numbers-title">The site&apos;s numbers</h2>
      <p className={styles.fine}>
        Counts, codes and ids: no hand, deck list, library or chat is read here.{" "}
        {numbers &&
          `Version ${numbers.version}, migration ${numbers.migration}, as of ${when(numbers.now)}.`}
      </p>
      <button
        type="button"
        className={styles.secondary}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setAsked((n) => n + 1);
        }}
      >
        {busy ? "Reading…" : "Read again"}
      </button>
      {message && (
        <p role="alert" className={styles.error}>
          {message}
        </p>
      )}
      {numbers && (
        <>
          <h3 className={admin.numbersHead}>Games</h3>
          <dl className={admin.standing}>
            <div>
              <dt>Running now</dt>
              <dd>{numbers.games.running}</dd>
            </div>
            <div>
              <dt>Recorded as running</dt>
              <dd>{numbers.games.active}</dd>
            </div>
            <div>
              <dt>Finished, last day</dt>
              <dd>{numbers.games.last_day.finished}</dd>
            </div>
            <div>
              <dt>Interrupted, last day</dt>
              <dd>{numbers.games.last_day.interrupted}</dd>
            </div>
            <div>
              <dt>Finished, last week</dt>
              <dd>{numbers.games.last_week.finished}</dd>
            </div>
            <div>
              <dt>Interrupted, last week</dt>
              <dd>{numbers.games.last_week.interrupted}</dd>
            </div>
          </dl>

          <h3 className={admin.numbersHead} id="fit-title">
            How tables fit what they described
          </h3>
          <p className={styles.fine}>
            After a game at a table that described itself, each of its players
            may say whether it was as described, stronger or weaker. The answers
            are counted here by the kind of game the table named, and shown
            nowhere else: no player and no host sees one, and nothing rates a
            player, a host or a deck.
          </p>
          {total === 0 ? (
            <p className={styles.fine}>No player has answered yet.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.audit} aria-labelledby="fit-title">
                <thead>
                  <tr>
                    <th scope="col">Described as</th>
                    <th scope="col">Answers</th>
                    <th scope="col">As described</th>
                    <th scope="col">Stronger</th>
                    <th scope="col">Weaker</th>
                  </tr>
                </thead>
                <tbody>
                  {fit.map((count) => {
                    const all = answers(count);
                    return (
                      <tr key={count.intent}>
                        <th scope="row">
                          {INTENT_NAMES[count.intent] ?? count.intent}
                        </th>
                        <td>{all}</td>
                        <td>
                          {count.as_described} ({share(count.as_described, all)}
                          )
                        </td>
                        <td>
                          {count.stronger} ({share(count.stronger, all)})
                        </td>
                        <td>
                          {count.weaker} ({share(count.weaker, all)})
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <Gates
            rollout={numbers.rollout}
            canStage={canStage}
            onChanged={(rollout) =>
              setNumbers((current) => current && { ...current, rollout })
            }
          />
        </>
      )}
    </section>
  );
}
