from typing import Literal

from pydantic import BaseModel, ConfigDict

from api.version import APP_VERSION


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Error(Contract):
    code: str
    message: str
    request_id: str


class Health(Contract):
    status: Literal["ok"] = "ok"
    version: str = APP_VERSION


class Readiness(Contract):
    status: Literal["ready", "not_ready"]
    database: Literal["ready", "unavailable", "migration_required"]


class Capability(Contract):
    id: str
    name: str
    available: bool = False
    milestone: str
    reason: str


class Bootstrap(Contract):
    name: Literal["Commander Duels"] = "Commander Duels"
    version: str = APP_VERSION
    protocol_version: Literal[1] = 1
    collection_policy: Literal["open_collection"] = "open_collection"
    capabilities: list[Capability]


class Format(Contract):
    id: Literal["commander", "legacy", "two_headed_giant"]
    name: str
    seats: list[int]
    default_seats: int
    description: str
    available: bool = False


class EngineStatus(Contract):
    status: Literal["unavailable", "scaffold"]
    protocol_version: Literal[1] = 1
    gameplay_available: Literal[False] = False
