import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { tierOrder } from "./alliance";
import { TierBadge } from "./TierBadge";

describe("the tier crests", () => {
  it("name their tier for screen readers", () => {
    render(
      <>
        {tierOrder.map((tier) => (
          <TierBadge key={tier} tier={tier} />
        ))}
      </>,
    );
    expect(
      screen
        .getAllByRole("img")
        .map((crest) => crest.getAttribute("aria-label")),
    ).toEqual([
      "Bronze tier",
      "Silver tier",
      "Gold tier",
      "Platinum tier",
      "Mythic tier",
      "Godlike tier",
    ]);
  });

  it("keep each crest's gradients its own", () => {
    const { container } = render(
      <>
        <TierBadge tier="gold" />
        <TierBadge tier="gold" />
      </>,
    );
    const ids = [...container.querySelectorAll("linearGradient")].map(
      (gradient) => gradient.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    // Every fill points at a gradient of its own crest, with no punctuation url(#…) would trip on.
    for (const crest of container.querySelectorAll("svg")) {
      const own = new Set(
        [...crest.querySelectorAll("linearGradient")].map(
          (gradient) => gradient.id,
        ),
      );
      for (const path of crest.querySelectorAll("[fill^='url(']")) {
        const id = /^url\(#([A-Za-z0-9_-]+)\)$/.exec(
          path.getAttribute("fill")!,
        )?.[1];
        expect(own.has(id!)).toBe(true);
      }
    }
  });

  it("tell the tiers apart by their emblem as well as their metal", () => {
    const { container } = render(
      <>
        {tierOrder.map((tier) => (
          <TierBadge key={tier} tier={tier} />
        ))}
      </>,
    );
    const crests = [...container.querySelectorAll("svg")];
    // One to four chevrons for the metals, each drawn as a dark line under a bright one.
    expect(
      crests.slice(0, 4).map((crest) => crest.querySelectorAll("g").length),
    ).toEqual([1, 2, 3, 4]);
    expect(crests[4]!.querySelectorAll("g")).toHaveLength(0);
    // Godlike's five colours, as pips.
    expect(crests[5]!.querySelectorAll("circle")).toHaveLength(5);
  });

  it("scale from 24 to 128 pixels, a little taller than wide", () => {
    const { container } = render(
      <>
        <TierBadge tier="silver" size={24} />
        <TierBadge tier="silver" size={128} />
      </>,
    );
    const [small, large] = container.querySelectorAll("svg");
    expect(small).toHaveAttribute("width", "24");
    expect(small).toHaveAttribute("height", "27");
    expect(large).toHaveAttribute("width", "128");
    expect(large).toHaveAttribute("height", "144");
    expect(small).toHaveAttribute("viewBox", "0 0 64 72");
  });

  it("hide from screen readers beside words that name the tier", () => {
    const { container } = render(<TierBadge tier="mythic" decorative />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
});
