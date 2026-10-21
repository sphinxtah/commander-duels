import { fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Admin } from "../Admin";
import { client, type Me } from "../api";
import { adminProduct, player } from "./fixtures";

// The API, answered route by route; each route keeps its last answer.
type Answer = (init?: unknown) => unknown;
const queues = new Map<string, Answer[]>();
function on(route: string, ...answers: Answer[]) {
  queues.set(route, answers);
}
function reply(status: number, body?: unknown) {
  const response = new Response(null, { status });
  return response.ok ? { data: body, response } : { error: body, response };
}
function serve(method: string) {
  return (async (path: string, init?: unknown) => {
    const queue = queues.get(`${method} ${path}`);
    if (!queue?.length) throw new Error(`No answer for ${method} ${path}`);
    return (queue.length > 1 ? queue.shift()! : queue[0])(init);
  }) as never;
}

const administrator: Me = {
  ...player,
  roles: ["player", "administrator"],
  permissions: [...player.permissions, "shop.manage"],
};
const sysop: Me = {
  ...player,
  id: "sysop-id",
  kind: "sysop",
  handle: "sysop",
  roles: ["sysop"],
  permissions: [...player.permissions, "shop.manage", "economy.manage"],
};
const draft = adminProduct();
const unresolved = adminProduct({
  id: "product-znr-set",
  name: "Zendikar Rising Set Booster",
  booster: "set",
  kind: "set",
  usd: 7.94,
  selling: false,
  data_status: "unresolved",
  collation_revision: null,
  unresolved_count: 2,
  unresolved: [
    {
      sheet: "rare",
      name: "A Card From Tomorrow",
      scryfall_id: "sf-1",
      mtgjson_uuid: "u-1",
    },
  ],
});
const view = {
  enabled: true,
  products: [draft, unresolved],
  last_run: {
    id: "run-1",
    trigger: "manual",
    status: "succeeded",
    started_at: "2026-10-21T10:00:00Z",
    finished_at: "2026-10-21T10:04:00Z",
    error_code: null,
    error_message: null,
    next_attempt_at: null,
    stats: {
      ready: 380,
      unresolved: 1,
      missing: 11,
      revisions: 380,
      downloaded: ["ZNR", "FRA"],
      unchanged: 0,
      mtgjson_version: "5.3.0+20261021",
    },
  },
  next_run_at: "2026-10-26T11:00:00Z",
  prices_as_of: "2026-10-21",
};

beforeEach(() => {
  queues.clear();
  for (const method of ["GET", "POST", "PUT"] as const)
    vi.spyOn(client, method).mockImplementation(serve(method));
  on("GET /api/v1/admin/shop", () => reply(200, view));
  on("GET /api/v1/admin/shop/runs", () => reply(200, [view.last_run]));
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function openTab(me: Me) {
  render(<Admin me={me} heading={createRef()} />);
  fireEvent.click(await screen.findByRole("tab", { name: "Card shop" }));
  return screen.findByRole("table", { name: "Products and prices" });
}

describe("the card shop in Administration", () => {
  it("shows the job's runs and the price list, and queues a run", async () => {
    on("POST /api/v1/admin/shop/sync", () =>
      reply(202, { job_id: "job-1", due_at: "2026-10-21T12:00:00Z" }),
    );
    const table = await openTab(administrator);
    const runs = screen.getByRole("table", {
      name: "Recent booster data runs",
    });
    expect(
      within(runs).getByText(/380 ready · 1 unresolved · 11 without data/),
    ).toBeInTheDocument();
    expect(within(runs).getByText("4 min")).toBeInTheDocument();
    expect(within(table).getByText("$4.97")).toBeInTheDocument();
    expect(
      within(table).getByText("Cards not in the catalog (2)"),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Show"), {
      target: { value: "problems" },
    });
    expect(within(table).queryByText("On sale")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Run the booster data job now" }),
    );
    expect(
      await screen.findByText(/booster data job is queued/),
    ).toBeInTheDocument();
    // Giving packs is SysOp's alone.
    expect(screen.queryByRole("heading", { name: "Give packs" })).toBeNull();
  });

  it("changes a price and takes a product off sale, each with a reason", async () => {
    const sent: unknown[] = [];
    on("PUT /api/v1/admin/shop/products/{product_id}/price", (init) => {
      sent.push(init);
      return reply(
        200,
        adminProduct({ price: 1234, price_basis: "set", price_override: 1234 }),
      );
    });
    on("PUT /api/v1/admin/shop/products/{product_id}/sale", (init) => {
      sent.push(init);
      return reply(
        200,
        adminProduct({
          price: 1234,
          price_basis: "set",
          price_override: 1234,
          on_sale: false,
          selling: false,
        }),
      );
    });
    await openTab(administrator);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Change Zendikar Rising Draft Booster",
      }),
    );
    const editor = screen.getByRole("region", {
      name: "Zendikar Rising Draft Booster: price and sale",
    });
    fireEvent.change(within(editor).getByLabelText("Price in tokens"), {
      target: { value: "1234" },
    });
    fireEvent.click(
      within(editor).getByRole("button", { name: "Save the price" }),
    );
    expect(
      await within(editor).findByText("Give a reason of 3 to 200 characters."),
    ).toBeInTheDocument();
    fireEvent.change(
      within(editor).getByLabelText("Reason (kept in the audit trail)"),
      { target: { value: "A test price" } },
    );
    fireEvent.click(
      within(editor).getByRole("button", { name: "Save the price" }),
    );
    expect(
      await screen.findByText(/now costs 1,234 tokens \(set by staff\)/),
    ).toBeInTheDocument();
    fireEvent.change(
      within(editor).getByLabelText("Reason (kept in the audit trail)"),
      { target: { value: "Testing a stop" } },
    );
    fireEvent.click(
      within(editor).getByRole("button", { name: "Take off sale" }),
    );
    expect(await screen.findByText(/is off sale/)).toBeInTheDocument();
    expect(sent).toEqual([
      {
        params: { path: { product_id: draft.id } },
        body: { tokens: 1234, reason: "A test price" },
      },
      {
        params: { path: { product_id: draft.id } },
        body: { on_sale: false, reason: "Testing a stop" },
      },
    ]);
  });

  it("lists a product's unresolved cards", async () => {
    await openTab(administrator);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Change Zendikar Rising Set Booster",
      }),
    );
    const missing = screen.getByRole("list", {
      name: "Cards not in the catalog",
    });
    expect(missing).toHaveTextContent(
      "A Card From Tomorrow (sheet rare, Scryfall sf-1)",
    );
  });

  it("lets SysOp give packs to an account", async () => {
    let sent: unknown;
    on("GET /api/v1/admin/users", () =>
      reply(200, {
        items: [
          {
            id: "ada-id",
            handle: "ada",
            display_name: "Ada",
            email: null,
            status: "active",
            roles: ["player"],
            created_at: "2026-10-19T10:00:00Z",
            last_seen_at: null,
            wins: 0,
            tier: "bronze",
            alliance: null,
            tokens: 0,
          },
        ],
        next_cursor: null,
      }),
    );
    on("GET /api/v1/admin/audit", () =>
      reply(200, { items: [], next_cursor: null }),
    );
    on("GET /api/v1/planeswalkers", () => reply(200, []));
    on("POST /api/v1/admin/users/{user_id}/packs", (init) => {
      sent = init;
      return reply(201, { granted: 3, inventory: [] });
    });
    await openTab(sysop);
    const form = screen
      .getByRole("heading", { name: "Give packs" })
      .closest("section")!;
    fireEvent.change(
      within(form).getByLabelText("Find an account by handle or name"),
      { target: { value: "ada" } },
    );
    fireEvent.click(await within(form).findByRole("button", { name: "ada" }));
    fireEvent.change(within(form).getByLabelText("Product"), {
      target: { value: draft.id },
    });
    // The unresolved product has no collation: it cannot be given.
    expect(
      within(within(form).getByLabelText("Product")).queryByText(/Set Booster/),
    ).toBeNull();
    fireEvent.change(within(form).getByLabelText("Packs (1 to 100)"), {
      target: { value: "3" },
    });
    fireEvent.change(
      within(form).getByLabelText("Reason (kept in the audit trail)"),
      { target: { value: "Testing the shop" } },
    );
    fireEvent.click(within(form).getByRole("button", { name: "Give packs" }));
    expect(
      await within(form).findByText(
        "ada received 3 Zendikar Rising Draft Booster packs.",
      ),
    ).toBeInTheDocument();
    expect(sent).toEqual({
      params: { path: { user_id: "ada-id" } },
      body: { product: draft.id, count: 3, reason: "Testing the shop" },
    });
  });
});
