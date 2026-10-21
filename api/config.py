from ipaddress import IPv4Network, IPv6Network, ip_network
from typing import Literal

from pydantic import Field, HttpUrl, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url

Network = IPv4Network | IPv6Network


def parse_networks(value: str) -> list[Network]:
    """A comma-separated CIDR list; a bare address is a single host (/32 or /128)."""
    return [ip_network(item.strip(), strict=False) for item in value.split(",") if item.strip()]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CD_", env_file=".env", extra="ignore")
    # "production" refuses to start with development credentials or an unsafe proxy setup.
    environment: Literal["development", "test", "production"] = "development"
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
    # Shared with the engine, which serves service games only to requests carrying it. Empty
    # turns games off. At least 32 characters; only the API and the engine know it.
    engine_service_token: SecretStr = SecretStr("")
    # Games one account may have running at once; SysOp is not limited. The engine's own cap
    # (CD_ENGINE_MAX_GAMES) and games_max bound the total.
    games_per_account: int = Field(default=1, ge=1, le=8)
    games_max: int = Field(default=2, ge=1, le=64)
    # Card images are fetched from Scryfall once, kept in this folder and served from our own
    # origin; browsers never contact Scryfall. Empty turns card images off.
    card_image_dir: str = ""
    scryfall_url: HttpUrl = HttpUrl("https://api.scryfall.com")
    # The worker keeps Scryfall's bulk files here and imports them into the catalog. Empty turns
    # the catalog sync off.
    catalog_dir: str = ""
    # When the daily sync becomes due, in UTC, plus up to the jitter. Scryfall publishes its bulk
    # files at about 09:00 UTC.
    catalog_sync_time: str = Field(default="10:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$")
    catalog_sync_jitter_minutes: int = Field(default=30, ge=0, le=360)
    # Bounds on one bulk file: compressed, and unpacked.
    catalog_max_download_mb: int = Field(default=1024, ge=1, le=16384)
    catalog_max_dataset_mb: int = Field(default=4096, ge=1, le=65536)
    # MTGJSON's set files, whose booster data gives Leng's card shop its pull ratios (v0.4.0). The
    # worker reads them weekly into the catalog folder's mtgjson/; the catalog folder being empty
    # turns this off too.
    booster_url: HttpUrl = HttpUrl("https://mtgjson.com/api/v5")
    # The Planeswalker roster and the starter decks, content/ in the repository (the API image
    # holds a copy).
    content_dir: str = "content"
    # What Commander bots play when no deck is chosen for them: the starter decks, or the engine's
    # fixture decks, whose card names are unique to each deck as the browser journeys' leak
    # checks need.
    bot_decks: Literal["starters", "fixtures"] = "starters"

    @field_validator("database_url")
    @classmethod
    def validate_database(cls, value: str) -> str:
        url = make_url(value)
        if url.drivername not in {"postgresql+psycopg", "sqlite"}:
            raise ValueError("Use postgresql+psycopg; sqlite is supported for isolated tests only")
        return value

    @field_validator("engine_service_token")
    @classmethod
    def validate_service_token(cls, value: SecretStr) -> SecretStr:
        secret = value.get_secret_value().strip()
        if secret and len(secret) < 32:
            raise ValueError("CD_ENGINE_SERVICE_TOKEN must be at least 32 characters")
        return SecretStr(secret)

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

    @model_validator(mode="after")
    def production_is_hardened(self) -> "Settings":
        if self.environment != "production":
            return self
        problems = []
        if self.public_url.scheme != "https":
            problems.append("CD_PUBLIC_URL must use https")
        if not self.cookie_secure:
            problems.append("CD_COOKIE_SECURE must be true")
        database = make_url(self.database_url)
        if database.drivername != "postgresql+psycopg":
            problems.append("CD_DATABASE_URL must be PostgreSQL")
        if len(database.password or "") < 16 or database.password == "commander":
            problems.append("the database password must be generated (16 characters or more)")
        if not self.engine_service_token.get_secret_value():
            problems.append("CD_ENGINE_SERVICE_TOKEN is required")
        if not self.google_client_id:
            problems.append("CD_GOOGLE_CLIENT_ID is required")
        if not self.trusted_proxy_list:
            problems.append("CD_TRUSTED_PROXIES must list the host proxy and the web container")
        if any(network.prefixlen == 0 for network in self.sysop_network_list):
            problems.append("CD_SYSOP_NETWORKS may not include every address")
        if problems:
            raise ValueError("Production settings refused: " + "; ".join(problems))
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
