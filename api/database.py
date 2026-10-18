from sqlalchemy import Engine, create_engine


def build_engine(url: str) -> Engine:
    kwargs = {"connect_timeout": 3} if url.startswith("postgresql") else {}
    return create_engine(url, pool_pre_ping=True, connect_args=kwargs)
