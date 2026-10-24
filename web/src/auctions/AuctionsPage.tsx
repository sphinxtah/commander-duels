import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { client, describe, type Me } from "../api";
import { hudChanged } from "../shell/hud";
import { auctionApi } from "./api";
import {
  AUCTION_TABS,
  amount,
  tabHref,
  tabNames,
  tabOf,
  useNow,
  type AuctionTab,
} from "./auctions";
import { Coin } from "./ItemViews";
import { ItemPanel } from "./ItemPanel";
import { SearchMarket } from "./SearchMarket";
import { SellDialog, type SellRequest } from "./SellDialog";
import { TransferListView, TransferTargetsView } from "./Transfers";
import type { AuctionItem, AuctionTargets, TransferList } from "./types";
import styles from "./auctions.module.css";

// Tivit's Auction House (v0.6.0): cards between players, as Madden Ultimate Team's transfer market
// works, in the app's dark and gold. The owner's painting is the banner, with the viewer's tokens
// and the market's counts; three tabs (search, the transfer list, the transfer targets) are part
// of the address, #auctions/<tab>, so Back and Forward move between them; Sell opens the listing
// dialog from any tab. An auction opens in the item panel. The server holds every rule (docs/
// auctions.md); the page shows its answers and asks again every few seconds.

const POLL_MS = 5000;

/** The tab icons: a magnifier, a ledger, a target. */
const tabIcons: Record<AuctionTab, ReactNode> = {
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="5.5" />
      <path d="M15 15l5 5" />
    </>
  ),
  list: (
    <>
      <rect x="5" y="3.5" width="14" height="17" rx="1.5" />
      <path d="M8.5 8h7M8.5 12h7M8.5 16h4" />
    </>
  ),
  targets: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4.2" />
      <circle cx="12" cy="12" r="0.9" />
    </>
  ),
};

export function AuctionsPage({
  me,
  heading,
}: {
  me: Me;
  heading: RefObject<HTMLHeadingElement | null>;
}) {
  const [tab, setTab] = useState<AuctionTab>(() => tabOf(window.location.hash));
  const now = useNow();
  const viewer = me.handle;
  const [balance, setBalance] = useState<number>();
  const [marketTotal, setMarketTotal] = useState<number>();
  const [list, setList] = useState<TransferList>();
  const [targets, setTargets] = useState<AuctionTargets>();
  const [open, setOpen] = useState<AuctionItem | null>(null);
  const [replaced, setReplaced] = useState<AuctionItem | null>(null);
  const [sell, setSell] = useState<SellRequest | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // The tab follows the address: a tab's link, Back and Forward.
  useEffect(() => {
    const change = () => {
      if (window.location.hash.toLowerCase().startsWith("#auctions"))
        setTab(tabOf(window.location.hash));
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);

  const loadBalance = useCallback(async () => {
    const { data } = await client.GET("/api/v1/me/tokens");
    if (data) setBalance(data.balance);
  }, []);
  const loadMine = useCallback(async (background: boolean) => {
    const [mine, watched] = await Promise.all([
      auctionApi.mine(background),
      auctionApi.targets(background),
    ]);
    if (mine.data) setList(mine.data);
    if (watched.data) setTargets(watched.data);
    if (!background && (mine.error || watched.error))
      setError(describe(mine.error ?? watched.error));
  }, []);
  useEffect(() => {
    void loadBalance();
    void loadMine(false);
  }, [loadBalance, loadMine, refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") void loadMine(true);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadMine]);

  /** Something spent, paid or moved a card: the balance, the lists and the top bar ask again. */
  const changed = useCallback(() => {
    hudChanged();
    setRefresh((count) => count + 1);
  }, []);

  const onPanelChanged = useCallback(
    (item: AuctionItem, said?: string) => {
      setOpen((current) =>
        current && current.id === item.id ? item : current,
      );
      setReplaced(item);
      if (said) {
        setMessage(said);
        changed();
      }
    },
    [changed],
  );

  async function watch(item: AuctionItem, on: boolean) {
    const { error: refused } = await auctionApi.watch(item.id, on);
    if (refused) return setError(describe(refused));
    setReplaced({ ...item, watching: on });
    void loadMine(true);
  }

  async function withdraw(item: AuctionItem) {
    if (busy) return;
    setBusy(true);
    try {
      const { data, error: refused } = await auctionApi.withdraw(item.id);
      if (!data) return setError(describe(refused));
      setError("");
      setMessage(`You withdrew ${item.card.name}. It is back in your library.`);
      changed();
    } finally {
      setBusy(false);
    }
  }

  async function clear(which: "sold" | "unsold" | "won" | "lost") {
    if (busy) return;
    setBusy(true);
    try {
      const { error: refused } =
        which === "sold" || which === "unsold"
          ? await auctionApi.clearMine(which)
          : await auctionApi.clearTargets(which);
      if (refused) return setError(describe(refused));
      setError("");
      await loadMine(false);
    } finally {
      setBusy(false);
    }
  }

  const listing = list?.active.length ?? 0;
  const winning = targets?.active.filter((item) => item.leading).length ?? 0;
  const outbid = targets?.active.filter((item) => item.outbid).length ?? 0;
  const tabCounts: Record<AuctionTab, string | undefined> = {
    search:
      marketTotal !== undefined ? `${amount(marketTotal)} live` : undefined,
    list: list
      ? `${listing} active · ${list.sold.length} sold · ${list.unsold.length} unsold`
      : undefined,
    targets: targets ? `${winning} winning · ${outbid} outbid` : undefined,
  };

  return (
    <div className={styles.page}>
      <header className={styles.banner}>
        <picture>
          <source
            media="(max-width: 700px)"
            srcSet="/menu/auctions-640.webp 640w, /menu/auctions-1280.webp 1280w"
            sizes="100vw"
          />
          <img
            className={styles.bannerArt}
            src="/menu/auctions-1280.webp"
            alt=""
            width={1280}
            height={720}
          />
        </picture>
        <div className={styles.bannerWords}>
          <span className={styles.bannerKicker}>The transfer market</span>
          <h1 ref={heading} tabIndex={-1}>
            Tivit's Auction House
          </h1>
          <p>
            Bid on other players' cards, or sell your own: every edition and
            finish its own item. A sale pays you in full.
          </p>
        </div>
        <dl className={styles.stats}>
          <div className={styles.statTokens}>
            <dt>Your tokens</dt>
            <dd>
              <Coin />
              {balance === undefined ? "…" : amount(balance)}
            </dd>
          </div>
          <div>
            <dt>Live auctions</dt>
            <dd>{marketTotal === undefined ? "…" : amount(marketTotal)}</dd>
          </div>
          <div>
            <dt>Your listings</dt>
            <dd>{list ? amount(listing) : "…"}</dd>
          </div>
          <div>
            <dt>Winning</dt>
            <dd>
              {targets ? amount(winning) : "…"}
              {outbid > 0 && (
                <small className={styles.statOutbid}>{outbid} outbid</small>
              )}
            </dd>
          </div>
        </dl>
      </header>

      <div className={styles.navRow}>
        <nav className={styles.tabs} aria-label="The auction house">
          {AUCTION_TABS.map((item) => (
            <a
              key={item}
              href={tabHref(item)}
              aria-current={tab === item ? "page" : undefined}
              className={styles.tab}
            >
              <svg
                viewBox="0 0 24 24"
                width="26"
                height="26"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                {tabIcons[item]}
              </svg>
              <span className={styles.tabWords}>
                <span className={styles.tabName}>{tabNames[item]}</span>
                {tabCounts[item] && (
                  <span className={styles.tabCount}>{tabCounts[item]}</span>
                )}
              </span>
              {item === "targets" && outbid > 0 && (
                <span
                  className={styles.tabAlert}
                  aria-label={`${outbid} outbid`}
                >
                  {outbid}
                </span>
              )}
            </a>
          ))}
        </nav>
        <button
          type="button"
          className={styles.sellButton}
          onClick={() => setSell({ mode: "sell" })}
        >
          <span aria-hidden="true">＋</span> Sell a card
        </button>
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <p className={styles.said} role="status">
        {message}
      </p>

      <div className={styles.tabPanel}>
        {tab === "search" ? (
          <SearchMarket
            now={now}
            viewer={viewer}
            refresh={refresh}
            onOpen={setOpen}
            onWatch={(item, on) => void watch(item, on)}
            onTotal={setMarketTotal}
            replaced={replaced}
          />
        ) : tab === "list" ? (
          <TransferListView
            list={list}
            now={now}
            busy={busy}
            onOpen={setOpen}
            onWithdraw={(item) => void withdraw(item)}
            onRelist={(item) => setSell({ mode: "relist", item })}
            onClear={(which) => void clear(which)}
            onSell={() => setSell({ mode: "sell" })}
          />
        ) : (
          <TransferTargetsView
            targets={targets}
            now={now}
            viewer={viewer}
            busy={busy}
            onOpen={setOpen}
            onClear={(which) => void clear(which)}
          />
        )}
      </div>

      <section className={styles.rules} aria-labelledby="rules-title">
        <h2 id="rules-title">How the auction house works</h2>
        <ul>
          <li>
            Each auction is one copy of a card in one exact print and one
            finish, basic lands included. Packs, alliance cards, the one of a
            kind and custom cards are never sold.
          </li>
          <li>
            A bid is held from your tokens at once and comes back if someone
            outbids you. Each bid beats the last by at least 5%.
          </li>
          <li>
            A bid in the last 30 seconds adds 30 seconds, so nobody wins by a
            last-moment snipe. Buy Now ends the auction at once.
          </li>
          <li>
            Listing takes the card out of your library, and decks that used it
            wait for it; an unsold card comes back. The seller receives every
            token the buyer pays.
          </li>
        </ul>
      </section>

      <ItemPanel
        item={open}
        now={now}
        viewer={viewer}
        balance={balance}
        onClose={() => setOpen(null)}
        onChanged={onPanelChanged}
        onOpen={setOpen}
      />
      <SellDialog
        request={sell}
        onClose={() => setSell(null)}
        onListed={(_items, said) => {
          setMessage(said);
          setError("");
          changed();
        }}
      />
    </div>
  );
}
