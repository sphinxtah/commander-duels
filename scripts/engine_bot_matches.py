"""Run consecutive development bot matches against the engine and summarize them.

Standard library only, so it runs inside the API container without copying files into it:

    docker compose exec -T api python - --count 10 < scripts/engine_bot_matches.py

The engine must have CD_ENGINE_DEV_ENDPOINTS=true (the Compose default). Each line of output is
one match as JSON; the last line is a summary. Use --seed to repeat one seed (determinism check).
"""

import argparse
import json
import os
import statistics
import sys
import urllib.error
import urllib.request
from typing import Any


def run_match(url: str, body: dict[str, Any], timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{url.rstrip('/')}/v1/bot_match",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            result: dict[str, Any] = json.load(response)
            return result
    except urllib.error.HTTPError as error:
        return {"result": "http_error", "status": error.code, "body": error.read().decode()}


def summarize(rows: list[dict[str, Any]]) -> dict[str, Any]:
    def spread(key: str) -> dict[str, float] | None:
        values = [row[key] for row in rows if isinstance(row.get(key), int | float)]
        if not values:
            return None
        return {"min": min(values), "median": statistics.median(values), "max": max(values)}

    results = [row.get("result") for row in rows]
    heap = [row.get("heap_used_mb") for row in rows]
    return {
        "summary": True,
        "matches": len(rows),
        "results": {kind: results.count(kind) for kind in sorted(set(map(str, results)))},
        "completed_rate": results.count("completed") / len(rows) if rows else 0,
        "turns": spread("turns"),
        "duration_ms": spread("duration_ms"),
        "distinct_log_digests": len({row.get("log_sha256") for row in rows}),
        "winner_seats": [row.get("winner_seat") for row in rows],
        "heap_used_mb_first_last": [heap[0], heap[-1]] if heap else None,
        "engine_errors": sum(int(row.get("engine_errors") or 0) for row in rows),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default=os.environ.get("CD_ENGINE_URL", "http://engine:8090"))
    parser.add_argument("--count", type=int, default=10)
    parser.add_argument("--seed", type=int, help="use this seed for every match")
    parser.add_argument("--skill", type=int)
    parser.add_argument("--turn-cap", type=int)
    parser.add_argument("--time-budget", type=int, help="seconds per match")
    args = parser.parse_args()

    rows: list[dict[str, Any]] = []
    for index in range(1, args.count + 1):
        body: dict[str, Any] = {}
        if args.seed is not None:
            body["seed"] = args.seed
        if args.skill is not None:
            body["skill"] = args.skill
        if args.turn_cap is not None:
            body["turn_cap"] = args.turn_cap
        if args.time_budget is not None:
            body["time_budget_seconds"] = args.time_budget
        budget = body.get("time_budget_seconds", 600)
        result = run_match(args.url, body, timeout=budget + 60)
        diagnostics = result.get("diagnostics") or {}
        row = {
            "match": index,
            "seed": result.get("seed"),
            "result": result.get("result"),
            "winner_seat": result.get("winner_seat"),
            "starting_seat": result.get("starting_seat"),
            "turns": result.get("turns"),
            "duration_ms": result.get("duration_ms"),
            "engine_errors": result.get("engine_errors"),
            "cleanup": result.get("cleanup"),
            "log_lines": (result.get("log_summary") or {}).get("lines"),
            "log_sha256": (result.get("log_summary") or {}).get("sha256"),
            "heap_used_mb": diagnostics.get("heap_used_mb"),
            "live_threads": diagnostics.get("live_threads"),
            "game_threads": diagnostics.get("game_threads"),
            "error": result.get("error") or result.get("body"),
        }
        rows.append(row)
        print(json.dumps(row), flush=True)
    print(json.dumps(summarize(rows)))
    return 0 if all(row["result"] in {"completed", "turn_limit"} for row in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
