"""Make the web's brand images from the owner's artwork.

- commander.duels.logo.nowords.png (1254 x 1254), the CD monogram on a transparent background, is
  the sidebar mark and the favicon. The home-screen icon puts it on the site's background, because
  iOS fills transparency with black. The installed app's icons (v0.3.0) come from it too: "icons
  <file>" makes only those, the transparent icon-192/512 and the maskable-192/512, whose mark sits
  inside the 80% circle that a launcher may crop to.
- commander.duels.banner.png (1916 x 821) leads the Play page: "banner <file>" makes its two
  widths and the phone crop of its logo half.
- "screenshots <files>" turns 16:9 captures of the site (play.png, table.png from the browser
  journeys) into the manifest's 1920 x 1080 WebP screenshots, named after each file.

The logo with the words (commander.duels.logo.png) is not on the site since the banner replaced
it, so no copy of it is made. Only these web-sized copies are in the repository. The script needs
Pillow, which the application does not use, so run it in a throwaway container:

    docker run --rm -v "<folder with the artwork>:/in:ro" -v "$PWD:/w" -w /w python:3.12.10-slim \
        sh -c "pip install -q pillow && python scripts/brand_assets.py \
        /in/commander.duels.logo.nowords.png"
"""

import re
import sys
from pathlib import Path

from PIL import Image  # type: ignore[import-not-found]

OUT = Path("web/public/brand")
SIZE = (1254, 1254)
BANNER = (1916, 821)
# The banner's logo half, for phones: centred on the logo (about x = 1375).
BANNER_LOGO = (925, 0, 1825, 821)
# The site's background (theme-color in web/index.html).
BACKGROUND = (16, 24, 25, 255)
# A maskable icon's mark: its larger side is this share of the icon, so even its corners stay
# inside the safe circle (80% of the side across; 0.56 x sqrt(2) is about 0.79).
MASKABLE_MARK = 0.56
SCREENSHOT = (1920, 1080)


def open_logo(path: str, mode: str) -> Image.Image:
    image = Image.open(path).convert(mode)
    if image.size != SIZE:
        raise SystemExit(f"Expected a {SIZE[0]} x {SIZE[1]} logo, got {image.size} in {path}")
    return image


def report(names: list[str]) -> None:
    for name in names:
        print(f"{OUT / name} {(OUT / name).stat().st_size} bytes")


def app_icons(mark: Image.Image) -> list[str]:
    """The manifest's icons: the mark as it is, and on the site's background for launchers."""
    OUT.mkdir(parents=True, exist_ok=True)
    lanczos = Image.Resampling.LANCZOS
    names = []
    for size in (192, 512):
        mark.resize((size, size), lanczos).save(OUT / f"icon-{size}.png", optimize=True)
        names.append(f"icon-{size}.png")
    box = mark.getbbox()
    if box is None:
        raise SystemExit("The logo is empty")
    drawn = mark.crop(box)
    for size in (192, 512):
        scale = MASKABLE_MARK * size / max(drawn.size)
        width, height = (max(1, round(side * scale)) for side in drawn.size)
        icon = Image.new("RGBA", (size, size), BACKGROUND)
        icon.alpha_composite(
            drawn.resize((width, height), lanczos), ((size - width) // 2, (size - height) // 2)
        )
        icon.convert("RGB").save(OUT / f"maskable-{size}.png", optimize=True)
        names.append(f"maskable-{size}.png")
    return names


def main(nowords: str) -> None:
    mark = open_logo(nowords, "RGBA")
    OUT.mkdir(parents=True, exist_ok=True)
    lanczos = Image.Resampling.LANCZOS
    mark.resize((128, 128), lanczos).save(OUT / "mark.webp", quality=90, method=6)
    for size in (32, 64):
        mark.resize((size, size), lanczos).save(OUT / f"favicon-{size}.png", optimize=True)
    touch = Image.new("RGBA", (180, 180), BACKGROUND)
    inner = mark.resize((156, 156), lanczos)
    touch.alpha_composite(inner, (12, 12))
    touch.convert("RGB").save(OUT / "touch-icon.png", optimize=True)
    app_icons(mark)
    for path in sorted(OUT.iterdir()):
        print(f"{path} {path.stat().st_size} bytes")


def icons(nowords: str) -> None:
    report(app_icons(open_logo(nowords, "RGBA")))


def banner(path: str) -> None:
    image = Image.open(path).convert("RGB")
    if image.size != BANNER:
        raise SystemExit(f"Expected a {BANNER[0]} x {BANNER[1]} banner, got {image.size}")
    OUT.mkdir(parents=True, exist_ok=True)
    lanczos = Image.Resampling.LANCZOS
    for width in (1600, 960):
        height = round(BANNER[1] * width / BANNER[0])
        image.resize((width, height), lanczos).save(
            OUT / f"banner-{width}.webp", quality=82, method=6
        )
    logo = image.crop(BANNER_LOGO)
    logo.resize((640, round(logo.height * 640 / logo.width)), lanczos).save(
        OUT / "banner-logo-640.webp", quality=84, method=6
    )
    report(["banner-1600.webp", "banner-960.webp", "banner-logo-640.webp"])


def screenshots(paths: list[str]) -> None:
    """Captures at 1920 x 1080 or any other 16:9 size (a 4K or high-DPI one is scaled down)."""
    OUT.mkdir(parents=True, exist_ok=True)
    names = []
    for path in paths:
        name = Path(path).stem
        if not re.fullmatch(r"[a-z0-9-]+", name):
            raise SystemExit(f"Name a capture in lower case, such as play.png: {path}")
        image = Image.open(path).convert("RGB")
        width, height = image.size
        if width * 9 != height * 16:
            raise SystemExit(f"Expected a 16:9 capture, got {width} x {height} in {path}")
        if image.size != SCREENSHOT:
            image = image.resize(SCREENSHOT, Image.Resampling.LANCZOS)
        names.append(f"screenshot-{name}-1920.webp")
        image.save(OUT / names[-1], quality=82, method=6)
    report(names)


if __name__ == "__main__":
    if sys.argv[1] == "banner":
        banner(sys.argv[2])
    elif sys.argv[1] == "icons":
        icons(sys.argv[2])
    elif sys.argv[1] == "screenshots":
        screenshots(sys.argv[2:])
    else:
        main(sys.argv[1])
