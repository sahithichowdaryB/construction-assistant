"""Manager-action dependencies. Connections and membership checks come from deps.py; this adds the
write-capable (sitemate_ops) connection and a manager/approver gate that returns the member."""

from fastapi import Depends, HTTPException

from database import ops_engine
from deps import check_member, connection, current_member  # noqa: F401  (re-exported for ops.py)

MANAGER_ROLES = ("manager", "approver")


def ops_connection():
    """Write identity (sitemate_ops) for manager actions; separate so the reader stays read-only."""
    try:
        engine = ops_engine()
    except KeyError:
        raise HTTPException(503, "No write login is configured (OPS_DATABASE_URL or MIGRATION_DATABASE_URL)") from None
    with engine.connect() as conn:
        yield conn


def current_manager(member=Depends(current_member)) -> dict:
    if member["role"] not in MANAGER_ROLES:
        raise HTTPException(403, "A manager or approver role is required")
    return member
