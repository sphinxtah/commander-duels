import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client, type TokenLine, type Tokens } from "../api";
import { change, lineWords, tokens } from "./tokens";
import { TokensPanel } from "./TokensPanel";

function line(fields: Partial<TokenLine>): TokenLine {
  return {
    kind: "bot_win",
    amount: 14,
    created_at: "2026-10-21T18:00:00Z",
    game_id: "g1",
    opponent: "a skill-4 bot",
    reason: null,
    ...fields,
  };
}

function shown(entries: TokenLine[]): Tokens {
  return { balance: 1514, earned: 1014, given: 1000, spent: 500, entries };
}

afterEach(() => vi.restoreAllMocks());

describe("the words for tokens", () => {
  it("count, sign and name each entry", () => {
    expect([tokens(1), tokens(1250), tokens(0)]).toEqual([
      "1 token",
      "1,250 tokens",
      "0 tokens",
    ]);
    expect([change(14), change(-500), change(0)]).toEqual(["+14", "−500", "0"]);
    expect(lineWords(line({}))).toBe("Beat a skill-4 bot");
    expect(lineWords(line({ kind: "human_win", opponent: "bob" }))).toBe(
      "Beat bob",
    );
    expect(lineWords(line({ kind: "welcome", game_id: null }))).toBe(
      "Welcome grant",
    );
    expect(lineWords(line({ kind: "grant", amount: -5 }))).toBe(
      "Taken back by SysOp",
    );
  });
});

describe("the profile's tokens", () => {
  it("show the balance, where it came from, and the latest entries", async () => {
    const entries = [
      line({
        kind: "human_win",
        amount: 0,
        opponent: "bob",
        reason: "Only 3 wins a day over the same player pay tokens.",
      }),
      ...Array.from({ length: 9 }, () => line({})),
    ];
    vi.spyOn(client, "GET").mockResolvedValue({
      data: shown(entries),
    } as never);
    render(<TokensPanel />);
    const list = await screen.findByRole("list", { name: "Latest tokens" });
    expect(screen.getByText("1,514")).toBeInTheDocument();
    expect(
      screen.getByText(
        "1,014 tokens won in games · 1,000 tokens given · 500 tokens spent in Leng's card shop",
      ),
    ).toBeInTheDocument();
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(8);
    expect(items[0]).toHaveTextContent(
      "0Beat bobOnly 3 wins a day over the same player pay tokens.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(10);
  });

  it("say why when they cannot be loaded", async () => {
    vi.spyOn(client, "GET").mockResolvedValue({
      data: undefined,
      error: { code: "unavailable", message: "Not now." },
    } as never);
    render(<TokensPanel />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Not now.");
  });
});
