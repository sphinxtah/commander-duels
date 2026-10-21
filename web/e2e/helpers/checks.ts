import { expect, type Page } from "@playwright/test";

// What every table must be at every size (design §24.2): one 16:9 stage scaled by
// min(w/1920, h/1080), nothing that scrolls, a canvas drawn at the screen's own pixels (up to
// 4K's), and every control that can be pressed reachable where it is drawn: the element at the
// centre of each card and each option is that card or option, never something drawn over it.

/** The largest canvas backing store (stage.ts's MAX_BACKING). */
const MAX_BACKING = 3840 * 2160;

/** Waits for the table to be drawn, then checks its scale, scrolling and canvas. */
export async function sizeChecks(
  page: Page,
  size: { width: number; height: number; dpr: number },
  renderer: "webgl" | "dom" = "webgl",
) {
  const root = page.locator("[data-screen]");
  await expect(root).toHaveAttribute("data-renderer", renderer, {
    timeout: 20_000,
  });
  await expect(root).toHaveAttribute("data-ready", "true");
  const k = Math.max(1 / 4, Math.min(size.width / 1920, size.height / 1080));
  const scale = Number(await root.getAttribute("data-scale"));
  expect(Math.abs(scale - k)).toBeLessThanOrEqual(0.001);
  const page_ = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      "canvas[data-table-canvas]",
    );
    return {
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      innerWidth,
      innerHeight,
      canvas: canvas && {
        width: canvas.width,
        height: canvas.height,
        cssWidth: canvas.clientWidth,
        cssHeight: canvas.clientHeight,
      },
    };
  });
  expect(page_.scrollWidth).toBeLessThanOrEqual(page_.innerWidth);
  expect(page_.scrollHeight).toBeLessThanOrEqual(page_.innerHeight);
  if (renderer === "webgl") {
    const canvas = page_.canvas!;
    expect(canvas).not.toBeNull();
    const wanted = canvas.cssWidth * size.dpr * canvas.cssHeight * size.dpr;
    if (wanted <= MAX_BACKING) {
      // The screen's own pixels, give or take rounding.
      expect(
        Math.abs(canvas.width - canvas.cssWidth * size.dpr),
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(canvas.height - canvas.cssHeight * size.dpr),
      ).toBeLessThanOrEqual(2);
    } else
      expect(canvas.width * canvas.height).toBeLessThanOrEqual(
        MAX_BACKING * 1.01,
      );
  }
}

/** Every enabled card and option, and what covers its centre when something does. Options in
 * the prompt column are scrolled into view there first; the page itself never scrolls. */
export async function occluded(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const describe = (element: Element | null) =>
      element
        ? `${element.tagName.toLowerCase()}${
            element.getAttribute("aria-label")
              ? ` "${element.getAttribute("aria-label")}"`
              : element.textContent?.trim()
                ? ` "${element.textContent.trim().slice(0, 40)}"`
                : ""
          }${element.className ? ` .${String(element.className).split(" ")[0]}` : ""}`
        : "nothing";
    const problems: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(
      "[data-card], [data-option]",
    )) {
      if ((element as HTMLButtonElement).disabled) continue;
      if (element.closest("[hidden], [role=menu], dialog")) continue;
      const column = element.closest("[data-column]");
      if (column) element.scrollIntoView({ block: "nearest" });
      const box = element.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
        problems.push(`${describe(element)} is off the screen`);
        continue;
      }
      const hit = document.elementFromPoint(x, y);
      if (hit !== element && !element.contains(hit))
        problems.push(`${describe(element)} is covered by ${describe(hit)}`);
    }
    return problems;
  });
}
