import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Portrait } from "./Portrait";

describe("the portraits", () => {
  it("offer the three sizes for the space they take, described by the roster", () => {
    render(
      <Portrait
        id="rowan"
        name="Rowan"
        description="A young mage with crackling lightning."
        size={144}
      />,
    );
    const portrait = screen.getByRole("img", {
      name: "A young mage with crackling lightning.",
    });
    expect(portrait).toHaveAttribute("src", "/portraits/rowan-256.webp");
    expect(portrait).toHaveAttribute(
      "srcset",
      "/portraits/rowan-128.webp 128w, /portraits/rowan-256.webp 256w, /portraits/rowan-512.webp 512w",
    );
    expect(portrait).toHaveAttribute("sizes", "144px");
    // A square box, so the whole picture shows: contain-fit, horns and hoods included.
    expect(portrait).toHaveAttribute("width", "144");
    expect(portrait).toHaveAttribute("height", "144");
  });

  it("take the 128 px file alone as thumbnails", () => {
    render(<Portrait id="kaya" name="Kaya" size={40} thumbnail />);
    const portrait = screen.getByRole("img", { name: "Portrait of Kaya" });
    expect(portrait).toHaveAttribute("src", "/portraits/kaya-128.webp");
    expect(portrait).not.toHaveAttribute("srcset");
  });

  it("stand back beside words that name them", () => {
    const { container } = render(<Portrait id="kaya" decorative thumbnail />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(container.querySelector("img")).toHaveAttribute("alt", "");
  });

  it("show a placeholder for a Planeswalker without one, and for a picture that is missing", () => {
    const { rerender } = render(
      <Portrait id="ezra" name="Ezra" portrait={false} />,
    );
    expect(
      screen.getByRole("img", { name: "Ezra: no portrait yet" }),
    ).toHaveAttribute("data-placeholder");

    rerender(<Portrait id="rowan" name="Rowan" />);
    fireEvent.error(screen.getByRole("img", { name: "Portrait of Rowan" }));
    expect(
      screen.getByRole("img", { name: "Rowan: no portrait yet" }),
    ).toBeInTheDocument();
    // Another Planeswalker's picture is tried afresh.
    rerender(<Portrait id="kaya" name="Kaya" />);
    expect(
      screen.getByRole("img", { name: "Portrait of Kaya" }),
    ).toHaveAttribute("src", "/portraits/kaya-256.webp");
  });
});
