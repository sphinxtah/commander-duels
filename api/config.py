from ipaddress import IPv4Network, IPv6Network, ip_network
from typing import Literal

from pydantic import Field, HttpUrl, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url

Network = IPv4Network | IPv6Network


def parse_networks(value: str) -> list[Network]:
    """A comma-separated CIDR list; a bare address is a single host (/32 or /128)."""
    return [ip_network(item.strip(), strict=False) for item in value.split(",") if item.strip()]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CD_", env_file=".env", extra="ignore")
    environment: Literal["development", "test"] = "development"
    database_url: str = "postgresql+psycopg://commander:commander@127.0.0.1:5432/commander"
    engine_url: HttpUrl = HttpUrl("http://localhost:8090")
    public_url: HttpUrl = HttpUrl("http://localhost:5173")
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    worker_poll_seconds: float = Field(default=5, ge=0.1, le=60)
    # Google sign-in is off until a Web OAuth client ID is configured. The ID is public; the
    # application needs no Google client secret for the ID-token flow.
    google_client_id: str = ""
    # "open": a first Google sign-in creates an active player. "approval": it creates a pending
    # account that SysOp or an administrator approves or denies (AUTH06).
    signup_policy: Literal["open", "approval"] = "open"
    # SysOp's entrance exists only for clients in these networks; empty disables it.
    sysop_networks: str = ""
    # Proxies whose X-Forwarded-For is believed. Every other peer is the client itself.
    trusted_proxies: str = ""
    cookie_secure: bool = True
    player_idle_minutes: int = Field(default=14 * 24 * 60, ge=5)
    player_absolute_minutes: int = Field(default=30 * 24 * 60, ge=5)
    sysop_idle_minutes: int = Field(default=60, ge=5)
    sysop_absolute_minutes: int = Field(default=12 * 60, ge=5)
    # Role and account-status changes need a sign-in at most this old (AUTH03 reauthentication).
    reauth_minutes: int = Field(default=12 * 60, ge=1)

    @field_validator("database_url")
    @classmethod
    def validate_database(cls, value: str) -> str:
        url = make_url(value)
        if url.drivername not in {"postgresql+psycopg", "sqlite"}:
            raise ValueError("Use postgresql+psycopg; sqlite is supported for isolated tests only")
        return value

    @field_validator("sysop_networks", "trusted_proxies")
    @classmethod
    def validate_networks(cls, value: str) -> str:
        parse_networks(value)
        return value

    @model_validator(mode="after")
    def sysop_networks_exclude_proxies(self) -> "Settings":
        # Every request through a proxy arrives from the proxy's address. A SysOp network holding
        # a proxy would open SysOp to anyone the proxy forwards for if forwarding ever broke.
        for network in self.sysop_network_list:
            for proxy in self.trusted_proxy_list:
                if network.version == proxy.version and network.overlaps(proxy):
                    raise ValueError(f"CD_SYSOP_NETWORKS {network} overlaps trusted proxy {proxy}")
        return self

    @property
    def sysop_network_list(self) -> list[Network]:
        return parse_networks(self.sysop_networks)

    @property
    def trusted_proxy_list(self) -> list[Network]:
        return parse_networks(self.trusted_proxies)

    @property
    def allowed_origins(self) -> set[str]:
        """Browser origins allowed to send state-changing requests: the public URL's origin, plus
        its loopback twin (localhost and 127.0.0.1 are the same machine)."""
        url = self.public_url
        port = f":{url.port}" if url.port and url.port not in (80, 443) else ""
        hosts = {url.host or ""}
        if url.host in ("localhost", "127.0.0.1"):
            hosts |= {"localhost", "127.0.0.1"}
        return {f"{url.scheme}://{host}{port}" for host in hosts}
