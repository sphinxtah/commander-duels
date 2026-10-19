"""Play one development human-versus-bot game through the engine's seat API and print it.

A scripted player answers every prompt for the human seat (seat 0) the way a client would: it reads
the authorized view, picks an option id and submits it with the prompt id and revision. It also
checks every payload it receives for concealed information. Standard library only, so it runs
inside the API container without copying files into it:

    docker compose exec -T api python - < scripts/engine_human_game.py

Pass arguments after "-", for example: python - --deck legacy-mono-green-creatures --quiet.
With --schema and the jsonschema package, every payload is also validated against
contracts/engine-seat-view.schema.json. The engine must have CD_ENGINE_DEV_ENDPOINTS=true (the
Compose default). The last line is a JSON summary; the exit code is 0 for a finished, clean game.
"""

import argparse
import json
import os
import random
import re
import sys
import urllib.error
import urllib.request
import uuid
from collections import Counter
from typing import Any

UUID_TEXT = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
OBJECT_ID = re.compile(r"^o[0-9a-f]{16}$")


class Engine:
    def __init__(self, url: str) -> None:
        self.url = url.rstrip("/")
        self.token: str | None = None

    def call(self, method: str, path: str, body: Any = None) -> tuple[int, dict[str, Any]]:
        data = None if body is None else json.dumps(body).encode()
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        request = urllib.request.Request(self.url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read().decode() or "{}")


class Checks:
    """Client-side checks: what a seat receives must never describe concealed cards."""

    def __init__(self, schema_path: str | None) -> None:
        self.payloads = 0
        self.problems: list[str] = []
        self.validator: Any = None
        if schema_path:
            # Optional: the API image has it; the standard-library checks run without it.
            from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

            with open(schema_path, encoding="utf-8") as handle:
                self.validator = Draft202012Validator(json.load(handle))

    def snapshot(self, snapshot: dict[str, Any]) -> None:
        self.payloads += 1
        if self.validator is not None:
            for error in self.validator.iter_errors(snapshot):
                self.problem(f"schema: {error.message} at {list(error.absolute_path)}")
        allowed = {snapshot.get("game_id")}
        if snapshot.get("prompt"):
            allowed.add(snapshot["prompt"].get("id"))
        text = json.dumps(snapshot)
        for found in set(UUID_TEXT.findall(text)) - allowed:
            self.problem(f"an internal UUID reached the seat: {found}")
        if '"seed"' in text:
            self.problem("the shuffle seed reached the seat")
        view = snapshot.get("view") or {}
        opponent = view.get("opponent") or {}
        for key in ("hand", "library"):
            if key in opponent or key in (view.get("you") or {}):
                self.problem(f"a player's {key} contents reached the seat")
        if opponent and len(view.get("hand", [])) != (view.get("you") or {}).get("hand_count"):
            self.problem("own hand size disagrees with its count")
        for card in view.get("hand", []):
            if not OBJECT_ID.match(card.get("id", "")):
                self.problem(f"hand card without an opaque id: {card}")

    def problem(self, message: str) -> None:
        if len(self.problems) < 20:
            self.problems.append(message)


class ScriptedSeat:
    """An eager, slightly random player, so games progress and reach combat."""

    def __init__(self, seed: int) -> None:
        self.random = random.Random(seed)
        self.pay_prompts_in_a_row = 0

    def choose(self, prompt: dict[str, Any]) -> dict[str, Any]:
        options = prompt["options"]
        kind = prompt["kind"]
        self.pay_prompts_in_a_row = self.pay_prompts_in_a_row + 1 if kind == "pay_mana" else 0

        def by(action: str) -> list[dict[str, Any]]:
            return [option for option in options if option["action"] == action]

        def fresh(action: str) -> list[dict[str, Any]]:
            return [option for option in by(action) if not option["selected"]]

        pick = self.random.choice
        if kind == "priority":
            if by("play_land"):
                return pick(by("play_land"))
            if by("cast") and self.random.random() < 0.8:
                return pick(by("cast"))
            return by("pass")[0]
        if kind == "mulligan":
            return by("keep")[0]
        if kind == "pay_mana":
            sources = by("tap_source")
            return pick(sources) if sources and self.pay_prompts_in_a_row <= 6 else by("cancel")[0]
        if kind == "declare_attackers":
            if by("all_attack") and self.random.random() < 0.34:
                return by("all_attack")[0]
            if fresh("toggle_attacker") and self.random.random() < 0.5:
                return pick(fresh("toggle_attacker"))
            return by("done")[0]
        if kind == "declare_blockers":
            if fresh("toggle_blocker") and self.random.random() < 0.34:
                return pick(fresh("toggle_blocker"))
            return by("done")[0]
        if kind == "choose_target":
            chosen = any(option["selected"] for option in options)
            unchosen = fresh("choose")
            if (chosen or not unchosen) and by("done"):
                return by("done")[0]
            opponent = [option for option in unchosen if option["seat"] == 1]
            if opponent and self.random.random() < 0.7:
                return opponent[0]
            return pick(unchosen or options)
        if kind == "assign_amounts":
            return by("suggested")[0]
        return pick(options)


def describe(option: dict[str, Any]) -> str:
    label = option["label"] or "(hidden)"
    return f"{option['id']} {option['action']} {label}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default=os.environ.get("CD_ENGINE_URL", "http://engine:8090"))
    parser.add_argument("--seed", type=int, default=20261018)
    parser.add_argument("--deck", default="legacy-mono-red-burn", help="the human seat's deck")
    parser.add_argument("--skill", type=int, default=1)
    parser.add_argument("--turn-cap", type=int, default=30)
    parser.add_argument("--schema", help="validate payloads against this JSON Schema file")
    parser.add_argument("--quiet", action="store_true", help="print only the summary")
    args = parser.parse_args()

    def say(line: str) -> None:
        if not args.quiet:
            print(line, flush=True)

    engine = Engine(args.url)
    checks = Checks(args.schema)
    seat = ScriptedSeat(args.seed)
    body = {"seed": args.seed, "human_deck": args.deck, "skill": args.skill}
    status, created = engine.call("POST", "/v1/games", body | {"turn_cap": args.turn_cap})
    if status != 201:
        print(json.dumps({"summary": True, "error": f"create failed: {status} {created}"}))
        return 1
    game_id = created["game_id"]
    engine.token = created["seat_token"]
    say(f"Game {game_id}: you are seat {created['seat']} with {args.deck}; {created['settings']}")

    kinds: Counter[str] = Counter()
    verified: list[str] = []
    since, log_from, answered = -1, 0, 0
    snapshot: dict[str, Any] = {}
    while True:
        query = f"?since={since}&wait_ms=10000&log_from={log_from}"
        status, snapshot = engine.call("GET", f"/v1/games/{game_id}/view{query}")
        if status != 200:
            checks.problem(f"view returned {status}: {snapshot}")
            break
        checks.snapshot(snapshot)
        since = snapshot["revision"]
        for line in snapshot["log"]:
            say(f"    T{line['turn']} {line['text']}")
        log_from = snapshot["log_from"] + len(snapshot["log"])
        if snapshot["result"] is not None:
            break
        prompt = snapshot["prompt"]
        if prompt is None:
            continue
        kinds[prompt["kind"]] += 1
        you = snapshot["view"]["you"]
        opponent = snapshot["view"]["opponent"]
        say(
            f"[r{since}] T{snapshot['view']['turn']} {prompt['kind']}: {prompt['message']}"
            f" (you {you['life']} life, {you['hand_count']} cards;"
            f" bot {opponent['life']} life, {opponent['hand_count']} cards)"
        )
        say("    options: " + " | ".join(describe(option) for option in prompt["options"]))

        def command(option_id: str, revision: int, prompt_id: str) -> dict[str, Any]:
            return {
                "v": 1,
                "game_id": game_id,
                "action_id": str(uuid.uuid4()),
                "expected_revision": revision,
                "prompt_id": prompt_id,
                "type": "submit_choice",
                "payload": {"option_id": option_id},
            }

        commands = f"/v1/games/{game_id}/commands"
        if prompt["kind"] == "unsupported":
            say(f"    unsupported XMage request {prompt['xmage_query']}: conceding")
            concession = {
                "v": 1,
                "game_id": game_id,
                "action_id": str(uuid.uuid4()),
                "expected_revision": since,
                "type": "concede",
                "payload": {},
            }
            engine.call("POST", commands, concession)
            continue
        choice = seat.choose(prompt)
        answer = command(choice["id"], since, prompt["id"])
        if not verified:
            stale = answer | {"action_id": str(uuid.uuid4()), "expected_revision": since + 1}
            status, reply = engine.call("POST", commands, stale)
            if status != 409 or reply.get("code") != "stale_revision":
                checks.problem(f"a stale revision was not refused: {status} {reply}")
            verified.append("stale_revision")
        status, reply = engine.call("POST", commands, answer)
        if status != 200:
            checks.problem(f"answer refused: {status} {reply}")
            break
        answered += 1
        say(f"    -> {describe(choice)}")
        if len(verified) == 1:
            late = answer | {"action_id": str(uuid.uuid4())}
            status, reply = engine.call("POST", commands, late)
            if status != 409 or reply.get("code") != "stale_prompt":
                checks.problem(f"an answer to a closed prompt was not refused: {status} {reply}")
            verified.append("stale_prompt")

    result = snapshot.get("result") or {}
    summary = {
        "summary": True,
        "game_id": game_id,
        "result": result.get("kind"),
        "winner_seat": result.get("winner_seat"),
        "conceded": result.get("conceded"),
        "turns": result.get("turns"),
        "prompts_answered": answered,
        "prompt_kinds": dict(sorted(kinds.items())),
        "payloads_checked": checks.payloads,
        "schema_validated": checks.validator is not None,
        "refusals_verified": verified,
        "problems": checks.problems,
    }
    print(json.dumps(summary))
    clean = result.get("kind") in {"completed", "turn_limit"} and not checks.problems
    return 0 if clean and len(verified) == 2 else 1


if __name__ == "__main__":
    sys.exit(main())
