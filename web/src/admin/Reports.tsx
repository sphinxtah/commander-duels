import { useCallback, useEffect, useRef, useState } from "react";
import {
  client,
  describe,
  type ReportDetail,
  type ReportStatus,
  type ReportSummary,
} from "../api";
import styles from "../Account.module.css";
import shell from "../App.module.css";
import admin from "./admin.module.css";
import { ChatLines } from "./ChatLines";

// Administration's Reports tab (v0.4.1): the players' problem reports, newest first, for SysOp
// and administrators (reports.manage). Opening a new report marks it seen; a status says what
// became of it. The screenshot is the API's own image, sent with the session's cookie. Since
// v0.4.4 a report may be of a chat message: it carries a copy of the message and of the ones
// before it that the reporter saw.

type ReportedChat = NonNullable<ReportDetail["chat"]>;

type Filter = "open" | ReportStatus | "all";
const filters: Record<Filter, ReportStatus[] | undefined> = {
  open: ["new", "seen"],
  new: ["new"],
  seen: ["seen"],
  fixed: ["fixed"],
  closed: ["closed"],
  all: undefined,
};
const filterNames: Record<Filter, string> = {
  open: "New and seen",
  new: "New",
  seen: "Seen",
  fixed: "Fixed",
  closed: "Closed",
  all: "All reports",
};
export const statusNames: Record<ReportStatus, string> = {
  new: "New",
  seen: "Seen",
  fixed: "Fixed",
  closed: "Closed",
};
const statuses: ReportStatus[] = ["new", "seen", "fixed", "closed"];

function when(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
}

function time(value: string) {
  return new Date(value).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** When, where and in what version: one line under the report's summary. */
function facts(report: ReportSummary) {
  const game = report.game_id
    ? `game ${report.game_id.slice(0, 8)}${
        report.game_turn !== null ? `, turn ${report.game_turn}` : ""
      }`
    : null;
  return [
    when(report.created_at),
    report.page,
    `v${report.app_version}`,
    game,
    report.screenshot ? "screenshot" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function reporterName(report: ReportSummary) {
  const { handle, display_name } = report.reporter;
  return handle ? `${handle} (${display_name})` : display_name;
}

/** The reported message, marked, after the ones the reporter saw before it, and who sent it. */
function ReportedMessage({ chat }: { chat: ReportedChat }) {
  const sender = chat.reported_user;
  return (
    <>
      <h3 className={admin.reportHeading}>Reported message</h3>
      <dl className={admin.reportFacts}>
        <div>
          <dt>Sent by</dt>
          <dd>
            {sender.handle ?? "Unknown account"}
            {sender.id && <small>{sender.id}</small>}
          </dd>
        </div>
        <div>
          <dt>Where</dt>
          <dd>
            {chat.kind === "direct" ? "A friend's message" : "A table's chat"}
          </dd>
        </div>
        {chat.game_id && (
          <div>
            <dt>Game</dt>
            <dd>
              <code>{chat.game_id}</code>
            </dd>
          </div>
        )}
      </dl>
      <ChatLines
        lines={chat.lines}
        label="The reported message and the messages before it"
      />
    </>
  );
}

function Detail({
  detail,
  onStatus,
}: {
  detail: ReportDetail;
  onStatus: (status: ReportStatus) => void;
}) {
  return (
    <div className={admin.report} id={`report-${detail.id}`}>
      <p className={admin.reportText}>{detail.description}</p>
      <dl className={admin.reportFacts}>
        <div>
          <dt>Reporter</dt>
          <dd>
            {reporterName(detail)}
            {detail.reporter.id && <small>{detail.reporter.id}</small>}
          </dd>
        </div>
        <div>
          <dt>Page</dt>
          <dd>
            <code>{detail.page}</code>
          </dd>
        </div>
        {detail.game_id && (
          <div>
            <dt>Game</dt>
            <dd>
              <code>{detail.game_id}</code>
              {detail.game_turn !== null && ` · turn ${detail.game_turn}`}
            </dd>
          </div>
        )}
        <div>
          <dt>Versions</dt>
          <dd>
            Web app {detail.app_version} · API {detail.api_version}
          </dd>
        </div>
        <div>
          <dt>Browser</dt>
          <dd>{detail.user_agent ?? "Not sent"}</dd>
        </div>
        <div>
          <dt>Window</dt>
          <dd>
            {detail.viewport_width} × {detail.viewport_height} at{" "}
            {detail.pixel_ratio}×
          </dd>
        </div>
        {detail.status_changed_at && (
          <div>
            <dt>Status set</dt>
            <dd>
              {when(detail.status_changed_at)}
              {detail.status_changed_by &&
                ` by ${detail.status_changed_by.label}`}
            </dd>
          </div>
        )}
      </dl>
      {detail.chat && <ReportedMessage chat={detail.chat} />}
      <h3 className={admin.reportHeading}>Latest requests</h3>
      {detail.requests.length === 0 ? (
        <p className={styles.fine}>None recorded.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.audit}>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Request</th>
                <th scope="col">Status</th>
                <th scope="col">Request ID</th>
              </tr>
            </thead>
            <tbody>
              {detail.requests.map((request, index) => (
                <tr key={index}>
                  <td>{time(request.at)}</td>
                  <td>
                    <code>
                      {request.method} {request.path}
                    </code>
                  </td>
                  <td>{request.status || "No answer"}</td>
                  <td>
                    <code>{request.request_id ?? "—"}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {detail.screenshot && (
        <>
          <h3 className={admin.reportHeading}>Screenshot</h3>
          <a
            href={`/api/v1/admin/reports/${detail.id}/screenshot`}
            target="_blank"
            rel="noreferrer"
          >
            <img
              className={admin.reportImage}
              src={`/api/v1/admin/reports/${detail.id}/screenshot`}
              alt={`Screenshot sent with “${detail.summary}”`}
              width={detail.screenshot_width ?? undefined}
              height={detail.screenshot_height ?? undefined}
              loading="lazy"
            />
          </a>
        </>
      )}
      <label className={styles.field}>
        <span>Status</span>
        <select
          value={detail.status}
          onChange={(event) => onStatus(event.target.value as ReportStatus)}
        >
          {statuses.map((status) => (
            <option key={status} value={status}>
              {status === "new" ? "New (unread)" : statusNames[status]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function Reports({ onCounts }: { onCounts?: () => void }) {
  const [filter, setFilter] = useState<Filter>("open");
  const [reports, setReports] = useState<ReportSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const [opened, setOpened] = useState<string>();
  const [details, setDetails] = useState<Record<string, ReportDetail>>({});
  const latest = useRef(0);

  const load = useCallback(
    async (after?: string) => {
      // Only the newest request may change the list, as for accounts.
      const ticket = ++latest.current;
      if (!after) setCursor(null);
      const { data, error } = await client
        .GET("/api/v1/admin/reports", {
          params: { query: { status: filters[filter], cursor: after } },
        })
        .catch(() => ({ data: undefined, error: undefined }));
      if (ticket !== latest.current) return;
      setLoaded(true);
      if (!data) return setMessage(describe(error));
      setMessage("");
      setReports((current) =>
        after ? [...current, ...data.items] : data.items,
      );
      setCursor(data.next_cursor);
    },
    [filter],
  );
  useEffect(() => {
    void load();
  }, [load]);

  function changed(detail: ReportDetail) {
    setDetails((current) => ({ ...current, [detail.id]: detail }));
    setReports((current) =>
      current.map((report) =>
        report.id === detail.id ? { ...report, status: detail.status } : report,
      ),
    );
  }
  async function setStatus(id: string, status: ReportStatus) {
    const { data, error } = await client.POST(
      "/api/v1/admin/reports/{report_id}/status",
      { params: { path: { report_id: id } }, body: { status } },
    );
    if (!data) return setMessage(describe(error));
    changed(data);
    setMessage(`“${data.summary}”: ${statusNames[data.status]}.`);
    onCounts?.();
  }
  async function toggle(report: ReportSummary) {
    if (opened === report.id) return setOpened(undefined);
    setOpened(report.id);
    const { data, error } = await client.GET(
      "/api/v1/admin/reports/{report_id}",
      { params: { path: { report_id: report.id } } },
    );
    if (!data) return setMessage(describe(error));
    changed(data);
    // Opening a report reads it.
    if (data.status === "new") {
      const seen = await client.POST(
        "/api/v1/admin/reports/{report_id}/status",
        {
          params: { path: { report_id: report.id } },
          body: { status: "seen" },
        },
      );
      if (seen.data) {
        changed(seen.data);
        onCounts?.();
      }
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="reports-title">
      <h2 id="reports-title">Problem reports</h2>
      <div className={styles.filters}>
        <label className={styles.field}>
          <span>Show</span>
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as Filter)}
          >
            {(Object.keys(filterNames) as Filter[]).map((value) => (
              <option key={value} value={value}>
                {filterNames[value]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => void load()}
        >
          Refresh
        </button>
      </div>
      <p role="status" className={styles.fine}>
        {message}
      </p>
      {loaded && reports.length === 0 ? (
        <p className={styles.fine}>No reports match.</p>
      ) : (
        <ul className={styles.users}>
          {reports.map((report) => {
            const open = opened === report.id;
            const detail = details[report.id];
            return (
              <li key={report.id} aria-label={report.summary}>
                <div className={styles.userHead}>
                  <div>
                    <strong>{report.summary}</strong>
                    <span>{reporterName(report)}</span>
                    {report.reported_user && (
                      <p className={admin.reportedFrom}>
                        Message from{" "}
                        {report.reported_user.handle ?? "an unknown account"}
                      </p>
                    )}
                    <small>{facts(report)}</small>
                  </div>
                  <span className={shell.tag} data-report={report.status}>
                    {statusNames[report.status].toUpperCase()}
                  </span>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.secondary}
                    aria-expanded={open}
                    aria-controls={open ? `report-${report.id}` : undefined}
                    onClick={() => void toggle(report)}
                  >
                    {open ? "Close" : "Open"} “{report.summary}”
                  </button>
                </div>
                {open && detail && (
                  <Detail
                    detail={detail}
                    onStatus={(status) => void setStatus(report.id, status)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {cursor && (
        <button className={styles.secondary} onClick={() => void load(cursor)}>
          Show older reports
        </button>
      )}
    </section>
  );
}
