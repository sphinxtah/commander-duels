import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import {
  client,
  describe,
  sysopSignIn,
  type AdminCounts,
  type AdminUser,
  type AuditEntry,
  type Me,
  type Planeswalker,
} from "./api";
import { Chats } from "./admin/Chats";
import { pendingWords, unreadWords } from "./admin/counts";
import { CustomCards } from "./admin/CustomCards";
import { DeleteAccount } from "./admin/DeleteAccount";
import { Reports } from "./admin/Reports";
import { ResetAccount, resetWords } from "./admin/ResetAccount";
import { SetWins } from "./admin/SetWins";
import { tierNames } from "./alliance/alliance";
import { Portrait } from "./alliance/Portrait";
import { TierBadge } from "./alliance/TierBadge";
import { CatalogAdmin } from "./catalog/CatalogAdmin";
import { ShopAdmin } from "./shop/ShopAdmin";
import { AuctionsAdmin } from "./auctions/AuctionsAdmin";
import { EconomySettings } from "./tokens/EconomySettings";
import { GiveTokens } from "./tokens/GiveTokens";
import styles from "./Account.module.css";
import shell from "./App.module.css";
import admin from "./admin/admin.module.css";

type Status = AdminUser["status"];
type GrantableRole = "moderator" | "content_editor" | "administrator";
// "All accounts" leaves the deleted ones out (v0.4.1): they are listed only when asked for.
const statuses: (Status | "")[] = [
  "",
  "pending",
  "active",
  "disabled",
  "denied",
  "deleted",
];
const statusNames: Record<Status | "", string> = {
  "": "All accounts",
  pending: "Waiting for approval",
  active: "Active",
  disabled: "Disabled",
  denied: "Denied",
  deleted: "Deleted",
};
const grantable: { role: GrantableRole; name: string }[] = [
  { role: "moderator", name: "Moderator" },
  { role: "content_editor", name: "Content editor" },
  { role: "administrator", name: "Administrator" },
];

function when(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
}

function Users({
  me,
  pending,
  onCounts,
}: {
  me: Me;
  /** How many accounts wait for approval (v0.4.1), when this account may approve them. */
  pending?: number | null;
  onCounts?: () => void;
}) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | "">("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [refresh, setRefresh] = useState(0);
  // The roster names each account's alliance (v0.3.1); without it, its ID stands in.
  const [roster, setRoster] = useState<Planeswalker[]>([]);
  // The account whose wins SysOp is setting, if any.
  const [settingWins, setSettingWins] = useState<string>();
  const [givingTokens, setGivingTokens] = useState<string>();
  // The account whose deletion the dialog asks to confirm (v0.4.1), if any.
  const [deleting, setDeleting] = useState<AdminUser>();
  // The account SysOp is resetting to a new one's state (v0.4.5), if any.
  const [resetting, setResetting] = useState<AdminUser>();
  const latest = useRef(0);
  // The message a failed load left, so a load that works can take it back.
  const loadFailure = useRef("");
  const manage = me.permissions.includes("admin.users.manage");
  const roles = me.permissions.includes("admin.roles.manage");
  const administrators = me.permissions.includes("admin.roles.administrator");
  const progress = me.permissions.includes("progress.manage");
  // SysOp gives and takes back tokens (v0.4.0).
  const economy = me.permissions.includes("economy.manage");
  // SysOp resets an account to a new one's state, for the setup wizard (v0.4.5).
  const resets = me.permissions.includes("admin.users.reset");
  // SysOp's changes, which any account's row offers, an administrator's too.
  const sysopChanges = progress || economy || resets;
  useEffect(() => {
    let active = true;
    void client
      .GET("/api/v1/planeswalkers")
      .then(({ data }) => {
        if (active && data) setRoster(data);
      })
      .catch(() => {
        // The list still shows each alliance by its ID.
      });
    return () => {
      active = false;
    };
  }, []);

  const load = useCallback(
    async (after?: string) => {
      // Only the newest request may change the list: an older answer (a previous filter, or
      // the first of two clicks on "Show more") would mix or repeat pages.
      const ticket = ++latest.current;
      if (!after) setCursor(null);
      const { data, error } = await client
        .GET("/api/v1/admin/users", {
          params: {
            query: {
              status: status || undefined,
              q: search || undefined,
              cursor: after,
            },
          },
        })
        .catch(() => ({ data: undefined, error: undefined }));
      if (ticket !== latest.current) return;
      if (!data) {
        loadFailure.current = describe(error);
        return setMessage(loadFailure.current);
      }
      // Take back an earlier failure to load, but keep an action's own message.
      const failed = loadFailure.current;
      loadFailure.current = "";
      if (failed) setMessage((current) => (current === failed ? "" : current));
      setUsers((current) => (after ? [...current, ...data.items] : data.items));
      setCursor(data.next_cursor);
    },
    [status, search],
  );
  useEffect(() => {
    void load();
  }, [load, refresh]);

  function replace(updated: AdminUser) {
    setUsers((current) =>
      current.map((user) => (user.id === updated.id ? updated : user)),
    );
  }
  async function changeStatus(
    user: AdminUser,
    next: "active" | "denied" | "disabled",
  ) {
    const { data, error } = await client.POST(
      "/api/v1/admin/users/{user_id}/status",
      {
        params: { path: { user_id: user.id } },
        body: { status: next },
      },
    );
    if (data) {
      replace(data);
      setMessage(
        `${user.handle ?? user.display_name}: ${statusNames[data.status]}.`,
      );
      // An approval or a denial changes how many wait (v0.4.1).
      onCounts?.();
    } else setMessage(describe(error));
  }
  async function toggleRole(user: AdminUser, role: GrantableRole, on: boolean) {
    const params = { path: { user_id: user.id, role } };
    const { data, error } = on
      ? await client.PUT("/api/v1/admin/users/{user_id}/roles/{role}", {
          params,
        })
      : await client.DELETE("/api/v1/admin/users/{user_id}/roles/{role}", {
          params,
        });
    if (data) replace(data);
    else setMessage(describe(error));
  }
  async function signOut(user: AdminUser) {
    const { data, error } = await client.POST(
      "/api/v1/admin/users/{user_id}/sign-out",
      {
        params: { path: { user_id: user.id } },
      },
    );
    if (data)
      setMessage(
        `${user.handle ?? user.display_name} was signed out everywhere.`,
      );
    else setMessage(describe(error));
  }
  function find(event: FormEvent) {
    event.preventDefault();
    setSearch(query.trim());
    // Searching again with the same words reloads the list (new sign-ups, changed states).
    setRefresh((value) => value + 1);
  }

  return (
    <section className={styles.panel} aria-labelledby="users-title">
      <h2 id="users-title">Accounts</h2>
      {/* The way to the requests that wait (v0.4.1), unless they are shown already. */}
      {pending ? (
        <p className={admin.shortcut}>
          <span>{pendingWords(pending)}.</span>
          {status !== "pending" && (
            <button
              type="button"
              className={styles.secondary}
              onClick={() => {
                setStatus("pending");
                setQuery("");
                setSearch("");
              }}
            >
              Show the waiting {pending === 1 ? "account" : "accounts"}
            </button>
          )}
        </p>
      ) : null}
      <form className={styles.filters} onSubmit={find} role="search">
        <label className={styles.field}>
          <span>Show</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as Status | "")}
          >
            {statuses.map((value) => (
              <option key={value} value={value}>
                {statusNames[value]}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          {/* Only administrators see addresses or find accounts by them. */}
          <span>
            {manage ? "Search handle, name or email" : "Search handle or name"}
          </span>
          <input
            type="search"
            value={query}
            maxLength={64}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button className={styles.secondary} type="submit">
          Search
        </button>
      </form>
      <p role="status" className={styles.fine}>
        {message}
      </p>
      {users.length === 0 ? (
        <p className={styles.fine}>No accounts match.</p>
      ) : (
        <ul className={styles.users}>
          {users.map((user) => {
            const name = user.handle ?? user.display_name;
            const isAdministrator = user.roles.includes("administrator");
            const locked = isAdministrator && !administrators;
            // A deleted account (v0.4.1) is "Deleted player", and nothing changes it.
            const deleted = user.status === "deleted";
            const allied = user.alliance
              ? roster.find((found) => found.id === user.alliance)
              : undefined;
            return (
              <li key={user.id} aria-label={name}>
                <div className={styles.userHead}>
                  <div>
                    <strong>
                      {deleted
                        ? user.display_name
                        : (user.handle ?? "No handle yet")}
                    </strong>
                    {!deleted && <span>{user.display_name}</span>}
                    {deleted ? (
                      <small>
                        Joined {when(user.created_at)} · deleted{" "}
                        {when(user.deleted_at)}
                      </small>
                    ) : (
                      <small>
                        {manage
                          ? `${user.email ?? "No email"} · joined`
                          : "Joined"}{" "}
                        {when(user.created_at)} · last seen{" "}
                        {when(user.last_seen_at)}
                      </small>
                    )}
                  </div>
                  <span className={shell.tag} data-status={user.status}>
                    {statusNames[user.status].toUpperCase()}
                  </span>
                </div>
                {/* Wins, tier and alliance (v0.3.1): the crest and the portrait sit beside the
                    words that name them. */}
                <dl className={admin.standing}>
                  <div>
                    <dt>Wins</dt>
                    <dd>{user.wins.toLocaleString("en-US")}</dd>
                  </div>
                  <div>
                    <dt>Tier</dt>
                    <dd>
                      <TierBadge tier={user.tier} size={24} decorative />
                      {tierNames[user.tier]}
                    </dd>
                  </div>
                  <div>
                    <dt>Tokens</dt>
                    <dd>{user.tokens.toLocaleString("en-US")}</dd>
                  </div>
                  <div>
                    <dt>Alliance</dt>
                    <dd>
                      {user.alliance ? (
                        <>
                          <Portrait
                            id={user.alliance}
                            portrait={allied?.portrait}
                            size={32}
                            thumbnail
                            decorative
                          />
                          {allied?.name ?? user.alliance}
                        </>
                      ) : (
                        "None"
                      )}
                    </dd>
                  </div>
                </dl>
                {roles && user.status === "active" && (
                  <fieldset className={styles.roleSet} disabled={locked}>
                    <legend>Roles</legend>
                    {grantable.map(({ role, name: roleName }) => (
                      <label key={role}>
                        <input
                          type="checkbox"
                          checked={user.roles.includes(role)}
                          disabled={role === "administrator" && !administrators}
                          onChange={(event) =>
                            void toggleRole(user, role, event.target.checked)
                          }
                        />
                        {roleName}
                      </label>
                    ))}
                  </fieldset>
                )}
                {!deleted && ((manage && !locked) || sysopChanges) && (
                  <div className={styles.actions}>
                    {/* SysOp sets any account's wins, and so its tier (v0.3.1). */}
                    {progress && settingWins !== user.id && (
                      <button
                        className={styles.secondary}
                        onClick={() => setSettingWins(user.id)}
                      >
                        Set wins for {name}
                      </button>
                    )}
                    {economy && givingTokens !== user.id && (
                      <button
                        className={styles.secondary}
                        onClick={() => setGivingTokens(user.id)}
                      >
                        Give tokens to {name}
                      </button>
                    )}
                    {manage && !locked && user.status === "pending" && (
                      <>
                        <button
                          className={shell.primary}
                          onClick={() => void changeStatus(user, "active")}
                        >
                          Approve {name}
                        </button>
                        <button
                          className={styles.secondary}
                          onClick={() => void changeStatus(user, "denied")}
                        >
                          Deny {name}
                        </button>
                      </>
                    )}
                    {manage && !locked && user.status === "active" && (
                      <>
                        <button
                          className={styles.secondary}
                          onClick={() => void signOut(user)}
                        >
                          Sign {name} out everywhere
                        </button>
                        <button
                          className={styles.danger}
                          onClick={() => void changeStatus(user, "disabled")}
                        >
                          Disable {name}
                        </button>
                      </>
                    )}
                    {manage &&
                      !locked &&
                      (user.status === "disabled" ||
                        user.status === "denied") && (
                        <button
                          className={styles.secondary}
                          onClick={() => void changeStatus(user, "active")}
                        >
                          Restore {name}
                        </button>
                      )}
                    {/* A fresh start, so the setup wizard runs again (v0.4.5). */}
                    {resets && user.id !== me.id && (
                      <button
                        className={styles.danger}
                        onClick={() => setResetting(user)}
                      >
                        Reset {name}'s account…
                      </button>
                    )}
                    {/* For good, when its owner asks (v0.4.1); never your own account. */}
                    {manage && !locked && user.id !== me.id && (
                      <button
                        className={styles.danger}
                        onClick={() => setDeleting(user)}
                      >
                        Delete {name}'s account…
                      </button>
                    )}
                  </div>
                )}
                {progress && settingWins === user.id && (
                  <SetWins
                    userId={user.id}
                    subject={name}
                    wins={user.wins}
                    onSet={(changed) => {
                      replace({
                        ...user,
                        wins: changed.wins,
                        tier: changed.tier.id,
                      });
                      setSettingWins(undefined);
                      setMessage(
                        `${name}: ${changed.wins.toLocaleString("en-US")} wins, ${changed.tier.name} tier.`,
                      );
                    }}
                    onCancel={() => setSettingWins(undefined)}
                  />
                )}
                {economy && givingTokens === user.id && (
                  <GiveTokens
                    userId={user.id}
                    subject={name}
                    onGiven={(changed) => {
                      replace({ ...user, tokens: changed.balance });
                      setGivingTokens(undefined);
                      setMessage(
                        `${name}: ${changed.balance.toLocaleString("en-US")} tokens.`,
                      );
                    }}
                    onCancel={() => setGivingTokens(undefined)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {cursor && (
        <button className={styles.secondary} onClick={() => void load(cursor)}>
          Show more accounts
        </button>
      )}
      {deleting && (
        <DeleteAccount
          user={deleting}
          onDeleted={(gone) => {
            replace(gone);
            setMessage(
              `${deleting.handle ?? deleting.display_name}'s account was deleted.`,
            );
          }}
          onClose={() => setDeleting(undefined)}
        />
      )}
      {resetting && (
        <ResetAccount
          user={resetting}
          onReset={(reset) => {
            replace(reset.account);
            setMessage(
              resetWords(resetting.handle ?? resetting.display_name, reset),
            );
          }}
          onClose={() => setResetting(undefined)}
        />
      )}
    </section>
  );
}

function Audit() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [action, setAction] = useState("");
  const [filter, setFilter] = useState("");
  const [message, setMessage] = useState("");
  const [refresh, setRefresh] = useState(0);
  const latest = useRef(0);
  const load = useCallback(
    async (after?: string) => {
      // As for accounts: only the newest request may change the log.
      const ticket = ++latest.current;
      if (!after) setCursor(null);
      const { data, error } = await client
        .GET("/api/v1/admin/audit", {
          params: { query: { action: filter || undefined, cursor: after } },
        })
        .catch(() => ({ data: undefined, error: undefined }));
      if (ticket !== latest.current) return;
      if (!data) return setMessage(describe(error));
      // The message only ever reports a failed load, which this one answers.
      setMessage("");
      setEntries((current) =>
        after ? [...current, ...data.items] : data.items,
      );
      setCursor(data.next_cursor);
    },
    [filter],
  );
  useEffect(() => {
    void load();
  }, [load, refresh]);
  return (
    <section className={styles.panel} aria-labelledby="audit-title">
      <h2 id="audit-title">Audit log</h2>
      <form
        className={styles.filters}
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setFilter(action.trim());
          // Filtering again by the same prefix reloads the newest events.
          setRefresh((value) => value + 1);
        }}
      >
        <label className={styles.field}>
          <span>Action starts with</span>
          <input
            value={action}
            maxLength={64}
            placeholder="auth., admin., profile."
            onChange={(event) => setAction(event.target.value)}
          />
        </label>
        <button className={styles.secondary} type="submit">
          Filter
        </button>
      </form>
      {message && (
        <p role="alert" className={styles.error}>
          {message}
        </p>
      )}
      <div className={styles.tableWrap}>
        <table className={styles.audit}>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Action</th>
              <th scope="col">By</th>
              <th scope="col">Account</th>
              <th scope="col">Address</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td>{when(entry.occurred_at)}</td>
                <td>
                  <code>{entry.action}</code>
                </td>
                <td>{entry.actor?.label ?? "—"}</td>
                <td>{entry.target?.label ?? "—"}</td>
                <td>{entry.source_address ?? "—"}</td>
                <td>
                  {Object.entries(entry.details)
                    .filter(([, value]) => value !== null)
                    .map(
                      ([key, value]) =>
                        `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`,
                    )
                    .join(" · ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor && (
        <button className={styles.secondary} onClick={() => void load(cursor)}>
          Show older events
        </button>
      )}
    </section>
  );
}

/** Tivit's Auction House's log (v0.6.0): SysOp's, and an administrator's given auctions.manage.
 * The permission is new in v0.6.0's contract, so it is looked for as a string until the generated
 * types name it. */
function readsAuctions(me: Me): boolean {
  return me.kind === "sysop" || me.permissions.includes("auctions.manage");
}

export function canAdminister(me: Me | null | undefined) {
  return Boolean(
    me &&
    me.status === "active" &&
    (me.permissions.includes("admin.users.read") ||
      me.permissions.includes("admin.audit.read") ||
      me.permissions.includes("catalog.manage") ||
      me.permissions.includes("custom_cards.manage") ||
      me.permissions.includes("shop.manage") ||
      me.permissions.includes("reports.manage") ||
      me.permissions.includes("chat.read_all") ||
      readsAuctions(me)),
  );
}

type Tab =
  | "users"
  | "reports"
  | "chats"
  | "economy"
  | "audit"
  | "catalog"
  | "shop"
  | "auctions"
  | "custom";

/** A tab's count, with words for screen readers ("Accounts, 2 accounts waiting…"). */
function TabCount({ count, words }: { count: number; words: string }) {
  if (!count) return null;
  return (
    <>
      <span className={admin.count} aria-hidden="true">
        {count}
      </span>
      <span className={styles.visuallyHidden}>, {words}</span>
    </>
  );
}

export function Admin({
  me,
  heading,
  counts,
  onCounts,
}: {
  me: Me | null | undefined;
  heading: RefObject<HTMLHeadingElement | null>;
  /** What waits (v0.4.1): accounts to approve and unread reports; null when not known. */
  counts?: AdminCounts | null;
  /** Asks for the counts again, after something here changed them. */
  onCounts?: () => void;
}) {
  const [tab, setTab] = useState<Tab>("users");
  if (!canAdminister(me))
    return (
      <>
        <span className={shell.eyebrow}>ADMINISTRATION</span>
        <h1 ref={heading} tabIndex={-1}>
          Administration
        </h1>
        <section className={shell.empty}>
          <span aria-hidden="true">⚖</span>
          <h2>
            {me ? "This area is for administrators." : "Sign in to continue."}
          </h2>
          <p>
            {me
              ? "Your account does not have administrative permissions."
              : "Administrators sign in with their Google account."}
          </p>
          {!me && (
            <a className={shell.primary} href="#profile">
              Sign in <span aria-hidden="true">→</span>
            </a>
          )}
        </section>
      </>
    );
  const users = me!.permissions.includes("admin.users.read");
  const audit = me!.permissions.includes("admin.audit.read");
  const catalog = me!.permissions.includes("catalog.manage");
  // The Godlike tier's custom cards, SysOp's alone (v0.3.1).
  const custom = me!.permissions.includes("custom_cards.manage");
  // Leng's card shop: prices, sale and the booster data (v0.4.0).
  const shop = me!.permissions.includes("shop.manage");
  // The players' problem reports, for SysOp and administrators (v0.4.1).
  const reports = me!.permissions.includes("reports.manage");
  // SysOp's reader of every chat, each opening audited (v0.4.4).
  const chats = me!.permissions.includes("chat.read_all");
  // Tivit's Auction House's log and SysOp's cancelling (v0.6.0).
  const auctions = readsAuctions(me!);
  const pending = counts?.pending_accounts ?? 0;
  const unread = counts?.unread_reports ?? 0;
  const available = [
    users && "users",
    reports && "reports",
    chats && "chats",
    users && "economy",
    audit && "audit",
    catalog && "catalog",
    shop && "shop",
    auctions && "auctions",
    custom && "custom",
  ].filter(Boolean) as Tab[];
  const shown = available.includes(tab) ? tab : available[0];
  return (
    <>
      <span className={shell.eyebrow}>ADMINISTRATION</span>
      <h1 ref={heading} tabIndex={-1}>
        Keep the table running.
      </h1>
      <p className={shell.lead}>
        Approve new players, read their problem reports, assign roles, review
        what changed and by whom, and keep the card catalog current.
      </p>
      <div
        className={styles.tabs}
        role="tablist"
        aria-label="Administration sections"
      >
        {users && (
          <button
            role="tab"
            aria-selected={shown === "users"}
            onClick={() => setTab("users")}
          >
            Accounts
            <TabCount count={pending} words={pendingWords(pending)} />
          </button>
        )}
        {reports && (
          <button
            role="tab"
            aria-selected={shown === "reports"}
            onClick={() => setTab("reports")}
          >
            Reports
            <TabCount count={unread} words={unreadWords(unread)} />
          </button>
        )}
        {chats && (
          <button
            role="tab"
            aria-selected={shown === "chats"}
            onClick={() => setTab("chats")}
          >
            Chats
          </button>
        )}
        {users && (
          <button
            role="tab"
            aria-selected={shown === "economy"}
            onClick={() => setTab("economy")}
          >
            Tokens
          </button>
        )}
        {audit && (
          <button
            role="tab"
            aria-selected={shown === "audit"}
            onClick={() => setTab("audit")}
          >
            Audit log
          </button>
        )}
        {catalog && (
          <button
            role="tab"
            aria-selected={shown === "catalog"}
            onClick={() => setTab("catalog")}
          >
            Card catalog
          </button>
        )}
        {shop && (
          <button
            role="tab"
            aria-selected={shown === "shop"}
            onClick={() => setTab("shop")}
          >
            Card shop
          </button>
        )}
        {auctions && (
          <button
            role="tab"
            aria-selected={shown === "auctions"}
            onClick={() => setTab("auctions")}
          >
            Auctions
          </button>
        )}
        {custom && (
          <button
            role="tab"
            aria-selected={shown === "custom"}
            onClick={() => setTab("custom")}
          >
            Custom cards
          </button>
        )}
      </div>
      <div role="tabpanel">
        {shown === "users" ? (
          <Users
            me={me!}
            pending={counts?.pending_accounts}
            onCounts={onCounts}
          />
        ) : shown === "reports" ? (
          <Reports onCounts={onCounts} />
        ) : shown === "chats" ? (
          <Chats />
        ) : shown === "economy" ? (
          <EconomySettings
            canChange={me!.permissions.includes("economy.manage")}
          />
        ) : shown === "audit" ? (
          <Audit />
        ) : shown === "catalog" ? (
          <CatalogAdmin />
        ) : shown === "shop" ? (
          <ShopAdmin me={me!} />
        ) : shown === "auctions" ? (
          <AuctionsAdmin me={me!} />
        ) : (
          <CustomCards />
        )}
      </div>
    </>
  );
}

/** SysOp's entrance. The caller renders it only after the server confirms the network. */
export function SysopSignIn({
  onSignedIn,
  heading,
}: {
  onSignedIn: (me: Me) => void;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const [username, setUsername] = useState("sysop");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      // A network failure comes back as an error too, so the form always says why.
      const { me, error } = await sysopSignIn(username, password);
      setPassword("");
      if (me) {
        onSignedIn(me);
        window.location.hash = "#admin";
      } else setMessage(error ?? "");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <span className={shell.eyebrow}>LOCAL ADMINISTRATOR</span>
      <h1 ref={heading} tabIndex={-1}>
        SysOp sign-in
      </h1>
      <section className={styles.panel}>
        <form
          className={styles.form}
          onSubmit={submit}
          aria-label="SysOp sign-in"
        >
          <label className={styles.field}>
            <span>Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label className={styles.field}>
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {message && (
            <p role="alert" className={styles.error}>
              {message}
            </p>
          )}
          <button className={shell.primary} type="submit" disabled={busy}>
            Sign in
          </button>
        </form>
      </section>
    </>
  );
}
