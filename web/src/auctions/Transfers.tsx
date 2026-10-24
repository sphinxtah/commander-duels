import type { ReactNode } from "react";
import { ItemRow } from "./ItemViews";
import type { AuctionItem, AuctionTargets, TransferList } from "./types";
import styles from "./auctions.module.css";

// Madden's other two screens (v0.6.0). The transfer list: the viewer's own listings, active, sold
// and unsold, with Withdraw before the first bid, Relist and the Clear buttons. The transfer
// targets: the auctions the viewer watches or bid on, active (winning or outbid), won and lost.

function Section({
  id,
  title,
  items,
  empty,
  clear,
  children,
}: {
  id: string;
  title: string;
  items: AuctionItem[] | undefined;
  empty: string;
  /** The section's Clear button, when it has anything to clear. */
  clear?: { label: string; onClear: () => void; busy?: boolean };
  children: (item: AuctionItem) => ReactNode;
}) {
  const count = items?.length ?? 0;
  return (
    <section className={styles.transfers} aria-labelledby={id}>
      <header className={styles.transferHead}>
        <h2 id={id}>
          {title} <span className={styles.sectionCount}>{count}</span>
        </h2>
        {clear && count > 0 && (
          <button
            type="button"
            className={styles.secondary}
            disabled={clear.busy}
            onClick={clear.onClear}
          >
            {clear.label}
          </button>
        )}
      </header>
      {items === undefined ? (
        <p className={styles.note} role="status">
          Loading…
        </p>
      ) : count === 0 ? (
        <p className={styles.sectionEmpty}>{empty}</p>
      ) : (
        <ul className={styles.rows} aria-label={title}>
          {items.map(children)}
        </ul>
      )}
    </section>
  );
}

export function TransferListView({
  list,
  now,
  busy,
  onOpen,
  onWithdraw,
  onRelist,
  onClear,
  onSell,
}: {
  list: TransferList | undefined;
  now: number;
  busy: boolean;
  onOpen: (item: AuctionItem) => void;
  onWithdraw: (item: AuctionItem) => void;
  onRelist: (item: AuctionItem) => void;
  onClear: (which: "sold" | "unsold") => void;
  onSell: () => void;
}) {
  const nothing =
    list && !list.active.length && !list.sold.length && !list.unsold.length;
  return (
    <div className={styles.transferPage}>
      {nothing && (
        <div className={styles.empty}>
          <strong>Your transfer list is empty.</strong>
          <p>
            List a card from your library and it waits here while it sells.
            Sold cards pay you in full: there is no fee.
          </p>
          <button type="button" className={styles.secondary} onClick={onSell}>
            Sell a card
          </button>
        </div>
      )}
      <Section
        id="list-active"
        title="Active"
        items={list?.active}
        empty="Nothing on the market."
      >
        {(item) => (
          <ItemRow key={item.id} item={item} now={now} onOpen={onOpen}>
            {item.bids === 0 && (
              <button
                type="button"
                className={styles.secondary}
                disabled={busy}
                aria-label={`Withdraw ${item.card.name}`}
                onClick={() => onWithdraw(item)}
              >
                Withdraw
              </button>
            )}
          </ItemRow>
        )}
      </Section>
      <Section
        id="list-sold"
        title="Sold"
        items={list?.sold}
        empty="Nothing sold yet."
        clear={{
          label: "Clear sold",
          onClear: () => onClear("sold"),
          busy,
        }}
      >
        {(item) => (
          <ItemRow key={item.id} item={item} now={now} onOpen={onOpen} />
        )}
      </Section>
      <Section
        id="list-unsold"
        title="Unsold"
        items={list?.unsold}
        empty="Nothing waiting to be relisted."
        clear={{
          label: "Clear unsold",
          onClear: () => onClear("unsold"),
          busy,
        }}
      >
        {(item) => (
          <ItemRow key={item.id} item={item} now={now} onOpen={onOpen}>
            <button
              type="button"
              className={styles.secondary}
              disabled={busy}
              aria-label={`Relist ${item.card.name}`}
              onClick={() => onRelist(item)}
            >
              Relist
            </button>
          </ItemRow>
        )}
      </Section>
      {list && list.unsold.length > 0 && (
        <p className={styles.note}>
          An unsold card is back in your library already; Clear unsold only
          tidies this list.
        </p>
      )}
    </div>
  );
}

export function TransferTargetsView({
  targets,
  now,
  viewer,
  busy,
  onOpen,
  onClear,
}: {
  targets: AuctionTargets | undefined;
  now: number;
  viewer?: string | null;
  busy: boolean;
  onOpen: (item: AuctionItem) => void;
  onClear: (which: "won" | "lost") => void;
}) {
  const nothing =
    targets &&
    !targets.active.length &&
    !targets.won.length &&
    !targets.lost.length;
  const winning = targets?.active.filter((item) => item.leading).length ?? 0;
  const outbid = targets?.active.filter((item) => item.outbid).length ?? 0;
  return (
    <div className={styles.transferPage}>
      {nothing && (
        <div className={styles.empty}>
          <strong>No targets yet.</strong>
          <p>
            Watch an auction with its star, or bid on one, and it waits here
            until it ends.
          </p>
        </div>
      )}
      {targets && targets.active.length > 0 && (
        <p className={styles.note}>
          Winning {winning} · outbid {outbid}. Your bids are held from your
          tokens; an outbid one has come back.
        </p>
      )}
      <Section
        id="targets-active"
        title="Active"
        items={targets?.active}
        empty="Nothing watched or bid on."
      >
        {(item) => (
          <ItemRow
            key={item.id}
            item={item}
            now={now}
            viewer={viewer}
            onOpen={onOpen}
          />
        )}
      </Section>
      <Section
        id="targets-won"
        title="Won"
        items={targets?.won}
        empty="Nothing won yet."
        clear={{ label: "Clear won", onClear: () => onClear("won"), busy }}
      >
        {(item) => (
          <ItemRow
            key={item.id}
            item={{ ...item, leading: true }}
            now={now}
            viewer={viewer}
            onOpen={onOpen}
          />
        )}
      </Section>
      <Section
        id="targets-lost"
        title="Lost"
        items={targets?.lost}
        empty="Nothing lost."
        clear={{ label: "Clear lost", onClear: () => onClear("lost"), busy }}
      >
        {(item) => (
          <ItemRow
            key={item.id}
            item={{ ...item, leading: false }}
            now={now}
            viewer={viewer}
            onOpen={onOpen}
          />
        )}
      </Section>
    </div>
  );
}
