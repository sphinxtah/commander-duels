"""Pictures of the packs on Leng's shelves (v0.4.3): web/public/packs/ and content/pack-art.json.

    python scripts/pack_art.py [--only SET[:booster] ...] [--sheets DIR] [--offline] [--cache DIR]

Every product in content/pack-prices.json gets the picture of its sealed pack where one can be
found, copied once and served from this site, never hotlinked (the owner's decision of
2026-10-22, accepting the licence risk of a retailer's images):

1. **TCGplayer first.** The price list names a TCGplayer product for most products (`source`, or a
   product id in `basis`). Its JSON details give the product's name, which must be the pack itself:
   a booster box, display, bundle or case is not, and neither is a foreign-language pack. Otherwise,
   and for products with no TCGplayer id, TCGplayer's search is asked for "<set name> <booster>"
   and the best English pack of that set is taken. OVERRIDES pins a product, sends it to an image
   on Wizards of the Coast's own pages, or leaves it to the generated design, with the reason.
2. **The image** (TCGplayer's 1000 x 1000 product picture) loses its plain white background: only
   the near-white pixels connected to the image's border become transparent, so white inside the
   pack stays. It is trimmed to the pack and written as WebP, 160 and 480 pixels tall:
   web/public/packs/<set>-<booster>-160.webp and -480.webp.
3. **The manifest**, content/pack-art.json: per product its two files and their sizes, its origin
   (tcgplayer or wizards), the page and image it came from and the product name checked; the
   products left to the generated design, each with its reason; and the set symbols.
4. **Set symbols:** Scryfall's set icons (https://api.scryfall.com/sets, `icon_svg_uri`) for every
   set in the price list, reduced to plain shapes (no scripts, styles, links or references), in
   web/public/sets/<set>.svg. The generated design draws the symbol when the manifest names one.

A product with no picture, and every set the weekly booster data job adds after the price list,
is drawn in the browser instead (web/src/shop/PackArt.tsx). The API reads the manifest
(api/products.py).

Polite to the sites it asks: one request at a time, half a second apart, a browser's User-Agent,
retries with backoff. Every answer is kept in the cache folder (default .local/pack-art, which git
ignores), so running it again fetches nothing it already has; --offline uses the cache alone.
--sheets writes contact sheets of the small images, to look at before committing. Needs Pillow
(the API image has it).
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ElementTree
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from io import BytesIO
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape, quoteattr

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
PRICES = ROOT / "content" / "pack-prices.json"
MANIFEST = ROOT / "content" / "pack-art.json"
PACKS = ROOT / "web" / "public" / "packs"
SETS = ROOT / "web" / "public" / "sets"
CACHE = ROOT / ".local" / "pack-art"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/130.0.0.0 Safari/537.36"
)
DETAILS = "https://mp-search-api.tcgplayer.com/v1/product/{id}/details"
SEARCH = "https://mp-search-api.tcgplayer.com/v1/search/request?q={q}&isList=false"
IMAGE = "https://tcgplayer-cdn.tcgplayer.com/product/{id}_in_1000x1000.jpg"
PAGE = "https://www.tcgplayer.com/product/{id}"
SCRYFALL_SETS = "https://api.scryfall.com/sets"
PAUSE = 0.5
ATTEMPTS = 5
HEIGHTS = (160, 480)
QUALITY = 80
# Background: a pixel whose every channel is at least 255 - TOLERANCE, and whose channels differ
# by at most SPREAD (a light grey, not a pale colour), when connected to the image's border.
TOLERANCE = 22
SPREAD = 14
# Windows refuses these as file names, whatever their extension.
RESERVED = {"con", "prn", "aux", "nul"} | {
    f"{name}{n}" for name in ("com", "lpt") for n in range(10)
}

# Per product, from looking at the contact sheets: "tcgplayer" pins a TCGplayer product id;
# "wizards" names an image on Wizards of the Coast's own pages (with "page" and "name");
# "generated" leaves it to the generated design, with the reason the manifest keeps; "rotate"
# turns the picture (degrees, counterclockwise) and "cut" picks the cut-out's mode (cut_out).
OVERRIDES: dict[tuple[str, str], dict[str, Any]] = {
    # TCGplayer's search finds neither (it lists products with recent sales); their ids sit among
    # the other early booster packs', 27319 to 27380, which are in alphabetical order.
    ("2ED", "default"): {"tcgplayer": 27375},
    ("ARN", "default"): {"tcgplayer": 27327},
    # On its side in TCGplayer's picture; upright, like Conspiracy: Take the Crown's.
    ("CNS", "draft"): {"rotate": -90},
    ("CSP", "draft"): {
        "generated": "TCGplayer's picture shows three packs fanned out, 200 pixels wide: too "
        "small to cut one from."
    },
    ("SOM", "draft"): {
        "generated": "TCGplayer's picture of Scars of Mirrodin - Booster Pack is the set's logo, "
        "not the pack."
    },
    ("SLZ", "default"): {
        "generated": "TCGplayer's picture of The Zeta Set is a promotional layout (the pack under "
        "a fan of cards, on a background), not the pack alone."
    },
}

# Products whose kind is never a pack of its own on TCGplayer: the reason, for the manifest.
NO_PACK_OF_ITS_OWN = {
    "six": "Six-card boosters came only inside other products; TCGplayer sells none alone.",
}

THEME_WORDS = {"w": "White", "u": "Blue", "b": "Black", "r": "Red", "g": "Green"}
BOX_WORDS = re.compile(
    r"\b(box|display|bundle|case|set of|fat pack|intro pack|prerelease|gift|collection|kit|"
    r"blister|sleeved|bundles|lot|pack lot|complete set|chinese|japanese|korean|german|french|"
    r"italian|spanish|portuguese|russian|foreign|fbb|sealed deck|draft night|commander deck)\b",
    re.IGNORECASE,
)


@dataclass
class Product:
    set: str
    set_name: str
    booster: str
    name: str
    source: str | None
    basis: str

    @property
    def key(self) -> str:
        return f"{self.set.lower()}-{self.booster}"


@dataclass
class Found:
    origin: str
    page: str
    image: str
    product_name: str


# Fetching, one request at a time and kept in the cache.


class Fetcher:
    def __init__(self, cache: Path, offline: bool) -> None:
        self.cache = cache
        self.offline = offline
        self.last = 0.0
        self.requests = 0

    def fetch(self, url: str, name: str, body: bytes | None = None) -> bytes | None:
        """The answer to url, from the cache when it holds one; None when the site has none."""
        path = self.cache / name
        missing = path.with_name(path.name + ".missing")
        if path.is_file():
            return path.read_bytes()
        if missing.is_file() or self.offline:
            return None
        headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        for attempt in range(ATTEMPTS):
            wait = self.last + PAUSE - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            self.last = time.monotonic()
            self.requests += 1
            request = urllib.request.Request(url, data=body, headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=60) as response:
                    data: bytes = response.read()
            except urllib.error.HTTPError as error:
                if error.code in (403, 404, 410):
                    missing.parent.mkdir(parents=True, exist_ok=True)
                    missing.write_text(f"{error.code}\n", encoding="utf-8")
                    return None
                if attempt == ATTEMPTS - 1:
                    raise
            except (urllib.error.URLError, TimeoutError):
                if attempt == ATTEMPTS - 1:
                    raise
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                return data
            time.sleep(2**attempt)
        return None

    def json(self, url: str, name: str, body: dict[str, Any] | None = None) -> Any:
        data = self.fetch(url, name, None if body is None else json.dumps(body).encode())
        return None if data is None else json.loads(data)


# Finding the pack on TCGplayer.


def words(text: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text.lower()).split())


def booster_phrase(booster: str) -> str:
    """How TCGplayer names the kind of pack, for its search."""
    if booster.startswith("theme-"):
        word = booster.removeprefix("theme-")
        return f"Theme Booster {THEME_WORDS.get(word, word.capitalize())}"
    return {
        "default": "Booster Pack",
        "draft": "Draft Booster Pack",
        "set": "Set Booster Pack",
        "collector": "Collector Booster Pack",
        "play": "Play Booster Pack",
        "jumpstart": "Jumpstart Booster Pack",
        "starter": "Starter Deck",
        "tournament": "Tournament Pack",
    }.get(booster, f"{booster.replace('-', ' ')} Booster Pack")


def fits(name: str, booster: str) -> bool:
    """Whether a TCGplayer product name is a single English pack of this kind of booster."""
    text = words(name)
    if BOX_WORDS.search(name):
        return False
    kinds = {
        "set": "set booster",
        "collector": "collector booster",
        "play": "play booster",
        "jumpstart": "jumpstart",
        "starter": "starter deck",
        "tournament": "tournament pack",
    }
    if booster.startswith("theme-"):
        word = booster.removeprefix("theme-")
        colour = words(THEME_WORDS.get(word, word))
        return "theme booster" in text and colour in text
    base = booster.split("-")[0]
    if base in kinds:
        return kinds[base] in text
    if booster in ("default", "draft"):
        others = ("set booster", "collector", "play booster", "jumpstart", "theme", "starter")
        return ("booster pack" in text or "draft booster" in text) and not any(
            other in text for other in others
        )
    return words(booster.replace("-", " ")) in text and "booster" in text


def ids_named(product: Product) -> list[int]:
    found = []
    match = re.search(r"tcgplayer\.com/product/(\d+)", product.source or "")
    if match:
        found.append(int(match[1]))
    found += [int(n) for n in re.findall(r"\bproduct (\d{4,})", product.basis)]
    return list(dict.fromkeys(found))


def details(fetcher: Fetcher, product_id: int) -> dict[str, Any] | None:
    found = fetcher.json(DETAILS.format(id=product_id), f"details/{product_id}.json")
    return found if isinstance(found, dict) and found.get("productName") else None


def search(fetcher: Fetcher, query: str) -> list[dict[str, Any]]:
    body = {
        "algorithm": "sales_synonym_v2",
        "from": 0,
        "size": 24,
        "filters": {
            "term": {"productLineName": ["magic"], "productTypeName": ["Sealed Products"]},
            "range": {},
            "match": {},
        },
        "context": {"cart": {}, "shippingCountry": "US"},
        "settings": {"useFuzzySearch": True},
        "sort": {},
    }
    slug = re.sub(r"[^a-z0-9]+", "-", query.lower()).strip("-")
    found = fetcher.json(
        SEARCH.format(q=urllib.parse.quote(query)), f"search/{slug}.json", body=body
    )
    try:
        return list(found["results"][0]["results"])
    except (KeyError, IndexError, TypeError):
        return []


def same_set(result: dict[str, Any], product: Product) -> bool:
    theirs = words(str(result.get("setName") or ""))
    ours = words(product.set_name)
    return bool(theirs) and (theirs == ours or theirs in ours or ours in theirs)


def tcgplayer(fetcher: Fetcher, product: Product) -> tuple[Found | None, str]:
    """The pack's TCGplayer product, or why there is none. The price list's own product counts
    unless it is a box or the like; a search result must name the kind of pack too."""
    pinned = OVERRIDES.get((product.set, product.booster), {})
    candidates = [pinned["tcgplayer"]] if "tcgplayer" in pinned else ids_named(product)
    reason = ""
    for product_id in candidates:
        found = details(fetcher, product_id)
        if found is None:
            continue
        name = str(found["productName"])
        if "tcgplayer" not in pinned and BOX_WORDS.search(name):
            reason = f"TCGplayer's product is not a single pack ({name}), and no pack was found."
            continue
        if found.get("imageCount"):
            return pictured(product_id, name), ""
        reason = f"TCGplayer has no picture of {name}."
    if "tcgplayer" in pinned:
        return None, reason or f"TCGplayer product {pinned['tcgplayer']} was not found."
    results = search(fetcher, f"{product.set_name} {booster_phrase(product.booster)}")
    matches = [
        result
        for result in results
        if same_set(result, product)
        and fits(str(result.get("productName", "")), product.booster)
        and int(result["productId"]) not in candidates
    ]
    matches.sort(key=lambda result: len(str(result.get("productName", ""))))
    for result in matches:
        product_id = int(result["productId"])
        found = details(fetcher, product_id)
        if found is not None and found.get("imageCount"):
            return pictured(product_id, str(found["productName"])), ""
    return None, reason or "TCGplayer lists no pack of this product."


def pictured(product_id: int, name: str) -> Found:
    return Found("tcgplayer", PAGE.format(id=product_id), IMAGE.format(id=product_id), name)


# The image: a transparent background, trimmed, in two sizes.


def border_connected(background: bytearray, width: int, height: int) -> bytearray:
    """1 for each background pixel connected (4-way) to the image's border; a span flood fill,
    whose row scans run in bytes.find."""
    left = bytearray(background)  # background not yet filled
    filled = bytearray(len(background))
    seeds = [(x, 0) for x in range(width)] + [(x, height - 1) for x in range(width)]
    seeds += [(0, y) for y in range(height)] + [(width - 1, y) for y in range(height)]
    while seeds:
        x, y = seeds.pop()
        row = y * width
        if not left[row + x]:
            continue
        gap = left.rfind(0, row, row + x)
        start = row if gap < 0 else gap + 1
        stop = left.find(0, row + x, row + width)
        stop = row + width if stop < 0 else stop
        left[start:stop] = bytes(stop - start)
        filled[start:stop] = b"\x01" * (stop - start)
        for other in (y - 1, y + 1):
            if not 0 <= other < height:
                continue
            base = other * width
            at = base + (start - row)
            end = base + (stop - row)
            while at < end:
                at = left.find(1, at, end)
                if at < 0:
                    break
                seeds.append((at - base, other))
                gap = left.find(0, at, end)
                at = end if gap < 0 else gap
    return filled


def edge_pixels(rgb: Image.Image) -> list[tuple[int, int, int]]:
    """The pixels along the image's four edges."""
    width, height = rgb.size
    boxes = [(0, 0, width, 1), (0, height - 1, width, height), (0, 0, 1, height)]
    boxes.append((width - 1, 0, width, height))
    return [pixel for box in boxes for pixel in rgb.crop(box).getdata()]


def on_border(mask: bytes | bytearray, width: int, height: int) -> int:
    """How many of the mask's border pixels are set."""
    columns = bytes(mask[y * width] for y in range(height))
    columns += bytes(mask[y * width + width - 1] for y in range(height))
    return sum(mask[:width]) + sum(mask[-width:]) + sum(columns)


def near(rgb: Image.Image, colour: tuple[int, int, int], tolerance: int) -> bytearray:
    """1 for each pixel within tolerance of colour, channel by channel."""
    difference = ImageChops.difference(rgb, Image.new("RGB", rgb.size, colour))
    red, green, blue = difference.split()
    far = ImageChops.lighter(ImageChops.lighter(red, green), blue)
    return bytearray(far.point(lambda value: 1 if value <= tolerance else 0).tobytes())


def framed(mask: bytearray, width: int, height: int, ring: int) -> bytearray:
    """The mask with its outermost ring counted as background, so a thin frame line drawn
    around the picture does not stop the fill."""
    out = bytearray(mask)
    for y in range(height):
        start = y * width
        if y < ring or y >= height - ring:
            out[start : start + width] = b"\x01" * width
        else:
            out[start : start + ring] = b"\x01" * ring
            out[start + width - ring : start + width] = b"\x01" * ring
    return out


def hull_of(opaque: bytes, width: int, height: int) -> bytearray:
    """1 inside the convex hull of the opaque pixels."""
    points = []
    for y in range(height):
        row = opaque[y * width : (y + 1) * width]
        left = row.find(1)
        if left >= 0:
            points += [(left, y), (row.rfind(1), y)]
    points = sorted(set(points))
    inside = Image.new("L", (width, height), 0)
    if len(points) < 3:
        return bytearray(width * height)

    def turn(o: tuple[int, int], a: tuple[int, int], b: tuple[int, int]) -> int:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[tuple[int, int]] = []
    upper: list[tuple[int, int]] = []
    for point in points:
        while len(lower) >= 2 and turn(lower[-2], lower[-1], point) <= 0:
            lower.pop()
        lower.append(point)
    for point in reversed(points):
        while len(upper) >= 2 and turn(upper[-2], upper[-1], point) <= 0:
            upper.pop()
        upper.append(point)
    ImageDraw.Draw(inside).polygon(lower[:-1] + upper[:-1], fill=1, outline=1)
    return bytearray(inside.tobytes())


def cut_out(image: Image.Image, mode: str = "") -> tuple[Image.Image, float]:
    """The pack without its plain background, trimmed; and the share of the border that was
    background (low: the picture fills its frame, or has a background of its own).

    The background's colour is the border's own when most of the border is one light colour
    (a few pictures sit on light grey), white otherwise. Modes:
    - "flood": every near-background pixel connected to the border goes;
    - "two" (the default for large pictures): only the pure background connected to the border
      goes, and the near-background outside the convex hull of the rest, so the light crimps and
      a white pack's art stay while the white beside a hang tab still goes;
    - "hull" (the default for small, old pictures, whose silver crimps are as light as the
      background): everything outside the convex hull of what the flood left goes.
    """
    rgb = image.convert("RGB")
    width, height = rgb.size
    mode = mode or ("two" if height >= 700 else "hull")
    edge = edge_pixels(rgb)
    red, green, blue = (
        sorted(pixel[channel] for pixel in edge)[len(edge) // 2] for channel in range(3)
    )
    background = (255, 255, 255)
    plain = near(rgb, background, TOLERANCE)
    if min(red, green, blue) >= 190 and max(red, green, blue) - min(red, green, blue) <= SPREAD:
        candidate = near(rgb, (red, green, blue), TOLERANCE)
        if on_border(candidate, width, height) > on_border(plain, width, height):
            plain, background = candidate, (red, green, blue)
    share = on_border(plain, width, height) / (2 * (width + height))
    ring = max(2, round(min(width, height) * 0.004))
    loose = border_connected(framed(plain, width, height, ring), width, height)
    if mode == "flood":
        gone = loose
    else:
        kept = Image.frombytes("L", (width, height), bytes(1 - value for value in loose))
        size = 5 if height >= 700 else 3
        kept = kept.filter(ImageFilter.MinFilter(size)).filter(ImageFilter.MaxFilter(size))
        hull = hull_of(kept.tobytes(), width, height)
        outside = bytes(a & (1 - b) for a, b in zip(loose, hull, strict=True))
        if mode == "hull":
            gone = bytearray(outside)
        else:
            pure = near(rgb, background, 5)
            strict = border_connected(framed(pure, width, height, ring), width, height)
            gone = bytearray(a | b for a, b in zip(strict, outside, strict=True))
    alpha = Image.frombytes("L", (width, height), bytes(gone)).point(
        lambda value: 0 if value else 255
    )
    # A large picture loses one pixel off the edge, which takes the light fringe; then a soft
    # edge.
    if height >= 700:
        alpha = alpha.filter(ImageFilter.MinFilter(3))
    alpha = alpha.filter(ImageFilter.GaussianBlur(0.7 if height >= 700 else 0.5))
    cut = rgb.convert("RGBA")
    cut.putalpha(alpha)
    box = alpha.point(lambda value: 255 if value > 24 else 0).getbbox()
    return (cut.crop(box) if box else cut), share


def sized(image: Image.Image, height: int) -> Image.Image:
    width = max(1, round(image.width * height / image.height))
    # Premultiplied, so the transparent white never bleeds into the edge.
    return image.convert("RGBa").resize((width, height), Image.Resampling.LANCZOS).convert("RGBA")


def write_images(product: Product, picture: Image.Image) -> dict[str, dict[str, Any]]:
    """The two sizes. The large one is never made bigger than the picture: TCGplayer has only
    about 200 x 350 pixels of many older packs, which the large file keeps as they are."""
    files = {}
    for label, height in zip(("small", "large"), HEIGHTS, strict=True):
        out = sized(picture, max(HEIGHTS[0], min(height, picture.height)))
        path = PACKS / f"{product.key}-{height}.webp"
        buffer = BytesIO()
        out.save(buffer, "WEBP", quality=QUALITY, alpha_quality=90, method=6)
        if not path.is_file() or path.read_bytes() != buffer.getvalue():
            path.write_bytes(buffer.getvalue())
        files[label] = {
            "src": f"/packs/{path.name}",
            "width": out.width,
            "height": out.height,
        }
    return files


# Set symbols.

SHAPES = {"svg", "g", "path", "circle", "ellipse", "rect", "polygon", "polyline", "line"}
SHAPE_ATTRIBUTES = {
    "d",
    "points",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "x",
    "y",
    "width",
    "height",
    "x1",
    "y1",
    "x2",
    "y2",
    "transform",
    "fill",
    "fill-rule",
    "clip-rule",
    "opacity",
    "fill-opacity",
}
PLAIN_VALUE = re.compile(r"^[\w\s.,#%()+-]*$")


def plain_svg(raw: bytes) -> str | None:
    """The icon with nothing but plain shapes: no scripts, styles, links, references, entities."""
    text = raw.decode("utf-8", errors="replace")
    if "<!ENTITY" in text or "<!DOCTYPE" in text:
        text = re.sub(r"<!DOCTYPE[^>[]*(\[[^\]]*\])?\s*>", "", text)
    if "<!ENTITY" in text:
        return None
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError:
        return None

    def local(tag: str) -> str:
        return tag.rsplit("}", 1)[-1]

    def write(element: ElementTree.Element) -> str:
        tag = local(element.tag)
        if tag not in SHAPES:
            return ""
        kept = []
        for name, value in element.attrib.items():
            name = local(name)
            if tag == "svg" and name == "viewBox" and PLAIN_VALUE.match(value):
                kept.append(f"viewBox={quoteattr(value)}")
            elif tag != "svg" and name in SHAPE_ATTRIBUTES and PLAIN_VALUE.match(value):
                if "url" in value.lower():
                    continue
                kept.append(f"{name}={quoteattr(value)}")
        if tag == "svg":
            kept.insert(0, 'xmlns="http://www.w3.org/2000/svg"')
        inner = "".join(write(child) for child in element)
        attributes = (" " + " ".join(kept)) if kept else ""
        return f"<{tag}{attributes}>{inner}</{tag}>" if inner else f"<{tag}{attributes}/>"

    if local(root.tag) != "svg":
        return None
    if "viewBox" not in root.attrib and root.get("width") and root.get("height"):
        width = re.sub(r"[^\d.]", "", root.get("width", ""))
        height = re.sub(r"[^\d.]", "", root.get("height", ""))
        root.set("viewBox", f"0 0 {escape(width)} {escape(height)}")
    out = write(root)
    return out + "\n" if "<path" in out or "<polygon" in out or "<circle" in out else None


def safe(code: str) -> str:
    name = code.lower()
    return f"{name}_" if name in RESERVED else name


def symbols(fetcher: Fetcher, codes: Iterable[str]) -> dict[str, str]:
    listing = fetcher.json(SCRYFALL_SETS, "scryfall/sets.json")
    if listing is None:
        return {}
    icons = {str(item["code"]).lower(): str(item["icon_svg_uri"]) for item in listing["data"]}
    SETS.mkdir(parents=True, exist_ok=True)
    found = {}
    for code in sorted(set(codes)):
        uri = icons.get(code.lower())
        if not uri:
            print(f"  no Scryfall icon for {code}")
            continue
        file = urllib.parse.urlsplit(uri).path.rsplit("/", 1)[-1]
        raw = fetcher.fetch(uri.split("?", 1)[0], f"icons/{file}")
        svg = plain_svg(raw) if raw else None
        if svg is None:
            print(f"  {code}: the icon could not be read")
            continue
        path = SETS / f"{safe(code)}.svg"
        if not path.is_file() or path.read_text(encoding="utf-8") != svg:
            path.write_text(svg, encoding="utf-8", newline="\n")
        found[code] = f"/sets/{path.name}"
    return found


# Contact sheets, to look at the results.


def sheets(entries: list[dict[str, Any]], folder: Path, per_sheet: int = 48) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    tile_w, tile_h, columns = 150, 200, 8
    font = ImageFont.load_default(size=11)
    for start in range(0, len(entries), per_sheet):
        chunk = entries[start : start + per_sheet]
        rows = (len(chunk) + columns - 1) // columns
        sheet = Image.new("RGB", (tile_w * columns, tile_h * rows), "#18221f")
        draw = ImageDraw.Draw(sheet)
        for index, entry in enumerate(chunk):
            x, y = (index % columns) * tile_w, (index // columns) * tile_h
            path = ROOT / "web" / "public" / entry["small"]["src"].lstrip("/")
            picture = Image.open(path).convert("RGBA")
            picture.thumbnail((tile_w - 10, tile_h - 30))
            sheet.paste(picture, (x + (tile_w - picture.width) // 2, y + 4), picture)
            draw.text(
                (x + 4, y + tile_h - 24), f"{entry['set']} {entry['booster']}", "#efcc8d", font
            )
        sheet.save(folder / f"packs-{start // per_sheet + 1:02d}.png")


# The run.


def load_products() -> list[Product]:
    listing = json.loads(PRICES.read_text(encoding="utf-8"))
    return [
        Product(
            set=str(item["set"]),
            set_name=str(item["set_name"]),
            booster=str(item["booster"]),
            name=str(item["name"]),
            source=item.get("source"),
            basis=str(item.get("basis") or ""),
        )
        for item in listing["products"]
    ]


def wanted(product: Product, only: list[str]) -> bool:
    if not only:
        return True
    return any(
        choice.upper() == product.set
        or choice.lower() == f"{product.set.lower()}:{product.booster}"
        for choice in only
    )


def resolve(fetcher: Fetcher, product: Product) -> tuple[Found | None, str]:
    pinned = OVERRIDES.get((product.set, product.booster), {})
    if "generated" in pinned:
        return None, str(pinned["generated"])
    if "wizards" in pinned:
        return (
            Found("wizards", str(pinned["page"]), str(pinned["wizards"]), str(pinned["name"])),
            "",
        )
    kind = product.booster
    if kind in NO_PACK_OF_ITS_OWN and "tcgplayer" not in pinned:
        return None, NO_PACK_OF_ITS_OWN[kind]
    return tcgplayer(fetcher, product)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--only", nargs="*", default=[], help="SET or set:booster to redo")
    parser.add_argument("--sheets", type=Path, help="write contact sheets into this folder")
    parser.add_argument("--offline", action="store_true", help="use the cache alone")
    parser.add_argument("--cache", type=Path, default=CACHE)
    args = parser.parse_args(argv)
    fetcher = Fetcher(args.cache, args.offline)
    products = load_products()
    before = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.is_file() else {}
    kept = {
        (entry["set"], entry["booster"]): entry
        for entry in before.get("products", []) + before.get("generated", [])
    }
    PACKS.mkdir(parents=True, exist_ok=True)
    pictures: list[dict[str, Any]] = []
    generated: list[dict[str, Any]] = []
    for product in products:
        ident = (product.set, product.booster)
        if not wanted(product, args.only) and ident in kept:
            entry = kept[ident]
            (pictures if "small" in entry else generated).append(entry)
            continue
        found, reason = resolve(fetcher, product)
        raw = None
        if found is not None:
            file = urllib.parse.urlsplit(found.image).path.rsplit("/", 1)[-1]
            raw = fetcher.fetch(found.image, f"images/{found.origin}/{file}")
            if raw is None:
                found, reason = None, f"TCGplayer's picture of {found.product_name} is missing."
        if found is None or raw is None:
            print(f"{product.set} {product.booster}: generated ({reason})")
            generated.append({"set": product.set, "booster": product.booster, "reason": reason})
            continue
        pinned = OVERRIDES.get(ident, {})
        source = Image.open(BytesIO(raw))
        if pinned.get("rotate"):
            source = source.rotate(int(pinned["rotate"]), expand=True)
        picture, share = cut_out(source, str(pinned.get("cut", "")))
        if share < 0.5:
            print(f"  {product.set} {product.booster}: only {share:.0%} of the border is plain")
        files = write_images(product, picture)
        pictures.append(
            {
                "set": product.set,
                "booster": product.booster,
                **files,
                "origin": found.origin,
                "page": found.page,
                "image": found.image,
                "product_name": found.product_name,
            }
        )
        print(f"{product.set} {product.booster}: {found.origin} ({found.product_name})")
    codes = {product.set for product in products if wanted(product, args.only)}
    marks = dict(before.get("symbols", {})) if args.only else {}
    marks |= symbols(fetcher, codes)
    # The folder is this script's: files no product names any more go.
    named = {Path(entry[size]["src"]).name for entry in pictures for size in ("small", "large")}
    for stale in PACKS.glob("*.webp"):
        if stale.name not in named:
            stale.unlink()
    manifest = {
        "as_of": date.today().isoformat(),
        "note": (
            "Pictures of the packs on Leng's shelves, made by scripts/pack_art.py: copied once "
            "from TCGplayer's product pages (or Wizards of the Coast's), the white background made "
            "transparent, served from this site. Products under 'generated' are drawn in the "
            "browser from their set. Set symbols are Scryfall's set icons."
        ),
        "products": pictures,
        "generated": generated,
        "symbols": dict(sorted(marks.items())),
    }
    MANIFEST.write_text(
        json.dumps(manifest, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n"
    )
    total = sum(path.stat().st_size for path in PACKS.glob("*.webp"))
    print(
        f"{len(pictures)} pictures ({total / 1e6:.1f} MB), {len(generated)} generated, "
        f"{len(marks)} set symbols; {fetcher.requests} requests"
    )
    if args.sheets:
        sheets(pictures, args.sheets)
    return 0


if __name__ == "__main__":
    sys.exit(main())
