import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { client, describe, type AdminUser, type Me } from "../api";
import account from "../Account.module.css";
import shell from "../App.module.css";
import type { components } from "../generated/api";
import { kindLabels, tokens } from "./shop";
import styles from "./shop.module.css";

// Leng's card shop in Administration (v0.4.0): the price list, with each product's market price,
// its price in tokens and why; changing a price or taking a product off sale, each with a reason
// the audit trail keeps; the booster data job's runs, with "run now"; and, for SysOp, packs given
// to any account. Staff see dollar prices here; players never do.

type AdminView = components["schemas"]["ShopAdminView"];
type AdminProduct = components["schemas"]["AdminProduct"];
type BoosterRun = components["schemas"]["BoosterRun"];

type Show = "all" | "selling" | "problems" | "off" | "set" | "unpriced";
const shows: Record<Show, string> = {
  all: "Every product",
  selling: "On sale now",
  problems: "Booster data missing or unresolved",
  off: "Taken off sale",
  set: "Priced by staff",
  unpriced: "Not priced yet",
};

const runNames: Record<string, string> = {
  running: "Running",
  succeeded: "New collations",
  unchanged: "Nothing changed",
  failed: "Failed",
  fenced: "Stopped (another run took over)",
};

const dataNames: Record<AdminProduct["data_status"], string> = {
  waiting: "Waiting for its first read",
  ready: "Ready",
  unresolved: "Cards not in the catalog",
  missing: "No booster data at MTGJSON",
};

const basisNames: Record<AdminProduct["price_basis"], string> = {
  market: "from the market price",
  set: "set by staff",
  fixed: "its own price (basic land packs)",
  unpriced: "not priced yet",
};

function when(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "—";
}

function took(run: BoosterRun) {
  if (!run.finished_at) return "—";
  const seconds = Math.round(
    (new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) /
      1000,
  );
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

function runDetails(run: BoosterRun): string {
  if (run.error_code)
    return `${run.error_code}: ${run.error_message ?? ""}${run.next_attempt_at ? ` · retries ${when(run.next_attempt_at)}` : ""}`;
  const stats = run.stats as Record<string, unknown>;
  const count = (name: string) =>
    typeof stats[name] === "number" ? (stats[name] as number) : 0;
  const downloaded = Array.isArray(stats.downloaded)
    ? stats.downloaded.length
    : 0;
  return [
    `${count("ready")} ready`,
    `${count("unresolved")} unresolved`,
    `${count("missing")} without data`,
    `${count("revisions")} new revisions`,
    `${downloaded} files downloaded, ${count("unchanged")} unchanged`,
    stats.mtgjson_version ? `MTGJSON ${String(stats.mtgjson_version)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function shownBy(product: AdminProduct, show: Show): boolean {
  switch (show) {
    case "selling":
      return product.selling;
    case "problems":
      return (
        product.data_status === "unresolved" ||
        product.data_status === "missing"
      );
    case "off":
      return !product.on_sale;
    case "set":
      return product.price_basis === "set";
    case "unpriced":
      return product.price_basis === "unpriced";
    default:
      return true;
  }
}

function statusOf(product: AdminProduct): { text: string; problem: boolean } {
  if (product.selling) return { text: "On sale", problem: false };
  if (!product.on_sale) return { text: "Off sale", problem: true };
  if (product.data_status !== "ready")
    return { text: dataNames[product.data_status], problem: true };
  return { text: "Not released yet", problem: true };
}

export function ShopAdmin({ me }: { me: Me }) {
  const [view, setView] = useState<AdminView>();
  const [runs, setRuns] = useState<BoosterRun[]>([]);
  const [message, setMessage] = useState("");
  const [q, setQ] = useState("");
  const [show, setShow] = useState<Show>("all");
  const [chosen, setChosen] = useState<string | null>(null);
  const [price, setPrice] = useState("");
  const [reason, setReason] = useState("");
  const [editError, setEditError] = useState("");
  const [busy, setBusy] = useState(false);
  const gives = me.permissions.includes("economy.manage");

  const load = useCallback(async () => {
    const [shop, recent] = await Promise.all([
      client.GET("/api/v1/admin/shop"),
      client.GET("/api/v1/admin/shop/runs"),
    ]);
    if (shop.data) setView(shop.data);
    if (recent.data) setRuns(recent.data);
    const failed = [shop, recent].find((result) => !result.data);
    if (failed) setMessage(describe(failed.error));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (view?.products ?? []).filter((product) => {
      const text =
        `${product.name} ${product.set_name} ${product.set_code} ${product.booster}`.toLowerCase();
      return (
        shownBy(product, show) && words.every((word) => text.includes(word))
      );
    });
  }, [view, q, show]);
  const product = view?.products.find((item) => item.id === chosen) ?? null;

  async function runNow() {
    const { data, error } = await client.POST("/api/v1/admin/shop/sync");
    setMessage(
      data
        ? "The booster data job is queued. The worker starts it within a minute; refresh to follow it."
        : describe(error),
    );
    if (data) void load();
  }

  function edit(item: AdminProduct) {
    setChosen(item.id);
    setPrice(String(item.price_override ?? item.price));
    setReason("");
    setEditError("");
  }

  function replaced(item: AdminProduct) {
    setView((before) =>
      before
        ? {
            ...before,
            products: before.products.map((found) =>
              found.id === item.id ? item : found,
            ),
          }
        : before,
    );
  }

  async function change(kind: "price" | "curve" | "sale") {
    if (!product || busy) return;
    const why = reason.trim();
    if (why.length < 3 || why.length > 200)
      return setEditError("Give a reason of 3 to 200 characters.");
    let value: number | null = null;
    if (kind === "price") {
      value = Number(price);
      if (!Number.isInteger(value) || value < 1 || value > 10_000_000_000)
        return setEditError("A price is a whole number of tokens, at least 1.");
    }
    setBusy(true);
    setEditError("");
    try {
      const path = { params: { path: { product_id: product.id } } };
      const result =
        kind === "sale"
          ? await client.PUT("/api/v1/admin/shop/products/{product_id}/sale", {
              ...path,
              body: { on_sale: !product.on_sale, reason: why },
            })
          : await client.PUT("/api/v1/admin/shop/products/{product_id}/price", {
              ...path,
              body: { tokens: value, reason: why },
            });
      if (!result.data) return setEditError(describe(result.error));
      replaced(result.data);
      setReason("");
      setPrice(String(result.data.price));
      setMessage(
        kind === "sale"
          ? `${result.data.name} is ${result.data.on_sale ? "back on sale" : "off sale"}.`
          : `${result.data.name} now costs ${tokens(result.data.price)} (${basisNames[result.data.price_basis]}).`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className={account.panel} aria-labelledby="booster-data-title">
        <h2 id="booster-data-title">Booster data</h2>
        <p className={account.fine}>
          Pull ratios come from MTGJSON's set files (MIT licence), read weekly
          and when asked. A product is sold only when every card in its booster
          is in the catalog.
          {view &&
            ` Last run: ${view.last_run ? `${when(view.last_run.started_at)} · ${runNames[view.last_run.status] ?? view.last_run.status}` : "never"} · next scheduled run ${when(view.next_run_at)}.`}
          {view && !view.enabled && " The job is turned off (CD_CATALOG_DIR)."}
        </p>
        <div className={account.actions}>
          <button className={shell.primary} onClick={() => void runNow()}>
            Run the booster data job now
          </button>
          <button className={account.secondary} onClick={() => void load()}>
            Refresh
          </button>
        </div>
        <p role="status" className={account.fine}>
          {message}
        </p>
        <div className={account.tableWrap}>
          <table
            className={account.audit}
            aria-label="Recent booster data runs"
          >
            <thead>
              <tr>
                <th scope="col">Started</th>
                <th scope="col">By</th>
                <th scope="col">Result</th>
                <th scope="col">Took</th>
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
                  <td>{runDetails(run)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={account.panel} aria-labelledby="price-list-title">
        <h2 id="price-list-title">The price list</h2>
        <p className={account.fine}>
          Prices in tokens follow each pack's market price
          {view?.prices_as_of ? ` (read on ${view.prices_as_of})` : ""} on a
          curve: a current pack 500, a Revised pack 150,000. A product with no
          market price costs 500 until priced. Every change needs a reason and
          is audited.
        </p>
        <div className={styles.adminFilters}>
          <label className={account.field}>
            <span>Search by name, set or code</span>
            <input
              type="search"
              value={q}
              maxLength={80}
              onChange={(event) => setQ(event.target.value)}
            />
          </label>
          <label className={account.field}>
            <span>Show</span>
            <select
              value={show}
              onChange={(event) => setShow(event.target.value as Show)}
            >
              {(Object.keys(shows) as Show[]).map((key) => (
                <option key={key} value={key}>
                  {shows[key]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {product && (
          <div
            className={styles.editor}
            role="region"
            aria-label={`${product.name}: price and sale`}
          >
            <h3>{product.name}</h3>
            <p className={account.fine}>
              {product.set_name} ({product.set_code}, MTGJSON booster “
              {product.booster}”) · {kindLabels[product.kind]} ·{" "}
              {tokens(product.price)}, {basisNames[product.price_basis]}
              {product.usd !== null &&
                ` · market price $${product.usd.toFixed(2)} (${product.usd_method ?? "—"}), ${tokens(product.curve_price ?? 0)} on the curve`}
              {product.usd_source && (
                <>
                  {" · "}
                  <a href={product.usd_source} target="_blank" rel="noreferrer">
                    source
                  </a>
                </>
              )}
              {product.price_reason && ` · price: “${product.price_reason}”`}
              {product.sale_reason && ` · sale: “${product.sale_reason}”`}
              {` · booster data: ${dataNames[product.data_status]}`}
              {product.collation_revision !== null &&
                `, revision ${product.collation_revision} (MTGJSON ${product.mtgjson_version ?? "—"})`}
            </p>
            {product.unresolved_count > 0 && (
              <div className={styles.unresolved}>
                <p>
                  {product.unresolved_count} cards in its booster are not in the
                  catalog
                  {product.unresolved.length < product.unresolved_count
                    ? `; the first ${product.unresolved.length}`
                    : ""}
                  :
                </p>
                <ul aria-label="Cards not in the catalog">
                  {product.unresolved.map((card, index) => (
                    <li key={index}>
                      {card.name ?? "A card MTGJSON does not name"} (sheet{" "}
                      {card.sheet}, Scryfall {card.scryfall_id ?? "—"})
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <form
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                void change("price");
              }}
            >
              <label className={account.field}>
                <span>Price in tokens</span>
                <input
                  inputMode="numeric"
                  value={price}
                  onChange={(event) => setPrice(event.target.value)}
                />
              </label>
              <label className={account.field}>
                <span>Reason (kept in the audit trail)</span>
                <input
                  value={reason}
                  maxLength={200}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              {editError && (
                <p className={account.error} role="alert">
                  {editError}
                </p>
              )}
              <div className={account.actions}>
                <button type="submit" className={shell.primary} disabled={busy}>
                  Save the price
                </button>
                {product.price_basis === "set" && (
                  <button
                    type="button"
                    className={account.secondary}
                    disabled={busy}
                    onClick={() => void change("curve")}
                  >
                    Return to the market price
                  </button>
                )}
                <button
                  type="button"
                  className={
                    product.on_sale ? account.danger : account.secondary
                  }
                  disabled={busy}
                  onClick={() => void change("sale")}
                >
                  {product.on_sale ? "Take off sale" : "Put back on sale"}
                </button>
                <button
                  type="button"
                  className={account.secondary}
                  onClick={() => setChosen(null)}
                >
                  Close
                </button>
              </div>
            </form>
          </div>
        )}
        <p className={account.fine} aria-live="polite">
          {view
            ? `${rows.length} of ${view.products.length} products.`
            : "Loading…"}
        </p>
        <div className={account.tableWrap}>
          <table className={account.audit} aria-label="Products and prices">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Released</th>
                <th scope="col">Price</th>
                <th scope="col">Market</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className={styles.hidden}>Change</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const status = statusOf(item);
                return (
                  <tr key={item.id}>
                    <td>
                      {item.name} <small>({item.set_code})</small>
                    </td>
                    <td>{item.released ?? "—"}</td>
                    <td>
                      {tokens(item.price)}
                      {item.price_basis !== "market" && (
                        <small> · {basisNames[item.price_basis]}</small>
                      )}
                    </td>
                    <td>
                      {item.usd !== null ? `$${item.usd.toFixed(2)}` : "—"}
                    </td>
                    <td>
                      <span
                        className={styles.status}
                        data-status={status.problem ? "problem" : "selling"}
                      >
                        {status.text}
                        {item.unresolved_count > 0 &&
                          ` (${item.unresolved_count})`}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className={account.secondary}
                        aria-label={`Change ${item.name}`}
                        onClick={() => edit(item)}
                      >
                        Change
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {gives && view && <GivePacks me={me} products={view.products} />}
    </>
  );
}

/** SysOp gives unopened packs to any account, its own included, with a reason (audited). */
function GivePacks({ me, products }: { me: Me; products: AdminProduct[] }) {
  const openable = products.filter((item) => item.collation_revision !== null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<AdminUser[]>([]);
  const [target, setTarget] = useState<{ id: string; label: string } | null>(
    null,
  );
  const [productId, setProductId] = useState("");
  const [count, setCount] = useState("1");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (!term) return setFound([]);
    let active = true;
    void client
      .GET("/api/v1/admin/users", { params: { query: { q: term, limit: 8 } } })
      .then(({ data }) => active && data && setFound(data.items));
    return () => {
      active = false;
    };
  }, [q]);

  async function give(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const amount = Number(count);
    if (!target) return setError("Choose an account first.");
    if (!productId) return setError("Choose a product.");
    if (!Number.isInteger(amount) || amount < 1 || amount > 100)
      return setError("Give 1 to 100 packs at a time.");
    const why = reason.trim();
    if (why.length < 3 || why.length > 200)
      return setError("Give a reason of 3 to 200 characters.");
    setBusy(true);
    setError("");
    setDone("");
    try {
      const { data, error: refused } = await client.POST(
        "/api/v1/admin/users/{user_id}/packs",
        {
          params: { path: { user_id: target.id } },
          body: { product: productId, count: amount, reason: why },
        },
      );
      if (!data) return setError(describe(refused));
      const name = openable.find((item) => item.id === productId)?.name ?? "";
      setDone(
        `${target.label} received ${data.granted} ${name} ${data.granted === 1 ? "pack" : "packs"}.`,
      );
      setReason("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={account.panel} aria-labelledby="give-packs-title">
      <h2 id="give-packs-title">Give packs</h2>
      <p className={account.fine}>
        SysOp gives unopened packs to any account, its own included. Each gift
        needs a reason and is audited.
      </p>
      <form onSubmit={give}>
        <label className={account.field}>
          <span>Find an account by handle or name</span>
          <input
            type="search"
            value={q}
            maxLength={64}
            onChange={(event) => setQ(event.target.value)}
          />
        </label>
        <div className={account.actions} role="group" aria-label="Accounts">
          <button
            type="button"
            className={account.secondary}
            aria-pressed={target?.id === me.id}
            onClick={() => setTarget({ id: me.id, label: "Your account" })}
          >
            My own account
          </button>
          {found.map((user) => (
            <button
              key={user.id}
              type="button"
              className={account.secondary}
              aria-pressed={target?.id === user.id}
              onClick={() =>
                setTarget({
                  id: user.id,
                  label: user.handle ?? user.display_name,
                })
              }
            >
              {user.handle ?? user.display_name}
            </button>
          ))}
        </div>
        <p className={account.fine}>
          {target ? `Giving to: ${target.label}` : "No account chosen."}
        </p>
        <label className={account.field}>
          <span>Product</span>
          <select
            value={productId}
            onChange={(event) => setProductId(event.target.value)}
          >
            <option value="">Choose a product</option>
            {openable.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} ({item.set_code})
              </option>
            ))}
          </select>
        </label>
        <label className={account.field}>
          <span>Packs (1 to 100)</span>
          <input
            inputMode="numeric"
            value={count}
            onChange={(event) => setCount(event.target.value)}
          />
        </label>
        <label className={account.field}>
          <span>Reason (kept in the audit trail)</span>
          <input
            value={reason}
            maxLength={200}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {error && (
          <p className={account.error} role="alert">
            {error}
          </p>
        )}
        <p className={account.fine} role="status">
          {done}
        </p>
        <button type="submit" className={shell.primary} disabled={busy}>
          Give packs
        </button>
      </form>
    </section>
  );
}
