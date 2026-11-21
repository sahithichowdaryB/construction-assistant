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
    """The project member behind the bearer token: a signed-in account's session, or a static token."""
    digest = hashlib.sha256(credentials.credentials.encode()).hexdigest()
    member = conn.execute(text("""
        SELECT m.member_id, m.role, coalesce(m.display_name, m.member_id) AS display_name
        FROM sitemate.sessions s
        JOIN sitemate.project_members m ON m.auth_user_id = s.auth_user_id
        WHERE m.project_id = :project AND s.token_hash = :digest
          AND s.revoked_at IS NULL AND s.expires_at > now()
        UNION ALL
        SELECT member_id, role, coalesce(display_name, member_id) FROM sitemate.project_members
        WHERE project_id = :project AND token_hash = :digest
        LIMIT 1
    """), {"project": project_id, "digest": digest}).mappings().one_or_none()
    if member is None:
        raise HTTPException(403, "Project access denied")
    return dict(member)


def require_roles(*roles):
    """Dependency that admits only members with one of the given project roles."""
    def check(member=Depends(current_member)):
        if member["role"] not in roles:
            raise HTTPException(403, f"This action needs the {' or '.join(roles)} role")
        return member
    return check


def check_member(member=Depends(current_member)):
    return member


def require_writer(member=Depends(current_member)):
    if member["role"] not in WRITER_ROLES:
        raise HTTPException(403, "This action needs a contributor, manager or approver role")
    return member


def check_cutoff(as_of):
    if as_of is not None and as_of.utcoffset() is None:
        raise HTTPException(422, "as_of must include a time zone")
