import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import chatStyles from "../../chat/chat.module.css";
import { BandHud, type TurnLine } from "./BandHud";
import { BAND, diamond, rect } from "./geometry";
import type { TableLayout } from "./types";
import styles from "./screen.module.css";

// The band's HUD (v0.5.1): a turn line kept whole with every diamond on the band, and the chat
// bar's diamond's count readable.

/** The band as the table lays it out, enough for the HUD. */
const layout = {
  band: {
    hud: {
      menu: diamond(BAND.hud.menu, BAND.y, BAND.hud.side),
      log: diamond(BAND.hud.log, BAND.y, BAND.hud.side),
      priority: diamond(BAND.hud.priority, BAND.y, BAND.hud.side),
      fullscreen: diamond(BAND.hud.fullscreen, BAND.y, BAND.hud.side),
      inspection: diamond(BAND.hud.inspection, BAND.y, BAND.hud.side),
    },
    turnText: BAND.turnText,
    status: BAND.status,
    stepText: rect(1250, 494, 1530, 526),
  },
} as unknown as TableLayout;

function hud(turn: string, every = true) {
  const line: TurnLine = {
    turn,
    step: "Declare attackers",
    stepId: "declare_attackers",
  };
  return (
    <BandHud
      layout={layout}
      sysop={every}
      drawer={null}
      onDrawer={() => undefined}
      menuOpen={false}
      onMenu={() => undefined}
      fullscreen={{
        available: false,
        active: false,
        escapeLocked: false,
        enteredByUs: false,
        toggle: () => undefined,
      }}
      turnLine={line}
      statusText="Connected"
      statusPhase="open"
      chat={every ? { unread: 0 } : null}
      friends={{ unread: 3, open: false, onToggle: () => undefined }}
    />
  );
}

/** The module's stylesheet, with its class names as the components get them in tests. */
function withCss(file: string, names: Record<string, string>) {
  const raw = readFileSync(file, "utf8");
  const style = document.createElement("style");
  style.textContent = raw.replace(
    /\.([a-zA-Z][\w-]*)/g,
    (_, name: string) => `.${names[name] ?? name}`,
  );
  document.head.append(style);
}

/** WCAG's contrast ratio between two colours, as #rrggbb or rgb(r, g, b). */
function contrast(one: string, other: string): number {
  const luminance = (colour: string) => {
    const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour);
    const channels = hex
      ? hex.slice(1).map((part) => parseInt(part, 16))
      : (colour.match(/\d+/g) ?? []).slice(0, 3).map(Number);
    const [r, g, b] = channels.map((value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const [light, dark] = [luminance(one), luminance(other)].sort(
    (a, b) => b - a,
  );
  return (light! + 0.05) / (dark! + 0.05);
}

afterEach(() => {
  document.head.querySelectorAll("style").forEach((style) => style.remove());
  vi.restoreAllMocks();
});

describe("the band's HUD", () => {
  it("draws a turn line too long for its box smaller, until it fits whole", () => {
    // jsdom lays nothing out: the line is as wide as its words at its own size, 303 units for
    // "Turn 12 · Other team’s turn" in Segoe UI Bold, and its box as wide as the band gives it.
    const words: Record<string, number> = {
      "Turn 12 · Other team’s turn": 303,
      "Turn 3 · Your turn": 190,
    };
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        const fit = Number(this.style.getPropertyValue("--fit") || 1);
        return Math.ceil((words[this.textContent ?? ""] ?? 0) * fit);
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return parseFloat(this.style.width) || 0;
      },
    );
    // SysOp at a Two-Headed Giant human table: the inspection, the table chat and the chat bar's
    // diamonds all on the band leave the line 268 units.
    const { rerender } = render(hud("Turn 12 · Other team’s turn"));
    const line = screen.getByText("Turn 12 · Other team’s turn");
    expect(line.style.width).toBe("268px");
    const fit = Number(line.style.getPropertyValue("--fit"));
    expect(fit).toBeLessThan(1);
    expect(fit).toBeGreaterThanOrEqual(0.7);
    expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
    // A shorter line is drawn at its own size again.
    rerender(hud("Turn 3 · Your turn"));
    expect(
      Number(
        screen.getByText("Turn 3 · Your turn").style.getPropertyValue("--fit"),
      ),
    ).toBe(1);
    // With fewer diamonds the long line fits as it is.
    rerender(hud("Turn 12 · Other team’s turn", false));
    const wide = screen.getByText("Turn 12 · Other team’s turn");
    expect(wide.style.width).toBe("356px");
    expect(Number(wide.style.getPropertyValue("--fit"))).toBe(1);
  });

  it("counts the friends' messages on the chat bar's diamond in colours that read, as on the bar", () => {
    withCss("src/game/table/screen.module.css", styles);
    withCss("src/chat/chat.module.css", chatStyles);
    render(hud("Turn 3 · Your turn"));
    const count = screen.getByRole("button", {
      name: "Friends and messages, 3 unread",
    }).lastElementChild as HTMLElement;
    expect(count).toHaveTextContent("3");
    const diamond = getComputedStyle(count);
    // At least 4.5:1, as text under 18.66 px bold needs.
    expect(
      contrast(diamond.color, diamond.backgroundColor),
    ).toBeGreaterThanOrEqual(4.5);
    // The bar's own counts are the same colours.
    const badge = document.body.appendChild(document.createElement("span"));
    badge.className = chatStyles.unread!;
    const bar = getComputedStyle(badge);
    expect([bar.color, bar.backgroundColor]).toEqual([
      diamond.color,
      diamond.backgroundColor,
    ]);
    badge.remove();
  });
});
