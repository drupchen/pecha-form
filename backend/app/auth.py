"""Accounts, sessions, and per-org authorization.

Identity enters the request path here and only here. The pieces:

- **Session cookie** ``sapche_session``: the browser holds a raw random token,
  ``sessions`` stores its sha256 with a sliding 30-day expiry.
- **Active org**: every data request names the org it operates in via the
  ``X-Org-Id`` header. The resolved :class:`AuthContext` lands in a ContextVar so
  handlers read it imperatively (``active_org_id()``) — mirroring ``get_db()`` —
  instead of threading a dependency through every signature.
- **guard(section, resolvers)**: a dependency factory attached at
  ``include_router`` time (see main.py). It authenticates, resolves the org
  membership, checks the section permission (GET/HEAD/OPTIONS need ``read``,
  everything else ``modify``), and verifies that any path-param resource actually
  belongs to the active org (wrong org → 404, so foreign ids don't leak
  existence).
- **Permissions**: a role is ``{section: none|read|modify}``; the effective level
  is the max across the membership's roles. Superusers get everything;
  ``can_manage_org`` on any held role makes the user an admin of that org.

Dev bridge: ``SAPCHE_AUTH_DISABLED=1`` skips authentication and acts as a
synthetic superuser (org from ``X-Org-Id``, default 1) — org resolution and the
resource-org checks still run, so scoping bugs surface even before login exists.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
from contextvars import ContextVar
from dataclasses import dataclass, field

from fastapi import HTTPException, Request

from .db import get_db

SECTIONS = ("texts", "workspace", "translate", "phonetics", "documents")
_LEVEL_RANK = {"none": 0, "read": 1, "modify": 2}

SESSION_COOKIE = "sapche_session"
SESSION_DAYS = 30
_SECURE_COOKIES = os.environ.get("SAPCHE_SECURE_COOKIES") == "1"


def _auth_disabled() -> bool:
    # Read per-request (not at import) so tests/dev can flip it without reloads.
    return os.environ.get("SAPCHE_AUTH_DISABLED") == "1"


@dataclass
class AuthContext:
    user_id: int
    is_superuser: bool = False
    org_id: int | None = None
    perms: dict[str, str] = field(default_factory=dict)
    can_manage_org: bool = False
    # True for a print-token pseudo-session (read-only, no user behind it).
    is_print_token: bool = False


_ctx: ContextVar[AuthContext | None] = ContextVar("sapche_auth_ctx", default=None)


# ─── Sessions ──────────────────────────────────────────────────────────────────

def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def create_session(conn, user_id: int) -> str:
    """Insert a session row and return the RAW token for the cookie."""
    raw = secrets.token_urlsafe(32)
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at) "
        f"VALUES (?, ?, datetime('now', '+{SESSION_DAYS} days'))",
        (hash_token(raw), user_id),
    )
    return raw


def delete_session(conn, raw: str) -> None:
    conn.execute("DELETE FROM sessions WHERE token_hash = ?", (hash_token(raw),))


def purge_expired_sessions(conn) -> None:
    conn.execute("DELETE FROM sessions WHERE expires_at < datetime('now')")


def set_session_cookie(response, raw_token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE, raw_token,
        max_age=SESSION_DAYS * 24 * 3600, httponly=True, samesite="lax",
        secure=_SECURE_COOKIES, path="/",
    )


def clear_session_cookie(response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")


def _session_user(conn, request: Request):
    """The users row for the request's session cookie, or None. Slides expiry."""
    raw = request.cookies.get(SESSION_COOKIE)
    if not raw:
        return None
    th = hash_token(raw)
    row = conn.execute(
        "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token_hash = ? AND s.expires_at > datetime('now')",
        (th,),
    ).fetchone()
    if row is None:
        return None
    conn.execute(
        "UPDATE sessions SET last_used_at = CURRENT_TIMESTAMP, "
        f"expires_at = datetime('now', '+{SESSION_DAYS} days') WHERE token_hash = ?",
        (th,),
    )
    conn.commit()
    return row


# ─── Permissions ───────────────────────────────────────────────────────────────

ALL_MODIFY = {s: "modify" for s in SECTIONS}
ALL_NONE = {s: "none" for s in SECTIONS}
ALL_READ = {s: "read" for s in SECTIONS}


def effective_perms(conn, user_id: int, org_id: int) -> tuple[dict[str, str], bool] | None:
    """(max-per-section perms, can_manage_org) for a membership, None if not a member."""
    m = conn.execute(
        "SELECT id FROM org_memberships WHERE user_id = ? AND org_id = ?",
        (user_id, org_id),
    ).fetchone()
    if m is None:
        return None
    perms = dict(ALL_NONE)
    can_manage = False
    for role in conn.execute(
        "SELECT r.perms, r.can_manage_org FROM membership_roles mr "
        "JOIN roles r ON r.id = mr.role_id WHERE mr.membership_id = ?",
        (m["id"],),
    ):
        can_manage = can_manage or bool(role["can_manage_org"])
        for section, level in json.loads(role["perms"] or "{}").items():
            if section in perms and _LEVEL_RANK.get(level, 0) > _LEVEL_RANK[perms[section]]:
                perms[section] = level
    if can_manage:
        perms = dict(ALL_MODIFY)  # org admins can do everything within the org
    return perms, can_manage


# ─── Resource → org resolution (anti cross-org access) ─────────────────────────
# One SQL per addressable kind: given the path-param value, whose org is it?
# NULL/no row → 404 from the guard. Kinds are referenced from main.py's guard maps.

_ORG_RESOLVERS = {
    "text": "SELECT org_id FROM texts WHERE id = ?",
    "document": "SELECT org_id FROM documents WHERE id = ?",
    "tag": "SELECT org_id FROM tags WHERE id = ?",
    "span": "SELECT t.org_id FROM spans s JOIN texts t ON t.id = s.text_id WHERE s.id = ?",
    "marker": "SELECT t.org_id FROM markers m JOIN texts t ON t.id = m.text_id WHERE m.id = ?",
    "node": "SELECT t.org_id FROM tree_nodes n JOIN texts t ON t.id = n.text_id WHERE n.id = ?",
    "suggestion": "SELECT t.org_id FROM suggestions s JOIN texts t ON t.id = s.text_id WHERE s.id = ?",
    "note": "SELECT t.org_id FROM notes n JOIN texts t ON t.id = n.text_id WHERE n.id = ?",
    "note_category": (
        "SELECT t.org_id FROM note_categories c JOIN texts t ON t.id = c.text_id WHERE c.id = ?"
    ),
    "passage": "SELECT t.org_id FROM passages p JOIN texts t ON t.id = p.text_id WHERE p.id = ?",
    "chunk": (
        "SELECT t.org_id FROM translation_chunks c JOIN texts t ON t.id = c.origin_text_id "
        "WHERE c.id = ?"
    ),
    "doc_item": (
        "SELECT d.org_id FROM document_items i JOIN documents d ON d.id = i.document_id "
        "WHERE i.id = ?"
    ),
    "op": (
        "SELECT t.org_id FROM derivation_ops o JOIN texts t ON t.id = o.text_id "
        "WHERE o.id = ?"
    ),
    "tr_suggestion": (
        "SELECT t.org_id FROM translation_suggestions s "
        "JOIN translation_chunks c ON c.id = s.chunk_id "
        "JOIN texts t ON t.id = c.origin_text_id WHERE s.id = ?"
    ),
    # chunk_layouts.text_id NULL = a GLOBAL row (applies wherever the content
    # appears) — resolves to NULL org, which the guard reads as "any org".
    "chunk_layout": (
        "SELECT t.org_id FROM chunk_layouts l LEFT JOIN texts t ON t.id = l.text_id "
        "WHERE l.id = ?"
    ),
    "font": "SELECT org_id FROM org_fonts WHERE id = ?",
}

_NO_ROW = object()


def _resolve_resource_org(conn, kind: str, value):
    """The org owning the resource; _NO_ROW if it doesn't exist; None = global row."""
    row = conn.execute(_ORG_RESOLVERS[kind], (value,)).fetchone()
    return row[0] if row is not None else _NO_ROW


# ─── Print tokens (headless PDF export) ────────────────────────────────────────
# export_pdf drives a cookie-less headless Chrome at the frontend's ?print= route;
# it authenticates with a short-lived signed token instead (read-only, org-bound).
# Accepted as an X-Print-Token header (fetches) or a print_token query param
# (URL-loaded seals/fonts, which can't send headers).

_PRINT_TOKEN_MAX_AGE_S = 300


def _print_signer():
    from itsdangerous import URLSafeTimedSerializer

    secret = os.environ.get("SAPCHE_SECRET_KEY")
    if not secret:
        # Derived per-process fallback: fine for dev/single-process; set the env
        # for anything real.
        secret = f"sapche-print-{os.getpid()}"
    return URLSafeTimedSerializer(secret, salt="print-token")


def mint_print_token(document_id: int, org_id: int) -> str:
    return _print_signer().dumps({"document_id": document_id, "org_id": org_id})


def _print_token_ctx(request: Request) -> AuthContext | None:
    tok = request.headers.get("X-Print-Token") or request.query_params.get("print_token")
    if not tok:
        return None
    from itsdangerous import BadSignature, SignatureExpired

    try:
        data = _print_signer().loads(tok, max_age=_PRINT_TOKEN_MAX_AGE_S)
    except (BadSignature, SignatureExpired):
        return None
    return AuthContext(
        user_id=0, org_id=int(data["org_id"]), perms=dict(ALL_READ), is_print_token=True,
    )


# ─── The guard ─────────────────────────────────────────────────────────────────

def _org_from_header(request: Request) -> int | None:
    raw = request.headers.get("X-Org-Id")
    if raw is None:
        return None
    try:
        return int(raw)
    except ValueError:
        raise HTTPException(400, "Bad X-Org-Id header")


def guard(section: str, resolvers: dict[str, str] | None = None,
          write_level: str = "modify"):
    """Router-level auth dependency (see module docstring).

    ``resolvers`` maps path-param names to _ORG_RESOLVERS kinds; every param
    present on the matched route is checked against the active org.
    ``write_level`` lets a router demand less than ``modify`` for its writes
    (reading_positions: saving your own spot only needs read access).
    """
    assert section in SECTIONS, section
    for kind in (resolvers or {}).values():
        assert kind in _ORG_RESOLVERS, kind

    # MUST be async: an async dependency runs in the request's task context, so
    # the ContextVar set here is visible to the (threadpool-run) sync handler.
    # A sync dependency would run in its own threadpool context and the set
    # would be lost before the handler executes.
    async def dependency(request: Request) -> AuthContext:
        conn = get_db()
        try:
            ctx = _authenticate(conn, request)
            _authorize(conn, request, ctx)
            _ctx.set(ctx)
            return ctx
        finally:
            conn.close()

    def _authenticate(conn, request: Request) -> AuthContext:
        printed = _print_token_ctx(request)
        if printed is not None:
            return printed
        if _auth_disabled():
            return AuthContext(user_id=1, is_superuser=True,
                               org_id=_org_from_header(request) or 1,
                               perms=dict(ALL_MODIFY), can_manage_org=True)
        user = _session_user(conn, request)
        if user is None:
            raise HTTPException(401, "Not authenticated")
        org_id = _org_from_header(request)
        if org_id is None:
            raise HTTPException(400, "Missing X-Org-Id header")
        if user["is_superuser"]:
            return AuthContext(user_id=user["id"], is_superuser=True, org_id=org_id,
                               perms=dict(ALL_MODIFY), can_manage_org=True)
        got = effective_perms(conn, user["id"], org_id)
        if got is None:
            raise HTTPException(403, "Not a member of this organization")
        perms, can_manage = got
        return AuthContext(user_id=user["id"], org_id=org_id, perms=perms,
                           can_manage_org=can_manage)

    def _authorize(conn, request: Request, ctx: AuthContext) -> None:
        needed = "read" if request.method in ("GET", "HEAD", "OPTIONS") else write_level
        if ctx.is_print_token and needed != "read":
            raise HTTPException(403, "Print token is read-only")
        if not ctx.is_superuser and not _auth_disabled():
            have = ctx.perms.get(section, "none")
            if _LEVEL_RANK[have] < _LEVEL_RANK[needed]:
                raise HTTPException(403, f"Requires {needed} access to {section}")
        for param, kind in (resolvers or {}).items():
            value = request.path_params.get(param)
            if value is None:
                continue
            org = _resolve_resource_org(conn, kind, value)
            if org is _NO_ROW or (org is not None and org != ctx.org_id):
                raise HTTPException(404, "Not found")

    return dependency


# ─── Imperative accessors (handler-side) ───────────────────────────────────────

def auth_context() -> AuthContext | None:
    return _ctx.get()


def active_org_id() -> int:
    """The org this request operates in. Guarded routes always have one."""
    ctx = _ctx.get()
    if ctx is None or ctx.org_id is None:
        if _auth_disabled():
            return 1
        raise HTTPException(400, "No active organization")
    return ctx.org_id


def current_user(request: Request) -> AuthContext:
    """Authentication only (no org, no section check) — for /api/auth and /api/orgs.

    Prefers the guard's context when one ran; otherwise resolves the cookie itself.
    """
    ctx = _ctx.get()
    if ctx is not None and not ctx.is_print_token:
        return ctx
    if _auth_disabled():
        return AuthContext(user_id=1, is_superuser=True, org_id=1,
                           perms=dict(ALL_MODIFY), can_manage_org=True)
    conn = get_db()
    try:
        user = _session_user(conn, request)
    finally:
        conn.close()
    if user is None:
        raise HTTPException(401, "Not authenticated")
    return AuthContext(user_id=user["id"], is_superuser=bool(user["is_superuser"]))


def current_user_id(request: Request) -> int:
    """The id of the user making the request (kept for existing Depends callers)."""
    return current_user(request).user_id
