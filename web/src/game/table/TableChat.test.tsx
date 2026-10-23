import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OutgoingChat } from "../connection";
import type { Alliances, ChatLine } from "../types";
import {
  AllianceContext,
  alliancePills,
  type TableAlliances,
} from "./Alliance";
import type { Channel, ChatPeople } from "./chat";
import { TableChat, useChatReading, type TableChatProps } from "./TableChat";

const handles = ["ada", "bob", "cara", "dan"];
const people = (seat: number | null): ChatPeople => ({
  seat,
  userId: seat === null ? "u-sys" : null,
  handle: (s) => handles[s] ?? `Seat ${s + 1}`,
});

let lines = 0;
function line(fields: Partial<ChatLine> = {}): ChatLine {
  lines += 1;
  return {
    id: `l${lines}`,
    channel: "table",
    kind: "text",
    seat: 1,
    sender: { id: "u-bob", handle: "bob" },
    body: "Hello",
    seats: [],
    client_id: null,
    created_at: "2026-10-22T10:00:00+00:00",
    ...fields,
  };
}

function panel(
  props: Partial<TableChatProps> & {
    alliances?: Alliances;
    open?: boolean;
    mine?: number | null;
    allowed?: number[];
  } = {},
) {
  const mine = props.mine === undefined ? 0 : props.mine;
  const act = vi.fn();
  const table: TableAlliances = {
    mine,
    alliances: props.alliances ?? { alliances: [], offers: [] },
    open: new Set(props.allowed ?? []),
    handle: (s) => handles[s],
    act,
  };
  const handlers = {
    onTab: vi.fn(),
    onSend: vi.fn(),
    onEmote: vi.fn(),
    onRetry: vi.fn(),
    onDiscard: vi.fn(),
    onReport: vi.fn(),
  };
  const all: TableChatProps = {
    state: { chat: [], outbox: [], allianceRefusal: null },
    people: people(mine),
    tab: "table",
    unread: { table: 0, allies: 0 },
    open: true,
    connected: true,
    ...handlers,
    ...props,
  };
  const view = render(
    <AllianceContext.Provider value={table}>
      <TableChat {...all} />
    </AllianceContext.Provider>,
  );
  return { ...view, ...handlers, act };
}

describe("the table's chat panel", () => {
  it("shows every line as plain text, never as HTML or a link", () => {
    panel({
      state: {
        chat: [
          line({
            body: '<img src=x onerror="alert(1)"> see https://evil.example',
          }),
          line({
            kind: "emote",
            body: "good_game",
            seat: 2,
            sender: { id: "u-cara", handle: "cara" },
          }),
          line({
            seat: null,
            sender: { id: "u-sys", handle: "sphinx" },
            body: "Watching.",
          }),
          line({
            kind: "event",
            body: "allied",
            seats: [1, 0],
            seat: 0,
            sender: { id: "u-ada", handle: "ada" },
          }),
        ],
        outbox: [],
        allianceRefusal: null,
      },
    });
    const list = screen.getByRole("list", { name: "Messages to the table" });
    expect(list.querySelector("img")).toBeNull();
    expect(within(list).queryByRole("link")).toBeNull();
    expect(
      within(list).getByText(
        '<img src=x onerror="alert(1)"> see https://evil.example',
      ),
    ).toBeInTheDocument();
    const items = within(list).getAllByRole("listitem");
    // Each player's line ends in its menu's ⋯, which only the eye reads.
    expect(items.map((item) => item.textContent?.replace("⋯", ""))).toEqual([
      expect.stringMatching(/^bob: <img/),
      "cara: Good game!",
      "sphinx (watching): Watching.",
      "You and bob are now allies.",
    ]);
  });

  it("sends with Enter, starts a new line with Shift+Enter, and holds 500 characters", () => {
    const { onSend } = panel();
    const box = screen.getByRole("textbox", { name: "Message to the table" });
    expect(box).toHaveFocus();
    expect(box).toHaveAttribute("maxlength", "500");
    fireEvent.change(box, { target: { value: "  Good luck  " } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("table", "Good luck");
    expect(box).toHaveValue("");
    // Nothing to send, nothing sent.
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
    fireEvent.change(box, {
      target: { value: Array(14).fill("x").join("\n") },
    });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(
      screen.getByText("A message may have at most 13 lines."),
    ).toBeInTheDocument();
  });

  it("greys a message until it comes back, and offers Try again once it failed", () => {
    const outbox: OutgoingChat[] = [
      {
        client_id: "c1",
        kind: "text",
        channel: "table",
        body: "On its way",
        status: "pending",
        error: null,
      },
      {
        client_id: "c2",
        kind: "emote",
        channel: "table",
        body: "thanks",
        status: "failed",
        error:
          "You are sending messages very fast. Wait 3 seconds, then try again.",
      },
    ];
    const { onRetry, onDiscard } = panel({
      state: { chat: [], outbox, allianceRefusal: null },
    });
    const list = screen.getByRole("list", { name: "Messages to the table" });
    const [waiting, failed] = within(list).getAllByRole("listitem");
    expect(waiting).toHaveAttribute("data-status", "pending");
    expect(waiting).toHaveTextContent("You: On its waySending…");
    expect(failed).toHaveTextContent("You: Thanks!");
    expect(failed).toHaveTextContent("Wait 3 seconds, then try again.");
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledWith("c2");
    fireEvent.click(within(failed).getByRole("button", { name: "Discard" }));
    expect(onDiscard).toHaveBeenCalledWith("c2");
  });

  it("sends emotes to the table", () => {
    const { onEmote } = panel();
    const emotes = screen.getByRole("group", { name: "Emotes to the table" });
    expect(within(emotes).getAllByRole("button")).toHaveLength(9);
    fireEvent.click(
      within(emotes).getByRole("button", { name: "Good luck, have fun!" }),
    );
    expect(onEmote).toHaveBeenCalledWith("good_luck");
  });

  it("explains the Allies tab until there are allies, then writes to them alone", () => {
    const chat = [
      line({ channel: "allies", seats: [0], body: "Psst" }),
      line({ body: "To everyone" }),
    ];
    const { unmount, onTab } = panel({
      tab: "allies",
      state: { chat, outbox: [], allianceRefusal: null },
      unread: { table: 2, allies: 0 },
    });
    expect(screen.getByText(/You have no allies yet/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    // Lines to allies only, here; the Table tab counts its unread.
    expect(
      screen.getByRole("list", { name: "Messages to allies" }),
    ).toHaveTextContent("bob to you: Psst");
    expect(screen.queryByText("To everyone")).toBeNull();
    const tab = screen.getByRole("tab", { name: "Table 2 unread" });
    fireEvent.keyDown(tab, { key: "ArrowLeft" });
    expect(onTab).toHaveBeenCalledWith("table");
    unmount();

    const { onSend } = panel({
      tab: "allies",
      alliances: { alliances: [[0, 1]], offers: [] },
    });
    const box = screen.getByRole("textbox", { name: "Message to your allies" });
    expect(
      screen.getByText("Only bob will read it. Enter sends."),
    ).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "Attack Cara" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("allies", "Attack Cara");
  });

  it("lets SysOp watching read the allies' lines and write to the table only", () => {
    panel({
      mine: null,
      tab: "allies",
      alliances: { alliances: [[1, 2]], offers: [{ from: 3, to: 1 }] },
      state: {
        chat: [line({ channel: "allies", seats: [2], body: "Secret" })],
        outbox: [],
        allianceRefusal: null,
      },
    });
    expect(screen.getByText("Secret")).toBeInTheDocument();
    expect(screen.getByText(/You are watching/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    const list = screen.getByRole("region", { name: "Alliances" });
    expect(list).toHaveTextContent("bob and cara are allies.");
    expect(list).toHaveTextContent("dan offered bob an alliance.");
    expect(within(list).queryByRole("button")).toBeNull();
  });

  it("reports another player's line from its menu, but not your own or an event", () => {
    const theirs = line({ body: "Rude words" });
    const { onReport } = panel({
      state: {
        chat: [
          theirs,
          line({
            seat: 0,
            sender: { id: "u-ada", handle: "ada" },
            body: "Mine",
          }),
          line({ kind: "event", body: "allied", seats: [1, 2], seat: 2 }),
        ],
        outbox: [],
        allianceRefusal: null,
      },
    });
    const menus = screen.getAllByRole("button", { name: /^More for/ });
    expect(menus).toHaveLength(1);
    fireEvent.click(menus[0]);
    const menu = screen.getByRole("menu", { name: "bob’s message" });
    expect(
      within(menu).getByRole("menuitem", { name: "Report" }),
    ).toHaveFocus();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Report" }));
    expect(onReport).toHaveBeenCalledWith({
      kind: "table",
      id: theirs.id,
      sender: "bob",
      body: "Rude words",
    });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(menus[0]).toHaveFocus();
  });

  it("lists the alliances with their actions", () => {
    const { act } = panel({
      allowed: [1, 2, 3],
      alliances: {
        alliances: [[0, 1]],
        offers: [
          { from: 0, to: 2 },
          { from: 3, to: 0 },
        ],
      },
      state: {
        chat: [],
        outbox: [],
        allianceRefusal: "That player has not offered an alliance.",
      },
    });
    const list = screen.getByRole("region", { name: "Alliances" });
    expect(list).toHaveTextContent("That player has not offered an alliance.");
    expect(list).toHaveTextContent("bob is your ally.");
    expect(list).toHaveTextContent("You offered cara an alliance.");
    expect(list).toHaveTextContent("dan offers you an alliance.");
    fireEvent.click(
      within(list).getByRole("button", { name: "End the alliance with bob" }),
    );
    fireEvent.click(
      within(list).getByRole("button", { name: "Withdraw the offer to cara" }),
    );
    fireEvent.click(
      within(list).getByRole("button", {
        name: "Accept the alliance with dan",
      }),
    );
    fireEvent.click(
      within(list).getByRole("button", { name: "Decline dan’s offer" }),
    );
    expect(act.mock.calls).toEqual([
      ["end", 1],
      ["withdraw", 2],
      ["accept", 3],
      ["decline", 3],
    ]);
  });
});

describe("the team's channel at a Two-Headed Giant table (v0.5.1)", () => {
  const fixed: Alliances = {
    alliances: [
      [0, 1],
      [2, 3],
    ],
    offers: [],
    fixed: true,
  };

  it("names the Team tab, writes to the teammate alone, and offers no alliance", () => {
    const { onSend } = panel({
      tab: "allies",
      allowed: [1, 2, 3],
      alliances: fixed,
      unread: { table: 1, allies: 0 },
      state: {
        chat: [line({ channel: "allies", seats: [0], body: "Bolt the flyer" })],
        outbox: [],
        allianceRefusal: null,
      },
    });
    expect(
      screen.getByRole("tab", { name: "Team", selected: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "Messages to your team" }),
    ).toHaveTextContent("bob to you: Bolt the flyer");
    const box = screen.getByRole("textbox", { name: "Message to your team" });
    expect(
      screen.getByText("Only bob will read it. Enter sends."),
    ).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "On it" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onSend).toHaveBeenCalledWith("allies", "On it");
    // The teams stand where the alliances would: nothing to offer, accept or end.
    expect(screen.queryByRole("region", { name: "Alliances" })).toBeNull();
    const team = screen.getByRole("region", { name: "Your team" });
    expect(team).toHaveTextContent(
      "You and bob: only the two of you read the Team tab, never the other team.",
    );
    expect(screen.queryByRole("button", { name: /alliance/i })).toBeNull();
  });

  it("says nobody reads the Team tab beside a bot teammate, and shows SysOp both teams", () => {
    const { unmount } = panel({
      mine: 2,
      tab: "allies",
      alliances: { alliances: [[0, 1]], offers: [], fixed: true },
    });
    expect(
      screen.getByText("Your teammate is a bot, so nobody reads this tab."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByRole("region", { name: "Your team" })).toHaveTextContent(
      "You and a bot: nobody reads the Team tab.",
    );
    unmount();
    panel({ mine: null, tab: "allies", alliances: fixed });
    expect(
      screen.getByText(/you read every team’s messages/),
    ).toBeInTheDocument();
    const teams = screen.getByRole("region", { name: "Teams" });
    expect(teams).toHaveTextContent("ada and bob are a team.");
    expect(teams).toHaveTextContent("cara and dan are a team.");
  });

  it("puts no alliance on the plates, which name the teammate already", () => {
    const table: TableAlliances = {
      mine: 0,
      alliances: fixed,
      open: new Set([1, 2, 3]),
      handle: (s) => handles[s] ?? "",
      act: vi.fn(),
    };
    expect([0, 1, 2, 3].map((seat) => alliancePills(table, seat))).toEqual([
      [],
      [],
      [],
      [],
    ]);
  });
});

describe("reading the chat", () => {
  function reading(seat: number | null = 0) {
    const say = vi.fn();
    const hook = renderHook<
      Record<Channel, number>,
      {
        chat: ChatLine[] | null;
        reading: Channel | null;
        outbox?: OutgoingChat[];
      }
    >(
      (props) =>
        useChatReading({
          chat: props.chat,
          outbox: props.outbox ?? [],
          refusal: null,
          people: people(seat),
          reading: props.reading,
          say,
        }),
      { initialProps: { chat: null, reading: null } },
    );
    return { ...hook, say };
  }

  it("counts the other players' new lines while folded, and says them; the history and your own are read", () => {
    const { result, rerender, say } = reading();
    const history = [line(), line()];
    rerender({ chat: history, reading: null });
    expect(result.current).toEqual({ table: 0, allies: 0 });

    const theirs = line({ body: "Your turn soon" });
    const mine = line({ seat: 0, sender: { id: "u-ada", handle: "ada" } });
    const allies = line({ channel: "allies", seats: [0], body: "Psst" });
    rerender({ chat: [...history, mine], reading: null });
    expect(say).not.toHaveBeenCalled();
    rerender({ chat: [...history, mine, theirs], reading: null });
    expect(say).toHaveBeenLastCalledWith("bob: Your turn soon");
    rerender({ chat: [...history, mine, theirs, allies], reading: null });
    expect(say).toHaveBeenLastCalledWith("bob to you: Psst");
    expect(result.current).toEqual({ table: 1, allies: 1 });

    // Unfolded on the Table tab, its lines are read; the Allies tab's are not yet.
    rerender({ chat: [...history, mine, theirs, allies], reading: "table" });
    expect(result.current).toEqual({ table: 0, allies: 1 });
    rerender({ chat: [...history, mine, theirs, allies], reading: "allies" });
    expect(result.current).toEqual({ table: 0, allies: 0 });

    // Several at once (a reconnect's history) are counted, not read out.
    rerender({
      chat: [...history, mine, theirs, allies, line(), line()],
      reading: null,
    });
    expect(say).toHaveBeenLastCalledWith("2 new messages in the chat.");
    expect(result.current.table).toBe(2);
  });

  it("says once that a message was not sent", () => {
    const { rerender, say } = reading();
    const failed: OutgoingChat = {
      client_id: "c1",
      kind: "text",
      channel: "table",
      body: "Hi",
      status: "failed",
      error: "You have no allies at this table.",
    };
    rerender({ chat: [], reading: null, outbox: [failed] });
    rerender({ chat: [], reading: null, outbox: [{ ...failed }] });
    expect(say.mock.calls).toEqual([
      ["Your message was not sent. You have no allies at this table."],
    ]);
    act(() => undefined);
  });
});
