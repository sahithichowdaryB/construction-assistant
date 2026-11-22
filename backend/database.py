import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine

load_dotenv(Path(__file__).with_name(".env"))


@lru_cache
def engine_for(setting="DATABASE_URL"):
    return create_engine(
        os.environ[setting], pool_pre_ping=True, pool_size=2, max_overflow=2,
        hide_parameters=True, connect_args={"connect_timeout": 10},
    )


def writer_engine():
    """Ingestion writes use WRITER_DATABASE_URL; without it, the migration login is used."""
    return engine_for("WRITER_DATABASE_URL" if os.environ.get("WRITER_DATABASE_URL") else "MIGRATION_DATABASE_URL")


_warned = set()


def _fallback(setting, reason):
    if setting not in _warned:
        _warned.add(setting)
        import logging
        logging.getLogger("sitemate.database").warning(
            "%s is not set: %s uses the writer login instead. Provision the least-privilege role "
            "(see backend/README.md) before sharing this deployment.", setting, reason)
    return writer_engine()


def ops_engine():
    """Manager actions and the worker use OPS_DATABASE_URL (sitemate_ops); without it, the writer login (like
    writer_engine, which itself falls back to the migration login)."""
    if os.environ.get("OPS_DATABASE_URL"):
        return engine_for("OPS_DATABASE_URL")
    return _fallback("OPS_DATABASE_URL", "manager actions and the worker")
