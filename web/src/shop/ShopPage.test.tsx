import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createRef } from "react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { client } from "../api";
import { history, opening, player, shopView } from "./fixtures";
import { ShopPage } from "./ShopPage";

vi.mock("../game/sound/engine", () => ({
  getSoundEngine: () => ({
    unlock: vi.fn(),
    play: vi.fn(),
    setVolume: vi.fn(),
    setMuted: vi.fn(),
  }),
}));

// The API, answered route by route; each route keeps its last answer.
type Answer = () => unknown;
const queues = new Map<string, Answer[]>();
function on(route: string, ...answers: Answer[]) {
  queues.set(route, answers);
}
function reply(status: number, body?: unknown) {
  const response = new Response(null, { status });
  return response.ok ? { data: body, response } : { error: body, response };
}
function serve(method: string) {
  return (async (path: string) => {
    const queue = queues.get(`${method} ${path}`);
    if (!queue?.length) throw new Error(`No answer for ${method} ${path}`);
    return (queue.length > 1 ? queue.shift()! : queue[0])();
  }) as never;
}

beforeAll(() => {
  const dialog = HTMLDialogElement.prototype;
  dialog.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  dialog.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});
beforeEach(() => {
  queues.clear();
  for (const method of ["GET", "POST"] as const)
    vi.spyOn(client, method).mockImplementation(serve(method));
  on("GET /api/v1/shop", () => reply(200, shopView));
  on("GET /api/v1/shop/openings", () => reply(200, history));
});
afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset.reducedMotion;
});

function shelf(name: string) {
  return within(
    screen.getByRole("region", { name: "On the shelves" }),
  ).getByRole("listitem", { name });
}

describe("Leng's card shop", () => {
  it("shows the balance, the packs held, the shelves by era and where the data comes from", async () => {
    render(<ShopPage me={player} heading={createRef()} />);
    expect(
      await screen.findByRole("heading", { name: "Leng's card shop" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("1,000")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /Leng, an old shopkeeper/ }),
    ).toBeInTheDocument();
    const packs = screen.getByRole("list", { name: "Unopened packs" });
    expect(within(packs).getByText(/× 2/)).toBeInTheDocument();
    for (const era of [
      "Play Boosters",
      "Set and Collector Boosters",
      "The first years",
    ])
      expect(screen.getByRole("region", { name: era })).toBeInTheDocument();
    expect(
      within(shelf("Reality Fracture Play Booster")).getByText("500 tokens"),
    ).toBeInTheDocument();
    expect(screen.getByText(/3 of 3 products on sale/)).toBeInTheDocument();
    expect(screen.getByText(/version 5\.3\.0\+20261021/)).toBeInTheDocument();
    expect(screen.getByText(/read on Oct 21, 2026/)).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "Packs you opened" })).getByText(
        /15 cards · 9 new · best: Mythic rare/,
      ),
    ).toBeInTheDocument();
    // Prices are tokens only.
    expect(document.body.textContent).not.toMatch(/\$|USD|dollar/);
  });

  it("filters and sorts the shelves", async () => {
    render(<ShopPage me={player} heading={createRef()} />);
    await screen.findByText("1,000");
    fireEvent.change(screen.getByLabelText("Search by set name or code"), {
      target: { value: "znr" },
    });
    expect(screen.getByText(/1 of 3 products/)).toBeInTheDocument();
    expect(shelf("Zendikar Rising Draft Booster")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search by set name or code"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("Year"), {
      target: { value: "1994" },
    });
    expect(screen.getByText(/1 of 3 products/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Booster type"), {
      target: { value: "play" },
    });
    expect(screen.getByText(/1 of 3 products/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Booster type"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("Sort"), {
      target: { value: "cheapest" },
    });
    // By price, the shelves are one list, cheapest first.
    const region = screen.getByRole("region", { name: "Every product" });
    expect(
      within(region)
        .getAllByRole("listitem")
        .map((item) => item.getAttribute("aria-label")),
    ).toEqual([
      "Zendikar Rising Draft Booster",
      "Reality Fracture Play Booster",
      "Revised Edition Booster Pack",
    ]);
  });

  it("buys a pack after a confirmation, retrying with the same key", async () => {
    let posted: { product: string; key: string }[] = [];
    vi.mocked(client.POST).mockImplementation((async (
      path: string,
      init: { body: { product: string; key: string } },
    ) => {
      if (path !== "/api/v1/shop/purchases") throw new Error(path);
      posted = [...posted, init.body];
      return posted.length === 1
        ? reply(503, {
            code: "service_unavailable",
            message: "The application service is unavailable. Try again.",
          })
        : reply(201, {
            pack: "pack-9",
            product: shopView.inventory[0].product,
            tokens: 380,
            balance: 620,
            repeated: false,
          });
    }) as never);
    render(<ShopPage me={player} heading={createRef()} />);
    await screen.findByText("1,000");
    // Revised costs more than the balance: its button says why it waits.
    const revised = shelf("Revised Edition Booster Pack");
    expect(
      within(revised).getByRole("button", {
        name: "Buy Revised Edition Booster Pack",
      }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      within(revised).getByText("You need 149,000 tokens more."),
    ).toBeInTheDocument();
    fireEvent.click(
      within(shelf("Zendikar Rising Draft Booster")).getByRole("button", {
        name: "Buy Zendikar Rising Draft Booster",
      }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Buy a Zendikar Rising Draft Booster?",
    });
    expect(dialog).toHaveTextContent(
      "It costs 380 tokens. You have 1,000 tokens, and will have 620 tokens left.",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Buy for 380 tokens" }),
    );
    expect(
      await within(dialog).findByText(
        "The application service is unavailable. Try again.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText(
        /You bought a Zendikar Rising Draft Booster for 380 tokens/,
      ),
    ).toBeInTheDocument();
    expect(posted).toHaveLength(2);
    expect(posted[0].key).toMatch(/^[0-9a-f]{32}$/);
    expect(posted[1]).toEqual(posted[0]);
    expect(posted[0].product).toBe("product-znr-draft");
  });

  it("opens a pack from the inventory, and shows one opened before", async () => {
    document.documentElement.dataset.reducedMotion = "true";
    on("POST /api/v1/shop/packs/{pack_id}/open", () => reply(200, opening));
    on("GET /api/v1/shop/openings/{opening_id}", () => reply(200, opening));
    render(<ShopPage me={player} heading={createRef()} />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open a pack of Zendikar Rising Draft Booster",
      }),
    );
    expect(
      await screen.findByRole("button", {
        name: "Tear open the Zendikar Rising Draft Booster",
      }),
    ).toBeInTheDocument();
    expect(client.POST).toHaveBeenCalledWith(
      "/api/v1/shop/packs/{pack_id}/open",
      { params: { path: { pack_id: "pack-1" } } },
    );
    // With reduced motion every step is immediate: through to the summary and back.
    fireEvent.click(screen.getByRole("button", { name: /Tear open the/ }));
    fireEvent.click(screen.getByRole("button", { name: "Reveal all" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to the shop" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /See its cards/ }),
    );
    expect(
      await screen.findByRole("list", { name: "Cards in the pack" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(client.GET).toHaveBeenCalledWith(
        "/api/v1/shop/openings/{opening_id}",
        { params: { path: { opening_id: "opening-0" } } },
      ),
    );
  });
});
