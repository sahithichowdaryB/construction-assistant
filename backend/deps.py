"""Shared request dependencies: database connection, project membership and time cutoffs."""

import hashlib

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import text

from database import engine_for

bearer = HTTPBearer()
WRITER_ROLES = ("contributor", "manager", "approver")


def connection():
    with engine_for().connect() as conn:
        yield conn


def current_member(project_id: str, credentials: HTTPAuthorizationCredentials = Depends(bearer),
                   conn=Depends(connection)):
    digest = hashlib.sha256(credentials.credentials.encode()).hexdigest()
    member = conn.execute(text("""
        SELECT member_id, role FROM sitemate.project_members
        WHERE project_id=:project AND token_hash=:digest
    """), {"project": project_id, "digest": digest}).mappings().one_or_none()
    if member is None:
        raise HTTPException(403, "Project access denied")
    return dict(member)


def check_member(member=Depends(current_member)):
    return member


def require_writer(member=Depends(current_member)):
    if member["role"] not in WRITER_ROLES:
        raise HTTPException(403, "This action needs a contributor, manager or approver role")
    return member


def check_cutoff(as_of):
    if as_of is not None and as_of.utcoffset() is None:
        raise HTTPException(422, "as_of must include a time zone")
