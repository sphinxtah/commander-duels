"""Play one development game through the engine's seat API and print it.

A scripted player answers every prompt for every human seat the way a client would: each seat uses
its own seat token, reads its authorized view, picks an option id and submits it with the prompt id
and revision. Every payload any seat receives is checked for concealed information. Standard library
only, so it runs inside the API container without copying files into it:

    docker compose exec -T api python - < scripts/engine_human_game.py

Pass arguments after "-", for example: python - --format commander --seats human,human,bot,bot.
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
import threading
import urllib.error
import urllib.request
import uuid
from collections import Counter
from typing import Any

UUID_TEXT = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
OBJECT_ID = re.compile(r"^o[0-9a-f]{16}$")
FINISHED = {"completed", "turn_limit", "humans_eliminated"}


class Engine:
    def __init__(self, url: str, token: str | None = None) -> None:
        self.url = url.rstrip("/")
        self.token = token

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
        self.lock = threading.Lock()
        self.payloads = 0
        self.problems: list[str] = []
        self.validator: Any = None
        if schema_path:
            # Optional: the API image has it; the standard-library checks run without it.
            from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

            with open(schema_path, encoding="utf-8") as handle:
                self.validator = Draft202012Validator(json.load(handle))

    def snapshot(self, seat: int, snapshot: dict[str, Any]) -> None:
        with self.lock:
            self.payloads += 1
        if self.validator is not None:
            for error in self.validator.iter_errors(snapshot):
                self.problem(f"seat {seat} schema: {error.message} at {list(error.absolute_path)}")
        if snapshot.get("seat") != seat:
            self.problem(f"seat {seat} was sent seat {snapshot.get('seat')}'s snapshot")
        allowed = {snapshot.get("game_id")}
        if snapshot.get("prompt"):
            allowed.add(snapshot["prompt"].get("id"))
        text = json.dumps(snapshot)
        for found in set(UUID_TEXT.findall(text)) - allowed:
            self.problem(f"an internal UUID reached seat {seat}: {found}")
        if '"seed"' in text:
            self.problem(f"the shuffle seed reached seat {seat}")
        for entry in (snapshot.get("settings") or {}).get("seats", []):
            if entry.get("seat") != seat and entry.get("deck") is not None:
                self.problem(f"seat {seat} was told seat {entry.get('seat')}'s deck")
        view = snapshot.get("view") or {}
        you = view.get("you") or {}
        for player in [you, *(view.get("opponents") or [])]:
            for key in ("hand", "library"):
                if key in player:
                    self.problem(f"seat {player.get('seat')}'s {key} contents reached seat {seat}")
        if you and len(view.get("hand", [])) != you.get("hand_count"):
            self.problem(f"seat {seat}'s hand size disagrees with its count")
        for card in view.get("hand", []):
            if not OBJECT_ID.match(card.get("id", "")):
                self.problem(f"hand card without an opaque id: {card}")

    def problem(self, message: str) -> None:
        with self.lock:
            if len(self.problems) < 20:
                self.problems.append(message)


class ScriptedSeat:
    """An eager, slightly random player, so games progress, reach combat and cast commanders."""

    def __init__(self, seed: int, seat: int) -> None:
        self.random = random.Random(seed * 10 + seat)
        self.seat = seat
        self.pay_prompts_in_a_row = 0

    def choose(self, prompt: dict[str, Any], view: dict[str, Any]) -> dict[str, Any]:
        options = prompt["options"]
        kind = prompt["kind"]
        self.pay_prompts_in_a_row = self.pay_prompts_in_a_row + 1 if kind == "pay_mana" else 0

        def by(action: str) -> list[dict[str, Any]]:
            return [option for option in options if option["action"] == action]

        def fresh(action: str) -> list[dict[str, Any]]:
            return [option for option in by(action) if not option["selected"]]

        pick = self.random.choice
        if kind == "priority":
            commanders = {c["object_id"] for c in (view.get("you") or {}).get("commanders", [])}
            commander = [option for option in by("cast") if option["object_id"] in commanders]
            if by("play_land"):
                return pick(by("play_land"))
            if commander and self.random.random() < 0.9:
                return commander[0]
            if by("cast") and self.random.random() < 0.8:
                return pick(by("cast"))
            return by("pass")[0]
        if kind == "mulligan":
            return by("keep")[0]
        if kind == "yes_no" and "command zone" in prompt["message"] and by("yes"):
            return by("yes")[0]
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
        if kind in ("choose_target", "choose_defender"):
            chosen = any(option["selected"] for option in options)
            unchosen = fresh("choose")
            if (chosen or not unchosen) and by("done"):
                return by("done")[0]
            opponents = [o for o in unchosen if o["seat"] is not None and o["seat"] != self.seat]
            if opponents and self.random.random() < 0.7:
                return pick(opponents)
            return pick(unchosen or options)
        if kind == "choose_ability" and by("use_ability"):
            return pick(by("use_ability"))
        if kind == "choose_choice" and by("choose"):
            return pick(by("choose"))
        if kind == "assign_amounts":
            return by("suggested")[0]
        return pick(options)


def describe(option: dict[str, Any]) -> str:
    label = option["label"] or "(hidden)"
    return f"{option['id']} {option['action']} {label}"


def command(
    game_id: str, revision: int, prompt_id: str | None, kind: str, payload: Any
) -> dict[str, Any]:
    body = {
        "v": 1,
        "game_id": game_id,
        "action_id": str(uuid.uuid4()),
        "expected_revision": revision,
        "type": kind,
        "payload": payload,
    }
    if prompt_id is not None:
        body["prompt_id"] = prompt_id
    return body


class Table:
    """The game's human seats, each played on its own thread."""

    def __init__(self, args: argparse.Namespace, game_id: str, tokens: dict[int, str]) -> None:
        self.args = args
        self.game_id = game_id
        self.tokens = tokens
        self.checks = Checks(args.schema)
        self.output = threading.Lock()
        self.kinds: Counter[str] = Counter()
        self.answered: Counter[int] = Counter()
        self.verified: list[str] = []
        self.results: dict[int, dict[str, Any]] = {}
        self.log_seat = min(tokens)

    def say(self, line: str) -> None:
        if not self.args.quiet:
            with self.output:
                print(line, flush=True)

    def play(self, seat: int) -> None:
        engine = Engine(self.args.url, self.tokens[seat])
        player = ScriptedSeat(self.args.seed, seat)
        commands = f"/v1/games/{self.game_id}/commands"
        since, log_from = -1, 0
        snapshot: dict[str, Any] = {}
        while True:
            query = f"?since={since}&wait_ms=10000&log_from={log_from}"
            status, snapshot = engine.call("GET", f"/v1/games/{self.game_id}/view{query}")
            if status != 200:
                self.checks.problem(f"seat {seat} view returned {status}: {snapshot}")
                break
            self.checks.snapshot(seat, snapshot)
            since = snapshot["revision"]
            if seat == self.log_seat:
                for line in snapshot["log"]:
                    self.say(f"    T{line['turn']} {line['text']}")
                log_from = snapshot["log_from"] + len(snapshot["log"])
            if snapshot["result"] is not None:
                break
            prompt = snapshot["prompt"]
            if prompt is None:
                continue
            with self.output:
                self.kinds[prompt["kind"]] += 1
            view = snapshot["view"]
            others = ", ".join(
                f"seat {o['seat']} {o['life']} life{' (out)' if o['lost'] else ''}"
                for o in view["opponents"]
            )
            detail = f" [{prompt['detail']}]" if prompt["detail"] else ""
            self.say(
                f"[seat {seat} r{since}] T{view['turn']} {prompt['kind']}:"
                f" {prompt['message']}{detail}"
                f" (you {view['you']['life']} life, {view['you']['hand_count']} cards; {others})"
            )
            self.say("    options: " + " | ".join(describe(option) for option in prompt["options"]))
            if prompt["kind"] == "unsupported":
                self.say(
                    f"    unsupported XMage request {prompt['xmage_query']}: seat {seat} concedes"
                )
                engine.call("POST", commands, command(self.game_id, since, None, "concede", {}))
                continue
            choice = player.choose(prompt, view)
            answer = command(
                self.game_id, since, prompt["id"], "submit_choice", {"option_id": choice["id"]}
            )
            self.probe_before(seat, engine, answer)
            status, reply = engine.call("POST", commands, answer)
            if status == 409 and reply.get("code") == "stale_revision":
                continue  # the seat's view changed while its prompt was open; read it again
            if status != 200:
                self.checks.problem(f"seat {seat} answer refused: {status} {reply}")
                break
            with self.output:
                self.answered[seat] += 1
            self.say(f"    -> seat {seat}: {describe(choice)}")
            self.probe_after(engine, answer)
        self.results[seat] = snapshot

    def probe_before(self, seat: int, engine: Engine, answer: dict[str, Any]) -> None:
        """Once per game: refuse a stale revision, and another seat answering this prompt."""
        with self.output:
            if "stale_revision" in self.verified:
                return
            self.verified.append("stale_revision")
        stale = answer | {
            "action_id": str(uuid.uuid4()),
            "expected_revision": answer["expected_revision"] + 1,
        }
        status, reply = engine.call("POST", f"/v1/games/{self.game_id}/commands", stale)
        if status != 409 or reply.get("code") != "stale_revision":
            self.checks.problem(f"a stale revision was not refused: {status} {reply}")
        other = next((token for other, token in self.tokens.items() if other != seat), None)
        if other is not None:
            intruder = Engine(self.args.url, other)
            _, theirs = intruder.call("GET", f"/v1/games/{self.game_id}/view")
            forged = answer | {
                "action_id": str(uuid.uuid4()),
                "expected_revision": theirs.get("revision", 0),
            }
            status, reply = intruder.call("POST", f"/v1/games/{self.game_id}/commands", forged)
            if status != 409 or reply.get("code") != "stale_prompt":
                self.checks.problem(f"another seat answered seat {seat}'s prompt: {status} {reply}")
            with self.output:
                self.verified.append("other_seat")

    def probe_after(self, engine: Engine, answer: dict[str, Any]) -> None:
        with self.output:
            if "stale_prompt" in self.verified:
                return
            self.verified.append("stale_prompt")
        late = answer | {"action_id": str(uuid.uuid4())}
        status, reply = engine.call("POST", f"/v1/games/{self.game_id}/commands", late)
        if status != 409 or reply.get("code") != "stale_prompt":
            self.checks.problem(f"an answer to a closed prompt was not refused: {status} {reply}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default=os.environ.get("CD_ENGINE_URL", "http://engine:8090"))
    parser.add_argument("--seed", type=int, default=20261018)
    parser.add_argument("--format", choices=["legacy", "commander"], default="legacy")
    parser.add_argument(
        "--seats",
        help="players in seat order, for example human,bot,bot,bot"
        " (default: human,bot for legacy and human,bot,bot,bot for commander)",
    )
    parser.add_argument(
        "--deck", help="the first human seat's deck; other seats get the format's fixtures"
    )
    parser.add_argument("--skill", type=int, default=1)
    parser.add_argument("--turn-cap", type=int, default=30)
    parser.add_argument("--schema", help="validate payloads against this JSON Schema file")
    parser.add_argument("--quiet", action="store_true", help="print only the summary")
    args = parser.parse_args()

    default_seats = "human,bot" if args.format == "legacy" else "human,bot,bot,bot"
    players = [player.strip() for player in (args.seats or default_seats).split(",")]
    seats: list[dict[str, Any]] = [{"player": player} for player in players]
    if args.deck and "human" in players:
        seats[players.index("human")]["deck"] = args.deck
    body = {
        "seed": args.seed,
        "format": args.format,
        "seats": seats,
        "skill": args.skill,
        "turn_cap": args.turn_cap,
    }
    status, created = Engine(args.url).call("POST", "/v1/games", body)
    if status != 201:
        print(json.dumps({"summary": True, "error": f"create failed: {status} {created}"}))
        return 1
    game_id = created["game_id"]
    tokens = {
        entry["seat"]: entry["seat_token"] for entry in created["seats"] if entry["seat_token"]
    }
    table = Table(args, game_id, tokens)
    table.say(f"Game {game_id}: {args.format}, seats {players}; {created['settings']}")
    threads = [threading.Thread(target=table.play, args=(seat,), daemon=True) for seat in tokens]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    result = (table.results.get(table.log_seat) or {}).get("result") or {}
    summary = {
        "summary": True,
        "game_id": game_id,
        "format": args.format,
        "seats": players,
        "result": result.get("kind"),
        "winner_seat": result.get("winner_seat"),
        "conceded_seats": result.get("conceded_seats"),
        "turns": result.get("turns"),
        "prompts_answered": sum(table.answered.values()),
        "prompts_by_seat": {str(seat): count for seat, count in sorted(table.answered.items())},
        "prompt_kinds": dict(sorted(table.kinds.items())),
        "payloads_checked": table.checks.payloads,
        "schema_validated": table.checks.validator is not None,
        "refusals_verified": table.verified,
        "problems": table.checks.problems,
    }
    print(json.dumps(summary))
    expected = {"stale_revision", "stale_prompt"} | ({"other_seat"} if len(tokens) > 1 else set())
    clean = result.get("kind") in FINISHED and not table.checks.problems
    return 0 if clean and expected <= set(table.verified) else 1


if __name__ == "__main__":
    sys.exit(main())
