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
import { deckOffer, history, opening, player, shopView } from "./fixtures";
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
    render(<ShopPage me={player} heading={createRef()} onSetup={vi.fn()} />);
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
    expect(screen.getByText(/3 of 3 products for sale/)).toBeInTheDocument();
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

  it("shows each pack's picture on the shelves, among the packs held and in the history", async () => {
    render(<ShopPage me={player} heading={createRef()} onSetup={vi.fn()} />);
    await screen.findByText("1,000");
    // Leng's counter is the owner's painting, in three sizes.
    const leng = screen.getByRole("img", { name: /Leng, an old shopkeeper/ });
    expect(leng.tagName).toBe("IMG");
    expect(leng.getAttribute("srcset")).toContain("/shop/leng-1448.webp 1448w");
    // The real pack beside its name is decorative: the item is named already.
    const picture = (item: HTMLElement) =>
      item.querySelector("[data-pack-art]");
    expect(picture(shelf("Zendikar Rising Draft Booster"))).toHaveAttribute(
      "src",
      "/packs/znr-draft-160.webp",
    );
    expect(picture(shelf("Zendikar Rising Draft Booster"))).toHaveAttribute(
      "alt",
      "",
    );
    // A product with no picture (a set after the price list) is drawn from its set.
    const drawn = picture(shelf("Reality Fracture Play Booster"));
    expect(drawn).toHaveAttribute("data-pack-art", "drawn");
    expect(drawn).toHaveTextContent("PLAY BOOSTER");
    const held = within(
      screen.getByRole("list", { name: "Unopened packs" }),
    ).getByRole("listitem", { name: "Zendikar Rising Draft Booster" });
    expect(picture(held)).toHaveAttribute("src", "/packs/znr-draft-160.webp");
    const opened = within(
      screen.getByRole("list", { name: "Packs you opened" }),
    ).getAllByRole("listitem")[0];
    expect(picture(opened)).toHaveAttribute("data-pack-art", "picture");
  });

  it("filters and sorts the shelves", async () => {
    render(<ShopPage me={player} heading={createRef()} onSetup={vi.fn()} />);
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
    render(<ShopPage me={player} heading={createRef()} onSetup={vi.fn()} />);
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

  it("shows the weekly sale at the counter, and sells its packs for less (v0.4.3)", async () => {
    const onSale = shopView.products.map((product) =>
      product.id === "product-znr-draft"
        ? { ...product, sale_price: 304 }
        : product,
    );
    on("GET /api/v1/shop", () =>
      reply(200, {
        ...shopView,
        products: onSale,
        sale: {
          percent: 20,
          starts_at: "2026-10-18T07:00:00Z",
          ends_at: "2026-10-25T07:00:00Z",
          products: ["product-znr-draft"],
        },
      }),
    );
    render(<ShopPage me={player} heading={createRef()} onSetup={vi.fn()} />);
    const sale = await screen.findByRole("region", {
      name: "This week's sale 20% off",
    });
    // The note on earning tokens is gone from the counter.
    expect(document.body.textContent).not.toMatch(/Wins earn tokens/);
    expect(within(sale).getByText(/^Until Sunday, Oct 25/)).toBeInTheDocument();
    const item = within(sale).getByRole("listitem", {
      name: "Zendikar Rising Draft Booster",
    });
    expect(item).toHaveTextContent("380 tokens 304 tokens");
    expect(
      within(shelf("Zendikar Rising Draft Booster")).getByText("Weekly sale"),
    ).toBeInTheDocument();
    expect(
      within(shelf("Reality Fracture Play Booster")).queryByText("Weekly sale"),
    ).toBeNull();
    fireEvent.click(
      within(item).getByRole("button", {
        name: "Buy Zendikar Rising Draft Booster for 304 tokens",
      }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Buy a Zendikar Rising Draft Booster?",
    });
    expect(dialog).toHaveTextContent(
      "It costs 304 tokens in this week's sale (380 tokens otherwise). You have 1,000 tokens, and will have 696 tokens left.",
    );
    expect(
      within(dialog).getByRole("button", { name: "Buy for 304 tokens" }),
    ).toBeInTheDocument();
  });

  it("opens a pack from the inventory, and shows one opened before", async () => {
    document.documentElement.dataset.reducedMotion = "true";
    on("POST /api/v1/shop/packs/{pack_id}/open", () => reply(200, opening));
    on("GET /api/v1/shop/openings/{opening_id}", () => reply(200, opening));
    render(<ShopPage me={player} heading={createRef()} onSetup={vi.fn()} />);
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

describe("Leng's starter decks (v0.4.2)", () => {
  const decks = [
    deckOffer("one", { owned: true, price: 42_000 }),
    deckOffer("two", { price: 900 }),
    deckOffer("three", { price: 94_000 }),
    deckOffer("four", { price: null }),
  ];

  it("are free until the two free ones are chosen, which the setup wizard does", async () => {
    on("GET /api/v1/shop", () =>
      reply(200, {
        ...shopView,
        decks: decks.map((deck) => ({ ...deck, owned: false, price: null })),
        free_decks: true,
      }),
    );
    const setup = vi.fn();
    render(<ShopPage me={player} heading={createRef()} onSetup={setup} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Starter decks" }));
    const shelf = screen.getByRole("list", { name: "Starter decks" });
    expect(within(shelf).getAllByText("Free")).toHaveLength(4);
    expect(within(shelf).queryByRole("button", { name: /^Buy/ })).toBeNull();
    // The commander's card is each deck's picture.
    expect(
      within(shelf)
        .getByRole("listitem", { name: "Stand-in one" })
        .querySelector("img"),
    ).toHaveAttribute(
      "src",
      "/api/v1/card-images/printings/printing-one?size=normal",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Claim your two free decks" }),
    );
    expect(setup).toHaveBeenCalledOnce();
  });

  it("then sell each of the others once, at its price in tokens", async () => {
    on("GET /api/v1/shop", () =>
      reply(200, { ...shopView, decks, free_decks: false }),
    );
    on("POST /api/v1/shop/decks", () =>
      reply(201, {
        deck: "deck-9",
        starter: "two",
        tokens: 900,
        balance: 100,
        repeated: false,
      }),
    );
    render(<ShopPage me={player} heading={createRef()} onSetup={vi.fn()} />);
    fireEvent.click(await screen.findByRole("tab", { name: "Starter decks" }));
    const item = (name: string) =>
      within(screen.getByRole("list", { name: "Starter decks" })).getByRole(
        "listitem",
        { name },
      );
    expect(item("Stand-in one")).toHaveTextContent("In your decks");
    expect(item("Stand-in four")).toHaveTextContent("Not for sale yet");
    expect(item("Stand-in three")).toHaveTextContent(
      "You need 93,000 tokens more.",
    );
    expect(
      within(item("Stand-in three")).getByRole("button", {
        name: "Buy Stand-in three",
      }),
    ).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(
      within(item("Stand-in two")).getByRole("button", {
        name: "Buy Stand-in two",
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "Buy Stand-in two?" });
    expect(dialog).toHaveTextContent(
      "It costs 900 tokens. You have 1,000 tokens, and will have 100 tokens left.",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Buy for 900 tokens" }),
    );
    expect(
      await screen.findByText(
        "You bought Stand-in two for 900 tokens. It is in your decks, and its cards in your library.",
      ),
    ).toBeInTheDocument();
    expect(client.POST).toHaveBeenCalledWith("/api/v1/shop/decks", {
      body: { deck: "two" },
    });
  });
});
