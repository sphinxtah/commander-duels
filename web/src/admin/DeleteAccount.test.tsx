import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Admin } from "../Admin";
import { client, type AdminUser, type Me } from "../api";
import { openDialogs, reply } from "../decks/fixtures";
import { DeleteAccount } from "./DeleteAccount";

beforeAll(openDialogs);
afterEach(() => {
  vi.restoreAllMocks();
});

function account(
  handle: string | null,
  fields: Partial<AdminUser> = {},
): AdminUser {
  return {
    id: `id-${handle ?? "nobody"}`,
    handle,
    display_name: handle ? handle.toUpperCase() : "Pat Doe",
    email: `${handle ?? "pat"}@example.com`,
    created_at: "2026-10-19T10:00:00Z",
    last_seen_at: null,
    roles: ["player"],
    status: "active",
    wins: 3,
    tier: "bronze",
    alliance: null,
    tokens: 50,
    deleted_at: null,
    ...fields,
  };
}
function gone(user: AdminUser): AdminUser {
  return {
    ...user,
    handle: null,
    display_name: "Deleted player",
    email: null,
    roles: [],
    status: "deleted",
    deleted_at: "2026-10-21T12:00:00Z",
  };
}
const DELETE = "/api/v1/admin/users/{user_id}/delete";
const REASON = "Asked by email to delete it";

function fill(dialog: HTMLElement, reason: string, typed: string) {
  fireEvent.change(within(dialog).getByRole("textbox", { name: /^Reason/ }), {
    target: { value: reason },
  });
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: /^Type .* to confirm$/ }),
    { target: { value: typed } },
  );
}

describe("the delete account dialog", () => {
  it("says what goes and what stays, and deletes only once the handle is typed", async () => {
    const bob = account("bob");
    const post = vi
      .spyOn(client, "POST")
      .mockResolvedValue(reply(200, gone(bob)) as never);
    const deleted = vi.fn();
    const closed = vi.fn();
    render(<DeleteAccount user={bob} onDeleted={deleted} onClose={closed} />);
    const dialog = screen.getByRole("dialog", {
      name: "Delete bob's account?",
    });
    expect(dialog).toHaveTextContent("This cannot be undone.");
    expect(dialog).toHaveTextContent(
      "The Google sign-in and the email address.",
    );
    expect(dialog).toHaveTextContent("Kept, as “Deleted player”");
    expect(dialog).toHaveTextContent(/game results, wins, tokens/);
    const button = within(dialog).getByRole("button", {
      name: "Delete the account",
    });
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);
    expect(post).not.toHaveBeenCalled();

    // A reason alone, or a handle typed wrong, is not enough.
    fill(dialog, REASON, "bo");
    expect(button).toHaveAttribute("aria-disabled", "true");
    fill(dialog, "no", "bob");
    expect(button).toHaveAttribute("aria-disabled", "true");
    // A phone's capital letter is no mistake: handles are unique whatever their case.
    fill(dialog, REASON, "Bob ");
    expect(button).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(button);
    await waitFor(() => expect(deleted).toHaveBeenCalledWith(gone(bob)));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(DELETE, {
      params: { path: { user_id: "id-bob" } },
      body: { reason: REASON },
    });
    expect(closed).toHaveBeenCalled();
  });

  it("asks for DELETE when the account has no handle", () => {
    const post = vi.spyOn(client, "POST");
    render(
      <DeleteAccount
        user={account(null, { status: "pending" })}
        onDeleted={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", {
      name: "Delete Pat Doe's account?",
    });
    const button = within(dialog).getByRole("button", {
      name: "Delete the account",
    });
    fill(dialog, REASON, "Pat Doe");
    expect(button).toHaveAttribute("aria-disabled", "true");
    fill(dialog, REASON, "DELETE");
    expect(button).toHaveAttribute("aria-disabled", "false");
    expect(post).not.toHaveBeenCalled();
  });

  it("shows a refusal and stays open", async () => {
    const message =
      "This account is playing a game. Delete it once the game ends or its seat concedes.";
    vi.spyOn(client, "POST").mockResolvedValue(
      reply(409, { code: "account_in_game", message }) as never,
    );
    const deleted = vi.fn();
    const closed = vi.fn();
    render(
      <DeleteAccount
        user={account("bob")}
        onDeleted={deleted}
        onClose={closed}
      />,
    );
    const dialog = screen.getByRole("dialog");
    fill(dialog, REASON, "bob");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete the account" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(message);
    expect(deleted).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(dialog).toHaveProperty("open", true);
  });

  it("says so when the service cannot be reached", async () => {
    vi.spyOn(client, "POST").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    render(
      <DeleteAccount
        user={account("bob")}
        onDeleted={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    fill(dialog, REASON, "bob");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete the account" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The application service is unavailable. Try again.",
    );
  });
});

describe("deleting from the accounts list", () => {
  const administrator: Me = {
    id: "id-me",
    kind: "player",
    status: "active",
    onboarding: "complete",
    handle: "me",
    display_name: "Me",
    email: "me@example.com",
    avatar: "tower",
    locale: "en",
    csrf_token: "token",
    permissions: [
      "admin.users.read",
      "admin.users.manage",
      "admin.roles.manage",
      "admin.audit.read",
    ],
    roles: ["player", "administrator"],
    preferences: { large_text: false, reduced_motion: false },
    session: {
      id: "session-1",
      kind: "google",
      authenticated_at: "2026-10-21T10:00:00Z",
      idle_expires_at: "2026-10-22T10:00:00Z",
      absolute_expires_at: "2026-11-20T10:00:00Z",
    },
  };

  function serve(users: AdminUser[]) {
    vi.spyOn(client, "GET").mockImplementation((async (path: string) =>
      path === "/api/v1/planeswalkers"
        ? reply(200, [])
        : reply(200, { items: users, next_cursor: null })) as never);
  }

  it("offers it on the rows the viewer may change, and shows the account deleted", async () => {
    const ann = account("ann");
    const chief = account("chief", { roles: ["player", "administrator"] });
    const own = account("me", { id: "id-me" });
    const earlier = gone(account("old"));
    serve([ann, chief, own, earlier]);
    const post = vi
      .spyOn(client, "POST")
      .mockResolvedValue(reply(200, gone(ann)) as never);
    render(<Admin me={administrator} heading={createRef()} />);

    const row = await screen.findByRole("listitem", { name: "ann" });
    // Never your own account, and only SysOp's for an administrator.
    for (const name of ["chief", "me"])
      expect(
        within(screen.getByRole("listitem", { name })).queryByRole("button", {
          name: /account…$/,
        }),
      ).toBeNull();
    // A deleted account is "Deleted player", and nothing more can be done with it.
    const deletedRow = screen.getByRole("listitem", { name: "Deleted player" });
    expect(deletedRow).toHaveTextContent("DELETED");
    expect(deletedRow).toHaveTextContent(/Joined .+ · deleted .*2026/);
    expect(deletedRow).not.toHaveTextContent("@example.com");
    expect(within(deletedRow).queryAllByRole("button")).toEqual([]);
    expect(screen.getByRole("option", { name: "Deleted" })).toBeInTheDocument();

    fireEvent.click(
      within(row).getByRole("button", { name: "Delete ann's account…" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Delete ann's account?",
    });
    fill(dialog, REASON, "ann");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete the account" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "ann's account was deleted.",
      ),
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("listitem", { name: "ann" })).toBeNull();
    expect(
      screen.getAllByRole("listitem", { name: "Deleted player" }),
    ).toHaveLength(2);
  });
});
