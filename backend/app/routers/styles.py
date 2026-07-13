"""Style designer (Phase 4). Booklet typography is data-driven: ORGANIZATION-wide role
templates + per-DOCUMENT overrides, resolved default ← org ← document by the frontend at
render time (the built-in defaults live in the frontend so bench + print stay identical).
Organizations/users are not built yet — everything is org 1 for now.
"""
import io
import json

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import Response
from pydantic import BaseModel

from ..db import get_db

router = APIRouter(prefix="/api", tags=["styles"])

DEFAULT_ORG = 1

# The documented style-name CONVENTION — role → (canonical docx paragraph-style name,
# accepted aliases incl. the reference booklet's names). Used by both the template
# export and the import so a template round-trips transparently.
ROLE_STYLE_NAMES: dict[str, tuple[str, list[str]]] = {
    "tibetan_body":  ("Tibetan Body", ["བོད་ཡིག", "Tibetan"]),
    "tibetan_title": ("Tibetan Section Title", ["ས་བཅད།", "Tibetan Section"]),
    "phonetics":     ("Phonetics", ["Phonetics Words", "Phonetics With-Tib"]),
    "translation":   ("Translation", ["Translation Words", "Translation With-Tib"]),
    "mantra":        ("Mantras", ["Mantra", "Mantras Words"]),
    "small":         ("Small Letters", ["Small Words", "Small"]),
    "section":       ("Sections", ["Section"]),
    "title_tib":     ("Title Tibetan", ["ཁ་བྱང་།", "ཁ་བྱང"]),
    "title_main":    ("Title", ["Text Title", "Book Title", "Main Title"]),
    "title_sub":     ("Subtitle", ["Sub Title"]),
    "copyright":     ("Copyright", []),
    "toc":           ("Table of Contents", ["TOC", "Contents"]),
    "folio":         ("Folio", ["Page Number", "Footer"]),
    "image_caption": ("Caption", ["Image Caption"]),
}

# Concrete role defaults for a starter template (the reference booklet's look), used when
# neither the org nor the document has a stored value. font/size/bold/italic.
_TEMPLATE_DEFAULTS: dict[str, dict] = {
    "tibetan_body":  {"font": "Chogyal", "size": 16},
    "tibetan_title": {"font": "Chogyal", "size": 22},
    "phonetics":     {"font": "Raleway", "size": 10, "italic": True},
    "translation":   {"font": "Gentium Basic", "size": 11},
    "mantra":        {"font": "Gentium Basic", "size": 11, "bold": True, "italic": True},
    "small":         {"font": "Libertinus Serif Display", "size": 9},
    "section":       {"font": "Libertinus Serif Display", "size": 15, "italic": True},
    "title_tib":     {"font": "Chogyal", "size": 20},
    "title_main":    {"font": "Libertinus Serif", "size": 18},
    "title_sub":     {"font": "Libertinus Serif", "size": 12.5, "italic": True},
    "copyright":     {"font": "Gentium Basic", "size": 11},
    "toc":           {"font": "Gentium Basic", "size": 10.5},
    "folio":         {"font": "Georgia", "size": 9},
    "image_caption": {"font": "Gentium Basic", "size": 9.5, "italic": True},
}
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


# ── Style Studio specimen (per-org editable sample) ──────────────────────────

class SampleIn(BaseModel):
    content: str


@router.get("/style-sample")
def get_style_sample(org_id: int = DEFAULT_ORG):
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT content FROM style_samples WHERE org_id = ?", (org_id,)).fetchone()
        return {"content": row["content"] if row else ""}
    finally:
        conn.close()


@router.put("/style-sample")
def put_style_sample(payload: SampleIn, org_id: int = DEFAULT_ORG):
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO style_samples (org_id, content) VALUES (?, ?) "
            "ON CONFLICT(org_id) DO UPDATE SET content = excluded.content",
            (org_id, payload.content))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ── docx style templates (import / export) ───────────────────────────────────
# An external docx whose NAMED styles follow ROLE_STYLE_NAMES seeds org or document
# styles — parsed to derive font family/size/weight/italic/colour/alignment. The
# starter template names its styles by the convention so parsing is transparent.

def _props_from_docx_style(style) -> dict:
    """Map a python-docx paragraph style → our StyleProps (only what is set)."""
    props: dict = {}
    f = style.font
    if f.name:
        props["fontFamily"] = f.name
    if f.size is not None:
        props["fontSize"] = f"{f.size.pt:g}pt"
    if f.bold:                       # only explicit bold sets weight (semibold lives in the family name)
        props["fontWeight"] = 700
    if f.italic is not None:
        props["italic"] = bool(f.italic)
    try:
        if f.color and f.color.rgb is not None:
            props["color"] = f"#{str(f.color.rgb).lower()}"
    except (AttributeError, ValueError):
        pass
    # Paragraph styles carry alignment/spacing; character styles don't.
    pf = getattr(style, "paragraph_format", None)
    if pf is not None:
        align = pf.alignment
        if align is not None:
            mapped = {0: "left", 1: "center", 2: "right", 3: "justify"}.get(int(align))
            if mapped:
                props["align"] = mapped
        if pf.line_spacing is not None and isinstance(pf.line_spacing, float):
            props["lineHeight"] = f"{pf.line_spacing:g}"
    return props


@router.get("/style-template.docx")
def export_style_template(target: str = "document", org_id: int = DEFAULT_ORG,
                          document_id: int | None = None):
    """Generate a starter .docx with one named paragraph style per role, valued from the
    resolved current styles (defaults ← org ← [document])."""
    import docx
    from docx.shared import Pt, RGBColor
    from docx.enum.style import WD_STYLE_TYPE

    conn = get_db()
    try:
        org = _rows_to_map(conn.execute(
            "SELECT role, props FROM style_roles WHERE org_id = ?", (org_id,)).fetchall())
        doc_ov = {}
        if target == "document" and document_id is not None:
            doc_ov = _rows_to_map(conn.execute(
                "SELECT role, props FROM document_style_overrides WHERE document_id = ?",
                (document_id,)).fetchall())
    finally:
        conn.close()

    out = docx.Document()
    out.add_paragraph("Booklet style template — edit each style's font/size/weight/italic, "
                      "then re-import. Do not rename the styles.").italic = True
    for role, (name, _aliases) in ROLE_STYLE_NAMES.items():
        base = dict(_TEMPLATE_DEFAULTS.get(role, {}))
        # resolve: template default ← org ← document (only keys present override)
        for src in (org.get(role, {}), doc_ov.get(role, {})):
            if src.get("fontFamily"): base["font"] = src["fontFamily"]
            if src.get("fontSize"):
                try: base["size"] = float(str(src["fontSize"]).rstrip("pt"))
                except ValueError: pass
            if "fontWeight" in src: base["bold"] = int(src.get("fontWeight") or 0) >= 600
            if "italic" in src: base["italic"] = bool(src["italic"])
        try:
            st = out.styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)
        except ValueError:
            st = out.styles[name]
        if base.get("font"): st.font.name = base["font"]
        if base.get("size"): st.font.size = Pt(float(base["size"]))
        if base.get("bold") is not None: st.font.bold = bool(base.get("bold"))
        if base.get("italic") is not None: st.font.italic = bool(base.get("italic"))
        p = out.add_paragraph(f"{name} — sample text  ༄༅།", style=name)  # noqa: RUF001

    buf = io.BytesIO()
    out.save(buf)
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": 'attachment; filename="booklet-style-template.docx"'})


@router.post("/style-template/import")
async def import_style_template(
    file: UploadFile = File(...),
    target: str = Form("document"),
    org_id: int = Form(DEFAULT_ORG),
    document_id: int | None = Form(None),
):
    """Parse an uploaded docx's named styles → role StyleProps → write to org or document."""
    import docx

    if target not in ("org", "document"):
        raise HTTPException(400, "target must be 'org' or 'document'")
    if target == "document" and document_id is None:
        raise HTTPException(400, "document_id is required for target=document")

    data = await file.read()
    try:
        d = docx.Document(io.BytesIO(data))
    except Exception:
        raise HTTPException(400, "Could not read the file as a .docx")

    # name (lowercased) → role, over canonical names + aliases
    name_to_role: dict[str, str] = {}
    for role, (canon, aliases) in ROLE_STYLE_NAMES.items():
        for nm in (canon, *aliases):
            name_to_role[nm.strip().lower()] = role

    applied: dict[str, dict] = {}
    for style in d.styles:
        try:
            role = name_to_role.get((style.name or "").strip().lower())
        except Exception:
            role = None
        if not role or role in applied:
            continue
        props = _props_from_docx_style(style)
        if props:
            applied[role] = props

    if not applied:
        raise HTTPException(422, "No matching named styles found. See the expected style names.")

    conn = get_db()
    try:
        for role, props in applied.items():
            blob = json.dumps(props)
            if target == "org":
                conn.execute(
                    "INSERT INTO style_roles (org_id, role, props) VALUES (?, ?, ?) "
                    "ON CONFLICT(org_id, role) DO UPDATE SET props = excluded.props",
                    (org_id, role, blob))
            else:
                conn.execute(
                    "INSERT INTO document_style_overrides (document_id, role, props) VALUES (?, ?, ?) "
                    "ON CONFLICT(document_id, role) DO UPDATE SET props = excluded.props",
                    (document_id, role, blob))
        conn.commit()
        return {"applied": list(applied.keys()), "count": len(applied)}
    finally:
        conn.close()
