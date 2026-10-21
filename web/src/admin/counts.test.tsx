import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client, type AdminCounts, type Me } from "../api";
import {
  COUNTS_MS,
  countsTotal,
  countsWords,
  useAdminCounts,
  useCountTitle,
  watchesCounts,
} from "./counts";

const sysop = {
  id: "00000000-0000-4000-8000-000000000001",
  status: "active",
  permissions: ["admin.users.manage", "reports.manage"],
} as Me;
const moderator = {
  ...sysop,
  id: "00000000-0000-4000-8000-000000000002",
  permissions: ["admin.users.read"],
} as Me;

let answers: AdminCounts[] = [];
let asked = 0;
beforeEach(() => {
  asked = 0;
  answers = [{ pending_accounts: 2, unread_reports: 1 }];
  vi.useFakeTimers();
  vi.spyOn(client, "GET").mockImplementation((async () => {
    asked += 1;
    const data = answers.length > 1 ? answers.shift() : answers[0];
    return { data, response: new Response(null, { status: 200 }) };
  }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.title = "Commander Duels";
});

let shown: AdminCounts | null = null;
function Probe({ me }: { me: Me | null }) {
  const { counts } = useAdminCounts(me);
  shown = counts;
  useCountTitle(countsTotal(counts));
  return null;
}
async function later(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}
function visibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("Administration's counts (v0.4.1)", () => {
  it("are words for screen readers and a total for the badge", () => {
    const counts = { pending_accounts: 2, unread_reports: 1 };
    expect(countsWords(counts)).toBe(
      "2 accounts waiting for approval, 1 unread report",
    );
    expect(countsWords({ pending_accounts: 1, unread_reports: 0 })).toBe(
      "1 account waiting for approval",
    );
    expect(countsWords({ pending_accounts: null, unread_reports: 3 })).toBe(
      "3 unread reports",
    );
    expect(countsTotal(counts)).toBe(3);
    expect(countsTotal(null)).toBe(0);
  });

  it("are watched by SysOp and administrators only", () => {
    expect(watchesCounts(sysop)).toBe(true);
    expect(
      watchesCounts({ ...sysop, permissions: ["reports.manage"] } as Me),
    ).toBe(true);
    expect(watchesCounts(moderator)).toBe(false);
    expect(watchesCounts({ ...sysop, status: "pending" } as Me)).toBe(false);
    expect(watchesCounts(null)).toBe(false);
  });

  it("are asked at once, every minute while the page is shown, and when it is shown again", async () => {
    render(<Probe me={sysop} />);
    await later(0);
    expect(asked).toBe(1);
    expect(shown).toEqual({ pending_accounts: 2, unread_reports: 1 });
    await later(COUNTS_MS);
    expect(asked).toBe(2);
    // A hidden page waits; shown again, it asks at once.
    visibility("hidden");
    await later(COUNTS_MS * 3);
    expect(asked).toBe(2);
    visibility("visible");
    await later(0);
    expect(asked).toBe(3);
    window.dispatchEvent(new Event("focus"));
    await later(0);
    expect(asked).toBe(4);
  });

  it("are never asked for an account that sees neither", async () => {
    render(<Probe me={moderator} />);
    await later(COUNTS_MS * 2);
    expect(asked).toBe(0);
    expect(shown).toBeNull();
  });

  it("put the total before the tab's title, whatever page sets it, and take it away", async () => {
    document.title = "Commander Duels";
    answers = [
      { pending_accounts: 2, unread_reports: 1 },
      { pending_accounts: 0, unread_reports: 0 },
    ];
    render(<Probe me={sysop} />);
    await later(0);
    expect(document.title).toBe("(3) Commander Duels");
    // The game screen sets a title of its own; the count goes back in front of it.
    document.title = "Commander Duels · Game";
    await later(0);
    expect(document.title).toBe("(3) Commander Duels · Game");
    await later(COUNTS_MS);
    expect(document.title).toBe("Commander Duels · Game");
  });
});
