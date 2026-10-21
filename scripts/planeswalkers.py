"""The Planeswalker Alliance's roster and portraits (v0.3.1).

- "roster" writes content/planeswalkers.json from the owner's tier list
  (docs/plans/0.3.1-planeswalkers.csv) and the portrait folder's avatar-roster.json and
  avatar-guide-descriptions.json: each Planeswalker's stable ID, name, tier, Planeswalker subtype,
  first Planeswalker card and a one-line description of its portrait for alternative text. The
  Godlike tier's Planeswalker is added by hand below; its cards are uploaded by SysOp and never
  named here. Standard library only.
- "portraits" makes the web sizes of the owner's 1254 x 1254 portraits (WebP with alpha, 128, 256
  and 512 px, contain-fitted, never cropped) into web/public/portraits/<id>-<size>.webp. The masters
  stay outside the repository. It needs Pillow, which the application does not use, so run it in
  a throwaway container:

    docker run --rm -v "<repo>/Planeswalkers images:/in:ro" -v "<repo>:/w" -w /w \
        python:3.12.10-slim sh -c "pip install -q pillow && \
        python scripts/planeswalkers.py portraits /in"

Usage: python scripts/planeswalkers.py roster "Planeswalkers images"
"""

import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TIERS = ROOT / "docs" / "plans" / "0.3.1-planeswalkers.csv"
ROSTER = ROOT / "content" / "planeswalkers.json"
PORTRAITS = ROOT / "web" / "public" / "portraits"
SIZES = (128, 256, 512)
TIER_ORDER = ("bronze", "silver", "gold", "platinum", "mythic", "godlike")
GODLIKE = {
    "id": "the-sphinx",
    "name": "The Sphinx",
    "tier": "godlike",
    "subtype": "Sphinx",
    "first_card": None,
    "first_printed": None,
    "description": None,
    "portrait": False,
    "custom": True,
}


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def roster(folder: Path) -> None:
    descriptions = json.loads((folder / "avatar-guide-descriptions.json").read_text("utf-8"))
    files = {
        entry["character"]: entry["filename"]
        for entry in json.loads((folder / "avatar-roster.json").read_text("utf-8"))
    }
    with TIERS.open(encoding="utf-8", newline="") as source:
        rows = list(csv.DictReader(source))
    planeswalkers = []
    for row in rows:
        name = row["character"]
        if files.get(name) != row["image_file"]:
            raise SystemExit(
                f"{name}: the tier list names {row['image_file']}, the folder {files.get(name)}"
            )
        planeswalkers.append(
            {
                "id": slug(name),
                "name": name,
                "tier": row["tier"],
                # Empty for The Wanderer, whose card has no Planeswalker subtype.
                "subtype": row["planeswalker_subtype"] or None,
                "first_card": row["first_planeswalker_card"],
                "first_printed": row["first_printed"],
                "description": descriptions[name],
                "portrait": True,
                "custom": False,
            }
        )
    planeswalkers.append(GODLIKE)
    planeswalkers.sort(
        key=lambda entry: (TIER_ORDER.index(entry["tier"]), entry["name"].casefold())
    )
    ids = [entry["id"] for entry in planeswalkers]
    if len(set(ids)) != len(ids):
        raise SystemExit("Two Planeswalkers share an ID")
    content = {
        "version": 1,
        "source": "The owner's tier list of 2026-10-20 (docs/plans/0.3.1-planeswalkers.csv).",
        "planeswalkers": planeswalkers,
    }
    # LF on every system, as the repository keeps text.
    with ROSTER.open("w", encoding="utf-8", newline="\n") as out:
        out.write(json.dumps(content, indent=2, ensure_ascii=False) + "\n")
    print(f"{len(planeswalkers)} Planeswalkers written to {ROSTER}")


def portraits(folder: Path) -> None:
    from PIL import Image  # type: ignore[import-not-found]

    entries = json.loads(ROSTER.read_text("utf-8"))["planeswalkers"]
    files = {
        entry["character"]: entry["filename"]
        for entry in json.loads((folder / "avatar-roster.json").read_text("utf-8"))
    }
    PORTRAITS.mkdir(parents=True, exist_ok=True)
    total = 0
    for entry in entries:
        if not entry["portrait"]:
            continue
        with Image.open(folder / files[entry["name"]]) as master:
            image = master.convert("RGBA")
        for size in SIZES:
            copy = image.copy()
            copy.thumbnail((size, size), Image.Resampling.LANCZOS)
            canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
            canvas.paste(copy, ((size - copy.width) // 2, (size - copy.height) // 2))
            target = PORTRAITS / f"{entry['id']}-{size}.webp"
            canvas.save(target, "WEBP", quality=82, method=6, exact=False)
            total += target.stat().st_size
    print(f"Portraits written to {PORTRAITS}: {total / 1_000_000:.1f} MB")


def main(argv: list[str]) -> None:
    if len(argv) != 3 or argv[1] not in ("roster", "portraits"):
        raise SystemExit(__doc__)
    folder = Path(argv[2])
    roster(folder) if argv[1] == "roster" else portraits(folder)


if __name__ == "__main__":
    main(sys.argv)
