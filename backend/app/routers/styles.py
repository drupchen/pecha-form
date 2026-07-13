"""Style designer (Phase 4). Booklet typography is data-driven: ORGANIZATION-wide role
templates + per-DOCUMENT overrides, resolved default ← org ← document by the frontend at
render time (the built-in defaults live in the frontend so bench + print stay identical).
Organizations/users are not built yet — everything is org 1 for now.
"""
import json

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import Response
from pydantic import BaseModel

from ..db import get_db

router = APIRouter(prefix="/api", tags=["styles"])

DEFAULT_ORG = 1
ALLOWED_FONT_MIME = {"font/ttf", "font/otf", "font/woff", "font/woff2",
                     "application/font-sfnt", "application/x-font-ttf",
                     "application/x-font-otf", "application/octet-stream"}
MAX_FONT_BYTES = 8 * 1024 * 1024


class StyleProps(BaseModel):
    props: dict


class StyleRow(BaseModel):
    role: str
    props: dict


class FontOut(BaseModel):
    id: int
    family: str
    weight: int
    italic: bool
    mime: str


def _rows_to_map(rows) -> dict:
    out = {}
    for r in rows:
        try:
            out[r["role"]] = json.loads(r["props"] or "{}")
        except json.JSONDecodeError:
            out[r["role"]] = {}
    return out


# ── Organization-wide role styles ────────────────────────────────────────────

@router.get("/styles")
def get_org_styles(org_id: int = DEFAULT_ORG):
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT role, props FROM style_roles WHERE org_id = ?", (org_id,)).fetchall()
        return _rows_to_map(rows)
    finally:
        conn.close()


@router.put("/styles/{role}")
def put_org_style(role: str, payload: StyleProps, org_id: int = DEFAULT_ORG):
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO style_roles (org_id, role, props) VALUES (?, ?, ?) "
            "ON CONFLICT(org_id, role) DO UPDATE SET props = excluded.props",
            (org_id, role, json.dumps(payload.props)))
        conn.commit()
        return {"role": role, "props": payload.props}
    finally:
        conn.close()


@router.delete("/styles/{role}")
def delete_org_style(role: str, org_id: int = DEFAULT_ORG):
    conn = get_db()
    try:
        conn.execute("DELETE FROM style_roles WHERE org_id = ? AND role = ?", (org_id, role))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ── Per-document overrides ───────────────────────────────────────────────────

@router.get("/documents/{document_id}/styles")
def get_doc_styles(document_id: int):
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT role, props FROM document_style_overrides WHERE document_id = ?",
            (document_id,)).fetchall()
        return _rows_to_map(rows)
    finally:
        conn.close()


@router.put("/documents/{document_id}/styles/{role}")
def put_doc_style(document_id: int, role: str, payload: StyleProps):
    conn = get_db()
    try:
        if not conn.execute("SELECT 1 FROM documents WHERE id = ?", (document_id,)).fetchone():
            raise HTTPException(404, "Document not found")
        conn.execute(
            "INSERT INTO document_style_overrides (document_id, role, props) VALUES (?, ?, ?) "
            "ON CONFLICT(document_id, role) DO UPDATE SET props = excluded.props",
            (document_id, role, json.dumps(payload.props)))
        conn.commit()
        return {"role": role, "props": payload.props}
    finally:
        conn.close()


@router.delete("/documents/{document_id}/styles/{role}")
def delete_doc_style(document_id: int, role: str):
    conn = get_db()
    try:
        conn.execute(
            "DELETE FROM document_style_overrides WHERE document_id = ? AND role = ?",
            (document_id, role))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ── Organization fonts (@font-face) ──────────────────────────────────────────

@router.get("/org-fonts")
def list_org_fonts(org_id: int = DEFAULT_ORG):
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT id, family, weight, italic, mime FROM org_fonts WHERE org_id = ? "
            "ORDER BY family, weight, italic", (org_id,)).fetchall()
        return [FontOut(id=r["id"], family=r["family"], weight=r["weight"],
                        italic=bool(r["italic"]), mime=r["mime"]) for r in rows]
    finally:
        conn.close()


@router.post("/org-fonts")
async def upload_org_font(
    file: UploadFile = File(...),
    family: str = Form(...),
    weight: int = Form(400),
    italic: bool = Form(False),
    org_id: int = Form(DEFAULT_ORG),
):
    data = await file.read()
    mime = file.content_type or "application/octet-stream"
    if mime not in ALLOWED_FONT_MIME:
        raise HTTPException(415, f"Unsupported font type: {mime}")
    if not data:
        raise HTTPException(400, "Empty file")
    if len(data) > MAX_FONT_BYTES:
        raise HTTPException(413, "Font too large (max 8 MB)")
    if not family.strip():
        raise HTTPException(400, "family is required")
    conn = get_db()
    try:
        cur = conn.execute(
            "INSERT INTO org_fonts (org_id, family, weight, italic, mime, data) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (org_id, family.strip(), weight, int(bool(italic)), mime, data))
        conn.commit()
        return FontOut(id=cur.lastrowid, family=family.strip(), weight=weight,
                       italic=bool(italic), mime=mime)
    finally:
        conn.close()


@router.get("/org-fonts/{font_id}/file")
def get_org_font_file(font_id: int):
    conn = get_db()
    try:
        row = conn.execute("SELECT mime, data FROM org_fonts WHERE id = ?", (font_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Font not found")
        return Response(content=row["data"], media_type=row["mime"],
                        headers={"Cache-Control": "public, max-age=86400"})
    finally:
        conn.close()


@router.delete("/org-fonts/{font_id}")
def delete_org_font(font_id: int):
    conn = get_db()
    try:
        conn.execute("DELETE FROM org_fonts WHERE id = ?", (font_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()
