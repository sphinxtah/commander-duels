import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockApi, reply } from "../decks/fixtures";
import { oldestFirst, SetCodesInfo } from "./SetCodes";

const set = (code: string, name: string, released_at: string | null) => ({
  code,
  name,
  released_at,
  type: "core",
  cards: 1,
});

describe("the edition codes (v0.9.6)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists every edition oldest to newest", () => {
    expect(
      oldestFirst([
        set("m10", "Magic 2010", "2009-07-17"),
        set("zzz", "Undated", null),
        set("lea", "Limited Edition Alpha", "1993-08-05"),
      ]).map((found) => found.code),
    ).toEqual(["lea", "m10", "zzz"]);
  });

  it("opens from the i, and a code chosen fills the field", async () => {
    const api = mockApi();
    api.on("GET /api/v1/sets", () =>
      reply(200, [
        set("3ed", "Revised Edition", "1994-04-11"),
        set("lea", "Limited Edition Alpha", "1993-08-05"),
      ]),
    );
    const picked = vi.fn();
    render(<SetCodesInfo onPick={picked} />);
    fireEvent.click(screen.getByRole("button", { name: "Edition codes" }));
    const rows = await screen.findAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "LEALimited Edition Alpha1993",
      "3EDRevised Edition1994",
    ]);
    fireEvent.click(screen.getByText("Revised Edition"));
    expect(picked).toHaveBeenCalledWith("3ED");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
