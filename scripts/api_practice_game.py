"""Play one practice game through the API as a signed-in account, and print it.

The client signs in as SysOp, starts a practice game against bots with POST /api/v1/practice-games
and plays it over the game's WebSocket, the way the browser will: the session cookie, the CSRF
token in the first message, and commands with an action ID, the expected revision and the prompt
ID. Every snapshot is checked for concealed information (the engine client's checks), and with
--schemas validated against the seat-view contract. Along the way it proves, once per game:

- a second tab observes and cannot command; taking control moves the lease (AUTH07);
- a command resent after its tab dropped runs once (T14);
- SysOp's inspection view arrives, matches the public view's counts, validates against its
  contract and is audited.

It needs the websockets package (in requirements.lock) and SysOp's password in
CD_SYSOP_PASSWORD, from a SysOp network. Run it against the API or the web proxy:

    CD_SYSOP_PASSWORD=... python scripts/api_practice_game.py --url http://localhost:8080 \\
        --origin http://localhost:8080 --schemas contracts

The last line is a JSON summary; the exit code is 0 for a finished, clean game.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from websockets.exceptions import ConnectionClosed
from websockets.sync.client import ClientConnection, connect

sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine_human_game import Checks, ScriptedSeat, describe  # noqa: E402

FINISHED = {"completed", "turn_limit", "humans_eliminated"}


class Api:
    """HTTP with the session cookie, which urllib would not send over plain http (it is Secure)."""

    def __init__(self, url: str, origin: str | None) -> None:
        self.url = url.rstrip("/")
        self.origin = origin
        self.cookie = ""
        self.csrf = ""

    def call(self, method: str, path: str, body: Any = None) -> tuple[int, Any]:
        headers = {"Content-Type": "application/json"}
        if self.cookie:
            headers["Cookie"] = self.cookie
        if self.csrf and method != "GET":
            headers["X-CSRF-Token"] = self.csrf
        if self.origin and method != "GET":
            headers["Origin"] = self.origin
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                self.remember(response.headers.get_all("Set-Cookie") or [])
                text = response.read().decode()
                return response.status, json.loads(text) if text else None
        except urllib.error.HTTPError as error:
            text = error.read().decode()
            return error.code, json.loads(text) if text else None

    def remember(self, cookies: list[str]) -> None:
        for header in cookies:
            name, _, rest = header.partition("=")
            if name == "cd_session":
                self.cookie = f"cd_session={rest.split(';', 1)[0]}"

    def sign_in(self, password: str) -> dict[str, Any]:
        status, me = self.call(
            "POST", "/api/v1/sysop/login", {"username": "sysop", "password": password}
        )
        if status != 200:
            raise SystemExit(f"SysOp sign-in failed: {status} {me}")
        self.csrf = me["csrf_token"]
        return me  # type: ignore[no-any-return]

    def socket(self, game_id: str) -> ClientConnection:
        base = "ws" + self.url.removeprefix("http")
        return connect(
            f"{base}/api/v1/games/{game_id}/events",
            additional_headers={"Cookie": self.cookie},
            origin=self.origin,  # type: ignore[arg-type]
            open_timeout=10,
        )


class Tab:
    """One WebSocket to the game. Every message passes through ``seen``."""

    def __init__(self, api: Api, game_id: str, run: "Run", **hello: Any) -> None:
        self.run = run
        self.socket = api.socket(game_id)
        self.socket.send(json.dumps({"type": "hello", "csrf_token": api.csrf} | hello))
        self.welcome = self.until("welcome")

    def receive(self, timeout: float = 60) -> dict[str, Any]:
        message: dict[str, Any] = json.loads(self.socket.recv(timeout=timeout))
        self.run.seen(message)
        return message

    def until(self, kind: str, timeout: float = 60, **match: Any) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            message = self.receive(max(0.1, deadline - time.monotonic()))
            if message["type"] == kind and all(message.get(k) == v for k, v in match.items()):
                return message

    def send(self, message: dict[str, Any]) -> None:
        self.socket.send(json.dumps(message))

    def command(self, envelope: dict[str, Any]) -> dict[str, Any]:
        self.send({"type": "command", "command": envelope})
        return self.until("command_result", action_id=envelope["action_id"])

    def close(self) -> None:
        self.socket.close()


class Run:
    """What the game sent, checked as it arrives."""

    def __init__(self, args: argparse.Namespace) -> None:
        schemas = Path(args.schemas) if args.schemas else None
        self.checks = Checks(str(schemas / "engine-seat-view.schema.json") if schemas else None)
        self.inspection_validator = inspection_validator(schemas) if schemas else None
        self.snapshot: dict[str, Any] | None = None
        self.inspections = 0
        self.inspection_problems: list[str] = []
        self.verified: list[str] = []

    def seen(self, message: dict[str, Any]) -> None:
        if message["type"] == "snapshot":
            snapshot = message["snapshot"]
            self.checks.snapshot(0, snapshot)
            if self.snapshot is None or snapshot["revision"] >= self.snapshot["revision"]:
                self.snapshot = snapshot
        elif message["type"] == "inspection":
            self.inspect(message["inspection"])

    def inspect(self, inspection: dict[str, Any]) -> None:
        """SysOp's view: every hand and library, with the public view's counts."""
        self.inspections += 1
        if self.inspection_validator is not None:
            for error in self.inspection_validator.iter_errors(inspection):
                self.inspection_problem(f"schema: {error.message} at {list(error.absolute_path)}")
        counts = {p["seat"]: p for p in inspection["view"]["opponents"]}
        for player in inspection["players"]:
            public = counts.get(player["seat"], {})
            if len(player["hand"]) != public.get("hand_count"):
                self.inspection_problem(f"seat {player['seat']} hand differs from its count")
            if len(player["library"]) != public.get("library_count"):
                self.inspection_problem(f"seat {player['seat']} library differs from its count")

    def inspection_problem(self, message: str) -> None:
        if len(self.inspection_problems) < 20:
            self.inspection_problems.append(message)


def inspection_validator(schemas: Path) -> Any:
    from jsonschema import Draft202012Validator  # type: ignore[import-untyped]
    from referencing import Registry, Resource

    seat_view = json.loads((schemas / "engine-seat-view.schema.json").read_text())
    schema = json.loads((schemas / "engine-inspection.schema.json").read_text())
    registry = Registry().with_resource(seat_view["$id"], Resource.from_contents(seat_view))
    return Draft202012Validator(schema, registry=registry)


def envelope(snapshot: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "v": 1,
        "game_id": snapshot["game_id"],
        "action_id": str(uuid.uuid4()),
        "expected_revision": snapshot["revision"],
        "prompt_id": snapshot["prompt"]["id"],
        "type": "submit_choice",
        "payload": payload,
    }


def play(args: argparse.Namespace, api: Api, game_id: str, run: Run) -> dict[str, Any]:
    """Plays the seat to the end of the game; returns the last snapshot."""
    player = ScriptedSeat(args.seed, 0)
    control = Tab(api, game_id, run, control=True, inspect=args.inspect)
    observer = Tab(api, game_id, run)
    answered = 0
    kinds: dict[str, int] = {}
    while True:
        snapshot = run.snapshot
        if snapshot is None or (snapshot["prompt"] is None and snapshot["result"] is None):
            control.until("snapshot")
            continue
        if snapshot["result"] is not None:
            break
        prompt = snapshot["prompt"]
        kinds[prompt["kind"]] = kinds.get(prompt["kind"], 0) + 1
        if prompt["kind"] == "unsupported":
            print(f"    unsupported request {prompt['xmage_query']}: conceding", flush=True)
            concede = envelope(snapshot, {}) | {"type": "concede"}
            concede.pop("prompt_id")
            control.command(concede)
            control.until("snapshot")
            continue
        choice = player.choose(prompt, snapshot["view"])
        answer = envelope(snapshot, player.payload(prompt, choice))
        if not args.quiet:
            print(
                f"[r{snapshot['revision']}] T{snapshot['view']['turn']} {prompt['kind']}: "
                f"{prompt['message']} -> {describe(choice)}",
                flush=True,
            )

        if "observer_refused" not in run.verified and answered >= 3:
            # The observing tab cannot command, then takes control and answers instead.
            refused = observer.command(answer)
            if refused["status"] != 409 or refused["body"]["code"] != "not_controller":
                run.checks.problem(f"an observer's command was not refused: {refused}")
            observer.send({"type": "take_control"})
            observer.until("lease", role="controller")
            control.until("lease", role="observer", reason="taken_over")
            late = control.command(answer | {"action_id": str(uuid.uuid4())})
            if late["body"].get("code") != "not_controller":
                run.checks.problem(f"the tab that lost the lease still commanded: {late}")
            reply = observer.command(answer)
            control.send({"type": "take_control"})
            control.until("lease", role="controller")
            run.verified.append("observer_refused")
            run.verified.append("lease_taken_over")
        elif "resend_once" not in run.verified and answered >= 6:
            # The controlling tab drops after sending; a new tab resends the same action.
            control.send({"type": "command", "command": answer})
            control.close()
            control = Tab(
                api, game_id, run, control=True, inspect=args.inspect, since=snapshot["revision"]
            )
            control.until("lease", role="controller")
            reply = control.command(answer)
            if reply["status"] != 200 or reply["body"].get("status") != "accepted":
                run.checks.problem(f"a resent command was not accepted once: {reply}")
            again = control.command(answer)
            if again != reply:
                run.checks.problem(f"a second resend changed the result: {again} vs {reply}")
            run.verified.append("resend_once")
        else:
            reply = control.command(answer)
        if reply["status"] == 409 and reply["body"].get("code") == "stale_revision":
            control.until("snapshot")
            continue
        if reply["status"] != 200:
            run.checks.problem(f"answer refused: {reply}")
            break
        answered += 1
        while run.snapshot is not None and run.snapshot["revision"] <= snapshot["revision"]:
            control.until("snapshot")
    control.close()
    observer.close()
    assert run.snapshot is not None
    return {"last": run.snapshot, "answered": answered, "kinds": kinds}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default="http://localhost:8080")
    parser.add_argument("--origin", help="the Origin to send, such as http://localhost:8080")
    parser.add_argument("--format", choices=["legacy", "commander"], default="legacy")
    parser.add_argument("--bots", type=int, help="bots at the table (Commander: 1 to 3)")
    parser.add_argument("--deck", help="your fixture deck")
    parser.add_argument("--deck-list", help="a deck list file (SysOp may use any card)")
    parser.add_argument("--bot-skill", type=int, default=1)
    parser.add_argument("--turn-cap", type=int, default=30)
    parser.add_argument("--seed", type=int, default=20261019, help="the scripted player's seed")
    parser.add_argument("--no-inspect", dest="inspect", action="store_false")
    parser.add_argument("--schemas", help="the contracts folder, to validate every payload")
    parser.add_argument("--quiet", action="store_true", help="print only the summary")
    args = parser.parse_args()
    password = os.environ.get("CD_SYSOP_PASSWORD") or sys.stdin.readline().strip()

    api = Api(args.url, args.origin)
    api.sign_in(password)
    body: dict[str, Any] = {
        "format": args.format,
        "bot_skill": args.bot_skill,
        "turn_cap": args.turn_cap,
    }
    if args.bots:
        body["bots"] = [{} for _ in range(args.bots)]
    if args.deck:
        body["deck"] = args.deck
    if args.deck_list:
        body["deck_list"] = Path(args.deck_list).read_text(encoding="utf-8")
    started = time.monotonic()
    status, game = api.call("POST", "/api/v1/practice-games", body)
    if status != 201:
        print(json.dumps({"summary": True, "error": f"create failed: {status} {game}"}))
        return 1
    game_id = game["id"]
    if not args.quiet:
        print(f"Game {game_id}: {args.format}, seats {game['seats']}", flush=True)
    run = Run(args)
    try:
        played = play(args, api, game_id, run)
    except (ConnectionClosed, TimeoutError) as error:
        run.checks.problem(f"the WebSocket failed: {error!r}")
        played = {"last": run.snapshot or {}, "answered": 0, "kinds": {}}

    # The API records the result; SysOp's inspection openings are in the audit trail.
    recorded: dict[str, Any] = {}
    for _ in range(50):
        _, state = api.call("GET", f"/api/v1/games/{game_id}")
        recorded = state["game"]
        if recorded["status"] != "active":
            break
        time.sleep(0.2)
    _, audit = api.call("GET", "/api/v1/admin/audit?action=game.&limit=200")
    audited = sorted(
        {entry["action"] for entry in audit["items"] if entry["details"].get("game") == game_id}
    )
    if args.inspect and "game.inspection_opened" not in audited:
        run.checks.problem("the inspection was not audited")
    if args.inspect and run.inspections == 0:
        run.checks.problem("no inspection view arrived")

    result = played["last"].get("result") or {}
    summary = {
        "summary": True,
        "game_id": game_id,
        "format": args.format,
        "seats": [seat["player"] for seat in game["seats"]],
        "result": result.get("kind"),
        "winner_seat": result.get("winner_seat"),
        "turns": result.get("turns"),
        "recorded_status": recorded.get("status"),
        "recorded_result": (recorded.get("result") or {}).get("kind"),
        "prompts_answered": played["answered"],
        "prompt_kinds": dict(sorted(played["kinds"].items())),
        "payloads_checked": run.checks.payloads,
        "schema_validated": run.checks.validator is not None,
        "inspections": run.inspections,
        "inspections_validated": run.inspection_validator is not None,
        "audited": audited,
        "verified": run.verified,
        "seconds": round(time.monotonic() - started, 1),
        "problems": run.checks.problems + run.inspection_problems,
    }
    print(json.dumps(summary))
    clean = (
        result.get("kind") in FINISHED
        and recorded.get("status") == "finished"
        and not summary["problems"]
        and {"observer_refused", "lease_taken_over", "resend_once"} <= set(run.verified)
    )
    return 0 if clean else 1


if __name__ == "__main__":
    sys.exit(main())
