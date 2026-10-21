import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { client, describe, type Me } from "../api";
import shell from "../App.module.css";
import { Leng } from "./Leng";
import { PackOpening } from "./PackOpening";
import {
  byEra,
  filtered,
  kindLabels,
  kindsOf,
  noFilters,
  purchaseKey,
  rarityLabels,
  sortLabels,
  tokens,
  yearsOf,
  type Filters,
  type Opening,
  type OpeningSummary,
  type Product,
  type ShopView,
  type Sort,
} from "./shop";
import styles from "./shop.module.css";

// Leng's card shop (v0.4.0): booster packs from Revised to the current set, bought with the tokens
// wins earn, and opened at Leng's counter. The server prices, sells and draws every pack; the page
// shows what it says and keeps one client key per purchase, so a retried request buys once.

function day(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString(
    "en-US",
    { year: "numeric", month: "short", day: "numeric" },
  );
}

function speech(view: ShopView | undefined): string {
  if (!view) return "Come in, come in. Let me light the lamp…";
  if (!view.products.length)
    return "My shelves are still being stocked. Come back once the booster data has been read.";
  const cheapest = Math.min(...view.products.map((product) => product.price));
  if (view.balance < cheapest)
    return "Short of tokens? Win a few games, then come back and see what the packs hold.";
  return "Welcome, traveller. Every pack on these shelves holds what the real ones held, rare for rare.";
}

export function ShopPage({
  me,
  heading,
}: {
  me: Me;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const [view, setView] = useState<ShopView>();
  const [history, setHistory] = useState<OpeningSummary[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [filters, setFilters] = useState<Filters>(noFilters);
  const [buying, setBuying] = useState<Product | null>(null);
  const [buyError, setBuyError] = useState("");
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState<{
    opening: Opening;
    startOpen: boolean;
  } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  // The purchase being confirmed keeps its key until it succeeds, so "Try again" buys once.
  const key = useRef("");

  const load = useCallback(async () => {
    const [shop, opened] = await Promise.all([
      client.GET("/api/v1/shop"),
      client.GET("/api/v1/shop/openings"),
    ]);
    if (shop.data) {
      setView(shop.data);
      setError("");
    } else setError(describe(shop.error));
    if (opened.data) setHistory(opened.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (buying) dialog.current?.showModal?.();
  }, [buying]);

  const products = useMemo(() => view?.products ?? [], [view]);
  const shown = useMemo(() => filtered(products, filters), [products, filters]);
  const groups = byEra(shown, view?.eras ?? [], filters.sort);
  const years = useMemo(() => yearsOf(products), [products]);
  const kinds = useMemo(() => kindsOf(products), [products]);
  const balance = view?.balance ?? 0;

  function choose(product: Product) {
    key.current = purchaseKey();
    setBuyError("");
    setBuying(product);
  }

  async function confirm() {
    if (!buying || busy) return;
    setBusy(true);
    setBuyError("");
    try {
      const { data, error: refused } = await client.POST(
        "/api/v1/shop/purchases",
        { body: { product: buying.id, key: key.current } },
      );
      if (!data) return setBuyError(describe(refused));
      setMessage(
        `You bought a ${buying.name} for ${tokens(data.tokens)}. It waits in your packs below.`,
      );
      dialog.current?.close();
      setBuying(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function open(packId: string) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const { data, error: refused } = await client.POST(
        "/api/v1/shop/packs/{pack_id}/open",
        { params: { path: { pack_id: packId } } },
      );
      if (!data) return setMessage(describe(refused));
      setOpening({ opening: data, startOpen: false });
      void load();
    } finally {
      setBusy(false);
    }
  }

  async function show(summary: OpeningSummary) {
    const { data, error: refused } = await client.GET(
      "/api/v1/shop/openings/{opening_id}",
      { params: { path: { opening_id: summary.id } } },
    );
    if (!data) return setMessage(describe(refused));
    setOpening({ opening: data, startOpen: true });
  }

  function update<K extends keyof Filters>(field: K, value: Filters[K]) {
    setFilters((before) => ({ ...before, [field]: value }));
  }

  const intro = (
    <>
      <span className={shell.eyebrow}>LENG'S CARD SHOP</span>
      <h1 ref={heading} tabIndex={-1}>
        Leng's card shop
      </h1>
    </>
  );

  if (opening) {
    const next = view?.inventory.find(
      (item) => item.product.id === opening.opening.product.id,
    );
    return (
      <>
        {intro}
        <PackOpening
          key={opening.opening.id}
          opening={opening.opening}
          startOpen={opening.startOpen}
          remaining={next?.count ?? 0}
          onAnother={next ? () => void open(next.next_pack) : undefined}
          onDone={() => {
            setOpening(null);
            void load();
          }}
        />
      </>
    );
  }

  return (
    <>
      {intro}
      <p className={shell.lead}>
        Tokens from your wins buy booster packs, from Revised to the current
        set. Each pack opens here at the counter, and its cards join your
        library for good.
      </p>
      <div className={styles.counter}>
        <Leng />
        <div className={styles.welcome}>
          <p className={styles.speech}>“{speech(view)}”</p>
          <div className={styles.balance}>
            <span>Your tokens</span>
            <strong>{view ? balance.toLocaleString("en-US") : "…"}</strong>
          </div>
          <p className={styles.note}>
            {me.kind === "sysop"
              ? "SysOp gives tokens and packs from Administration."
              : "Wins earn tokens: 5 to 20 for each bot you beat, 50 to 500 for each player."}
          </p>
        </div>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <p className={styles.note} role="status">
        {message}
      </p>

      <section className={styles.section} aria-labelledby="packs-title">
        <h2 id="packs-title">Your packs</h2>
        {view && view.inventory.length === 0 ? (
          <p className={styles.note}>
            No unopened packs. Packs you buy wait here until you open them.
          </p>
        ) : (
          <ul className={styles.inventory} aria-label="Unopened packs">
            {view?.inventory.map((item) => (
              <li key={item.product.id} aria-label={item.product.name}>
                <div>
                  <strong>{item.product.name}</strong>{" "}
                  <span>
                    × {item.count} · {kindLabels[item.product.kind]}
                  </span>
                </div>
                {item.openable ? (
                  <button
                    type="button"
                    className={shell.primary}
                    disabled={busy}
                    aria-label={`Open a pack of ${item.product.name}`}
                    onClick={() => void open(item.next_pack)}
                  >
                    Open a pack
                  </button>
                ) : (
                  <span>Its booster data has not been read yet.</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby="shelves-title">
        <h2 id="shelves-title">On the shelves</h2>
        <div className={styles.filters}>
          <label className={styles.field}>
            <span>Search by set name or code</span>
            <input
              type="search"
              value={filters.q}
              maxLength={80}
              onChange={(event) => update("q", event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>Year</span>
            <select
              value={filters.year}
              onChange={(event) => update("year", event.target.value)}
            >
              <option value="">Any year</option>
              {years.map((year) => (
                <option key={year} value={String(year)}>
                  {year}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>Booster type</span>
            <select
              value={filters.kind}
              onChange={(event) =>
                update("kind", event.target.value as Filters["kind"])
              }
            >
              <option value="">Any type</option>
              {kinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kindLabels[kind]}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>Sort</span>
            <select
              value={filters.sort}
              onChange={(event) => update("sort", event.target.value as Sort)}
            >
              {(Object.keys(sortLabels) as Sort[]).map((sort) => (
                <option key={sort} value={sort}>
                  {sortLabels[sort]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className={styles.note} aria-live="polite">
          {view
            ? `${shown.length} of ${products.length} ${products.length === 1 ? "product" : "products"} on sale.`
            : "Loading the shelves…"}
        </p>
        {groups.map(({ era, products: group }) => (
          <section
            key={era?.id ?? "all"}
            className={styles.era}
            aria-label={era ? era.name : "Every product"}
          >
            {era && (
              <h3>
                {era.name} <small>since {era.since.slice(0, 4)}</small>
              </h3>
            )}
            <ul className={styles.products}>
              {group.map((product) => {
                const short = product.price - balance;
                return (
                  <li
                    key={product.id}
                    className={styles.product}
                    aria-label={product.name}
                  >
                    <header>
                      <strong>{product.name}</strong>
                      <span className={styles.code}>{product.set_code}</span>
                    </header>
                    <p>
                      {product.set_name} · {day(product.released)}
                    </p>
                    <p>
                      {kindLabels[product.kind]}
                      {product.pack_size ? ` · ${product.pack_size} cards` : ""}
                      {product.price_basis === "unpriced"
                        ? " · not priced yet"
                        : ""}
                    </p>
                    <div className={styles.price}>
                      <b>{tokens(product.price)}</b>
                      <button
                        type="button"
                        className={styles.secondary}
                        aria-disabled={short > 0}
                        title={
                          short > 0
                            ? `You need ${tokens(short)} more.`
                            : undefined
                        }
                        aria-label={`Buy ${product.name}`}
                        onClick={() => short <= 0 && choose(product)}
                      >
                        Buy
                      </button>
                    </div>
                    {short > 0 && (
                      <p className={styles.note}>
                        You need {tokens(short)} more.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </section>

      <section className={styles.section} aria-labelledby="history-title">
        <h2 id="history-title">Packs you opened</h2>
        {history.length === 0 ? (
          <p className={styles.note}>None yet.</p>
        ) : (
          <ul className={styles.history} aria-label="Packs you opened">
            {history.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.product.name}</strong>{" "}
                  <span>
                    {new Date(item.opened_at).toLocaleString("en-US", {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}{" "}
                    · {item.cards} cards · {item.new_cards} new · best:{" "}
                    {rarityLabels[item.best] ?? item.best}
                    {item.foils ? ` · ${item.foils} foil` : ""}
                  </span>
                </div>
                <button
                  type="button"
                  className={styles.secondary}
                  aria-label={`See its cards: the ${item.product.name} opened ${day(item.opened_at)}`}
                  onClick={() => void show(item)}
                >
                  See its cards
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby="about-title">
        <h2 id="about-title">About the packs</h2>
        <div className={styles.about}>
          <p>
            Pull ratios follow{" "}
            <a href="https://mtgjson.com" target="_blank" rel="noreferrer">
              MTGJSON
            </a>
            's booster data (MIT licence)
            {view?.data.mtgjson_version
              ? `, version ${view.data.mtgjson_version}`
              : ""}
            : each pack is drawn from its set's own booster layouts and print
            sheets, slot by slot, foils included. They describe real packs as
            well as the community has recorded them, not a promise of any retail
            product's odds.
          </p>
          <p>
            Prices follow the market prices of sealed packs
            {view?.data.prices_as_of
              ? `, read on ${day(view.data.prices_as_of)}`
              : ""}
            , scaled so a current pack costs 500 tokens and a Revised pack
            150,000. Tokens are play money: wins earn them, and they cannot be
            bought, sold or cashed out. Alpha and Beta are not sold here; they
            are for tournaments.
          </p>
        </div>
      </section>

      <dialog
        ref={dialog}
        className={styles.dialog}
        aria-labelledby="buy-title"
        onClose={() => setBuying(null)}
      >
        {buying && (
          <>
            <h2 id="buy-title">Buy a {buying.name}?</h2>
            <p>
              It costs {tokens(buying.price)}. You have {tokens(balance)}, and
              will have {tokens(balance - buying.price)} left.
            </p>
            {buyError && (
              <p className={styles.error} role="alert">
                {buyError}
              </p>
            )}
            <div className={styles.actions}>
              <button
                type="button"
                className={shell.primary}
                disabled={busy}
                onClick={() => void confirm()}
              >
                {buyError ? "Try again" : `Buy for ${tokens(buying.price)}`}
              </button>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => dialog.current?.close()}
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </dialog>
    </>
  );
}
