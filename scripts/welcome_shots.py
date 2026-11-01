"""The setup wizard's welcome screenshots (v0.8.4): web/e2e/welcome-shots.spec.ts saves each at
1280 x 800 as a PNG; this makes web/public/welcome/<name>-1280.webp and <name>-640.webp from them.

    python scripts/welcome_shots.py web/test-results/welcome
"""

import sys
from pathlib import Path

from PIL import Image

NAMES = ("table", "decks", "shop", "alliance")
OUT = Path(__file__).resolve().parent.parent / "web" / "public" / "welcome"


def main(folder: Path) -> int:
    made = 0
    for name in NAMES:
        source = folder / f"{name}.png"
        if not source.exists():
            print(f"{name}: no screenshot", file=sys.stderr)
            continue
        with Image.open(source) as shot:
            picture = shot.convert("RGB")
            if picture.size != (1280, 800):
                picture = picture.resize((1280, 800), Image.Resampling.LANCZOS)
            picture.save(OUT / f"{name}-1280.webp", "WEBP", quality=82, method=6)
            picture.resize((640, 400), Image.Resampling.LANCZOS).save(
                OUT / f"{name}-640.webp", "WEBP", quality=82, method=6
            )
        made += 1
        print(f"{name}: made")
    return 0 if made == len(NAMES) else 1


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1] if len(sys.argv) > 1 else "web/test-results/welcome")))
