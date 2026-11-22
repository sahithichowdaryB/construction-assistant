import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine

load_dotenv(Path(__file__).with_name(".env"))


def engine_for(setting="DATABASE_URL"):
    """The pool of the login in environment variable `setting` (KeyError when it is not set)."""
    return _engine(os.environ[setting])


@lru_cache
def _engine(url: str):
    """One small pool per database login, shared by every caller (keyed by URL, so engine_for() and
    engine_for(setting="DATABASE_URL") are the same pool). The Supabase session pooler allows 15 clients per login,
    shared by every machine running the backend: each pool keeps DB_POOL_SIZE connections open (default 1) and opens
    up to DB_MAX_OVERFLOW more under load (default 4), which are closed again as soon as they are returned. Two
    machines then use at most 10 of the 15, leaving room for scripts."""
    return create_engine(
        url, pool_pre_ping=True,
        pool_size=int(os.environ.get("DB_POOL_SIZE") or 1), max_overflow=int(os.environ.get("DB_MAX_OVERFLOW") or 4),
        pool_timeout=30, hide_parameters=True, connect_args={"connect_timeout": 10},
    )


def writer_engine():
    """Ingestion writes use WRITER_DATABASE_URL; without it, the migration login is used."""
    return engine_for("WRITER_DATABASE_URL" if os.environ.get("WRITER_DATABASE_URL") else "MIGRATION_DATABASE_URL")


engine_for.cache_clear = _engine.cache_clear  # tests reset the pools between databases
