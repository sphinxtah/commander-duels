import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuspendedTable } from "../game/saves";
import { SuspendedPanel } from "./SuspendedPanel";

const api = vi.hoisted(() => ({ POST: vi.fn(), DELETE: vi.fn() }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  client: api,
}));
vi.mock("../game/sound/engine", () => ({
  getSoundEngine: () => ({ unlock: vi.fn() }),
}));

function suspended(change: Partial<SuspendedTable> = {}): SuspendedTable {
  return {
    code: "TABLECODE1234",
    format: "commander",
    host: "alice",
    you_host: false,
    save_id: "s1",
    game_id: "g1",
    saved_at: new Date(Date.now() - 3_600_000).toISOString(),
    expires_at: new Date(Date.now() + 29.5 * 86_400_000).toISOString(),
    turn: 6,
    players: [
      { seat: 0, handle: "alice", you: false, needed: true, ready: true },
      { seat: 1, handle: "bob", you: true, needed: true, ready: false },
      { seat: 2, handle: "cara", you: false, needed: false, ready: false },
    ],
    ...change,
  };
}

beforeAll(() => {
  const dialog = HTMLDialogElement.prototype;
  dialog.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  dialog.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});
beforeEach(() => {
  api.POST.mockReset();
  api.DELETE.mockReset();
});

describe("a suspended table (v1.0.0)", () => {
  it("says who is back, and gets this player ready to play on", async () => {
    const table = { code: "TABLECODE1234", status: "suspended" };
    api.POST.mockResolvedValue({ data: table });
    const onTable = vi.fn();
    render(
      <SuspendedPanel
        suspended={suspended()}
        onTable={onTable}
        onChanged={vi.fn()}
      />,
    );
    const panel = screen.getByRole("region", {
      name: "This table's game is suspended",
    });
    expect(panel).toHaveTextContent("Turn 6.");
    expect(panel).toHaveTextContent("alice is ready");
    expect(panel).toHaveTextContent("bob (you) is not here yet");
    expect(panel).toHaveTextContent(
      "cara is out of the game, and is not waited for",
    );
    expect(panel).toHaveTextContent("1 of 2 ready.");
    expect(panel).toHaveTextContent("one of the host's saved games, alice's");
    expect(panel).toHaveTextContent("A save ends when the game is upgraded");
    // A guest cannot give the game up.
    expect(
      screen.queryByRole("button", { name: "Discard the game" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ready to play on" }));
    await waitFor(() =>
      expect(api.POST).toHaveBeenCalledWith(
        "/api/v1/tables/{code}/suspension/ready",
        { params: { path: { code: "TABLECODE1234" } } },
      ),
    );
    await waitFor(() => expect(onTable).toHaveBeenCalledWith(table));
  });

  it("says why a player cannot get ready, and takes a ready back", async () => {
    api.POST.mockResolvedValue({
      error: {
        code: "game_limit",
        message:
          "Finish, save or close your running game before playing this one on.",
      },
    });
    const onChanged = vi.fn();
    const { rerender } = render(
      <SuspendedPanel
        suspended={suspended()}
        onTable={vi.fn()}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Ready to play on" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Finish, save or close your running game",
    );
    expect(onChanged).toHaveBeenCalled();

    api.DELETE.mockResolvedValue({ data: { status: "suspended" } });
    rerender(
      <SuspendedPanel
        suspended={suspended({
          players: [
            {
              seat: 0,
              handle: "alice",
              you: false,
              needed: true,
              ready: false,
            },
            { seat: 1, handle: "bob", you: true, needed: true, ready: true },
          ],
        })}
        onTable={vi.fn()}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Not ready after all" }),
    );
    await waitFor(() =>
      expect(api.DELETE).toHaveBeenCalledWith(
        "/api/v1/tables/{code}/suspension/ready",
        { params: { path: { code: "TABLECODE1234" } } },
      ),
    );
  });

  it("lets the host alone discard it, after asking", async () => {
    api.DELETE.mockResolvedValue({ data: undefined });
    const onChanged = vi.fn();
    render(
      <SuspendedPanel
        suspended={suspended({
          you_host: true,
          players: [
            { seat: 0, handle: "alice", you: true, needed: true, ready: false },
            { seat: 1, handle: "bob", you: false, needed: true, ready: false },
          ],
        })}
        onTable={vi.fn()}
        onChanged={onChanged}
      />,
    );
    expect(
      screen.getByRole("region", { name: "This table's game is suspended" }),
    ).toHaveTextContent("one of your saved games");
    fireEvent.click(screen.getByRole("button", { name: "Discard the game" }));
    const dialog = screen.getByRole("dialog", {
      name: "Discard this suspended game?",
    });
    expect(dialog).toHaveTextContent("for every player");
    expect(api.DELETE).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(api.DELETE).toHaveBeenCalledWith("/api/v1/saves/{save_id}", {
        params: { path: { save_id: "s1" } },
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
