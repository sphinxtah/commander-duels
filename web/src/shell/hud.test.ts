import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client, type Me } from "../api";
import { progress } from "../alliance/fixtures";
import { hudChanged, useHud } from "./hud";

const me = { id: "u1", status: "active", alliance: null } as unknown as Me;

function answer(balance: number) {
  return vi.spyOn(client, "GET").mockImplementation((async (path: string) => {
    const response = new Response(null, { status: 200 });
    if (path === "/api/v1/me/tokens")
      return {
        data: { balance, earned: 0, given: 0, spent: 0, entries: [] },
        response,
      };
    return { data: progress(), response };
  }) as unknown as typeof client.GET);
}

afterEach(() => vi.restoreAllMocks());

describe("the top bar's tokens", () => {
  it("are asked for again when a page says they changed, without a change of page", async () => {
    // The owner's report (v0.5.0): after buying a pack the top bar kept the old total.
    answer(1000);
    const { result } = renderHook(() => useHud(me, "shop"));
    await waitFor(() => expect(result.current.balance).toBe(1000));
    const get = answer(750);
    get.mockClear();
    act(() => hudChanged());
    await waitFor(() => expect(result.current.balance).toBe(750));
    expect(get).toHaveBeenCalledWith("/api/v1/me/tokens");
  });

  it("stop listening once the shell has gone", async () => {
    answer(1000);
    const { result, unmount } = renderHook(() => useHud(me, "shop"));
    await waitFor(() => expect(result.current.balance).toBe(1000));
    unmount();
    const get = answer(750);
    get.mockClear();
    hudChanged();
    expect(get).not.toHaveBeenCalled();
  });
});
