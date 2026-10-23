import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { client } from "../api";
import { dailyQuests, quest } from "../records/fixtures";
import { DailyQuests } from "./DailyQuests";
import { resetsIn } from "./quests";

afterEach(() => vi.restoreAllMocks());

async function settle() {
  await act(() => new Promise((done) => setTimeout(done, 20)));
}

function ok(data: unknown) {
  return { data, response: new Response(null, { status: 200 }) } as never;
}

describe("the words for quests (v0.5.0)", () => {
  it("say when the next day's quests come", () => {
    const now = Date.parse("2026-10-22T12:00:00Z");
    expect(resetsIn("2026-10-23T07:00:00Z", now)).toBe("in 19 h");
    expect(resetsIn("2026-10-22T12:40:00Z", now)).toBe("in 40 min");
    expect(resetsIn("2026-10-22T12:00:30Z", now)).toBe("in a minute");
  });
});

describe("today's quests on the main menu (v0.5.0)", () => {
  it("show the three, with their rewards and progress, and swap one once", async () => {
    const shown = dailyQuests({
      quests: [
        quest({ completed_at: "2026-10-22T18:00:00Z", progress: 1 }),
        quest({
          slot: 1,
          id: "win-red",
          name: "Win with a red deck",
          tokens: 150,
        }),
        quest({
          slot: 2,
          id: "win-3",
          name: "Win three games",
          tokens: 200,
          target: 3,
          progress: 2,
        }),
      ],
    });
    vi.spyOn(client, "GET").mockResolvedValue(ok(shown));
    const swapped = dailyQuests({
      can_swap: false,
      quests: [
        shown.quests[0]!,
        quest({
          slot: 1,
          id: "beat-skill-6",
          name: "Beat a skill-6 bot",
          tokens: 250,
          swapped: true,
        }),
        shown.quests[2]!,
      ],
    });
    const post = vi.spyOn(client, "POST").mockResolvedValue(ok(swapped));
    render(<DailyQuests />);
    await settle();
    const panel = screen.getByRole("region", { name: "Today's quests" });
    const items = within(panel).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent("Win a game100 tokens✓ Complete, paid");
    expect(items[2]).toHaveTextContent("Win three games200 tokens2 of 3Swap");
    expect(
      within(panel).getByRole("progressbar", {
        name: "Win three games: progress",
      }),
    ).toHaveAttribute("aria-valuenow", "2");
    // A quest done cannot be swapped.
    expect(within(items[0]!).queryByRole("button")).toBeNull();
    expect(panel).toHaveTextContent("You may swap one quest today.");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Swap “Win with a red deck” for another quest",
      }),
    );
    await settle();
    expect(post).toHaveBeenCalledWith("/api/v1/me/quests/{slot}/swap", {
      params: { path: { slot: 1 } },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Swapped: your new quest is “Beat a skill-6 bot”.",
    );
    expect(within(panel).queryByRole("button", { name: /Swap/ })).toBeNull();
    expect(panel).toHaveTextContent("0 of 1 · swapped in today");
    expect(panel).toHaveTextContent("Today's swap is used.");
  });

  it("asks the top bar again when the look paid for wins before it", async () => {
    vi.spyOn(client, "GET").mockResolvedValue(ok(dailyQuests({ paid: 225 })));
    const changed = vi.fn();
    window.addEventListener("cd:hud-changed", changed);
    render(<DailyQuests />);
    await settle();
    window.removeEventListener("cd:hud-changed", changed);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("say why when they cannot be loaded or swapped", async () => {
    vi.spyOn(client, "GET").mockResolvedValue(ok(dailyQuests()));
    vi.spyOn(client, "POST").mockResolvedValue({
      error: {
        code: "swap_used",
        message:
          "You have swapped a quest today. Tomorrow's quests bring a new swap.",
      },
      response: new Response(null, { status: 409 }),
    } as never);
    render(<DailyQuests />);
    await settle();
    fireEvent.click(
      screen.getByRole("button", { name: "Swap “Win a game” for another quest" }),
    );
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You have swapped a quest today.",
    );
  });

  it("say so when the quests could not load", async () => {
    vi.spyOn(client, "GET").mockRejectedValue(new TypeError("offline"));
    render(<DailyQuests />);
    await settle();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("stay away for an account the service gives none to", async () => {
    vi.spyOn(client, "GET").mockResolvedValue({
      error: { code: "not_signed_in", message: "Sign in to continue." },
      response: new Response(null, { status: 401 }),
    } as never);
    const { container } = render(<DailyQuests />);
    await settle();
    expect(container).toBeEmptyDOMElement();
  });
});
