import { useEffect, useRef, useState } from "react";
import { describe } from "../api";
import { CardDetails } from "../catalog/CardViews";
import { CardZoom, type Zoomed } from "../catalog/CardZoom";
import catalog from "../catalog/catalog.module.css";
import shell from "../App.module.css";
import { auctionApi } from "./api";
import {
  amount,
  bidOutcome,
  cardImage,
  durationNames,
  editionLine,
  finishNames,
  increment,
  milestone,
  msLeft,
  rarityNames,
  requestKey,
  standing,
  stepDown,
  stepUp,
  timeLeft,
  tokens,
  urgent,
} from "./auctions";
import {
  CardArt,
  FinishChip,
  Price,
  StandingBadge,
  TimeLeft,
} from "./ItemViews";
import type { AuctionItem, ComparePrices } from "./types";
import styles from "./auctions.module.css";

// An auction opened (v0.6.0), Madden's item panel: a drawer at the side of a wide window, a sheet
// over a phone's. The big picture, its edition and finish, the seller, the bids and the price;
// the bid stepper, Make bid, Buy Now with its confirmation, Watch, Compare price and the card's
// details. It asks for the auction again every few seconds while it is open, so a bid from
// someone else, or the end, shows.

const POLL_MS = 5000;

export function ItemPanel({
  item,
  now,
  viewer,
  balance,
  onClose,
  onChanged,
  onOpen,
}: {
  item: AuctionItem | null;
  now: number;
  viewer?: string | null;
  /** The viewer's tokens, if known. */
  balance?: number;
  onClose: () => void;
  /** An answer changed the auction (a bid, Buy Now, Withdraw, Watch) or the viewer's balance. */
  onChanged: (item: AuctionItem, said?: string) => void;
  /** Opens another auction in the panel (from Compare price). */
  onOpen: (item: AuctionItem) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const details = useRef<HTMLDialogElement>(null);
  const [shownDetails, setShownDetails] = useState(false);
  const [zoom, setZoom] = useState<Zoomed>();
  const [bid, setBid] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [said, setSaid] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [compare, setCompare] = useState<ComparePrices | "loading" | null>(
    null,
  );
  // One key per bid or purchase until it succeeds: "Try again" spends once.
  const bidKey = useRef("");
  const buyKey = useRef("");
  const id = item?.id;

  useEffect(() => {
    if (item && !dialog.current?.open) dialog.current?.showModal?.();
    if (!item && dialog.current?.open) dialog.current.close();
  }, [item]);
  // A new auction starts afresh: its least bid, no confirmation, no comparison.
  useEffect(() => {
    if (!item) return;
    setBid(item.next_bid);
    setError("");
    setSaid("");
    setConfirming(false);
    setCompare(null);
    bidKey.current = requestKey();
    buyKey.current = requestKey();
    // Only when another auction opens; the same one's updates keep what the player typed.
  }, [id]);
  // Someone else's bid raises the least bid: the stepper follows it up, never down.
  const least = item?.next_bid;
  useEffect(() => {
    if (least !== undefined) setBid((value) => Math.max(value, least));
  }, [least]);
  useEffect(() => {
    if (!id) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void auctionApi.item(id, true).then(({ data }) => {
        if (data) onChanged(data);
      });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [id, onChanged]);
  useEffect(() => {
    if (shownDetails) details.current?.showModal?.();
  }, [shownDetails]);

  // The live region speaks at the countdown's milestones only.
  const mark =
    item && item.status === "active" ? milestone(item.ends_at, now) : "";
  const live = Boolean(
    item && item.status === "active" && msLeft(item.ends_at, now) > 0,
  );
  const canBid = live && item && !item.mine;
  // An unlimited auction (v0.6.3) is Buy Now only: no bids.
  const buyNowOnly = item?.duration === "unlimited";
  const outcome = item ? bidOutcome(item, bid) : "too_low";
  const short = balance !== undefined && bid > balance ? bid - balance : 0;

  async function placeBid() {
    if (!item || busy) return;
    if (outcome === "too_low") {
      setError(`The least bid is ${tokens(item.next_bid)}.`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { data, error: refused } = await auctionApi.bid(
        item.id,
        bid,
        bidKey.current,
      );
      if (!data) return setError(describe(refused));
      bidKey.current = requestKey();
      const words =
        data.status === "sold"
          ? `You bought ${item.card.name} for ${tokens(data.sold_price ?? bid)}. It is in your library.`
          : `Your bid of ${tokens(bid)} is the highest.`;
      setSaid(words);
      onChanged(data, words);
    } finally {
      setBusy(false);
    }
  }

  async function buyNow() {
    if (!item || busy || item.buy_now === null) return;
    setBusy(true);
    setError("");
    try {
      const { data, error: refused } = await auctionApi.buyNow(
        item.id,
        buyKey.current,
      );
      if (!data) return setError(describe(refused));
      buyKey.current = requestKey();
      setConfirming(false);
      const words = `You bought ${item.card.name} for ${tokens(data.sold_price ?? item.buy_now)}. It is in your library.`;
      setSaid(words);
      onChanged(data, words);
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (!item || busy) return;
    setBusy(true);
    setError("");
    try {
      const { data, error: refused } = await auctionApi.withdraw(item.id);
      if (!data) return setError(describe(refused));
      const words = `You withdrew ${item.card.name}. It is back in your library.`;
      setSaid(words);
      onChanged(data, words);
    } finally {
      setBusy(false);
    }
  }

  async function watch(on: boolean) {
    if (!item) return;
    const { error: refused } = await auctionApi.watch(item.id, on);
    if (refused) return setError(describe(refused));
    onChanged({ ...item, watching: on });
  }

  async function comparePrices() {
    if (!item) return;
    if (compare && compare !== "loading") return setCompare(null);
    setCompare("loading");
    const { data, error: refused } = await auctionApi.compare(
      item.card.printing_id,
      item.finish,
    );
    if (!data) {
      setCompare(null);
      return setError(describe(refused));
    }
    setCompare(data);
  }

  const shown = item ? standing(item, now, viewer) : null;
  return (
    <>
      <dialog
        ref={dialog}
        className={styles.drawer}
        aria-labelledby="auction-item-title"
        onClose={onClose}
        onClick={(event) => {
          // A click on the backdrop (the dialog itself, outside its panel) closes it.
          if (event.target === dialog.current) dialog.current?.close();
        }}
      >
        {item && (
          <div className={styles.drawerBody}>
            <header className={styles.drawerHead}>
              <span className={styles.drawerKicker}>
                {item.mine ? "Your listing" : `Sold by ${item.seller}`}
              </span>
              <button
                type="button"
                className={styles.drawerClose}
                aria-label="Close the auction"
                onClick={() => dialog.current?.close()}
              >
                ×
              </button>
            </header>
            <div className={styles.drawerHero}>
              <button
                type="button"
                className={styles.heroArt}
                aria-label={`Show ${item.card.name} bigger`}
                onClick={() =>
                  setZoom({
                    name: item.card.name,
                    src: () => cardImage(item.card, "png"),
                    faces: 0,
                    details: () => setShownDetails(true),
                    finish: item.finish,
                  })
                }
              >
                <CardArt card={item.card} finish={item.finish} size="large" />
              </button>
              <div className={styles.heroWords}>
                <h2 id="auction-item-title">{item.card.name}</h2>
                <p className={styles.heroEdition}>{editionLine(item.card)}</p>
                <p className={styles.heroChips}>
                  <span
                    className={styles.rarity}
                    data-rarity={item.card.rarity}
                  >
                    {rarityNames[item.card.rarity] ?? item.card.rarity}
                  </span>
                  <FinishChip finish={item.finish} />
                  <StandingBadge shown={shown} />
                </p>
                <p className={styles.heroType}>{item.card.type_line}</p>
              </div>
            </div>

            <dl className={styles.facts}>
              {(!buyNowOnly || item.status === "sold") && (
                <div>
                  <dt>
                    {item.status === "sold"
                      ? "Sold for"
                      : item.current_bid !== null
                        ? "Current bid"
                        : "Starting bid"}
                  </dt>
                  <dd>
                    <Price
                      value={
                        item.status === "sold"
                          ? item.sold_price
                          : (item.current_bid ?? item.starting_bid)
                      }
                      className={styles.bigPrice}
                    />
                  </dd>
                </div>
              )}
              <div>
                <dt>Buy Now</dt>
                <dd>
                  <Price value={item.buy_now} className={styles.bigPrice} />
                </dd>
              </div>
              {(live || item.ends_at !== null) && (
                <div>
                  <dt>{live ? "Time left" : "Ended"}</dt>
                  <dd className={styles.bigTime}>
                    {live || item.ends_at === null ? (
                      <TimeLeft endsAt={item.ends_at} now={now} />
                    ) : (
                      <time dateTime={item.ends_at}>
                        {new Date(item.ends_at).toLocaleString("en-US", {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </time>
                    )}
                  </dd>
                </div>
              )}
              {!buyNowOnly && (
                <div>
                  <dt>Bids</dt>
                  <dd>
                    {item.bids.toLocaleString("en-US")}
                    {item.high_bidder && (
                      <small> · highest {item.high_bidder}</small>
                    )}
                  </dd>
                </div>
              )}
              {item.my_bid !== null && !item.mine && (
                <div>
                  <dt>Your bid</dt>
                  <dd>
                    <Price value={item.my_bid} />
                  </dd>
                </div>
              )}
              <div>
                <dt>Listed for</dt>
                <dd>{durationNames[item.duration]}</dd>
              </div>
              {item.status === "sold" && item.buyer && (
                <div>
                  <dt>Buyer</dt>
                  <dd>{item.buyer}</dd>
                </div>
              )}
            </dl>
            <p className={styles.hidden} aria-live="polite">
              {mark}
            </p>

            {canBid && (
              <section
                className={styles.bidBox}
                aria-label={buyNowOnly ? "Buy it" : "Make a bid"}
              >
                {buyNowOnly ? (
                  <p className={styles.bidHint}>
                    Buy Now only: this listing has no end and takes no bids.
                    {item.buy_now !== null &&
                      balance !== undefined &&
                      item.buy_now > balance &&
                      ` You need ${tokens(item.buy_now - balance)} more.`}
                  </p>
                ) : (
                  <>
                    <div className={styles.stepper}>
                      <button
                        type="button"
                        aria-label={`Lower the bid by ${tokens(bid - stepDown(bid, item.next_bid))}`}
                        disabled={bid <= item.next_bid || busy}
                        onClick={() => setBid(stepDown(bid, item.next_bid))}
                      >
                        −
                      </button>
                      <label>
                        <span className={styles.hidden}>
                          Your bid in tokens
                        </span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={item.next_bid}
                          step={1}
                          value={Number.isFinite(bid) ? bid : ""}
                          onChange={(event) =>
                            setBid(Math.floor(Number(event.target.value)))
                          }
                        />
                      </label>
                      <button
                        type="button"
                        aria-label={`Raise the bid by ${tokens(increment(bid))}`}
                        disabled={busy}
                        onClick={() => setBid(stepUp(bid))}
                      >
                        +
                      </button>
                    </div>
                    <p className={styles.bidHint}>
                      {outcome === "too_low"
                        ? `The least bid is ${tokens(item.next_bid)}.`
                        : outcome === "buys"
                          ? `A bid of ${tokens(bid)} reaches Buy Now: it buys the card for ${tokens(item.buy_now!)}.`
                          : item.leading
                            ? "You hold the highest bid."
                            : `Least bid ${amount(item.next_bid)} · steps of 5%. The tokens are held until someone outbids you.`}
                      {short > 0 && ` You need ${tokens(short)} more.`}
                    </p>
                  </>
                )}
                <div className={styles.bidActions}>
                  {!buyNowOnly && (
                    <button
                      type="button"
                      className={shell.primary}
                      disabled={busy || item.leading || outcome === "too_low"}
                      onClick={() => void placeBid()}
                    >
                      {error && !confirming ? "Try again" : "Make bid"}
                    </button>
                  )}
                  {item.buy_now !== null && !confirming && (
                    <button
                      type="button"
                      className={styles.buyButton}
                      disabled={busy}
                      onClick={() => setConfirming(true)}
                    >
                      Buy Now · {amount(item.buy_now)}
                    </button>
                  )}
                </div>
                {confirming && item.buy_now !== null && (
                  <div
                    className={styles.confirm}
                    role="group"
                    aria-label="Confirm Buy Now"
                  >
                    <p>
                      Buy {item.card.name} ({finishNames[item.finish]}) now for{" "}
                      <strong>{tokens(item.buy_now)}</strong>?
                      {balance !== undefined &&
                        ` You have ${tokens(balance)}${balance >= item.buy_now ? `, and will have ${tokens(balance - item.buy_now + (item.leading && item.my_bid ? item.my_bid : 0))} left` : ""}.`}
                    </p>
                    <div className={styles.bidActions}>
                      <button
                        type="button"
                        className={shell.primary}
                        disabled={busy}
                        onClick={() => void buyNow()}
                      >
                        Buy for {tokens(item.buy_now)}
                      </button>
                      <button
                        type="button"
                        className={styles.secondary}
                        onClick={() => setConfirming(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )}
            {live && item.mine && (
              <section className={styles.bidBox} aria-label="Your listing">
                <p className={styles.bidHint}>
                  {item.bids === 0
                    ? "No bids yet: you may withdraw it, and the card comes back to your library."
                    : "It has bids, so it stays on the market until it ends."}
                </p>
                {item.bids === 0 && (
                  <div className={styles.bidActions}>
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy}
                      onClick={() => void withdraw()}
                    >
                      Withdraw
                    </button>
                  </div>
                )}
              </section>
            )}
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            <p className={styles.said} role="status">
              {said}
            </p>

            <div className={styles.drawerTools}>
              {!item.mine && (
                <button
                  type="button"
                  className={styles.secondary}
                  aria-pressed={item.watching}
                  onClick={() => void watch(!item.watching)}
                >
                  {item.watching ? "★ Watching" : "☆ Watch"}
                </button>
              )}
              <button
                type="button"
                className={styles.secondary}
                aria-expanded={compare !== null}
                onClick={() => void comparePrices()}
              >
                Compare price
              </button>
              <button
                type="button"
                className={styles.secondary}
                onClick={() => setShownDetails(true)}
              >
                Card details
              </button>
            </div>
            {compare !== null && (
              <ComparePanel
                compare={compare}
                current={item}
                now={now}
                onOpen={onOpen}
              />
            )}
          </div>
        )}
      </dialog>
      <dialog
        ref={details}
        className={catalog.cardDialog}
        aria-label={item ? `${item.card.name}, card details` : "Card details"}
        onClose={() => setShownDetails(false)}
      >
        <button
          type="button"
          className={catalog.close}
          aria-label="Close the card"
          onClick={() => details.current?.close()}
        >
          ×
        </button>
        {shownDetails && item && (
          <CardDetails
            cardId={item.card.concept_id}
            chosenPrinting={item.card.printing_id}
            printings="chosen"
            finish={item.finish}
            onZoom={setZoom}
          />
        )}
      </dialog>
      <CardZoom zoomed={zoom} onClose={() => setZoom(undefined)} />
    </>
  );
}

/** Compare price: the same edition and finish's live listings, lowest first, and its recent
 * sales. */
function ComparePanel({
  compare,
  current,
  now,
  onOpen,
}: {
  compare: ComparePrices | "loading";
  current: AuctionItem;
  now: number;
  onOpen: (item: AuctionItem) => void;
}) {
  if (compare === "loading")
    return (
      <p className={styles.note} role="status">
        Comparing prices…
      </p>
    );
  const sales = compare.recent_sales;
  const average = sales.length
    ? Math.round(
        sales.reduce((sum, sale) => sum + sale.price, 0) / sales.length,
      )
    : null;
  return (
    <section className={styles.compare} aria-labelledby="compare-title">
      <h3 id="compare-title">
        Compare price{" "}
        <small>
          {current.card.name} · {current.card.set_code.toUpperCase()} ·{" "}
          {finishNames[current.finish]}
        </small>
      </h3>
      <h4>On the market</h4>
      {compare.items.length === 0 ? (
        <p className={styles.note}>No other live listing of it.</p>
      ) : (
        <ol className={styles.compareList}>
          {compare.items.map((other) => (
            <li
              key={other.id}
              data-current={other.id === current.id || undefined}
            >
              <button
                type="button"
                disabled={other.id === current.id}
                onClick={() => onOpen(other)}
                aria-label={`${other.id === current.id ? "This auction" : `Open ${other.seller}'s`}: ${other.current_bid !== null ? "bid" : "starting bid"} ${tokens(other.current_bid ?? other.starting_bid)}${other.buy_now !== null ? `, Buy Now ${tokens(other.buy_now)}` : ""}, ${timeLeft(other.ends_at, now)} left`}
              >
                <span className={styles.compareWho}>
                  <CardArt
                    card={other.card}
                    finish={other.finish}
                    className={styles.compareArt}
                  />
                  <span>
                    {other.id === current.id ? "This one" : other.seller}
                  </span>
                </span>
                <Price value={other.current_bid ?? other.starting_bid} />
                <Price value={other.buy_now} className={styles.buyNow} />
                <span
                  className={styles.time}
                  data-urgent={urgent(other.ends_at, now) || undefined}
                >
                  {timeLeft(other.ends_at, now)}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <h4>
        Recently sold
        {average !== null && (
          <small>
            {" "}
            · average <Price value={average} />
          </small>
        )}
      </h4>
      {sales.length === 0 ? (
        <p className={styles.note}>Not sold yet.</p>
      ) : (
        <ol className={styles.salesList}>
          {sales.map((sale, index) => (
            <li key={`${sale.sold_at}-${index}`}>
              <Price value={sale.price} />
              <time dateTime={sale.sold_at}>
                {new Date(sale.sold_at).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
