from typing import Literal

from pydantic import Field, HttpUrl, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="CD_", env_file=".env", extra="ignore")
    environment: Literal["development", "test"] = "development"
    database_url: str = "postgresql+psycopg://commander:commander@127.0.0.1:5432/commander"
    engine_url: HttpUrl = HttpUrl("http://localhost:8090")
    public_url: HttpUrl = HttpUrl("http://localhost:5173")
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"
    worker_poll_seconds: float = Field(default=5, ge=0.1, le=60)
    google_client_id: str = ""

    @field_validator("database_url")
    @classmethod
    def validate_database(cls, value: str) -> str:
        url = make_url(value)
        if url.drivername not in {"postgresql+psycopg", "sqlite"}:
            raise ValueError("Use postgresql+psycopg; sqlite is supported for isolated tests only")
        return value
