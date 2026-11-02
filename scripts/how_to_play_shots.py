"""How to play's screenshots of the table (v0.8.6): web/e2e/how-to-play-shots.spec.ts saves each at
1280 x 800 as a PNG, with marks.json saying where the places the guide points at lie on them; this
makes web/public/how-to-play/<name>-1280.webp and <name>-640.webp, and writes the marks to
web/src/howToPlay/shots.json, which the guide reads.

    python scripts/how_to_play_shots.py web/test-results/how-to-play
"""

import json
import sys
from pathlib import Path

from PIL import Image

NAMES = ("table", "commander", "attacking", "blocking", "stack", "prompt")
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "public" / "how-to-play"
SHOTS = ROOT / "web" / "src" / "howToPlay" / "shots.json"
SIZE = (1280, 800)


def main(folder: Path) -> int:
    marks = json.loads((folder / "marks.json").read_text(encoding="utf-8"))
    # Shots made before keep their entries when this run has no picture of them.
    shots = json.loads(SHOTS.read_text(encoding="utf-8")) if SHOTS.exists() else {}
    OUT.mkdir(parents=True, exist_ok=True)
    for name in NAMES:
        source = folder / f"{name}.png"
        if not source.exists() or name not in marks:
            print(f"{name}: no screenshot", file=sys.stderr)
            continue
        with Image.open(source) as shot:
            picture = shot.convert("RGB")
            if picture.size != SIZE:
                picture = picture.resize(SIZE, Image.Resampling.LANCZOS)
            picture.save(OUT / f"{name}-1280.webp", "WEBP", quality=82, method=6)
            picture.resize((640, 400), Image.Resampling.LANCZOS).save(
                OUT / f"{name}-640.webp", "WEBP", quality=82, method=6
            )
        shots[name] = {"width": SIZE[0], "height": SIZE[1], "marks": marks[name]}
        print(f"{name}: made")
    SHOTS.write_text(json.dumps(shots, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1] if len(sys.argv) > 1 else "web/test-results/how-to-play")))
