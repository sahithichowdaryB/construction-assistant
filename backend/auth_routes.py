"""Sign-in with Supabase Auth accounts: email and password in, a bearer session token out.

The password is checked by `sitemate.verify_password` inside the database. A successful login
creates a row in `sitemate.sessions` holding only the SHA-256 of a random token; the token itself
goes to the web app, which keeps it in an httpOnly cookie. Every project route then resolves the
token to a project member and role (deps.current_member).
"""

import hashlib
import logging
import os
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import text

from database import writer_engine
from deps import connection

router = APIRouter(prefix="/auth", tags=["auth"])
log = logging.getLogger("sitemate.auth")
bearer = HTTPBearer()

SESSION_HOURS = 12
REMEMBER_DAYS = 30
# Slow down password guessing: at most 5 failed attempts per email in 10 minutes.
MAX_FAILURES, FAILURE_WINDOW = 5, 600
_failures: dict[str, list[float]] = {}
_lock = threading.Lock()


class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=200)
    remember: bool = False


def _digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _recent_failures(key: str) -> int:
    now = time.monotonic()
    with _lock:
        recent = [t for t in _failures.get(key, []) if now - t < FAILURE_WINDOW]
        _failures[key] = recent
        return len(recent)


def _record_failure(key: str):
    with _lock:
        _failures.setdefault(key, []).append(time.monotonic())


def _memberships(conn, user_id):
    rows = conn.execute(text("""
        SELECT m.project_id, p.name AS project_name, m.member_id, m.role,
               coalesce(m.display_name, m.member_id) AS display_name
        FROM sitemate.project_members m JOIN sitemate.projects p ON p.id = m.project_id
        WHERE m.auth_user_id = :u ORDER BY m.project_id
    """), {"u": user_id}).mappings().all()
    return [dict(r) for r in rows]


def _user_view(user_id, email, memberships):
    name = memberships[0]["display_name"] if memberships else email
    return {"id": str(user_id), "email": email, "name": name}


@router.post("/login")
def login(body: LoginIn, request: Request):
    email = body.email.strip().lower()
    if _recent_failures(email) >= MAX_FAILURES:
        raise HTTPException(429, "Too many failed sign-in attempts. Wait a few minutes and try again.")
    with writer_engine().begin() as conn:
        user_id = conn.scalar(text("SELECT sitemate.verify_password(:e, :p)"), {"e": email, "p": body.password})
        if user_id is None:
            _record_failure(email)
            raise HTTPException(401, "Email or password is incorrect")
        memberships = _memberships(conn, user_id)
        if not memberships:
            raise HTTPException(403, "This account is not a member of any project")
        token = secrets.token_urlsafe(32)
        lifetime = timedelta(days=REMEMBER_DAYS) if body.remember else timedelta(hours=SESSION_HOURS)
        expires = datetime.now(timezone.utc) + lifetime
        conn.execute(text("""
            INSERT INTO sitemate.sessions (token_hash, auth_user_id, email, expires_at, user_agent)
            VALUES (:h, :u, :e, :x, :ua)
        """), {"h": _digest(token), "u": user_id, "e": email, "x": expires,
               "ua": (request.headers.get("user-agent") or "")[:300]})
        conn.execute(text("UPDATE auth.users SET last_sign_in_at = now() WHERE id = :u"), {"u": user_id})
    with _lock:
        _failures.pop(email, None)
    return {"token": token, "expires_at": expires, "user": _user_view(user_id, email, memberships),
            "memberships": memberships}


@router.get("/me")
def me(credentials: HTTPAuthorizationCredentials = Depends(bearer), conn=Depends(connection)):
    session = conn.execute(text("""
        SELECT auth_user_id, email, expires_at FROM sitemate.sessions
        WHERE token_hash = :h AND revoked_at IS NULL AND expires_at > now()
    """), {"h": _digest(credentials.credentials)}).mappings().one_or_none()
    if session is None:
        raise HTTPException(401, "Session expired. Sign in again.")
    memberships = _memberships(conn, session["auth_user_id"])
    return {"user": _user_view(session["auth_user_id"], session["email"], memberships),
            "memberships": memberships, "expires_at": session["expires_at"]}


RESET_MINUTES = 30
MAX_RESET_REQUESTS, RESET_WINDOW = 3, 900
_reset_requests: dict[str, list[float]] = {}
GENERIC_RESET = "If an account exists for that email, a reset link has been sent. It is valid for 30 minutes."


class ForgotIn(BaseModel):
    email: str = Field(min_length=3, max_length=320)


class ResetIn(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    password: str = Field(min_length=10, max_length=200)


def _strong(password: str) -> bool:
    return any(c.isalpha() for c in password) and any(c.isdigit() for c in password)


@router.post("/password/forgot")
def forgot_password(body: ForgotIn):
    """Issue a single-use reset link. The answer is the same whether or not the account exists.

    The link is delivered through the configured channel. No mail service is set up in this project,
    so the link goes to the API log, and with AUTH_DEV_RESET_LINKS=true it is also returned to the
    page (development only: anyone who knows an email could then reset that account).
    """
    email = body.email.strip().lower()
    now = time.monotonic()
    with _lock:
        recent = [t for t in _reset_requests.get(email, []) if now - t < RESET_WINDOW]
        if len(recent) >= MAX_RESET_REQUESTS:
            raise HTTPException(429, "Too many reset requests. Wait a few minutes and try again.")
        _reset_requests[email] = recent + [now]
    link = None
    with writer_engine().begin() as conn:
        user_id = conn.scalar(text("SELECT id FROM auth.users WHERE lower(email) = :e AND deleted_at IS NULL"),
                              {"e": email})
        if user_id is not None:
            token = secrets.token_urlsafe(32)
            conn.execute(text("""
                INSERT INTO sitemate.password_resets (token_hash, auth_user_id, expires_at)
                VALUES (:h, :u, now() + make_interval(mins => :m))
            """), {"h": _digest(token), "u": user_id, "m": RESET_MINUTES})
            link = f"{os.environ.get('APP_URL', 'http://localhost:3000').rstrip('/')}/reset-password?token={token}"
            log.warning("Password reset link for %s (valid %s min): %s", email, RESET_MINUTES, link)
    out = {"message": GENERIC_RESET}
    if link and os.environ.get("AUTH_DEV_RESET_LINKS", "").lower() == "true":
        out["dev_reset_url"] = link
    return out


@router.post("/password/reset")
def reset_password(body: ResetIn):
    """Set a new password with a valid reset link; every open session of the account is signed out."""
    if not _strong(body.password):
        raise HTTPException(422, "Use at least 10 characters with letters and numbers")
    with writer_engine().begin() as conn:
        user_id = conn.scalar(text("""
            UPDATE sitemate.password_resets SET used_at = now()
            WHERE token_hash = :h AND used_at IS NULL AND expires_at > now()
            RETURNING auth_user_id
        """), {"h": _digest(body.token)})
        if user_id is None:
            raise HTTPException(400, "This reset link is invalid or has expired. Request a new one.")
        conn.execute(text("""UPDATE auth.users SET encrypted_password = extensions.crypt(:pw, extensions.gen_salt('bf')),
                                 updated_at = now() WHERE id = :u"""), {"pw": body.password, "u": user_id})
        conn.execute(text("UPDATE sitemate.password_resets SET used_at = now() "
                          "WHERE auth_user_id = :u AND used_at IS NULL"), {"u": user_id})
        conn.execute(text("UPDATE sitemate.sessions SET revoked_at = now() "
                          "WHERE auth_user_id = :u AND revoked_at IS NULL"), {"u": user_id})
    return {"message": "Your password has been changed. Sign in with the new password."}


@router.post("/logout", status_code=204)
def logout(credentials: HTTPAuthorizationCredentials = Depends(bearer)):
    with writer_engine().begin() as conn:
        conn.execute(text("UPDATE sitemate.sessions SET revoked_at = now() "
                          "WHERE token_hash = :h AND revoked_at IS NULL"), {"h": _digest(credentials.credentials)})
