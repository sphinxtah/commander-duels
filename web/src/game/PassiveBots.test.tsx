import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "../api";
import { reply } from "../decks/fixtures";
import { PassiveBots } from "./PassiveBots";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SysOp's passive bots", () => {
  it("switches the bots through the API and shows the server's answer", async () => {
    const put = vi
      .spyOn(client, "PUT")
      .mockResolvedValue(reply(200, { id: "g", passive_bots: true }) as never);
    const changed = vi.fn();
    render(<PassiveBots gameId="g" passive={false} onChange={changed} />);
    const toggle = screen.getByRole("switch", { name: "Passive bots" });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(put).toHaveBeenCalledWith("/api/v1/games/{game_id}/bots", {
      params: { path: { game_id: "g" } },
      body: { passive: true },
    });
    expect(changed.mock.calls[0]![0]).toMatchObject({ passive_bots: true });
  });

  it("says why when the server refuses", async () => {
    vi.spyOn(client, "PUT").mockResolvedValue(
      reply(409, {
        code: "passive_bots_unavailable",
        message:
          "Passive bots are for SysOp's own running practice game against bots alone.",
      }) as never,
    );
    render(<PassiveBots gameId="g" passive={false} onChange={() => {}} />);
    fireEvent.click(screen.getByRole("switch", { name: "Passive bots" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Passive bots are for SysOp's own",
    );
  });
});
