import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { client, forgetRequests, recordRequest } from "../api";
import { ReportButton, ReportDialog } from "./ReportProblem";
import {
  ScreenshotError,
  SMALL_BYTES,
  prepareScreenshot,
  type Screenshot,
} from "./screenshot";

// The canvas work is screenshot.test.ts's; here the prepared image is handed over as it would be.
vi.mock("./screenshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./screenshot")>()),
  prepareScreenshot: vi.fn(),
}));

beforeAll(() => {
  // jsdom has no modal dialogs: open and close, and the close event the dialog listens for.
  const dialog = HTMLDialogElement.prototype;
  dialog.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  dialog.close = function (this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

type Answer = { data?: unknown; error?: unknown; response: Response };
let posts: { path: string; body: Record<string, unknown> }[] = [];
let answers: Answer[] = [];
function answer(status: number, body?: unknown, headers?: HeadersInit) {
  const response = new Response(null, { status, headers });
  return response.ok ? { data: body, response } : { error: body, response };
}
const receipt = {
  id: "r1",
  created_at: "2026-10-21T12:00:00Z",
  screenshot: false,
};

beforeEach(() => {
  posts = [];
  answers = [];
  vi.spyOn(client, "POST").mockImplementation((async (
    path: string,
    init: { body: Record<string, unknown> },
  ) => {
    posts.push({ path, body: init.body });
    return answers.length > 1 ? answers.shift()! : answers[0]!;
  }) as never);
  vi.mocked(prepareScreenshot).mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
  forgetRequests();
});

function shot(fields: Partial<Screenshot> = {}): Screenshot {
  return {
    dataUrl: "data:image/png;base64,AAAA",
    type: "image/png",
    size: 1024,
    width: 64,
    height: 48,
    ...fields,
  };
}
function png(name = "shot.png") {
  return new File([new Uint8Array(8)], name, { type: "image/png" });
}
function dialog() {
  return screen.getByRole("dialog", { hidden: true });
}
function write(summary = "The board froze", description = "I passed.") {
  fireEvent.change(screen.getByLabelText("Summary"), {
    target: { value: summary },
  });
  fireEvent.change(
    screen.getByLabelText("What happened? What did you expect?"),
    { target: { value: description } },
  );
}
async function send() {
  fireEvent.click(screen.getByRole("button", { name: "Send report" }));
  await screen.findByRole("heading", {
    name: "Thank you. Your report was sent.",
  });
}

describe("Report a problem", () => {
  it("says what it attaches, and sends that with the summary and what happened", async () => {
    window.location.hash = "#decks?filter=private";
    recordRequest(
      new Request("http://localhost/api/v1/decks?q=x"),
      new Response(null, { status: 200, headers: { "X-Request-ID": "req-1" } }),
    );
    answers = [answer(201, receipt)];
    render(<ReportButton />);
    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    expect(dialog()).toHaveAttribute("open");
    expect(dialog()).toHaveTextContent(
      "We'll also send: this page, the version, your browser and screen size, and the IDs of your last requests to the site.",
    );
    expect(dialog()).not.toHaveTextContent("the game and turn");
    write("  The board froze  ", "I passed priority.\nNothing happened.");
    await send();
    expect(posts).toEqual([
      {
        path: "/api/v1/reports",
        body: {
          summary: "The board froze",
          description: "I passed priority.\nNothing happened.",
          screenshot: null,
          context: {
            page: "#decks",
            app_version: __APP_VERSION__,
            viewport_width: window.innerWidth,
            viewport_height: window.innerHeight,
            pixel_ratio: window.devicePixelRatio || 1,
            game_id: null,
            game_turn: null,
            requests: [
              {
                method: "GET",
                path: "/api/v1/decks",
                status: 200,
                request_id: "req-1",
                at: expect.any(String),
              },
            ],
          },
        },
      },
    ]);
    // Closed and opened again: an empty form for the next report.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(dialog()).not.toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    expect(screen.getByLabelText("Summary")).toHaveValue("");
  });

  it("keeps a draft that was not sent", () => {
    render(<ReportButton />);
    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    write("Half written");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(dialog()).not.toHaveAttribute("open");
    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    expect(screen.getByLabelText("Summary")).toHaveValue("Half written");
  });

  it("names the game and its turn when sent from the table", async () => {
    answers = [answer(201, receipt)];
    render(
      <ReportDialog open game={{ id: "g1", turn: 12 }} onClose={() => {}} />,
    );
    expect(dialog()).toHaveTextContent(
      "We'll also send: this page, the version, the game and turn, your browser and screen size",
    );
    write();
    await send();
    expect(posts[0]!.body.context).toMatchObject({
      game_id: "g1",
      game_turn: 12,
    });
  });

  it("attaches a chosen file, shows it and sends it", async () => {
    vi.mocked(prepareScreenshot).mockResolvedValue(shot());
    answers = [answer(201, { ...receipt, screenshot: true })];
    render(<ReportDialog open onClose={() => {}} />);
    const chosen = png();
    fireEvent.change(screen.getByLabelText("Choose an image…"), {
      target: { files: [chosen] },
    });
    const preview = await screen.findByRole("img", {
      name: "The screenshot to send",
    });
    // A data: URL: the site's Content-Security-Policy refuses blob: images.
    expect(preview).toHaveAttribute("src", "data:image/png;base64,AAAA");
    expect(vi.mocked(prepareScreenshot)).toHaveBeenCalledWith(chosen);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Screenshot attached: 64 × 48, 1 KB.",
    );
    write();
    await send();
    expect(posts[0]!.body.screenshot).toBe("AAAA");
  });

  it("takes an image pasted anywhere in the dialog", async () => {
    vi.mocked(prepareScreenshot).mockResolvedValue(shot());
    render(<ReportDialog open onClose={() => {}} />);
    const pasted = png("pasted.png");
    fireEvent.paste(screen.getByLabelText("Summary"), {
      clipboardData: { files: [pasted], items: [], types: ["Files"] },
    });
    await screen.findByRole("img", { name: "The screenshot to send" });
    expect(vi.mocked(prepareScreenshot)).toHaveBeenCalledWith(pasted);
  });

  it("leaves a paste of text alone", () => {
    render(<ReportDialog open onClose={() => {}} />);
    fireEvent.paste(screen.getByLabelText("Summary"), {
      clipboardData: { files: [], items: [], types: ["text/plain"] },
    });
    expect(vi.mocked(prepareScreenshot)).not.toHaveBeenCalled();
  });

  it("takes an image dropped on the dialog", async () => {
    vi.mocked(prepareScreenshot).mockResolvedValue(shot());
    render(<ReportDialog open onClose={() => {}} />);
    const dropped = png("dropped.png");
    const transfer = { files: [dropped], items: [], types: ["Files"] };
    fireEvent.dragOver(dialog(), { dataTransfer: transfer });
    expect(dialog()).toHaveAttribute("data-dragging");
    fireEvent.drop(dialog(), { dataTransfer: transfer });
    expect(dialog()).not.toHaveAttribute("data-dragging");
    await screen.findByRole("img", { name: "The screenshot to send" });
    expect(vi.mocked(prepareScreenshot)).toHaveBeenCalledWith(dropped);
  });

  it("removes the screenshot, and sends none", async () => {
    vi.mocked(prepareScreenshot).mockResolvedValue(shot());
    answers = [answer(201, receipt)];
    render(<ReportDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Choose an image…"), {
      target: { files: [png()] },
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove the screenshot" }),
    );
    expect(
      screen.queryByRole("img", { name: "The screenshot to send" }),
    ).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Screenshot removed.");
    write();
    await send();
    expect(posts[0]!.body.screenshot).toBeNull();
  });

  it("says why an image cannot be attached: another type, or too large", async () => {
    const actual =
      await vi.importActual<typeof import("./screenshot")>("./screenshot");
    vi.mocked(prepareScreenshot).mockImplementation(actual.prepareScreenshot);
    render(<ReportDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Choose an image…"), {
      target: {
        files: [new File(["GIF89a"], "a.gif", { type: "image/gif" })],
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a PNG, JPEG or WebP image.",
    );
    vi.mocked(prepareScreenshot).mockRejectedValue(
      new ScreenshotError(
        "The image stays too large even at low quality. Try a smaller one.",
      ),
    );
    fireEvent.change(screen.getByLabelText("Choose an image…"), {
      target: { files: [png("huge.png")] },
    });
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "The image stays too large even at low quality.",
      ),
    );
    expect(
      screen.queryByRole("img", { name: "The screenshot to send" }),
    ).toBeNull();
  });

  it("sends a large screenshot again, smaller, when a proxy refuses it", async () => {
    const original = png("large.png");
    vi.mocked(prepareScreenshot)
      .mockResolvedValueOnce(
        shot({ dataUrl: "data:image/png;base64,LARGE", size: 2_000_000 }),
      )
      .mockResolvedValueOnce(
        shot({ dataUrl: "data:image/webp;base64,SMALL", size: 700_000 }),
      );
    answers = [answer(413, "<html>413</html>"), answer(201, receipt)];
    render(<ReportDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Choose an image…"), {
      target: { files: [original] },
    });
    await screen.findByRole("img", { name: "The screenshot to send" });
    write();
    await send();
    expect(vi.mocked(prepareScreenshot)).toHaveBeenLastCalledWith(
      original,
      SMALL_BYTES,
    );
    expect(posts.map((post) => post.body.screenshot)).toEqual([
      "LARGE",
      "SMALL",
    ]);
  });

  it("shows the API's refusal, and keeps the report to send again", async () => {
    answers = [
      answer(429, {
        code: "too_many_reports",
        message:
          "You have sent 20 reports in the last 24 hours. Try again later.",
      }),
    ];
    render(<ReportDialog open onClose={() => {}} />);
    write();
    fireEvent.click(screen.getByRole("button", { name: "Send report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You have sent 20 reports in the last 24 hours.",
    );
    expect(screen.getByLabelText("Summary")).toHaveValue("The board froze");
    await act(async () => {});
  });
});
