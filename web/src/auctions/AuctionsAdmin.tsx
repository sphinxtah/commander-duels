import { useCallback, useEffect, useState } from "react";
import { describe, type Me } from "../api";
import { auctionApi } from "./api";
import { editionLine, finishNames, tokens } from "./auctions";
import { CardArt, Price } from "./ItemViews";
import type { AuctionItem, AuctionPage, AuctionStatus } from "./types";
import styles from "./auctions.module.css";

// Administration's Auctions tab (v0.6.0): the auction house watched, not limited. Every auction,
// newest first, filtered by status: the sales log (seller, buyer, card, edition, finish, price,
// time), the live ones and the cancelled. SysOp alone cancels a live auction, with a reason that
// the audit log keeps; the high bid and the card go back. Administrators with auctions.manage read
// it.

const statusNames: Record<AuctionStatus, string> = {
  active: "Live",
  sold: "Sold",
  expired: "Unsold",
  withdrawn: "Withdrawn",
  cancelled: "Cancelled",
};

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function AuctionsAdmin({ me }: { me: Me }) {
  const sysop = me.kind === "sysop";
  const [status, setStatus] = useState<AuctionStatus | "">("sold");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState<AuctionPage>();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [cancelling, setCancelling] = useState<AuctionItem | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const cursor = cursors[cursors.length - 1] ?? null;

  const load = useCallback(async () => {
    const { data, error: refused } = await auctionApi.adminList(status, cursor);
    if (data) {
      setPage(data);
      setError("");
    } else setError(describe(refused));
  }, [status, cursor]);
  useEffect(() => {
    void load();
  }, [load]);

  async function cancel() {
    if (!cancelling || busy || !reason.trim()) return;
    setBusy(true);
    try {
      const { data, error: refused } = await auctionApi.adminCancel(
        cancelling.id,
        reason.trim(),
      );
      if (!data) return setError(describe(refused));
      setMessage(
        `The auction of ${cancelling.card.name} by ${cancelling.seller} is cancelled: the card went back${cancelling.current_bid !== null ? ` and ${cancelling.high_bidder}'s ${tokens(cancelling.current_bid)} were returned` : ""}.`,
      );
      setCancelling(null);
      setReason("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.admin} aria-labelledby="auctions-admin-title">
      <h2 id="auctions-admin-title">Tivit's Auction House</h2>
      <p className={styles.note}>
        Every auction, newest first: the sales log, the live auctions and the
        cancelled. There is no limit on prices, and no fee; every sale is also
        in both players' token ledgers.
        {sysop
          ? " You may cancel a live auction: the card goes back to its seller and the high bid to its bidder, and the reason is kept in the audit log."
          : " Only SysOp cancels an auction."}
      </p>
      <div className={styles.adminBar}>
        <label className={styles.field}>
          <span>Show</span>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as AuctionStatus | "");
              setCursors([null]);
            }}
          >
            <option value="sold">Sales</option>
            <option value="active">Live auctions</option>
            <option value="cancelled">Cancelled</option>
            <option value="expired">Unsold</option>
            <option value="withdrawn">Withdrawn</option>
            <option value="">Everything</option>
          </select>
        </label>
        <p role="status" className={styles.resultsCount}>
          {page
            ? `${page.total.toLocaleString("en-US")} ${page.total === 1 ? "auction" : "auctions"}`
            : "Loading…"}
        </p>
      </div>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <p className={styles.said} role="status">
        {message}
      </p>
      {cancelling && (
        <form
          className={styles.cancelForm}
          aria-label={`Cancel the auction of ${cancelling.card.name}`}
          onSubmit={(event) => {
            event.preventDefault();
            void cancel();
          }}
        >
          <p>
            Cancel {cancelling.seller}'s auction of{" "}
            <strong>{cancelling.card.name}</strong> (
            {editionLine(cancelling.card)}, {finishNames[cancelling.finish]})?
            {cancelling.current_bid !== null &&
              ` ${cancelling.high_bidder}'s bid of ${tokens(cancelling.current_bid)} goes back.`}
          </p>
          <label className={styles.field}>
            <span>Reason (kept in the audit log)</span>
            <input
              type="text"
              value={reason}
              required
              maxLength={300}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className={styles.bidActions}>
            <button
              type="submit"
              className={styles.danger}
              disabled={busy || !reason.trim()}
            >
              Cancel the auction
            </button>
            <button
              type="button"
              className={styles.secondary}
              onClick={() => setCancelling(null)}
            >
              Keep it
            </button>
          </div>
        </form>
      )}
      <div className={styles.tableWrap}>
        <table className={styles.log}>
          <caption className={styles.hidden}>Auctions, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Listed</th>
              <th scope="col">Card</th>
              <th scope="col">Seller</th>
              <th scope="col">Buyer</th>
              <th scope="col">Price</th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className={styles.hidden}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {page?.items.map((item) => (
              <tr key={item.id}>
                <td>
                  <time dateTime={item.created_at}>{when(item.created_at)}</time>
                </td>
                <th scope="row">
                  <span className={styles.logCard}>
                    <CardArt
                      card={item.card}
                      finish={item.finish}
                      className={styles.logArt}
                    />
                    <span>
                      {item.card.name}
                      <small>
                        {editionLine(item.card)} · {finishNames[item.finish]}
                      </small>
                    </span>
                  </span>
                </th>
                <td>{item.seller}</td>
                <td>{item.buyer ?? (item.high_bidder ? `${item.high_bidder} (leading)` : "—")}</td>
                <td>
                  <Price
                    value={
                      item.sold_price ?? item.current_bid ?? item.starting_bid
                    }
                  />
                  <small>
                    {item.status === "sold"
                      ? `${item.bids} ${item.bids === 1 ? "bid" : "bids"}`
                      : item.current_bid !== null
                        ? "high bid"
                        : "starting bid"}
                  </small>
                </td>
                <td>
                  <span className={styles.logStatus} data-status={item.status}>
                    {statusNames[item.status]}
                  </span>
                  <small>
                    {item.status === "active" ? "ends " : ""}
                    {when(item.ends_at)}
                  </small>
                </td>
                <td>
                  {sysop && item.status === "active" && (
                    <button
                      type="button"
                      className={styles.secondary}
                      aria-label={`Cancel ${item.seller}'s auction of ${item.card.name}`}
                      onClick={() => {
                        setCancelling(item);
                        setReason("");
                      }}
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {page && page.items.length === 0 && (
        <p className={styles.note}>None.</p>
      )}
      {(cursors.length > 1 || page?.next_cursor) && (
        <nav className={styles.pager} aria-label="Log pages">
          <button
            type="button"
            className={styles.secondary}
            disabled={cursors.length <= 1}
            onClick={() => setCursors(cursors.slice(0, -1))}
          >
            ◀ Newer
          </button>
          <button
            type="button"
            className={styles.secondary}
            disabled={!page?.next_cursor}
            onClick={() =>
              page?.next_cursor && setCursors([...cursors, page.next_cursor])
            }
          >
            Older ▶
          </button>
        </nav>
      )}
    </section>
  );
}
