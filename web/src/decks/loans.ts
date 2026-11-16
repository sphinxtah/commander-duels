import { useCallback, useEffect, useState } from "react";
import { client, describe } from "../api";
import type { components } from "../generated/api";

// Friend deck lending (v1.0.0, docs/decks.md; api/loans.py), behind the gate deck_lending. A
// player lends a deck to a friend, who looks at it, accepts, and plays it for seven days at a
// private table where the lender sits. Nothing changes hands. The owner's decision of
// 2026-11-15: as a real deck handed over, it is lent to one friend at a time, and its owner
// cannot play it while the friend has it.

export const DECK_LENDING = "deck_lending";

/** How often an open page asks for the account's loans again. */
const REFRESH_MS = 30_000;

export type Loan = components["schemas"]["Loan"];
export type Loans = components["schemas"]["Loans"];
export type LentDeck = components["schemas"]["LentDeck"];

/** "November 22": the day a loan ends by itself. */
export function untilWords(until: string): string {
  return new Date(until).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
  });
}

/** A loan as its lender's deck row says it. */
export function givenWords(loan: Loan): string {
  return loan.state === "accepted"
    ? `Lent to ${loan.borrower.handle} until ${untilWords(loan.until)}: you cannot play it meanwhile.`
    : `Offered to ${loan.borrower.handle}, who has not answered yet. It is still yours to play.`;
}

export interface LoanBook {
  /** null until the loans arrived, or where lending is not the account's to reach. */
  loans: Loans | null;
  busy: boolean;
  error: string;
  /** Offers a deck to a friend; true when it was offered. */
  offer: (deckId: string, playerId: string) => Promise<boolean>;
  accept: (loanId: string) => void;
  decline: (loanId: string) => void;
  /** The lender takes a deck back, or the borrower gives it back. */
  end: (loanId: string) => void;
}

/** The account's loans, given and taken; asked for only where lending is open to it. */
export function useLoans(enabled: boolean): LoanBook {
  const [loans, setLoans] = useState<Loans | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const { data } = await client
      .GET("/api/v1/loans")
      .catch(() => ({ data: undefined }));
    if (data) setLoans(data);
  }, []);
  // A loan changes in the other player's hands (accepted, given back, taken back) and by the
  // clock: asked again every half minute while the page is looked at, and as it is come back to.
  useEffect(() => {
    if (!enabled) return;
    void load();
    const again = () => {
      if (document.visibilityState === "visible") void load();
    };
    const timer = window.setInterval(again, REFRESH_MS);
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [enabled, load]);
  const change = useCallback(
    async (request: Promise<{ data?: Loans; error?: unknown }>) => {
      setBusy(true);
      setError("");
      const { data, error: failure } = await request.catch(() => ({
        data: undefined,
        error: undefined,
      }));
      setBusy(false);
      if (data) setLoans(data);
      else setError(describe(failure));
    },
    [],
  );
  const offer = useCallback(
    async (deckId: string, playerId: string) => {
      setBusy(true);
      setError("");
      const { data, error: failure } = await client
        .POST("/api/v1/decks/{deck_id}/loans", {
          params: { path: { deck_id: deckId } },
          body: { player_id: playerId },
        })
        .catch(() => ({ data: undefined, error: undefined }));
      setBusy(false);
      if (!data) {
        setError(describe(failure));
        return false;
      }
      await load();
      return true;
    },
    [load],
  );
  const path = (loanId: string) => ({ params: { path: { loan_id: loanId } } });
  return {
    loans: enabled ? loans : null,
    busy,
    error,
    offer,
    accept: (loanId) =>
      void change(client.POST("/api/v1/loans/{loan_id}/accept", path(loanId))),
    decline: (loanId) =>
      void change(client.POST("/api/v1/loans/{loan_id}/decline", path(loanId))),
    end: (loanId) =>
      void change(client.DELETE("/api/v1/loans/{loan_id}", path(loanId))),
  };
}

/** The open loan of one of the account's decks, if it has one. */
export function loanOf(loans: Loans | null, deckId: string): Loan | undefined {
  return loans?.given.find((loan) => loan.deck.id === deckId);
}
