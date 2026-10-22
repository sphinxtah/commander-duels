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
import { client, type AccountReset, type AdminUser, type Me } from "../api";
import { openDialogs, reply } from "../decks/fixtures";
import { ResetAccount, resetWords } from "./ResetAccount";

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
    wins: 15,
    tier: "silver",
    alliance: "ajani",
    tokens: 2340,
    deleted_at: null,
    ...fields,
  };
}
function reset(user: AdminUser): AccountReset {
  return {
    account: {
      ...user,
      handle: null,
      wins: 0,
      tier: "bronze",
      alliance: null,
      tokens: 1000,
    },
    decks: 3,
    cards: 212,
    packs: 1,
    wins: user.wins,
    tokens: user.tokens,
  };
}
const RESET = "/api/v1/admin/users/{user_id}/reset";

function type(dialog: HTMLElement, typed: string) {
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: /^Type .* to confirm$/ }),
    { target: { value: typed } },
  );
}

describe("the reset account dialog", () => {
  it("says what is cleared and what stays, and resets only once the handle is typed", async () => {
    const bob = account("bob");
    const post = vi
      .spyOn(client, "POST")
      .mockResolvedValue(reply(200, reset(bob)) as never);
    const done = vi.fn();
    const closed = vi.fn();
    render(<ResetAccount user={bob} onReset={done} onClose={closed} />);
    const dialog = screen.getByRole("dialog", {
      name: "Reset bob's account?",
    });
    expect(dialog).toHaveTextContent("This cannot be undone.");
    expect(dialog).toHaveTextContent(/setup wizard welcomes the player/);
    expect(dialog).toHaveTextContent(/The handle, which anyone may then take/);
    expect(dialog).toHaveTextContent(/Its decks go to the trash/);
    expect(dialog).toHaveTextContent(/Friends, requests and blocks/);
    const button = within(dialog).getByRole("button", {
      name: "Reset the account",
    });
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);
    expect(post).not.toHaveBeenCalled();

    type(dialog, "bo");
    expect(button).toHaveAttribute("aria-disabled", "true");
    // Handles are unique whatever their case, so a phone's capital letter is no mistake.
    type(dialog, "Bob ");
    expect(button).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(button);
    await waitFor(() => expect(done).toHaveBeenCalledWith(reset(bob)));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(RESET, {
      params: { path: { user_id: "id-bob" } },
    });
    expect(closed).toHaveBeenCalled();
  });

  it("asks for RESET when the account has no handle", () => {
    render(
      <ResetAccount user={account(null)} onReset={vi.fn()} onClose={vi.fn()} />,
    );
    const dialog = screen.getByRole("dialog", {
      name: "Reset Pat Doe's account?",
    });
    const button = within(dialog).getByRole("button", {
      name: "Reset the account",
    });
    type(dialog, "Pat Doe");
    expect(button).toHaveAttribute("aria-disabled", "true");
    type(dialog, "reset");
    expect(button).toHaveAttribute("aria-disabled", "false");
  });

  it("shows a refusal and stays open", async () => {
    const message =
      "This account is seated at an open table. Reset it once it leaves the table, or the table starts or closes.";
    vi.spyOn(client, "POST").mockResolvedValue(
      reply(409, { code: "account_at_table", message }) as never,
    );
    const done = vi.fn();
    const closed = vi.fn();
    render(
      <ResetAccount user={account("bob")} onReset={done} onClose={closed} />,
    );
    const dialog = screen.getByRole("dialog");
    type(dialog, "bob");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reset the account" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(message);
    expect(done).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(dialog).toHaveProperty("open", true);
  });

  it("says so when the service cannot be reached", async () => {
    vi.spyOn(client, "POST").mockRejectedValue(
      new TypeError("Failed to fetch"),
    );
    render(
      <ResetAccount
        user={account("bob")}
        onReset={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    type(dialog, "bob");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reset the account" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "The application service is unavailable. Try again.",
    );
  });

  it("words the result by its counts", () => {
    expect(resetWords("bob", reset(account("bob")))).toBe(
      "bob's account is new again: 3 decks moved to the trash, 212 cards and 1 unopened pack cleared, 15 wins set back to 0 and 2,340 tokens to 1,000.",
    );
  });
});

describe("resetting from the accounts list", () => {
  const sysop: Me = {
    id: "id-sysop",
    kind: "sysop",
    status: "active",
    onboarding: "complete",
    handle: "sysop",
    display_name: "SysOp",
    email: null,
    avatar: "tower",
    locale: "en",
    csrf_token: "token",
    permissions: [
      "admin.users.read",
      "admin.users.manage",
      "admin.roles.manage",
      "admin.roles.administrator",
      "admin.audit.read",
      "admin.users.reset",
    ],
    roles: ["sysop"],
    preferences: { large_text: false, reduced_motion: false },
    session: {
      id: "session-1",
      kind: "sysop",
      authenticated_at: "2026-10-22T10:00:00Z",
      idle_expires_at: "2026-10-22T11:00:00Z",
      absolute_expires_at: "2026-10-22T22:00:00Z",
    },
  };

  function serve(users: AdminUser[]) {
    vi.spyOn(client, "GET").mockImplementation((async (path: string) =>
      path === "/api/v1/planeswalkers"
        ? reply(200, [])
        : reply(200, { items: users, next_cursor: null })) as never);
  }

  it("is SysOp's alone, and shows the account new again", async () => {
    const ann = account("ann");
    const chief = account("chief", { roles: ["player", "administrator"] });
    const earlier = account(null, {
      id: "id-old",
      display_name: "Deleted player",
      status: "deleted",
      deleted_at: "2026-10-21T12:00:00Z",
    });
    serve([ann, chief, earlier]);
    const post = vi
      .spyOn(client, "POST")
      .mockResolvedValue(reply(200, reset(ann)) as never);
    const { unmount } = render(<Admin me={sysop} heading={createRef()} />);

    const row = await screen.findByRole("listitem", { name: "ann" });
    // SysOp may reset an administrator's account too; a deleted one, never.
    expect(
      within(screen.getByRole("listitem", { name: "chief" })).getByRole(
        "button",
        { name: "Reset chief's account…" },
      ),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole("listitem", { name: "Deleted player" }),
      ).queryAllByRole("button"),
    ).toEqual([]);

    fireEvent.click(
      within(row).getByRole("button", { name: "Reset ann's account…" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Reset ann's account?" });
    type(dialog, "ann");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reset the account" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "ann's account is new again: 3 decks moved to the trash",
      ),
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    // The row shows the account as a new one: no handle, 0 wins, 1,000 tokens, no alliance.
    const fresh = screen.getByRole("listitem", { name: "ANN" });
    expect(fresh).toHaveTextContent("No handle yet");
    expect(fresh).toHaveTextContent(/Wins\s*0/);
    expect(fresh).toHaveTextContent(/Tokens\s*1,000/);
    expect(fresh).toHaveTextContent(/Alliance\s*None/);
    unmount();

    // An administrator, who has every other account permission, is not offered it.
    serve([ann]);
    render(
      <Admin
        me={{
          ...sysop,
          kind: "player",
          roles: ["player", "administrator"],
          permissions: sysop.permissions.filter(
            (permission) =>
              permission !== "admin.users.reset" &&
              permission !== "admin.roles.administrator",
          ),
        }}
        heading={createRef()}
      />,
    );
    const theirs = await screen.findByRole("listitem", { name: "ann" });
    expect(
      within(theirs).getByRole("button", { name: "Delete ann's account…" }),
    ).toBeInTheDocument();
    expect(
      within(theirs).queryByRole("button", { name: /^Reset / }),
    ).toBeNull();
  });
});
