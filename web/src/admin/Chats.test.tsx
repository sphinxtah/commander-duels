import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Admin } from "../Admin";
import { client, type Me, type ReportDetail, type ReportSummary } from "../api";
import { reply } from "../decks/fixtures";
import type { components } from "../generated/api";
import { ChatLines, type ChatLine } from "./ChatLines";

// A reported message's excerpt in Reports, and SysOp's reader of chats (v0.4.4).

type ReaderChat = components["schemas"]["ReaderChat"];
type ReaderTranscript = components["schemas"]["ReaderTranscript"];

// The API, answered route by route, as in Admin.test.tsx. Each route takes its answers in order
// and keeps the last.
type Answer = () => unknown;
const queues = new Map<string, Answer[]>();
let calls: string[] = [];
function on(route: string, ...answers: Answer[]) {
  queues.set(route, answers);
}
function serve(method: string) {
  return (async (path: string) => {
    const route = `${method} ${path}`;
    calls.push(route);
    const queue = queues.get(route);
    if (!queue?.length) throw new Error(`No answer for ${route}`);
    return (queue.length > 1 ? queue.shift()! : queue[0])();
  }) as never;
}
/** What each request of the route asked for: its parameters, in order. */
function asked(route: string) {
  const sent = vi.mocked(client.GET).mock.calls as unknown as [
    string,
    { params?: object } | undefined,
  ][];
  return sent
    .filter(([path]) => `GET ${path}` === route)
    .map(([, init]) => init?.params);
}

const USERS = "GET /api/v1/admin/users";
const REPORTS = "GET /api/v1/admin/reports";
const DETAIL = "GET /api/v1/admin/reports/{report_id}";
const STATUS = "POST /api/v1/admin/reports/{report_id}/status";
const CHATS = "GET /api/v1/admin/chats";
const CONVERSATION = "GET /api/v1/admin/chats/conversations/{conversation_id}";
const TABLE = "GET /api/v1/admin/chats/games/{game_id}";
const PLAYERS = "GET /api/v1/players";

const GAME = "8f14e45f-ceea-467f-a0e6-9d8b2c0e5f6a";
const CONVERSATION_ID = "0c0c0c0c-1111-4000-8000-000000000001";
const ada = { id: "00000000-0000-4000-8000-00000000000a", handle: "ada" };
const bob = { id: "00000000-0000-4000-8000-00000000000b", handle: "bob" };
const cyd = { id: "00000000-0000-4000-8000-00000000000c", handle: "cyd" };
const sysop: Me = {
  id: "00000000-0000-4000-8000-000000000001",
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
    "admin.audit.read",
    "reports.manage",
    "chat.read_all",
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
// An administrator reads reported messages, never the chats themselves.
const administrator: Me = {
  ...sysop,
  kind: "player",
  permissions: sysop.permissions.filter(
    (permission) => permission !== "chat.read_all",
  ),
  roles: ["player", "administrator"],
};

function line(id: string, fields: Partial<ChatLine>): ChatLine {
  return {
    id,
    channel: "table",
    kind: "text",
    sender: ada,
    seats: [0],
    body: "",
    created_at: "2026-10-22T10:00:00Z",
    reported: false,
    ...fields,
  };
}
// What a page would make of it, were it read as HTML.
const markup = '<img src="x" onerror="alert(1)"><b>bold</b>';
const tableLines: ChatLine[] = [
  line("l1", { body: "Good luck all" }),
  line("l2", { kind: "event", body: "allied", sender: bob, seats: [0, 1] }),
  line("l3", { kind: "emote", body: "good_game", sender: bob, seats: [1] }),
  line("l4", { channel: "allies", body: "Watch seat 2", seats: [0, 1] }),
  line("l5", {
    kind: "event",
    body: "alliance_ended",
    sender: null,
    seats: [0, 1],
  }),
  line("l6", { body: "Who am I?", sender: { id: null, handle: null } }),
  line("l7", {
    channel: "allies",
    body: markup,
    sender: bob,
    seats: [1, 0, 2],
    reported: true,
  }),
];

beforeEach(() => {
  calls = [];
  queues.clear();
  for (const method of ["GET", "POST", "PUT", "DELETE"] as const)
    vi.spyOn(client, method).mockImplementation(serve(method));
  on("GET /api/v1/planeswalkers", () => reply(200, []));
  on(USERS, () => reply(200, { items: [], next_cursor: null }));
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a chat's lines", () => {
  it("say who, where and when; emotes and alliances in words; the reported one marked", () => {
    render(<ChatLines lines={tableLines} label="Excerpt" />);
    const excerpt = screen.getByRole("list", { name: "Excerpt" });
    const [said, allied, emote, allies, ended, unknown, reported] =
      within(excerpt).getAllByRole("listitem");
    expect(said).toHaveTextContent("ada");
    expect(said).toHaveTextContent("seat 0 · To the table");
    expect(said).toHaveTextContent("Good luck all");
    expect(
      within(said).getByText(/2026/, { selector: "time" }),
    ).toHaveAttribute("datetime", "2026-10-22T10:00:00Z");
    expect(allied).toHaveTextContent("bob");
    expect(allied).toHaveTextContent("Seats 0 and 1 became allies.");
    expect(emote).toHaveTextContent("Good game!");
    expect(emote).not.toHaveTextContent("good_game");
    expect(allies).toHaveTextContent("Allies only, to seat 1");
    // Leaving the game ended it: no one sent it.
    expect(ended).toHaveTextContent("The game");
    expect(ended).toHaveTextContent(
      "The alliance between seats 0 and 1 ended.",
    );
    expect(unknown).toHaveTextContent("Unknown account");
    expect(reported).toHaveTextContent("Allies only, to seats 0 and 2");

    // Only the reported line is marked, in words as well as in colour.
    expect(
      within(excerpt)
        .getAllByRole("listitem")
        .filter((item) => item.hasAttribute("data-reported")),
    ).toEqual([reported]);
    expect(within(reported).getByText("Reported")).toBeInTheDocument();
    expect(within(excerpt).getAllByText("Reported")).toHaveLength(1);

    // Text, never HTML.
    expect(reported).toHaveTextContent(markup);
    expect(excerpt.querySelector("img, b")).toBeNull();
  });

  it("name a friend's message as one, with no seat", () => {
    render(
      <ChatLines
        lines={[
          line("d1", { channel: "direct", seats: [], body: "Hi Bob" }),
          line("d2", {
            channel: "direct",
            seats: [],
            sender: null,
            body: "Hi",
          }),
        ]}
        label="Conversation"
      />,
    );
    const [first, second] = within(
      screen.getByRole("list", { name: "Conversation" }),
    ).getAllByRole("listitem");
    expect(first).toHaveTextContent("ada");
    expect(first).toHaveTextContent("Friend's message");
    expect(first).not.toHaveTextContent("seat");
    expect(second).toHaveTextContent("Unknown account");
  });
});

describe("a report of a message", () => {
  const summary: ReportSummary = {
    id: "r1",
    created_at: "2026-10-22T12:00:00Z",
    status: "seen",
    summary: "Rude at the table",
    reporter: { id: ada.id, handle: "ada", display_name: "Ada" },
    page: `#game/${GAME}`,
    app_version: "0.4.4",
    game_id: GAME,
    game_turn: 3,
    screenshot: false,
    reported_user: bob,
  };
  const detail: ReportDetail = {
    ...summary,
    description: "Bob was rude.",
    api_version: "0.4.4",
    user_agent: null,
    viewport_width: 1366,
    viewport_height: 768,
    pixel_ratio: 1,
    requests: [],
    screenshot_width: null,
    screenshot_height: null,
    status_changed_at: null,
    status_changed_by: null,
    chat: {
      kind: "table",
      game_id: GAME,
      reported_user: bob,
      lines: tableLines,
    },
  };

  it("is marked in the list, and opened shows the excerpt with who sent it", async () => {
    on(REPORTS, () =>
      reply(200, {
        items: [
          summary,
          { ...summary, id: "r2", summary: "Board froze", reported_user: null },
        ],
        next_cursor: null,
      }),
    );
    on(DETAIL, () => reply(200, detail));
    render(<Admin me={administrator} heading={createRef()} />);
    fireEvent.click(screen.getByRole("tab", { name: /Reports/ }));
    const item = await screen.findByRole("listitem", {
      name: "Rude at the table",
    });
    expect(item).toHaveTextContent("Message from bob");
    expect(
      screen.getByRole("listitem", { name: "Board froze" }),
    ).not.toHaveTextContent("Message from");

    fireEvent.click(
      within(item).getByRole("button", { name: "Open “Rude at the table”" }),
    );
    expect(
      await within(item).findByRole("heading", { name: "Reported message" }),
    ).toBeInTheDocument();
    // A seen report is not set seen again.
    expect(calls).not.toContain(STATUS);
    expect(item).toHaveTextContent("Sent bybob");
    expect(item).toHaveTextContent(bob.id);
    expect(item).toHaveTextContent("A table's chat");
    expect(item).toHaveTextContent(`Game${GAME}`);
    const excerpt = within(item).getByRole("list", {
      name: "The reported message and the messages before it",
    });
    const lines = within(excerpt).getAllByRole("listitem");
    expect(lines).toHaveLength(7);
    expect(lines.at(-1)).toHaveAttribute("data-reported", "true");
    expect(lines.at(-1)).toHaveTextContent(markup);
    expect(excerpt.querySelector("img, b")).toBeNull();
  });

  it("from a friend says so, with no game", async () => {
    on(REPORTS, () =>
      reply(200, {
        items: [{ ...summary, game_id: null, game_turn: null }],
        next_cursor: null,
      }),
    );
    on(DETAIL, () =>
      reply(200, {
        ...detail,
        game_id: null,
        game_turn: null,
        chat: {
          kind: "direct",
          game_id: null,
          reported_user: bob,
          lines: [
            line("d1", { channel: "direct", seats: [], body: "Hi Bob" }),
            line("d2", {
              channel: "direct",
              seats: [],
              sender: bob,
              body: "Go away",
              reported: true,
            }),
          ],
        },
      }),
    );
    render(<Admin me={administrator} heading={createRef()} />);
    fireEvent.click(screen.getByRole("tab", { name: /Reports/ }));
    const item = await screen.findByRole("listitem", {
      name: "Rude at the table",
    });
    fireEvent.click(within(item).getByRole("button", { name: /^Open/ }));
    const excerpt = await within(item).findByRole("list", {
      name: "The reported message and the messages before it",
    });
    expect(item).toHaveTextContent("A friend's message");
    expect(item).not.toHaveTextContent("Game");
    expect(within(excerpt).getAllByRole("listitem")[1]).toHaveTextContent(
      "bobFriend's message",
    );
  });
});

describe("SysOp's reader of chats", () => {
  function ref(player: { id: string; handle: string }) {
    return { ...player, avatar: "sigil" as const, alliance: null };
  }
  const conversation: ReaderChat = {
    kind: "direct",
    id: CONVERSATION_ID,
    players: [ref(ada), ref(bob)],
    messages: 3,
    last_message_at: "2026-10-22T11:00:00Z",
  };
  const table: ReaderChat = {
    kind: "table",
    id: GAME,
    players: [ref(ada), ref(bob), ref(cyd)],
    messages: 12,
    last_message_at: "2026-10-22T10:00:00Z",
  };
  const conversationLines: ReaderTranscript = {
    kind: "direct",
    id: CONVERSATION_ID,
    players: [ref(ada), ref(bob)],
    lines: [
      line("d1", { channel: "direct", seats: [], body: "Hi Bob" }),
      line("d2", { channel: "direct", seats: [], sender: bob, body: markup }),
    ],
  };
  const tableLinesRead: ReaderTranscript = {
    kind: "table",
    id: GAME,
    players: [ref(ada), ref(bob), ref(cyd)],
    lines: tableLines.map((each) => ({ ...each, reported: false })),
  };

  it("is a tab only for an account with chat.read_all", async () => {
    const { unmount } = render(
      <Admin me={administrator} heading={createRef()} />,
    );
    expect(screen.queryByRole("tab", { name: "Chats" })).toBeNull();
    expect(calls).not.toContain(CHATS);
    unmount();
    // chat.read_all alone opens Administration on it.
    on(CHATS, () => reply(200, { chats: [] }));
    render(
      <Admin
        me={{ ...sysop, permissions: ["chat.read_all"] }}
        heading={createRef()}
      />,
    );
    expect(screen.getByRole("tab", { name: "Chats" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(await screen.findByText("No chats yet.")).toBeInTheDocument();
  });

  it("lists the latest chats, and fetches one only when it is opened", async () => {
    on(CHATS, () => reply(200, { chats: [conversation, table] }));
    on(CONVERSATION, () => reply(200, conversationLines));
    on(TABLE, () => reply(200, tableLinesRead));
    render(<Admin me={sysop} heading={createRef()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    expect(
      screen.getByText("Opening a chat is recorded in the audit trail."),
    ).toBeInTheDocument();
    const friends = await screen.findByRole("listitem", {
      name: "Conversation between ada and bob",
    });
    expect(friends).toHaveTextContent("CONVERSATION");
    expect(friends).toHaveTextContent("3 messages");
    const game = screen.getByRole("listitem", {
      name: "Table chat of game 8f14e45f",
    });
    expect(game).toHaveTextContent("ada, bob and cyd");
    expect(game).toHaveTextContent("TABLE");
    expect(game).toHaveTextContent("12 messages");
    expect(asked(CHATS)).toEqual([{ query: { player_id: undefined } }]);
    // Listing reads no message.
    expect(calls).not.toContain(CONVERSATION);
    expect(calls).not.toContain(TABLE);

    fireEvent.click(
      within(friends).getByRole("button", {
        name: "Open the conversation between ada and bob",
      }),
    );
    const read = await within(friends).findByRole("list", {
      name: "Messages of the conversation between ada and bob",
    });
    expect(asked(CONVERSATION)).toEqual([
      { path: { conversation_id: CONVERSATION_ID } },
    ]);
    expect(calls).not.toContain(TABLE);
    const [hello, rude] = within(read).getAllByRole("listitem");
    expect(hello).toHaveTextContent("Hi Bob");
    expect(rude).toHaveTextContent(markup);
    expect(read.querySelector("img, b")).toBeNull();
    expect(within(read).queryByText("Reported")).toBeNull();

    fireEvent.click(
      within(game).getByRole("button", {
        name: "Open the table chat of game 8f14e45f",
      }),
    );
    const tableRead = await within(game).findByRole("list", {
      name: "Messages of the table chat of game 8f14e45f",
    });
    expect(asked(TABLE)).toEqual([{ path: { game_id: GAME } }]);
    // Allies-only lines too, with whom they went to.
    expect(tableRead).toHaveTextContent("Allies only, to seats 0 and 2");
    // One open at a time: the conversation closed, and nothing more was asked for.
    expect(within(friends).queryByRole("list")).toBeNull();
    fireEvent.click(
      within(game).getByRole("button", {
        name: "Close the table chat of game 8f14e45f",
      }),
    );
    expect(within(game).queryByRole("list")).toBeNull();
    expect(calls.filter((call) => call === CONVERSATION)).toHaveLength(1);
    expect(calls.filter((call) => call === TABLE)).toHaveLength(1);
  });

  it("shows one player's chats, found by handle", async () => {
    on(CHATS, () => reply(200, { chats: [conversation, table] }));
    on(PLAYERS, () =>
      reply(200, {
        by_email: false,
        players: [{ ...ref(ada), friendship: "none", presence: null }],
      }),
    );
    render(<Admin me={sysop} heading={createRef()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    await screen.findByRole("listitem", {
      name: "Conversation between ada and bob",
    });
    fireEvent.change(screen.getByLabelText("Find a player's chats by handle"), {
      target: { value: " ad " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Show ada's chats" }),
    );
    expect(asked(PLAYERS)).toEqual([{ query: { q: "ad" } }]);
    await waitFor(() =>
      expect(asked(CHATS).at(-1)).toEqual({ query: { player_id: ada.id } }),
    );
    expect(screen.getByText("Showing ada's chats.")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Show everyone's chats" }),
    );
    await waitFor(() =>
      expect(asked(CHATS).at(-1)).toEqual({ query: { player_id: undefined } }),
    );
    expect(calls).not.toContain(CONVERSATION);
    expect(calls).not.toContain(TABLE);
  });
});
