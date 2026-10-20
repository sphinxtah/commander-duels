"""Make the web's brand images from the owner's artwork.

- commander.duels.logo.nowords.png (1254 x 1254), the CD monogram on a transparent background, is
  the sidebar mark and the favicon. The home-screen icon puts it on the site's background, because
  iOS fills transparency with black.
- commander.duels.banner.png (1916 x 821) leads the Play page: "banner <file>" makes its two
  widths and the phone crop of its logo half.

The logo with the words (commander.duels.logo.png) is not on the site since the banner replaced
it, so no copy of it is made. Only these web-sized copies are in the repository. The script needs
Pillow, which the application does not use, so run it in a throwaway container:

    docker run --rm -v "<folder with the artwork>:/in:ro" -v "$PWD:/w" -w /w python:3.12.10-slim \
        sh -c "pip install -q pillow && python scripts/brand_assets.py \
        /in/commander.duels.logo.nowords.png"
"""

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


def open_logo(path: str, mode: str) -> Image.Image:
    image = Image.open(path).convert(mode)
    if image.size != SIZE:
        raise SystemExit(f"Expected a {SIZE[0]} x {SIZE[1]} logo, got {image.size} in {path}")
    return image


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
    for path in sorted(OUT.iterdir()):
        print(f"{path} {path.stat().st_size} bytes")


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
    for name in ("banner-1600.webp", "banner-960.webp", "banner-logo-640.webp"):
        print(f"{OUT / name} {(OUT / name).stat().st_size} bytes")


if __name__ == "__main__":
    if sys.argv[1] == "banner":
        banner(sys.argv[2])
    else:
        main(sys.argv[1])
