"""Authentication endpoints: bootstrap, login/logout, /me, Google, invites.

All public (no guard in main.py) — each endpoint does exactly the checking it
needs. Passwords are argon2id (argon2-cffi); Google sign-in verifies a Google
Identity Services ID token posted by the frontend (no OAuth redirect dance).
Onboarding is invite-only: accounts are only ever created by ``/bootstrap``
(first user, empty DB) or by accepting an invite (password or Google path).
"""
from __future__ import annotations

import json
import os

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from ..auth import (
    ALL_MODIFY,
    AuthContext,
    clear_session_cookie,
    create_session,
    current_user,
    delete_session,
    effective_perms,
    hash_token,
    purge_expired_sessions,
    SESSION_COOKIE,
    set_session_cookie,
)
from ..db import get_db

router = APIRouter(prefix="/api", tags=["auth"])

_hasher = PasswordHasher()


class LoginIn(BaseModel):
    email: str
    password: str


class BootstrapIn(BaseModel):
    email: str
    password: str
    display_name: str = ""


class GoogleIn(BaseModel):
    credential: str
    invite_token: str | None = None


class PasswordIn(BaseModel):
    current_password: str | None = None
    new_password: str


class InviteAcceptIn(BaseModel):
    password: str
    display_name: str = ""


class ProfileIn(BaseModel):
    display_name: str


class UiStateIn(BaseModel):
    last_text_id: int | None = None
    last_route: str | None = None


_RESUMABLE_ROUTES = ("/", "/workspace", "/translate", "/phonetics", "/documents")


# ─── Payload helpers ───────────────────────────────────────────────────────────

def _role_names(conn, user_id: int, org_id: int) -> list[str]:
    return [r["name"] for r in conn.execute(
        "SELECT r.name FROM org_memberships om "
        "JOIN membership_roles mr ON mr.membership_id = om.id "
        "JOIN roles r ON r.id = mr.role_id "
        "WHERE om.user_id = ? AND om.org_id = ? ORDER BY r.name",
        (user_id, org_id),
    )]


def _me_payload(conn, user_id: int) -> dict:
    user = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if user is None:
        # Dev bridge (SAPCHE_AUTH_DISABLED): a synthetic superuser with no row.
        orgs = [
            {"id": o["id"], "name": o["name"], "can_manage_org": True,
             "perms": dict(ALL_MODIFY), "roles": []}
            for o in conn.execute("SELECT id, name FROM organizations ORDER BY id")
        ]
        return {"user": {"id": user_id, "email": "dev@localhost", "display_name": "Dev",
                         "is_superuser": True, "has_password": True,
                         "has_google": False}, "orgs": orgs}
    if user["is_superuser"]:
        # Superusers see every org; access is implicit, so no role names.
        orgs = [
            {"id": o["id"], "name": o["name"], "can_manage_org": True,
             "perms": dict(ALL_MODIFY), "roles": _role_names(conn, user_id, o["id"])}
            for o in conn.execute("SELECT id, name FROM organizations ORDER BY id")
        ]
    else:
        orgs = []
        for m in conn.execute(
            "SELECT o.id, o.name FROM org_memberships om "
            "JOIN organizations o ON o.id = om.org_id WHERE om.user_id = ? ORDER BY o.id",
            (user_id,),
        ).fetchall():
            perms, can_manage = effective_perms(conn, user_id, m["id"])
            orgs.append({"id": m["id"], "name": m["name"],
                         "can_manage_org": can_manage, "perms": perms,
                         "roles": _role_names(conn, user_id, m["id"])})
    return {
        "user": {"id": user["id"], "email": user["email"],
                 "display_name": user["display_name"],
                 "is_superuser": bool(user["is_superuser"]),
                 "has_password": user["password_hash"] is not None,
                 "has_google": user["google_sub"] is not None},
        "orgs": orgs,
    }


def _start_session(conn, response: Response, user_id: int) -> dict:
    purge_expired_sessions(conn)
    raw = create_session(conn, user_id)
    conn.commit()
    set_session_cookie(response, raw)
    return _me_payload(conn, user_id)


# ─── Bootstrap (first user) ────────────────────────────────────────────────────

@router.get("/auth/bootstrap-needed")
def bootstrap_needed():
    conn = get_db()
    try:
        empty = conn.execute("SELECT 1 FROM users LIMIT 1").fetchone() is None
        return {"bootstrap_needed": empty}
    finally:
        conn.close()


@router.post("/auth/bootstrap")
def bootstrap(payload: BootstrapIn, response: Response):
    """Create the FIRST account: platform admin + org-1 admin. 403 once users exist."""
    conn = get_db()
    try:
        if conn.execute("SELECT 1 FROM users LIMIT 1").fetchone():
            raise HTTPException(403, "Already bootstrapped")
        cur = conn.execute(
            "INSERT INTO users (email, display_name, password_hash, is_superuser) "
            "VALUES (?, ?, ?, 1)",
            (payload.email.strip(), payload.display_name.strip(),
             _hasher.hash(payload.password)),
        )
        user_id = cur.lastrowid
        m = conn.execute(
            "INSERT INTO org_memberships (org_id, user_id) VALUES (1, ?)", (user_id,)
        )
        admin_role = conn.execute(
            "SELECT id FROM roles WHERE org_id = 1 AND can_manage_org = 1 ORDER BY id LIMIT 1"
        ).fetchone()
        if admin_role:
            conn.execute(
                "INSERT INTO membership_roles (membership_id, role_id) VALUES (?, ?)",
                (m.lastrowid, admin_role["id"]),
            )
        # The pre-platform single local user was id 1 (reading_positions rows); the
        # person bootstrapping IS that user, so adopt their positions.
        conn.execute(
            "UPDATE OR IGNORE reading_positions SET user_id = ? WHERE user_id = 1",
            (user_id,),
        )
        return _start_session(conn, response, user_id)
    finally:
        conn.close()


# ─── Password login ────────────────────────────────────────────────────────────

@router.post("/auth/login")
def login(payload: LoginIn, response: Response):
    conn = get_db()
    try:
        user = conn.execute(
            "SELECT * FROM users WHERE email = ?", (payload.email.strip(),)
        ).fetchone()
        if user is None or not user["password_hash"]:
            raise HTTPException(401, "Invalid email or password")
        try:
            _hasher.verify(user["password_hash"], payload.password)
        except VerifyMismatchError:
            raise HTTPException(401, "Invalid email or password")
        if _hasher.check_needs_rehash(user["password_hash"]):
            conn.execute("UPDATE users SET password_hash = ? WHERE id = ?",
                         (_hasher.hash(payload.password), user["id"]))
        return _start_session(conn, response, user["id"])
    finally:
        conn.close()


@router.post("/auth/logout", status_code=204)
def logout(request: Request, response: Response):
    raw = request.cookies.get(SESSION_COOKIE)
    if raw:
        conn = get_db()
        try:
            delete_session(conn, raw)
            conn.commit()
        finally:
            conn.close()
    clear_session_cookie(response)


@router.get("/auth/me")
def me(ctx: AuthContext = Depends(current_user)):
    conn = get_db()
    try:
        return _me_payload(conn, ctx.user_id)
    finally:
        conn.close()


@router.patch("/auth/profile")
def update_profile(payload: ProfileIn, ctx: AuthContext = Depends(current_user)):
    """Edit one's own display name (email is the identity key — immutable)."""
    conn = get_db()
    try:
        conn.execute("UPDATE users SET display_name = ? WHERE id = ?",
                     (payload.display_name.strip(), ctx.user_id))
        conn.commit()
        return _me_payload(conn, ctx.user_id)
    finally:
        conn.close()


# ─── Per-org resume state (last open text + tab) ───────────────────────────────
# Needs a user AND an org but no section permission — a translate-only user still
# has a location. Org comes from the X-Org-Id header; membership is the gate.

def _member_org_or_403(conn, ctx: AuthContext, request: Request) -> int:
    raw = request.headers.get("X-Org-Id")
    if raw is None:
        raise HTTPException(400, "Missing X-Org-Id header")
    try:
        org_id = int(raw)
    except ValueError:
        raise HTTPException(400, "Bad X-Org-Id header")
    if not ctx.is_superuser and effective_perms(conn, ctx.user_id, org_id) is None:
        raise HTTPException(403, "Not a member of this organization")
    return org_id


@router.get("/auth/state")
def get_ui_state(request: Request, ctx: AuthContext = Depends(current_user)):
    conn = get_db()
    try:
        org_id = _member_org_or_403(conn, ctx, request)
        row = conn.execute(
            "SELECT last_text_id, last_route FROM user_org_state "
            "WHERE user_id = ? AND org_id = ?", (ctx.user_id, org_id)).fetchone()
        return dict(row) if row else {"last_text_id": None, "last_route": None}
    finally:
        conn.close()


@router.put("/auth/state")
def put_ui_state(payload: UiStateIn, request: Request,
                 ctx: AuthContext = Depends(current_user)):
    if payload.last_route is not None and payload.last_route not in _RESUMABLE_ROUTES:
        raise HTTPException(400, "Unknown route")
    conn = get_db()
    try:
        org_id = _member_org_or_403(conn, ctx, request)
        if payload.last_text_id is not None:
            owner = conn.execute("SELECT org_id FROM texts WHERE id = ?",
                                 (payload.last_text_id,)).fetchone()
            if owner is None or owner["org_id"] != org_id:
                raise HTTPException(400, "Text is not in this organization")
        conn.execute(
            "INSERT INTO user_org_state (user_id, org_id, last_text_id, last_route, updated_at) "
            "VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT(user_id, org_id) DO UPDATE SET "
            "last_text_id = excluded.last_text_id, last_route = excluded.last_route, "
            "updated_at = CURRENT_TIMESTAMP",
            (ctx.user_id, org_id, payload.last_text_id, payload.last_route))
        conn.commit()
        return {"last_text_id": payload.last_text_id, "last_route": payload.last_route}
    finally:
        conn.close()


@router.post("/auth/password", status_code=204)
def change_password(payload: PasswordIn, ctx: AuthContext = Depends(current_user)):
    """Set or change one's own password (current required iff one exists)."""
    conn = get_db()
    try:
        user = conn.execute("SELECT * FROM users WHERE id = ?", (ctx.user_id,)).fetchone()
        if user is None:
            raise HTTPException(404, "No such user")
        if user["password_hash"]:
            if not payload.current_password:
                raise HTTPException(400, "Current password required")
            try:
                _hasher.verify(user["password_hash"], payload.current_password)
            except VerifyMismatchError:
                raise HTTPException(403, "Current password is wrong")
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?",
                     (_hasher.hash(payload.new_password), ctx.user_id))
        conn.commit()
    finally:
        conn.close()


# ─── Google sign-in (GIS ID token) ─────────────────────────────────────────────

def _verify_google_credential(credential: str) -> dict:
    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    if not client_id:
        raise HTTPException(503, "Google sign-in is not configured")
    from google.auth.transport import requests as google_requests
    from google.oauth2 import id_token

    try:
        claims = id_token.verify_oauth2_token(
            credential, google_requests.Request(), client_id
        )
    except ValueError:
        raise HTTPException(401, "Invalid Google credential")
    if not claims.get("email") or not claims.get("email_verified"):
        raise HTTPException(403, "Google account has no verified email")
    return claims


@router.post("/auth/google")
def google_login(payload: GoogleIn, response: Response):
    claims = _verify_google_credential(payload.credential)
    conn = get_db()
    try:
        user = conn.execute(
            "SELECT * FROM users WHERE google_sub = ?", (claims["sub"],)
        ).fetchone()
        if user is None:
            # Link Google onto an existing account with the same (verified) email.
            user = conn.execute(
                "SELECT * FROM users WHERE email = ?", (claims["email"],)
            ).fetchone()
            if user is not None:
                conn.execute("UPDATE users SET google_sub = ? WHERE id = ?",
                             (claims["sub"], user["id"]))
        if user is None:
            # New account: only through a valid invite (invite-only platform).
            invite = _valid_invite(conn, payload.invite_token) if payload.invite_token else None
            if invite is None:
                raise HTTPException(403, "invite_required")
            if invite["email"].lower() != claims["email"].lower():
                raise HTTPException(403, "Invite was issued for a different email")
            cur = conn.execute(
                "INSERT INTO users (email, display_name, google_sub) VALUES (?, ?, ?)",
                (claims["email"], claims.get("name", ""), claims["sub"]),
            )
            _grant_invite(conn, invite, cur.lastrowid)
            return _start_session(conn, response, cur.lastrowid)
        # Existing account: an accompanying invite just grants the membership.
        if payload.invite_token:
            invite = _valid_invite(conn, payload.invite_token)
            if invite is not None and invite["email"].lower() == user["email"].lower():
                _grant_invite(conn, invite, user["id"])
        return _start_session(conn, response, user["id"])
    finally:
        conn.close()


# ─── Invites ───────────────────────────────────────────────────────────────────

def _valid_invite(conn, raw_token: str):
    return conn.execute(
        "SELECT i.*, o.name AS org_name FROM invites i "
        "JOIN organizations o ON o.id = i.org_id "
        "WHERE i.token_hash = ? AND i.accepted_at IS NULL "
        "AND i.expires_at > datetime('now')",
        (hash_token(raw_token),),
    ).fetchone()


def _grant_invite(conn, invite, user_id: int) -> None:
    """Membership + the invite's roles; marks the invite used. Idempotent-ish."""
    conn.execute(
        "INSERT OR IGNORE INTO org_memberships (org_id, user_id) VALUES (?, ?)",
        (invite["org_id"], user_id),
    )
    m = conn.execute(
        "SELECT id FROM org_memberships WHERE org_id = ? AND user_id = ?",
        (invite["org_id"], user_id),
    ).fetchone()
    for role_id in json.loads(invite["role_ids"] or "[]"):
        # Roles may have been edited/deleted since the invite was minted.
        if conn.execute("SELECT 1 FROM roles WHERE id = ? AND org_id = ?",
                        (role_id, invite["org_id"])).fetchone():
            conn.execute(
                "INSERT OR IGNORE INTO membership_roles (membership_id, role_id) "
                "VALUES (?, ?)", (m["id"], role_id),
            )
    conn.execute("UPDATE invites SET accepted_at = CURRENT_TIMESTAMP WHERE id = ?",
                 (invite["id"],))


@router.get("/invites/{token}")
def invite_info(token: str):
    """Public: what the invite-accept screen shows. 410 for dead links."""
    conn = get_db()
    try:
        invite = _valid_invite(conn, token)
        if invite is None:
            raise HTTPException(410, "This invite link is no longer valid")
        existing = conn.execute(
            "SELECT 1 FROM users WHERE email = ?", (invite["email"],)
        ).fetchone()
        return {"email": invite["email"], "org_name": invite["org_name"],
                "account_exists": existing is not None}
    finally:
        conn.close()


@router.post("/invites/{token}/accept")
def invite_accept(token: str, payload: InviteAcceptIn, request: Request,
                  response: Response):
    """Password path: create the account (or add the membership) and sign in."""
    conn = get_db()
    try:
        invite = _valid_invite(conn, token)
        if invite is None:
            raise HTTPException(410, "This invite link is no longer valid")
        user = conn.execute(
            "SELECT * FROM users WHERE email = ?", (invite["email"],)
        ).fetchone()
        if user is not None:
            # Existing account: honor the invite only for a session that IS that
            # user (else someone with the link could hijack the account).
            try:
                ctx = current_user(request)
            except HTTPException:
                raise HTTPException(
                    409, "An account with this email already exists — log in first, "
                         "then open the invite link again")
            if ctx.user_id != user["id"]:
                raise HTTPException(403, "This invite was issued to a different account")
            _grant_invite(conn, invite, user["id"])
            conn.commit()
            return _me_payload(conn, user["id"])
        cur = conn.execute(
            "INSERT INTO users (email, display_name, password_hash) VALUES (?, ?, ?)",
            (invite["email"], payload.display_name.strip(),
             _hasher.hash(payload.password)),
        )
        _grant_invite(conn, invite, cur.lastrowid)
        return _start_session(conn, response, cur.lastrowid)
    finally:
        conn.close()
