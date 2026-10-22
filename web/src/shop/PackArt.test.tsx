import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { product, znrArt } from "./fixtures";
import { PackArt } from "./PackArt";
import { bandOf, hashOf, linesOf, paletteOf } from "./packDesign";

// The pack's picture (v0.4.3): the real one when the API names it, a pack drawn from the set
// otherwise, and the drawn one when the picture fails to load.

const drawn = product({
  id: "product-sfr-play",
  set_code: "SFR",
  set_name: "Starfall Reaches",
  name: "Starfall Reaches Play Booster",
  kind: "play",
  booster: "play",
  released: "2027-02-05",
  era: "play",
  art: null,
  symbol: null,
});

describe("a pack's picture", () => {
  it("is the real pack's, small by default, with both sizes for the browser to choose", () => {
    const { container } = render(<PackArt product={product()} height={9} />);
    const image = container.querySelector("img")!;
    expect(image).toHaveAttribute("data-pack-art", "picture");
    expect(image).toHaveAttribute("src", "/packs/znr-draft-160.webp");
    expect(image).toHaveAttribute(
      "srcset",
      "/packs/znr-draft-160.webp 92w, /packs/znr-draft-480.webp 276w",
    );
    // Its size is known before it loads, so nothing shifts; it loads when it comes into view.
    expect(image).toHaveAttribute("width", "92");
    expect(image).toHaveAttribute("height", "160");
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveAttribute("decoding", "async");
    // Beside the product's name it is decorative.
    expect(image).toHaveAttribute("alt", "");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("names the product where it stands alone, and takes the large size at the counter", () => {
    render(
      <PackArt
        product={product()}
        height={20}
        size="large"
        label="Zendikar Rising Draft Booster"
      />,
    );
    const image = screen.getByRole("img", {
      name: "Zendikar Rising Draft Booster",
    });
    expect(image).toHaveAttribute("src", znrArt.large.src);
    expect(image).toHaveAttribute("width", "276");
    expect(image).toHaveAttribute("height", "480");
  });

  it("is drawn from the set when there is no picture: its name, symbol and booster type", () => {
    render(
      <PackArt
        product={{ ...drawn, symbol: "/sets/sfr.svg" }}
        height={9}
        label="Starfall Reaches Play Booster"
      />,
    );
    const pack = screen.getByRole("img", {
      name: "Starfall Reaches Play Booster",
    });
    expect(pack.tagName.toLowerCase()).toBe("svg");
    expect(pack).toHaveAttribute("data-pack-art", "drawn");
    expect(pack).toHaveTextContent("Starfall");
    expect(pack).toHaveTextContent("Reaches");
    expect(pack).toHaveTextContent("PLAY BOOSTER");
    expect(pack).toHaveTextContent("SFR · 2027");
    expect(pack.querySelector("image")).toHaveAttribute(
      "href",
      "/sets/sfr.svg",
    );
  });

  it("shows the set's code where it has no symbol, and is decorative without a label", () => {
    const { container } = render(<PackArt product={drawn} height={9} />);
    const pack = container.querySelector("svg")!;
    expect(pack).toHaveAttribute("aria-hidden", "true");
    expect(pack.querySelector("image")).toBeNull();
    expect(pack.querySelector("title")).toBeNull();
    expect(
      [...pack.querySelectorAll("text")].map((text) => text.textContent),
    ).toContain("SFR");
  });

  it("falls back to the drawn pack when the picture fails to load", () => {
    const { container } = render(
      <PackArt product={product()} height={9} label="Zendikar Rising" />,
    );
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    const pack = screen.getByRole("img", { name: "Zendikar Rising" });
    expect(pack).toHaveAttribute("data-pack-art", "drawn");
    expect(pack).toHaveTextContent("DRAFT BOOSTER");
    expect(pack.querySelector("image")).toHaveAttribute(
      "href",
      "/sets/znr.svg",
    );
  });

  it("gives every drawing its own ids, so two packs on a page never share a gradient", () => {
    const { container } = render(
      <>
        <PackArt product={drawn} height={9} />
        <PackArt product={drawn} height={9} />
      </>,
    );
    const ids = [...container.querySelectorAll("[id]")].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[\w-]+$/);
  });
});

describe("the drawn pack's design", () => {
  it("takes its colours from the set's code, the same every time, tinted by its era", () => {
    expect(hashOf("ZNR")).toBe(hashOf("ZNR"));
    expect(hashOf("ZNR")).not.toBe(hashOf("KHM"));
    expect(paletteOf("znr", "collector")).toEqual(
      paletteOf("ZNR", "collector"),
    );
    expect(paletteOf("ZNR", "collector").body).not.toBe(
      paletteOf("ZNR", "first").body,
    );
  });

  it("names the booster type from the product's own name", () => {
    expect(bandOf(product()).label).toBe("Draft Booster");
    expect(
      bandOf(
        product({
          name: "Revised Edition Booster Pack",
          set_name: "Revised Edition",
          kind: "booster",
          booster: "default",
        }),
      ).label,
    ).toBe("Booster");
    expect(
      bandOf(
        product({
          name: "Mercadian Masques Tournament Pack",
          set_name: "Mercadian Masques",
          kind: "tournament",
          booster: "tournament",
        }),
      ).label,
    ).toBe("Tournament Pack");
    // A name that does not start with the set's: the type's own label.
    expect(
      bandOf(
        product({
          name: "Summer Magic Booster Pack",
          set_name: "Summer Magic / Edgar",
          kind: "booster",
        }),
      ).label,
    ).toBe("Booster");
    // A guild's theme booster shows both its colours; a colour's, its colour.
    const guild = bandOf(
      product({
        name: "Guilds of Ravnica Theme Booster Izzet",
        set_name: "Guilds of Ravnica",
        kind: "theme",
        booster: "theme-izzet",
      }),
    );
    expect(guild.colours).toHaveLength(2);
    expect(
      bandOf(
        product({
          name: "Dominaria Theme Booster Black",
          set_name: "Dominaria",
          kind: "theme",
          booster: "theme-b",
        }),
      ),
    ).toMatchObject({ label: "Theme Booster Black", colours: ["#2e2a2b"] });
  });

  it("sets the set's name in at most three lines", () => {
    expect(linesOf("Zendikar Rising")).toEqual({
      lines: ["Zendikar", "Rising"],
      size: 15,
    });
    expect(linesOf("Magic 2010")).toEqual({ lines: ["Magic 2010"], size: 13 });
    expect(linesOf("Phyrexia: All Will Be One")).toEqual({
      lines: ["Phyrexia: All", "Will Be One"],
      size: 11,
    });
    const long = linesOf("The Lord of the Rings: Tales of Middle-earth");
    expect(long.lines).toHaveLength(3);
    expect(long.lines.join(" ")).toBe(
      "The Lord of the Rings: Tales of Middle-earth",
    );
  });
});
