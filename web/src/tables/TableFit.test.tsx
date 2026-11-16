import { act, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockApi, reply } from "../decks/fixtures";
import { TableFitPanel, useTableFit } from "./TableFit";

// How the table fit (v1.0.0): the one optional question on a table game's result, and who
// sees the answer (the owner's decision 25: the site's numbers only).

function Asked({ ready = true }: { ready?: boolean }) {
  const fit = useTableFit("g1", ready);
  return <TableFitPanel fit={fit} />;
}

async function settle() {
  for (let i = 0; i < 4; i++)
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

const ROUTE = "/api/v1/games/{game_id}/table-fit";

afterEach(() => vi.restoreAllMocks());

describe("how the table fit", () => {
  it("is asked in one tap, counts the answer and lets it be changed", async () => {
    const api = mockApi();
    api.on(`GET ${ROUTE}`, () =>
      reply(200, { asked: true, intent_name: "Upgraded casual", fit: null }),
    );
    api.on(
      `PUT ${ROUTE}`,
      () =>
        reply(200, {
          asked: true,
          intent_name: "Upgraded casual",
          fit: "stronger",
        }),
      () =>
        reply(200, {
          asked: true,
          intent_name: "Upgraded casual",
          fit: "as_described",
        }),
    );
    render(<Asked />);
    await settle();
    const question = within(
      screen.getByRole("group", { name: "How did the table fit?" }),
    );
    expect(
      question.getByText(/Its host described this table as/),
    ).toHaveTextContent(
      "Its host described this table as Upgraded casual. Was the game that?",
    );
    // Who sees it is said where it is asked.
    expect(
      question.getByText(
        "Optional. Only the site's numbers count it: no player and no host sees your answer, and nobody is rated.",
      ),
    ).toBeInTheDocument();
    const answers = question.getAllByRole("button");
    expect(answers.map((button) => button.textContent)).toEqual([
      "As described",
      "Stronger than described",
      "Weaker than described",
    ]);
    for (const button of answers)
      expect(button).toHaveAttribute("aria-pressed", "false");
    expect(question.queryByRole("status")).toBeNull();

    await act(async () =>
      question.getByRole("button", { name: "Stronger than described" }).click(),
    );
    await settle();
    expect(api.calls.at(-1)).toMatchObject({
      route: `PUT ${ROUTE}`,
      options: {
        params: { path: { game_id: "g1" } },
        body: { fit: "stronger" },
      },
    });
    expect(
      question.getByRole("button", { name: "Stronger than described" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(question.getByRole("status")).toHaveTextContent(
      "Counted. You can change your answer.",
    );

    await act(async () =>
      question.getByRole("button", { name: "As described" }).click(),
    );
    await settle();
    expect(
      question.getByRole("button", { name: "As described" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      question.getByRole("button", { name: "Stronger than described" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("shows the answer given before", async () => {
    const api = mockApi();
    api.on(`GET ${ROUTE}`, () =>
      reply(200, { asked: true, intent_name: "Competitive", fit: "weaker" }),
    );
    render(<Asked />);
    await settle();
    expect(
      screen.getByRole("button", { name: "Weaker than described" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("asks nothing of a game whose table described nothing", async () => {
    const api = mockApi();
    api.on(`GET ${ROUTE}`, () =>
      reply(200, { asked: false, intent_name: null, fit: null }),
    );
    render(<Asked />);
    await settle();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("does not ask the server before the game is one to ask about", async () => {
    const api = mockApi();
    render(<Asked ready={false} />);
    await settle();
    expect(api.calls).toHaveLength(0);
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("says when the answer could not be counted", async () => {
    const api = mockApi();
    api.on(`GET ${ROUTE}`, () =>
      reply(200, { asked: true, intent_name: "High power", fit: null }),
    );
    api.on(`PUT ${ROUTE}`, () =>
      reply(409, {
        code: "no_table_fit",
        message:
          "Only a finished game of a table that described itself asks how it fit.",
      }),
    );
    render(<Asked />);
    await settle();
    await act(async () =>
      screen.getByRole("button", { name: "As described" }).click(),
    );
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Only a finished game of a table that described itself asks how it fit.",
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
});
