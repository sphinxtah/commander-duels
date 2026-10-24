"""Play one development game through the engine's seat API and print it.

A scripted player answers every prompt for every human seat the way a client would: each seat uses
its own seat token, reads its authorized view, picks an option id and submits it with the prompt id
and revision. A spectator thread watches the public view with the game's spectator token. Every
payload any seat or the spectator receives is checked for concealed information. Standard library
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
# The scripted seat's answer to a choose_name prompt that offers no visible card's name: typed.
TYPED_NAME: dict[str, Any] = {"id": "-", "action": "text", "label": "Black Lotus"}


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
        self.spectator_payloads = 0
        self.problems: list[str] = []
        self.validator: Any = None
        if schema_path:
            # Optional: the API image has it; the standard-library checks run without it.
            from jsonschema import Draft202012Validator  # type: ignore[import-untyped]

            with open(schema_path, encoding="utf-8") as handle:
                self.validator = Draft202012Validator(json.load(handle))

    def spectator(self, snapshot: dict[str, Any]) -> None:
        """A spectator sees no seat, prompt, hand or deck: public information only."""
        with self.lock:
            self.spectator_payloads += 1
        view = snapshot.get("view") or {}
        if snapshot.get("prompt") is not None or view.get("you") is not None or view.get("hand"):
            self.problem("a spectator was sent a prompt, a seat's state or a hand")
        if any(player.get("hand") is not None for player in view.get("opponents") or []):
            self.problem("a spectator was sent a player's hand")
        self.snapshot(None, snapshot)

    def snapshot(self, seat: int | None, snapshot: dict[str, Any]) -> None:
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
        opponents = view.get("opponents") or []
        # Since v0.5.1 a seat controlling another player's turn (rule 723) sees what that player
        # may see while the control lasts: the player's entry names the seat in controlled_by.
        controlled = {
            player.get("seat")
            for player in opponents
            if seat is not None and player.get("controlled_by") == seat
        }
        teams = {player.get("team") for player in opponents if player.get("seat") in controlled}
        for player in [you, *opponents]:
            # Since v0.5.0 a player carries `hand`, null but for a Two-Headed Giant teammate's,
            # whose hand is the seat's to see (rule 810.5), and since v0.5.1 for a player whose
            # turn the seat controls, or that player's teammate (723.4).
            team = player.get("team")
            teammate = player is not you and team is not None and team == you.get("team")
            shown = player is not you and (
                teammate or player.get("seat") in controlled or (team is not None and team in teams)
            )
            for key in ("hand", "library"):
                if player.get(key) is not None and not (key == "hand" and shown):
                    self.problem(f"seat {player.get('seat')}'s {key} contents reached seat {seat}")
        prompt = snapshot.get("prompt") or {}
        for_seat = prompt.get("for_seat")
        if for_seat is not None and for_seat not in controlled:
            self.problem(
                f"seat {seat} was asked for seat {for_seat}, whose turn it does not control"
            )
        controller = you.get("controlled_by")
        seats = (snapshot.get("settings") or {}).get("seats", [])
        human_controller = any(
            entry.get("seat") == controller and entry.get("player") == "human" for entry in seats
        )
        if prompt and for_seat is None and controller is not None and human_controller:
            self.problem(
                f"seat {seat} was asked for itself while seat {controller} controls its turn"
            )
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
        if kind == "choose_mode":
            if by("done") and (not by("choose_mode") or self.random.random() < 0.5):
                return by("done")[0]
            return pick(by("choose_mode") or options)
        if kind == "order_triggers":
            return pick(by("put_first"))
        if kind == "choose_pile":
            return pick(by("choose_pile"))
        if kind == "choose_choice" and by("choose"):
            return pick(by("choose"))
        if kind == "choose_name":
            # A visible card's name when one is offered; otherwise a name in every card-name list.
            return pick(by("choose")) if by("choose") else TYPED_NAME
        if kind == "assign_amounts":
            return by("suggested")[0]
        return pick(options)

    def payload(self, prompt: dict[str, Any], choice: dict[str, Any]) -> dict[str, Any]:
        """The answer: the option, a typed name, or for choose_amount sometimes a number above the
        minimum."""
        if choice is TYPED_NAME:
            return {"text": choice["label"]}
        if prompt["kind"] == "choose_amount" and prompt["amounts"]:
            entry = prompt["amounts"]["entries"][0]
            value = entry["min"] + self.random.randint(0, min(2, entry["max"] - entry["min"]))
            if value != entry["min"]:
                return {"amounts": [value]}
        return {"option_id": choice["id"]}


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

    def __init__(
        self, args: argparse.Namespace, game_id: str, tokens: dict[int, str], spectator: str
    ) -> None:
        self.args = args
        self.game_id = game_id
        self.tokens = tokens
        self.spectator_token = spectator
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
            payload = player.payload(prompt, choice)
            answer = command(self.game_id, since, prompt["id"], "submit_choice", payload)
            self.probe_before(seat, engine, answer)
            status, reply = engine.call("POST", commands, answer)
            if status == 409 and reply.get("code") == "stale_revision":
                continue  # the seat's view changed while its prompt was open; read it again
            if status != 200:
                self.checks.problem(f"seat {seat} answer refused: {status} {reply}")
                break
            with self.output:
                self.answered[seat] += 1
            chosen = f"amount {payload['amounts'][0]}" if "amounts" in payload else describe(choice)
            self.say(f"    -> seat {seat}: {chosen}")
            self.probe_after(engine, answer)
        self.results[seat] = snapshot

    def watch(self) -> None:
        """The spectator: long-polls the public view until the game's result reaches it."""
        engine = Engine(self.args.url, self.spectator_token)
        since = -1
        while True:
            query = f"?since={since}&wait_ms=10000"
            status, snapshot = engine.call("GET", f"/v1/games/{self.game_id}/view{query}")
            if status != 200:
                self.checks.problem(f"spectator view returned {status}: {snapshot}")
                return
            self.checks.spectator(snapshot)
            since = snapshot["revision"]
            if snapshot["result"] is not None:
                return

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
    parser.add_argument(
        "--spectator-delay", type=int, default=0, help="seconds the spectator view runs behind"
    )
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
        "spectator_delay_seconds": args.spectator_delay,
    }
    status, created = Engine(args.url).call("POST", "/v1/games", body)
    if status != 201:
        print(json.dumps({"summary": True, "error": f"create failed: {status} {created}"}))
        return 1
    game_id = created["game_id"]
    tokens = {
        entry["seat"]: entry["seat_token"] for entry in created["seats"] if entry["seat_token"]
    }
    table = Table(args, game_id, tokens, created["spectator_token"])
    table.say(f"Game {game_id}: {args.format}, seats {players}; {created['settings']}")
    threads = [threading.Thread(target=table.play, args=(seat,), daemon=True) for seat in tokens]
    threads.append(threading.Thread(target=table.watch, daemon=True))
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
        "spectator_payloads": table.checks.spectator_payloads,
        "schema_validated": table.checks.validator is not None,
        "refusals_verified": table.verified,
        "problems": table.checks.problems,
    }
    print(json.dumps(summary))
    expected = {"stale_revision", "stale_prompt"} | ({"other_seat"} if len(tokens) > 1 else set())
    clean = (
        result.get("kind") in FINISHED
        and not table.checks.problems
        and table.checks.spectator_payloads > 0
    )
    return 0 if clean and expected <= set(table.verified) else 1


if __name__ == "__main__":
    sys.exit(main())
