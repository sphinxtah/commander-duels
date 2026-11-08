"""Summarizes a campaign difficulty run (v0.9.1, docs/campaign.md "Difficulty").

The engine's CampaignDifficulty (engine/src/test) plays a reference deck suite against each ward and
writes a JSON report; this prints one row a ward: games, the reference's wins, the wardens' wins,
the rest (turn cap, draw, timeout, error), the median game length, and the earliest reference turn
of the first hit and of the first lethal threat.

    python scripts/campaign_difficulty.py engine/target/campaign-difficulty.json
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


def summary(report: dict[str, Any]) -> list[dict[str, Any]]:
    by_ward: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for game in report["games"]:
        by_ward[int(game["ward"])].append(game)
    rows = []
    for ward in sorted(by_ward):
        games = by_ward[ward]
        hits = [g["firstHit"] for g in games if g.get("firstHit") is not None]
        lethal = [g["firstLethal"] for g in games if g.get("firstLethal") is not None]
        rows.append(
            {
                "ward": ward,
                "games": len(games),
                "reference": sum(g["outcome"] == "reference" for g in games),
                "warden": sum(g["outcome"] == "warden" for g in games),
                "other": sum(g["outcome"] not in ("reference", "warden") for g in games),
                "median_turns": statistics.median(g["turns"] for g in games),
                "first_hit": min(hits) if hits else None,
                "first_lethal": min(lethal) if lethal else None,
            }
        )
    return rows


def main() -> None:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "engine/target/campaign-difficulty.json")
    report = json.loads(path.read_text(encoding="utf-8"))
    print(f"Reference skill {report['reference_skill']}")
    print("ward games ref warden other turns hit lethal")
    for row in summary(report):
        print(
            f"{row['ward']:>4} {row['games']:>5} {row['reference']:>3} {row['warden']:>6} "
            f"{row['other']:>5} {row['median_turns']:>5} {row['first_hit'] or '-':>3} "
            f"{row['first_lethal'] or '-':>6}"
        )


if __name__ == "__main__":
    main()
