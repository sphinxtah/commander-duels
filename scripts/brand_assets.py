"""Make the web's brand images from the owner's two logo files (1254 x 1254 each).

- commander.duels.logo.png, with the words, goes on the Play page.
- commander.duels.logo.nowords.png, the CD monogram on a transparent background, is the sidebar
  mark and the favicon wherever the words are not needed. The home-screen icon puts it on the
  site's background, because iOS fills transparency with black.

Only these web-sized copies are in the repository. It needs Pillow, which the application does
not use, so run it in a throwaway container:

    docker run --rm -v "<folder with the logos>:/in:ro" -v "$PWD:/w" -w /w python:3.12.10-slim \\
        sh -c "pip install -q pillow && python scripts/brand_assets.py \\
        /in/commander.duels.logo.png /in/commander.duels.logo.nowords.png"
"""

import sys
from pathlib import Path

from PIL import Image  # type: ignore[import-not-found]

OUT = Path("web/public/brand")
SIZE = (1254, 1254)
# The site's background (theme-color in web/index.html).
BACKGROUND = (16, 24, 25, 255)


def open_logo(path: str, mode: str) -> Image.Image:
    image = Image.open(path).convert(mode)
    if image.size != SIZE:
        raise SystemExit(f"Expected a {SIZE[0]} x {SIZE[1]} logo, got {image.size} in {path}")
    return image


def main(words: str, nowords: str) -> None:
    logo = open_logo(words, "RGB")
    mark = open_logo(nowords, "RGBA")
    OUT.mkdir(parents=True, exist_ok=True)
    lanczos = Image.Resampling.LANCZOS
    logo.resize((720, 720), lanczos).save(OUT / "logo.webp", quality=86, method=6)
    mark.resize((128, 128), lanczos).save(OUT / "mark.webp", quality=90, method=6)
    for size in (32, 64):
        mark.resize((size, size), lanczos).save(OUT / f"favicon-{size}.png", optimize=True)
    touch = Image.new("RGBA", (180, 180), BACKGROUND)
    inner = mark.resize((156, 156), lanczos)
    touch.alpha_composite(inner, (12, 12))
    touch.convert("RGB").save(OUT / "touch-icon.png", optimize=True)
    for path in sorted(OUT.iterdir()):
        print(f"{path} {path.stat().st_size} bytes")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
