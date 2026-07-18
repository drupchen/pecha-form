"""Organization administration: orgs (platform admins), members, roles, invites
(org admins). Not behind a section guard — each endpoint checks the capability
it needs: ``is_superuser`` for org CRUD and the platform-wide user list,
``can_manage_org`` (or superuser) for everything inside one org.
"""
from __future__ import annotations

import json
import os
import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator

from ..auth import (
    AuthContext, SECTIONS, current_user, effective_perms, hash_token,
)
from ..db import get_db, seed_org_roles
from ..mailer import send_invite

router = APIRouter(prefix="/api", tags=["orgs"])

INVITE_DAYS = 14
_LEVELS = ("none", "read", "modify")


class OrgIn(BaseModel):
    name: str


class RoleIn(BaseModel):
    name: str | None = None
    perms: dict[str, str] | None = None
    can_manage_org: bool | None = None

    @field_validator("perms")
    @classmethod
    def _check_perms(cls, v):
        if v is None:
            return v
        bad = {k for k in v if k not in SECTIONS} | {
            k for k, lvl in v.items() if lvl not in _LEVELS}
        if bad:
            raise ValueError(f"Bad sections/levels: {sorted(bad)}")
        return {s: v.get(s, "none") for s in SECTIONS}


class MemberRolesIn(BaseModel):
    role_ids: list[int]


class InviteIn(BaseModel):
    email: str
    role_ids: list[int] = []


# ─── Capability checks ─────────────────────────────────────────────────────────

def _require_superuser(ctx: AuthContext) -> None:
    if not ctx.is_superuser:
        raise HTTPException(403, "Platform admin only")


def _require_org_admin(conn, ctx: AuthContext, org_id: int) -> None:
    if ctx.is_superuser:
        return
    got = effective_perms(conn, ctx.user_id, org_id)
    if got is None or not got[1]:
        raise HTTPException(403, "Requires org admin")


def _org_or_404(conn, org_id: int):
    org = conn.execute(
        "SELECT * FROM organizations WHERE id = ?", (org_id,)).fetchone()
    if org is None:
        raise HTTPException(404, "No such organization")
    return org


# A mutation on memberships/roles must never leave the org without a single
# admin. Counted AFTER applying the change inside the same transaction; the
# caller rolls back by raising.
def _assert_still_has_admin(conn, org_id: int) -> None:
    row = conn.execute(
        "SELECT 1 FROM org_memberships om "
        "JOIN membership_roles mr ON mr.membership_id = om.id "
        "JOIN roles r ON r.id = mr.role_id "
        "WHERE om.org_id = ? AND r.can_manage_org = 1 LIMIT 1",
        (org_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(409, "This would leave the organization without an admin")


# ─── Organizations (platform level) ────────────────────────────────────────────

@router.get("/orgs")
def list_orgs(ctx: AuthContext = Depends(current_user)):
    conn = get_db()
    try:
        if ctx.is_superuser:
            rows = conn.execute(
                "SELECT o.id, o.name, "
                " (SELECT COUNT(*) FROM org_memberships m WHERE m.org_id = o.id) AS member_count "
                "FROM organizations o ORDER BY o.id").fetchall()
        else:
            rows = conn.execute(
                "SELECT o.id, o.name, "
                " (SELECT COUNT(*) FROM org_memberships m WHERE m.org_id = o.id) AS member_count "
                "FROM organizations o JOIN org_memberships om ON om.org_id = o.id "
                "WHERE om.user_id = ? ORDER BY o.id", (ctx.user_id,)).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


@router.post("/orgs")
def create_org(payload: OrgIn, ctx: AuthContext = Depends(current_user)):
    _require_superuser(ctx)
    conn = get_db()
    try:
        cur = conn.execute("INSERT INTO organizations (name) VALUES (?)",
                           (payload.name.strip(),))
        seed_org_roles(conn, cur.lastrowid)
        conn.commit()
        return {"id": cur.lastrowid, "name": payload.name.strip(), "member_count": 0}
    finally:
        conn.close()


@router.patch("/orgs/{org_id}")
def rename_org(org_id: int, payload: OrgIn, ctx: AuthContext = Depends(current_user)):
    _require_superuser(ctx)
    conn = get_db()
    try:
        _org_or_404(conn, org_id)
        conn.execute("UPDATE organizations SET name = ? WHERE id = ?",
                     (payload.name.strip(), org_id))
        conn.commit()
        return {"id": org_id, "name": payload.name.strip()}
    finally:
        conn.close()


@router.delete("/orgs/{org_id}", status_code=204)
def delete_org(org_id: int, ctx: AuthContext = Depends(current_user)):
    """Refuses while the org still holds data: texts/documents got org_id via
    ALTER ADD (no FK), so SQLite would NOT cascade them — emptiness is the guard."""
    _require_superuser(ctx)
    conn = get_db()
    try:
        _org_or_404(conn, org_id)
        for table in ("texts", "documents"):
            if conn.execute(f"SELECT 1 FROM {table} WHERE org_id = ? LIMIT 1",
                            (org_id,)).fetchone():
                raise HTTPException(
                    409, f"Organization still has {table} — move or delete them first")
        conn.execute("DELETE FROM organizations WHERE id = ?", (org_id,))
        conn.commit()
    finally:
        conn.close()


# ─── Platform-wide users ───────────────────────────────────────────────────────

@router.get("/users")
def list_users(ctx: AuthContext = Depends(current_user)):
    _require_superuser(ctx)
    conn = get_db()
    try:
        users = [dict(u) for u in conn.execute(
            "SELECT id, email, display_name, is_superuser, created_at, "
            " password_hash IS NOT NULL AS has_password, "
            " google_sub IS NOT NULL AS has_google "
            "FROM users ORDER BY id")]
        memberships = conn.execute(
            "SELECT om.user_id, o.id AS org_id, o.name AS org_name "
            "FROM org_memberships om JOIN organizations o ON o.id = om.org_id").fetchall()
        by_user: dict[int, list] = {}
        for m in memberships:
            by_user.setdefault(m["user_id"], []).append(
                {"org_id": m["org_id"], "org_name": m["org_name"]})
        for u in users:
            u["orgs"] = by_user.get(u["id"], [])
            u["is_superuser"] = bool(u["is_superuser"])
            u["has_password"] = bool(u["has_password"])
            u["has_google"] = bool(u["has_google"])
        return users
    finally:
        conn.close()


# ─── Members ───────────────────────────────────────────────────────────────────

@router.get("/orgs/{org_id}/members")
def list_members(org_id: int, ctx: AuthContext = Depends(current_user)):
    conn = get_db()
    try:
        _org_or_404(conn, org_id)
        _require_org_admin(conn, ctx, org_id)
        rows = conn.execute(
            "SELECT om.id AS membership_id, u.id AS user_id, u.email, u.display_name "
            "FROM org_memberships om JOIN users u ON u.id = om.user_id "
            "WHERE om.org_id = ? ORDER BY u.email", (org_id,)).fetchall()
        members = [dict(r) for r in rows]
        for m in members:
            m["role_ids"] = [r["role_id"] for r in conn.execute(
                "SELECT role_id FROM membership_roles WHERE membership_id = ?",
                (m.pop("membership_id"),))]
        return members
    finally:
        conn.close()


@router.put("/orgs/{org_id}/members/{user_id}/roles")
def set_member_roles(org_id: int, user_id: int, payload: MemberRolesIn,
                     ctx: AuthContext = Depends(current_user)):
    conn = get_db()
    try:
        _org_or_404(conn, org_id)
        _require_org_admin(conn, ctx, org_id)
        m = conn.execute(
            "SELECT id FROM org_memberships WHERE org_id = ? AND user_id = ?",
            (org_id, user_id)).fetchone()
        if m is None:
            raise HTTPException(404, "Not a member")
        for role_id in payload.role_ids:
            if not conn.execute("SELECT 1 FROM roles WHERE id = ? AND org_id = ?",
                                (role_id, org_id)).fetchone():
                raise HTTPException(400, f"Role {role_id} is not this org's")
        conn.execute("DELETE FROM membership_roles WHERE membership_id = ?", (m["id"],))
        conn.executemany(
            "INSERT INTO membership_roles (membership_id, role_id) VALUES (?, ?)",
            [(m["id"], rid) for rid in set(payload.role_ids)])
        _assert_still_has_admin(conn, org_id)
        conn.commit()
        return {"user_id": user_id, "role_ids": sorted(set(payload.role_ids))}
    finally:
        conn.close()


@router.delete("/orgs/{org_id}/members/{user_id}", status_code=204)
def remove_member(org_id: int, user_id: int, ctx: AuthContext = Depends(current_user)):
    conn = get_db()
    try:
        _org_or_404(conn, org_id)
        _require_org_admin(conn, ctx, org_id)
        cur = conn.execute(
            "DELETE FROM org_memberships WHERE org_id = ? AND user_id = ?",
            (org_id, user_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "Not a member")
        _assert_still_has_admin(conn, org_id)
        conn.commit()
    finally:
        conn.close()


# ─── Roles ─────────────────────────────────────────────────────────────────────

def _role_out(row) -> dict:
    return {"id": row["id"], "name": row["name"],
            "perms": json.loads(row["perms"] or "{}"),
            "can_manage_org": bool(row["can_manage_org"])}


@router.get("/orgs/{org_id}/roles")
def list_roles(org_id: int, ctx: AuthContext = Depends(current_user)):
    conn = get_db()
    try:
        _org_or_404(conn, org_id)
        _require_org_admin(conn, ctx, org_id)
        return [_role_out(r) for r in conn.execute(
            "SELECT * FROM roles WHERE org_id = ? ORDER BY id", (org_id,))]
    finally:
        conn.close()


@router.post("/orgs/{org_id}/roles")
def create_role(org_id: int, payload: RoleIn, ctx: AuthContext = Depends(current_user)):
    if not payload.name or not payload.name.strip():
        raise HTTPException(400, "Role name required")
    conn = get_db()
    try:
        _org_or_404(conn, org_id)
        _require_org_admin(conn, ctx, org_id)
        perms = payload.perms or {s: "none" for s in SECTIONS}
        try:
            cur = conn.execute(
                "INSERT INTO roles (org_id, name, perms, can_manage_org) VALUES (?, ?, ?, ?)",
                (org_id, payload.name.strip(), json.dumps(perms),
                 int(bool(payload.can_manage_org))))
        except Exception:
            raise HTTPException(409, "A role with this name exists")
        conn.commit()
        row = conn.execute("SELECT * FROM roles WHERE id = ?", (cur.lastrowid,)).fetchone()
        return _role_out(row)
    finally:
        conn.close()


@router.patch("/orgs/{org_id}/roles/{role_id}")
def update_role(org_id: int, role_id: int, payload: RoleIn,
                ctx: AuthContext = Depends(current_user)):
    conn = get_db()
    try:
        _org_or_404(conn, org_id)
        _require_org_admin(conn, ctx, org_id)
        role = conn.execute("SELECT * FROM roles WHERE id = ? AND org_id = ?",
                            (role_id, org_id)).fetchone()
        if role is None:
            raise HTTPException(404, "No such role")
        name = payload.name.strip() if payload.name else role["name"]
        perms = payload.perms if payload.perms is not None else json.loads(role["perms"])
        can_manage = (int(bool(payload.can_manage_org))
                      if payload.can_manage_org is not None else role["can_manage_org"])
        conn.execute(
            "UPDATE roles SET name = ?, perms = ?, can_manage_org = ? WHERE id = ?",
            (name, json.dumps(perms), can_manage, role_id))
        _assert_still_has_admin(conn, org_id)
        conn.commit()
        return _role_out(conn.execute(
            "SELECT * FROM roles WHERE id = ?", (role_id,)).fetchone())
    finally:
        conn.close()


@router.delete("/orgs/{org_id}/roles/{role_id}", status_code=204)
def delete_role(org_id: int, role_id: int, ctx: AuthContext = Depends(current_user)):
    conn = get_db()
    try:
        _org_or_404(conn, org_id)
        _require_org_admin(conn, ctx, org_id)
        if conn.execute("SELECT 1 FROM membership_roles WHERE role_id = ? LIMIT 1",
                        (role_id,)).fetchone():
            raise HTTPException(409, "Role is assigned to members — unassign it first")
        cur = conn.execute("DELETE FROM roles WHERE id = ? AND org_id = ?",
                           (role_id, org_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "No such role")
        conn.commit()
    finally:
        conn.close()


# ─── Invites ───────────────────────────────────────────────────────────────────

def _frontend_url() -> str:
    return os.environ.get("SAPCHE_FRONTEND_URL", "http://localhost:5173").rstrip("/")


@router.get("/orgs/{org_id}/invites")
def list_invites(org_id: int, ctx: AuthContext = Depends(current_user)):
    conn = get_db()
    try:
        _org_or_404(conn, org_id)
        _require_org_admin(conn, ctx, org_id)
        return [dict(r) for r in conn.execute(
            "SELECT id, email, role_ids, created_at, expires_at, "
            " expires_at < datetime('now') AS expired "
            "FROM invites WHERE org_id = ? AND accepted_at IS NULL ORDER BY id DESC",
            (org_id,))]
    finally:
        conn.close()


@router.post("/orgs/{org_id}/invites")
def create_invite(org_id: int, payload: InviteIn,
                  ctx: AuthContext = Depends(current_user)):
    email = payload.email.strip()
    if "@" not in email:
        raise HTTPException(400, "A valid email is required")
    conn = get_db()
    try:
        _org_or_404(conn, org_id)
        _require_org_admin(conn, ctx, org_id)
        if conn.execute(
            "SELECT 1 FROM org_memberships om JOIN users u ON u.id = om.user_id "
            "WHERE om.org_id = ? AND u.email = ?", (org_id, email)).fetchone():
            raise HTTPException(409, "Already a member")
        for role_id in payload.role_ids:
            if not conn.execute("SELECT 1 FROM roles WHERE id = ? AND org_id = ?",
                                (role_id, org_id)).fetchone():
                raise HTTPException(400, f"Role {role_id} is not this org's")
        raw = secrets.token_urlsafe(32)
        cur = conn.execute(
            "INSERT INTO invites (org_id, email, token_hash, role_ids, invited_by, expires_at) "
            f"VALUES (?, ?, ?, ?, ?, datetime('now', '+{INVITE_DAYS} days'))",
            (org_id, email, hash_token(raw), json.dumps(sorted(set(payload.role_ids))),
             None if ctx.user_id == 0 else ctx.user_id))
        conn.commit()
        invite_url = f"{_frontend_url()}/?invite={raw}"
        send_invite(email, invite_url)
        # The RAW token exists only in this response — the row keeps its sha256.
        return {"id": cur.lastrowid, "email": email, "invite_url": invite_url}
    finally:
        conn.close()


@router.delete("/orgs/{org_id}/invites/{invite_id}", status_code=204)
def revoke_invite(org_id: int, invite_id: int, ctx: AuthContext = Depends(current_user)):
    conn = get_db()
    try:
        _org_or_404(conn, org_id)
        _require_org_admin(conn, ctx, org_id)
        cur = conn.execute("DELETE FROM invites WHERE id = ? AND org_id = ?",
                           (invite_id, org_id))
        if cur.rowcount == 0:
            raise HTTPException(404, "No such invite")
        conn.commit()
    finally:
        conn.close()
