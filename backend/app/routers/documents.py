"""Documents (Phase D1): booklets assembled from an ordered sequence of pages.

A document is a booklet — ordered `document_items` (multiple secondary texts +
furniture pages: cover/blank/toc/copyright/image/backcover) published in a set of
`document_languages` that page-align. D1 is the structure + management layer only;
pagination lands page numbers (D2) and PDF export (D3) come later. The auto-TOC is
computed from each text page's section tree (reuses tree_nodes.get_nested_tree).
"""
from typing import List

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, Response
from starlette.background import BackgroundTask

from ..auth import active_org_id, mint_print_token
from ..db import get_db
import gzip
import io
import json
import os
import queue as _queue
import re
import shutil
import subprocess
import tempfile
import threading

from ..schemas import (
    DocumentCreate, DocumentUpdate, DocumentOut, DocumentDetailOut,
    DocumentItemIn, DocumentItemPatch, DocumentItemOut,
    DocumentReorderIn, DocumentLanguagesIn, TocEntry, TocSection,
    DocumentLayoutRow, DocumentLayoutIn, DocumentLayoutDeleteIn,
    DocumentLayoutConfigIn, DocumentLayoutOut, PaginationStampIn,
    DocumentFurnitureRow, DocumentFurnitureIn, ImageSizeIn,
    TitlePageFieldRow, TitleFieldIn, TitleShiftIn,
    DocumentVersionCreate, DocumentVersionOut,
)
from .translations import _sanitize_body
from .tree_nodes import get_nested_tree

router = APIRouter(prefix="/api", tags=["documents"])

# Built-in booklet geometry (mm / pt). The future style designer makes these editable;
# a document's layout_config JSON holds only overrides, merged onto this.
DEFAULT_LAYOUT_CONFIG = {
    "page_width_mm": 148.0, "page_height_mm": 210.0,   # A5 (matches the reference booklets)
    "margin_top_mm": 10.0, "margin_bottom_mm": 12.4,
    "margin_bind_mm": 16.0, "margin_outer_mm": 20.0,   # bind side (spine) vs outer edge (slack)
    "tibetan_pt": 16.0, "phonetics_pt": 10.0, "translation_pt": 11.0,
    "leading": 1.2,
    # SECONDS of quiet before the automatic breaks re-flow themselves. The clock restarts on
    # every upstream change, so a working session never repaginates under the cursor — it
    # settles once you stop. Not geometry, but per-document user config, which is what this
    # JSON already is.
    "reflow_delay_s": 20,
}


# ─── Helpers ────────────────────────────────────────────────────────────────────

def _doc_languages(conn, document_id: int) -> List[str]:
    return [r["lang"] for r in conn.execute(
        "SELECT lang FROM document_languages WHERE document_id = ? ORDER BY position, lang",
        (document_id,)).fetchall()]


def _item_out(conn, row) -> DocumentItemOut:
    title = None
    if row["text_id"] is not None:
        t = conn.execute("SELECT title FROM texts WHERE id = ?", (row["text_id"],)).fetchone()
        title = t["title"] if t else None
    has_image = False
    w_mm = h_mm = None
    if row["kind"] in IMAGE_KINDS:
        img = conn.execute(
            "SELECT width_mm, height_mm FROM document_images WHERE item_id = ?", (row["id"],)).fetchone()
        if img is not None:
            has_image = True
            w_mm, h_mm = img["width_mm"], img["height_mm"]
    return DocumentItemOut(
        id=row["id"], document_id=row["document_id"], position=row["position"],
        kind=row["kind"], text_id=row["text_id"], text_title=title,
        caption=row["caption"], body=row["body"], has_image=has_image,
        image_width_mm=w_mm, image_height_mm=h_mm)


def _items(conn, document_id: int) -> List[DocumentItemOut]:
    rows = conn.execute(
        "SELECT * FROM document_items WHERE document_id = ? ORDER BY position, id",
        (document_id,)).fetchall()
    return [_item_out(conn, r) for r in rows]


def _doc_out(conn, row) -> DocumentOut:
    n = conn.execute("SELECT COUNT(*) c FROM document_items WHERE document_id = ?",
                     (row["id"],)).fetchone()["c"]
    return DocumentOut(
        id=row["id"], title=row["title"],
        created_at=row["created_at"], updated_at=row["updated_at"],
        item_count=n, languages=_doc_languages(conn, row["id"]))


def _require_doc(conn, document_id: int):
    row = conn.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Document not found")
    return row


def _touch(conn, document_id: int):
    conn.execute("UPDATE documents SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                 (document_id,))


# ─── Documents ──────────────────────────────────────────────────────────────────

@router.get("/documents", response_model=List[DocumentOut])
def list_documents():
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT * FROM documents WHERE org_id = ? ORDER BY updated_at DESC, id",
            (active_org_id(),)).fetchall()
        return [_doc_out(conn, r) for r in rows]
    finally:
        conn.close()


@router.post("/documents", response_model=DocumentOut)
def create_document(payload: DocumentCreate):
    title = payload.title.strip()
    if not title:
        raise HTTPException(400, "Title required")
    conn = get_db()
    try:
        cur = conn.execute("INSERT INTO documents (org_id, title) VALUES (?, ?)",
                           (active_org_id(), title))
        conn.commit()
        return _doc_out(conn, _require_doc(conn, cur.lastrowid))
    finally:
        conn.close()


@router.get("/documents/{document_id}", response_model=DocumentDetailOut)
def get_document(document_id: int):
    conn = get_db()
    try:
        row = _require_doc(conn, document_id)
        base = _doc_out(conn, row)
        return DocumentDetailOut(**base.model_dump(), items=_items(conn, document_id))
    finally:
        conn.close()


@router.patch("/documents/{document_id}", response_model=DocumentOut)
def update_document(document_id: int, payload: DocumentUpdate):
    title = payload.title.strip()
    if not title:
        raise HTTPException(400, "Title required")
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        conn.execute("UPDATE documents SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                     (title, document_id))
        conn.commit()
        return _doc_out(conn, _require_doc(conn, document_id))
    finally:
        conn.close()


@router.delete("/documents/{document_id}")
def delete_document(document_id: int):
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        conn.execute("DELETE FROM documents WHERE id = ?", (document_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ─── Items ──────────────────────────────────────────────────────────────────────

@router.post("/documents/{document_id}/items", response_model=DocumentItemOut)
def add_item(document_id: int, payload: DocumentItemIn):
    if payload.kind == "text":
        if payload.text_id is None:
            raise HTTPException(400, "A text page needs a text_id")
    elif payload.text_id is not None:
        raise HTTPException(400, "text_id only applies to a text page")
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        if payload.text_id is not None and not conn.execute(
                "SELECT 1 FROM texts WHERE id = ?", (payload.text_id,)).fetchone():
            raise HTTPException(404, "Text not found")
        pos = conn.execute(
            "SELECT COALESCE(MAX(position), -1) + 1 AS p FROM document_items WHERE document_id = ?",
            (document_id,)).fetchone()["p"]
        cur = conn.execute(
            "INSERT INTO document_items (document_id, position, kind, text_id, caption, body) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (document_id, pos, payload.kind, payload.text_id, payload.caption, payload.body))
        _touch(conn, document_id)
        conn.commit()
        row = conn.execute("SELECT * FROM document_items WHERE id = ?", (cur.lastrowid,)).fetchone()
        return _item_out(conn, row)
    finally:
        conn.close()


@router.patch("/document-items/{item_id}", response_model=DocumentItemOut)
def patch_item(item_id: int, payload: DocumentItemPatch):
    conn = get_db()
    try:
        row = conn.execute("SELECT * FROM document_items WHERE id = ?", (item_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Item not found")
        sets, args = [], []
        for field in ("text_id", "caption", "body"):
            val = getattr(payload, field)
            if val is not None:
                sets.append(f"{field} = ?"); args.append(val)
        if sets:
            conn.execute(f"UPDATE document_items SET {', '.join(sets)} WHERE id = ?",
                         (*args, item_id))
            _touch(conn, row["document_id"])
            conn.commit()
        row = conn.execute("SELECT * FROM document_items WHERE id = ?", (item_id,)).fetchone()
        return _item_out(conn, row)
    finally:
        conn.close()


@router.delete("/document-items/{item_id}")
def delete_item(item_id: int):
    conn = get_db()
    try:
        row = conn.execute("SELECT document_id FROM document_items WHERE id = ?", (item_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Item not found")
        conn.execute("DELETE FROM document_items WHERE id = ?", (item_id,))
        _touch(conn, row["document_id"])
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.post("/documents/{document_id}/items/reorder", response_model=List[DocumentItemOut])
def reorder_items(document_id: int, payload: DocumentReorderIn):
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        owned = {r["id"] for r in conn.execute(
            "SELECT id FROM document_items WHERE document_id = ?", (document_id,)).fetchall()}
        if set(payload.ordered_ids) != owned:
            raise HTTPException(400, "ordered_ids must be exactly this document's items")
        for i, item_id in enumerate(payload.ordered_ids):
            conn.execute("UPDATE document_items SET position = ? WHERE id = ?", (i, item_id))
        _touch(conn, document_id)
        conn.commit()
        return _items(conn, document_id)
    finally:
        conn.close()


# ─── Languages ──────────────────────────────────────────────────────────────────

@router.put("/documents/{document_id}/languages", response_model=List[str])
def set_languages(document_id: int, payload: DocumentLanguagesIn):
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        known = {r["code"] for r in conn.execute("SELECT code FROM languages").fetchall()}
        seen, langs = set(), []
        for code in payload.langs:
            code = code.strip().lower()
            if code and code in known and code not in seen:
                seen.add(code); langs.append(code)
        conn.execute("DELETE FROM document_languages WHERE document_id = ?", (document_id,))
        for i, code in enumerate(langs):
            conn.execute(
                "INSERT INTO document_languages (document_id, lang, position) VALUES (?, ?, ?)",
                (document_id, code, i))
        _touch(conn, document_id)
        conn.commit()
        return _doc_languages(conn, document_id)
    finally:
        conn.close()


# ─── Table of contents ──────────────────────────────────────────────────────────

def _to_toc_sections(nodes: list) -> List[TocSection]:
    """Map nested tree nodes → TOC sections, keeping only titled nodes; a title-less
    (transparent/structural) node is skipped but its titled descendants are promoted."""
    out: List[TocSection] = []
    for n in nodes:
        kids = _to_toc_sections(n.get("children", []))
        title = (n.get("title") or "").strip()
        if title:
            out.append(TocSection(title=title, level=None,
                                  anchor_syl_id=n.get("segment_start_syl_id"), children=kids))
        else:
            out.extend(kids)  # promote children of an untitled node
    return out


@router.get("/documents/{document_id}/toc", response_model=List[TocEntry])
def document_toc(document_id: int):
    """One entry per text page (in order): the text's title + its section tree. Page
    numbers are deferred to D2 pagination."""
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        text_items = conn.execute(
            "SELECT * FROM document_items WHERE document_id = ? AND kind = 'text' "
            "AND text_id IS NOT NULL ORDER BY position, id", (document_id,)).fetchall()
        titles = {r["id"]: r["title"] for r in conn.execute("SELECT id, title FROM texts").fetchall()}
    finally:
        conn.close()
    out: List[TocEntry] = []
    for it in text_items:
        # get_nested_tree opens its own connection (read-only) — reuse it directly.
        tree = get_nested_tree(it["text_id"])
        out.append(TocEntry(
            item_id=it["id"], text_id=it["text_id"],
            text_title=titles.get(it["text_id"], ""),
            sections=_to_toc_sections(tree["roots"])))
    return out


# ─── Pagination layout (Phase D2) ───────────────────────────────────────────────

# The page format and the guides: sheet size, and the four margins the text block and the
# binding/folio guides are drawn from. These are the keys the ORG template may state; the rest
# of DEFAULT_LAYOUT_CONFIG stays code-and-document. Type sizes are the roles' business now that
# every role names its own size, and reflow_delay_s is about how the bench behaves while you
# work rather than about what prints.
ORG_LAYOUT_KEYS = (
    "page_width_mm", "page_height_mm",
    "margin_top_mm", "margin_bottom_mm", "margin_bind_mm", "margin_outer_mm",
)


def _org_layout(conn, org_id: int = 1) -> dict:
    """The org template's geometry, filtered to the keys it is allowed to speak for."""
    row = conn.execute("SELECT config FROM org_layout WHERE org_id = ?", (org_id,)).fetchone()
    if row is None or not row["config"]:
        return {}
    try:
        cfg = json.loads(row["config"])
    except (ValueError, TypeError):
        return {}
    return {k: v for k, v in cfg.items() if k in ORG_LAYOUT_KEYS} if isinstance(cfg, dict) else {}


def _effective_config(conn, row) -> dict:
    """default ← org ← document, exactly as a role's props resolve.

    The org sits between so a booklet that says nothing about its geometry follows the house,
    and one that does keeps its own — doc 7's margins are its own and stay that way.
    """
    cfg = dict(DEFAULT_LAYOUT_CONFIG)
    cfg.update(_org_layout(conn))
    raw = row["layout_config"] if "layout_config" in row.keys() else None
    if raw:
        try:
            cfg.update(json.loads(raw))
        except (ValueError, TypeError):
            pass
    return cfg


@router.get("/documents/{document_id}/layout", response_model=DocumentLayoutOut)
def get_layout(document_id: int):
    conn = get_db()
    try:
        row = _require_doc(conn, document_id)
        rows = conn.execute(
            "SELECT * FROM document_layout WHERE document_id = ? ORDER BY id",
            (document_id,)).fetchall()
        keys = row.keys()
        return DocumentLayoutOut(
            config=_effective_config(conn, row),
            rows=[DocumentLayoutRow(**dict(r)) for r in rows],
            pagination_sig=row["pagination_sig"] if "pagination_sig" in keys else None,
            pagination_fp=row["pagination_fp"] if "pagination_fp" in keys else None)
    finally:
        conn.close()


@router.put("/documents/{document_id}/pagination-stamp")
def put_pagination_stamp(document_id: int, payload: PaginationStampIn):
    """Record what the breaks just written were flowed against.

    Only the bench calls this, immediately after a successful flow. Everything else leaves
    it alone, so a mismatch means exactly one thing: the booklet has moved since.
    """
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        conn.execute(
            "UPDATE documents SET pagination_sig = ?, pagination_fp = ?, "
            "updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (payload.pagination_sig, payload.pagination_fp, document_id))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.put("/documents/{document_id}/layout-config", response_model=DocumentLayoutOut)
def put_layout_config(document_id: int, payload: DocumentLayoutConfigIn):
    """Merge partial geometry overrides onto the document's config."""
    conn = get_db()
    try:
        row = _require_doc(conn, document_id)
        current = {}
        raw = row["layout_config"] if "layout_config" in row.keys() else None
        if raw:
            try:
                current = json.loads(raw)
            except (ValueError, TypeError):
                current = {}
        # Only keep keys the defaults know about (guard against junk).
        for k, v in payload.config.items():
            if k in DEFAULT_LAYOUT_CONFIG:
                current[k] = v
        conn.execute("UPDATE documents SET layout_config = ?, updated_at = CURRENT_TIMESTAMP "
                     "WHERE id = ?", (json.dumps(current), document_id))
        conn.commit()
        row = _require_doc(conn, document_id)
        rows = conn.execute("SELECT * FROM document_layout WHERE document_id = ? ORDER BY id",
                            (document_id,)).fetchall()
        keys = row.keys()
        return DocumentLayoutOut(
            config=_effective_config(conn, row),
            rows=[DocumentLayoutRow(**dict(r)) for r in rows],
            pagination_sig=row["pagination_sig"] if "pagination_sig" in keys else None,
            pagination_fp=row["pagination_fp"] if "pagination_fp" in keys else None)
    finally:
        conn.close()


@router.put("/documents/{document_id}/layout", response_model=DocumentLayoutRow)
def upsert_layout_row(document_id: int, payload: DocumentLayoutIn):
    """Set/replace one shared layout decision (page break or balancing adjustment)."""
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        if not conn.execute("SELECT 1 FROM document_items WHERE id = ? AND document_id = ?",
                            (payload.item_id, document_id)).fetchone():
            raise HTTPException(404, "Item not in this document")
        # '' = shared across editions (SQLite UNIQUE treats NULLs as distinct, which
        # would defeat the upsert — normalise the shared case to an empty string).
        lang = payload.lang or ""
        conn.execute(
            "INSERT INTO document_layout "
            "(document_id, item_id, anchor_syl_id, kind, char_offset, value, lang) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(document_id, item_id, anchor_syl_id, kind, lang) DO UPDATE SET "
            "char_offset = excluded.char_offset, value = excluded.value",
            (document_id, payload.item_id, payload.anchor_syl_id, payload.kind,
             payload.char_offset, payload.value, lang))
        _touch(conn, document_id)
        conn.commit()
        r = conn.execute(
            "SELECT * FROM document_layout WHERE document_id = ? AND item_id = ? "
            "AND anchor_syl_id = ? AND kind = ? AND lang = ?",
            (document_id, payload.item_id, payload.anchor_syl_id, payload.kind,
             lang)).fetchone()
        return DocumentLayoutRow(**dict(r))
    finally:
        conn.close()


@router.delete("/documents/{document_id}/layout")
def delete_layout_row(document_id: int, payload: DocumentLayoutDeleteIn):
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        conn.execute(
            "DELETE FROM document_layout WHERE document_id = ? AND item_id = ? "
            "AND anchor_syl_id = ? AND kind = ? AND lang = ?",
            (document_id, payload.item_id, payload.anchor_syl_id, payload.kind,
             payload.lang or ""))
        _touch(conn, document_id)
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ─── Furniture content (per-language authored text for cover/title/copyright) ────

@router.get("/documents/{document_id}/furniture", response_model=List[DocumentFurnitureRow])
def list_furniture(document_id: int):
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        return [DocumentFurnitureRow(item_id=r["item_id"], lang=r["lang"],
                                    block=r["block"], body=r["body"])
                for r in conn.execute(
                    "SELECT item_id, lang, block, body FROM document_furniture "
                    "WHERE document_id = ?",
                    (document_id,)).fetchall()]
    finally:
        conn.close()


@router.put("/documents/{document_id}/furniture", response_model=DocumentFurnitureRow)
def upsert_furniture(document_id: int, payload: DocumentFurnitureIn):
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        if not conn.execute("SELECT 1 FROM document_items WHERE id = ? AND document_id = ?",
                            (payload.item_id, document_id)).fetchone():
            raise HTTPException(404, "Item not in this document")
        body = _sanitize_body(payload.body)
        conn.execute(
            "INSERT INTO document_furniture (document_id, item_id, lang, block, body) "
            "VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT(document_id, item_id, lang, block) DO UPDATE SET body = excluded.body",
            (document_id, payload.item_id, payload.lang, payload.block, body))
        _touch(conn, document_id)
        conn.commit()
        return DocumentFurnitureRow(item_id=payload.item_id, lang=payload.lang,
                                    block=payload.block, body=body)
    finally:
        conn.close()


# ─── Title-page fields (origin/author content + per-field vertical placement) ────

_TITLE_FIELDS = {"image", "tibetan", "title", "subtitle", "origin", "author", "content"}


@router.get("/documents/{document_id}/title-fields", response_model=List[TitlePageFieldRow])
def list_title_fields(document_id: int):
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        return [TitlePageFieldRow(item_id=r["item_id"], field=r["field"], lang=r["lang"],
                                  body=r["body"], shift_mm=r["shift_mm"])
                for r in conn.execute(
                    "SELECT item_id, field, lang, body, shift_mm FROM title_page_field "
                    "WHERE document_id = ?", (document_id,)).fetchall()]
    finally:
        conn.close()


@router.put("/documents/{document_id}/title-field", response_model=TitlePageFieldRow)
def upsert_title_field(document_id: int, payload: TitleFieldIn):
    """The cover's dedicated origin/author text, per edition (title/sub-title still come from
    the text). An empty body clears the row."""
    if payload.field not in ("origin", "author"):
        raise HTTPException(400, "field must be 'origin' or 'author'")
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        if not conn.execute("SELECT 1 FROM document_items WHERE id = ? AND document_id = ?",
                            (payload.item_id, document_id)).fetchone():
            raise HTTPException(404, "Item not in this document")
        body = _sanitize_body(payload.body)
        if body.strip():
            conn.execute(
                "INSERT INTO title_page_field (document_id, item_id, field, lang, body) "
                "VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(document_id, item_id, field, lang) DO UPDATE SET body = excluded.body",
                (document_id, payload.item_id, payload.field, payload.lang, body))
        else:
            conn.execute(
                "DELETE FROM title_page_field WHERE document_id = ? AND item_id = ? "
                "AND field = ? AND lang = ?",
                (document_id, payload.item_id, payload.field, payload.lang))
        _touch(conn, document_id)
        conn.commit()
        return TitlePageFieldRow(item_id=payload.item_id, field=payload.field,
                                 lang=payload.lang, body=body or None)
    finally:
        conn.close()


@router.put("/documents/{document_id}/title-shift", response_model=TitlePageFieldRow)
def upsert_title_shift(document_id: int, payload: TitleShiftIn):
    """A title-page field's vertical nudge (mm), shared across editions (lang=''). 0 clears."""
    if payload.field not in _TITLE_FIELDS:
        raise HTTPException(400, "unknown title field")
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        if not conn.execute("SELECT 1 FROM document_items WHERE id = ? AND document_id = ?",
                            (payload.item_id, document_id)).fetchone():
            raise HTTPException(404, "Item not in this document")
        if abs(payload.shift_mm) < 0.05:
            conn.execute(
                "DELETE FROM title_page_field WHERE document_id = ? AND item_id = ? "
                "AND field = ? AND lang = ''",
                (document_id, payload.item_id, payload.field))
        else:
            conn.execute(
                "INSERT INTO title_page_field (document_id, item_id, field, lang, shift_mm) "
                "VALUES (?, ?, ?, '', ?) "
                "ON CONFLICT(document_id, item_id, field, lang) DO UPDATE SET shift_mm = excluded.shift_mm",
                (document_id, payload.item_id, payload.field, payload.shift_mm))
        _touch(conn, document_id)
        conn.commit()
        return TitlePageFieldRow(item_id=payload.item_id, field=payload.field, lang="",
                                 shift_mm=payload.shift_mm)
    finally:
        conn.close()


# ─── PDF export (Phase D3) ───────────────────────────────────────────────────
# The booklet is printed by headless Chromium off the frontend's `?print=` route —
# the SAME rendering engine as the on-screen pagination bench, so the PDF is WYSIWYG.
# We drive the system Chrome/Chromium (no bundled browser dependency); the frontend
# must be reachable at PECHA_FRONTEND_URL (the dev server, or a served build).

_CHROME_BINS = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]
FRONTEND_URL = os.environ.get("PECHA_FRONTEND_URL", "http://localhost:5173").rstrip("/")


def _find_chrome() -> str | None:
    for b in _CHROME_BINS:
        p = shutil.which(b)
        if p:
            return p
    return None


def _render_booklet_pdf(document_id: int, org_id: int, lang: str) -> bytes:
    """Render ONE edition of the booklet to PDF bytes via headless Chromium, with the
    navigation outline injected. Shared by the live `export_pdf` and the version renderer,
    so a frozen version can never diverge from a live export. Raises HTTPException on failure.

    The headless Chrome has no session cookie — the print page authenticates every API call
    with a short-lived signed print token (read-only, bound to the org). It only transits
    the local process argv."""
    chrome = _find_chrome()
    if not chrome:
        raise HTTPException(500, "No Chrome/Chromium binary found on the server for PDF export.")
    fd, out_path = tempfile.mkstemp(suffix=".pdf", prefix="booklet_")
    os.close(fd)
    try:
        token = mint_print_token(document_id, org_id)
        url = f"{FRONTEND_URL}/?print={document_id}&lang={lang}&print_token={token}"
        cmd = [
            chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
            "--no-pdf-header-footer", "--virtual-time-budget=25000",
            f"--print-to-pdf={out_path}", url,
        ]
        try:
            subprocess.run(cmd, capture_output=True, timeout=180, check=False)
        except subprocess.TimeoutExpired:
            raise HTTPException(504, "PDF render timed out. Is the frontend reachable at PECHA_FRONTEND_URL?")
        if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            raise HTTPException(500, "PDF render produced no output.")
        # Navigation outline (bookmarks) — best-effort; a failure yields a booklet without
        # bookmarks rather than no PDF.
        try:
            outline = _fetch_outline(chrome, url)
            if outline:
                _inject_outline(out_path, outline)
        except Exception:
            pass
        with open(out_path, "rb") as f:
            return f.read()
    finally:
        _safe_unlink(out_path)


@router.get("/documents/{document_id}/pdf")
def export_pdf(document_id: int, lang: str = "en"):
    conn = get_db()
    try:
        doc = _require_doc(conn, document_id)
        title = doc["title"]
        org_id = doc["org_id"]
    finally:
        conn.close()
    pdf = _render_booklet_pdf(document_id, org_id, lang)
    safe = "".join(c for c in (title or "booklet") if c.isalnum() or c in " -_").strip() or "booklet"
    return Response(
        content=pdf, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{safe}-{lang}.pdf"'},
    )


def _fetch_outline(chrome: str, url: str) -> list:
    """Render the print page a second time with --dump-dom and read the navigation
    outline the page emits as a `<script id="booklet-outline">` JSON blob."""
    out = subprocess.run(
        [chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
         "--virtual-time-budget=25000", "--dump-dom", url],
        capture_output=True, timeout=120)
    html = out.stdout.decode("utf-8", "replace")
    m = re.search(r'<script id="booklet-outline"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        return []
    try:
        data = json.loads(m.group(1) or "[]")
        return data if isinstance(data, list) else []
    except json.JSONDecodeError:
        return []


def _inject_outline(path: str, outline: list) -> None:
    """Write a nested bookmark outline into the PDF at `path` (page indices are 0-based
    physical pages emitted by the print page)."""
    from pypdf import PdfReader, PdfWriter
    writer = PdfWriter()
    writer.append(PdfReader(path))
    n = len(writer.pages)
    if not n:
        return

    def add(nodes: list, parent) -> None:
        for node in nodes:
            if not isinstance(node, dict):
                continue
            pi = node.get("pageIndex", 0)
            try:
                pi = max(0, min(n - 1, int(pi)))
            except (TypeError, ValueError):
                pi = 0
            title = (node.get("title") or " ").strip() or " "
            item = writer.add_outline_item(title, pi, parent=parent)
            kids = node.get("children")
            if isinstance(kids, list) and kids:
                add(kids, item)

    add(outline, None)
    with open(path, "wb") as f:
        writer.write(f)


def _safe_unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


# ─── Image pages (Phase D3) ──────────────────────────────────────────────────
# One image per `image_page` item, stored inline (booklet images are few/small),
# shared across language editions. Served back to the print route / editor preview.

ALLOWED_IMAGE_MIME = {"image/png", "image/jpeg", "image/webp", "image/gif"}
MAX_IMAGE_BYTES = 10 * 1024 * 1024
# Furniture kinds that can carry an imported (resizable) image — the cover seal, the
# copyright/second-cover emblem, the back cover, and standalone image pages.
IMAGE_KINDS = ("cover", "copyright", "image_page", "backcover")


@router.put("/document-items/{item_id}/image")
async def upload_item_image(item_id: int, file: UploadFile = File(...)):
    data = await file.read()
    mime = file.content_type or ""
    if mime not in ALLOWED_IMAGE_MIME:
        raise HTTPException(415, f"Unsupported image type: {mime or 'unknown'}")
    if not data:
        raise HTTPException(400, "Empty file")
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "Image too large (max 10 MB)")
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT document_id, kind FROM document_items WHERE id = ?", (item_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Item not found")
        if row["kind"] not in IMAGE_KINDS:
            raise HTTPException(400, "Item does not support an image")
        conn.execute(
            "INSERT INTO document_images (item_id, document_id, mime, data) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(item_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, "
            "updated_at = CURRENT_TIMESTAMP",
            (item_id, row["document_id"], mime, data))
        _touch(conn, row["document_id"])
        conn.commit()
        return {"ok": True, "mime": mime, "bytes": len(data)}
    finally:
        conn.close()


@router.get("/document-items/{item_id}/image")
def get_item_image(item_id: int):
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT mime, data FROM document_images WHERE item_id = ?", (item_id,)).fetchone()
        if not row:
            raise HTTPException(404, "No image for this item")
        return Response(content=row["data"], media_type=row["mime"],
                        headers={"Cache-Control": "no-store"})
    finally:
        conn.close()


@router.delete("/document-items/{item_id}/image")
def delete_item_image(item_id: int):
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT document_id FROM document_images WHERE item_id = ?", (item_id,)).fetchone()
        conn.execute("DELETE FROM document_images WHERE item_id = ?", (item_id,))
        if row:
            _touch(conn, row["document_id"])
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.put("/document-items/{item_id}/image/size")
def set_item_image_size(item_id: int, payload: ImageSizeIn):
    """Set the image's display size (mm); null clears a dimension (→ natural)."""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT document_id FROM document_images WHERE item_id = ?", (item_id,)).fetchone()
        if not row:
            raise HTTPException(404, "No image for this item")
        conn.execute(
            "UPDATE document_images SET width_mm = ?, height_mm = ? WHERE item_id = ?",
            (payload.width_mm, payload.height_mm, item_id))
        _touch(conn, row["document_id"])
        conn.commit()
        return {"ok": True, "width_mm": payload.width_mm, "height_mm": payload.height_mm}
    finally:
        conn.close()


# ═══ Booklet versioning (semver): frozen PDFs + tip-of-major data snapshots ═══════
#
# A version bump freezes the booklet: every version stores the rendered PDF *bytes*
# per edition (so old versions consult/re-export unchanged, independent of the live
# DB), and the tip of each major additionally keeps a lossless data snapshot
# (translations/phonetics/layout/styles/content) for read-only fine-grained access.
#
# The PDF render (headless Chromium, minutes) runs on a single module-level daemon
# thread fed by a queue — NOT FastAPI BackgroundTasks, which would pin a request-
# threadpool slot and starve the all-sync document routes. The queue also serializes
# bumps. ASSUMES a single uvicorn worker (in-process queue). Stuck 'rendering' rows
# left by a restart are marked failed in init_db (db.py).

_version_render_q: "_queue.Queue[int]" = _queue.Queue()
_version_worker_started = False
_version_worker_lock = threading.Lock()


def _start_version_worker():
    global _version_worker_started
    with _version_worker_lock:
        if _version_worker_started:
            return
        threading.Thread(target=_version_worker_loop, name="version-render",
                         daemon=True).start()
        _version_worker_started = True


def _version_worker_loop():
    while True:
        version_id = _version_render_q.get()
        try:
            _render_version(version_id)
        except Exception as e:  # never let the worker thread die
            conn = get_db()
            try:
                conn.execute(
                    "UPDATE document_versions SET status='failed', error=? WHERE id=?",
                    (str(e)[:500], version_id))
                conn.commit()
            except Exception:
                pass
            finally:
                conn.close()
        finally:
            _version_render_q.task_done()


def _render_version(version_id: int):
    """Render every edition of a version to frozen PDF bytes. Own DB connection
    (runs off the request thread); a token is minted per edition."""
    conn = get_db()
    try:
        v = conn.execute(
            "SELECT document_id, org_id, langs FROM document_versions WHERE id=?",
            (version_id,)).fetchone()
        if not v:
            return
        document_id, org_id = v["document_id"], v["org_id"]
        langs = json.loads(v["langs"] or "[]")
    finally:
        conn.close()

    for lang in langs:
        pdf = _render_booklet_pdf(document_id, org_id, lang)  # may raise → worker marks failed
        page_count = None
        try:
            from pypdf import PdfReader
            page_count = len(PdfReader(io.BytesIO(pdf)).pages)
        except Exception:
            pass
        conn = get_db()
        try:
            conn.execute(
                "INSERT INTO document_version_pdf (version_id, lang, pdf, page_count, byte_size) "
                "VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(version_id, lang) DO UPDATE SET "
                "pdf=excluded.pdf, page_count=excluded.page_count, byte_size=excluded.byte_size",
                (version_id, lang, pdf, page_count, len(pdf)))
            conn.commit()
        finally:
            conn.close()

    conn = get_db()
    try:
        conn.execute("UPDATE document_versions SET status='ready', error=NULL WHERE id=?",
                     (version_id,))
        conn.commit()
    finally:
        conn.close()


def _next_semver(conn, document_id: int, bump: str) -> tuple[int, int]:
    """Compute the next (major, minor). No versions yet → 1.0; 'minor' → maj.(min+1)
    of the current max; 'major' → (maxmajor+1).0."""
    row = conn.execute(
        "SELECT major, minor FROM document_versions WHERE document_id=? "
        "ORDER BY major DESC, minor DESC LIMIT 1", (document_id,)).fetchone()
    if not row:
        return (1, 0)
    if bump == "major":
        return (row["major"] + 1, 0)
    return (row["major"], row["minor"] + 1)


def _version_out(row) -> DocumentVersionOut:
    return DocumentVersionOut(
        id=row["id"], document_id=row["document_id"], major=row["major"],
        minor=row["minor"], semver=row["semver"], bump=row["bump"], note=row["note"],
        status=row["status"], error=row["error"], langs=json.loads(row["langs"] or "[]"),
        has_snapshot=bool(row["has_snapshot"]), created_at=row["created_at"])


# ─── Data snapshot (Phase B): lossless capture of the compile inputs ──────────────

def _dump(conn, sql: str, params=()) -> list:
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def _text_closure(conn, root_ids: list[int]) -> list[int]:
    """The transitive set of texts a booklet composes from: each item's text plus its
    ancestors (parent_text_id) and derivation sources (derivation_ops.src_text_id).
    Snapshotting this whole closure makes the capture faithful to what the print route
    actually renders (transcluded content lives in the source texts)."""
    seen: set[int] = set()
    stack = [t for t in root_ids if t is not None]
    while stack:
        tid = stack.pop()
        if tid is None or tid in seen:
            continue
        seen.add(tid)
        r = conn.execute("SELECT parent_text_id FROM texts WHERE id=?", (tid,)).fetchone()
        if r and r["parent_text_id"] is not None:
            stack.append(r["parent_text_id"])
        for s in conn.execute(
                "SELECT DISTINCT src_text_id FROM derivation_ops "
                "WHERE text_id=? AND src_text_id IS NOT NULL", (tid,)):
            stack.append(s["src_text_id"])
    return sorted(seen)


def _in_clause(ids: list) -> str:
    """A safe `IN (…)` fragment for a list of ints (ids are DB-internal, not user text)."""
    return "(" + ",".join(str(int(i)) for i in ids) + ")" if ids else "(NULL)"


def _capture_snapshot(conn, document_id: int) -> dict:
    """Serialize every compile input the print route consumes into a plain dict
    (gzipped by the caller). Raw table rows keyed by table → lossless, and enough
    to re-render or restore later; the viewer reads the translation/phonetics parts."""
    org_id = _require_doc(conn, document_id)["org_id"]
    root_ids = [r["text_id"] for r in conn.execute(
        "SELECT text_id FROM document_items WHERE document_id=? AND text_id IS NOT NULL",
        (document_id,)).fetchall()]
    texts = _text_closure(conn, root_ids)
    tc = _in_clause(texts)

    chunk_ids = [r["id"] for r in conn.execute(
        f"SELECT id FROM translation_chunks WHERE origin_text_id IN {tc}").fetchall()]
    cc = _in_clause(chunk_ids)
    op_ids = [r["id"] for r in conn.execute(
        f"SELECT id FROM derivation_ops WHERE text_id IN {tc}").fetchall()]
    oc = _in_clause(op_ids)
    layout_ids = [r["id"] for r in conn.execute(
        f"SELECT id FROM chunk_layouts WHERE text_id IN {tc}").fetchall()]
    lc = _in_clause(layout_ids)
    passage_ids = [r["id"] for r in conn.execute(
        f"SELECT id FROM passages WHERE text_id IN {tc}").fetchall()]
    pc = _in_clause(passage_ids)

    snap = {
        "schema": 1,
        "document_id": document_id,
        "document": _dump(conn, "SELECT * FROM documents WHERE id=?", (document_id,)),
        "document_items": _dump(conn, "SELECT * FROM document_items WHERE document_id=?", (document_id,)),
        "document_languages": _dump(conn, "SELECT * FROM document_languages WHERE document_id=?", (document_id,)),
        "document_layout": _dump(conn, "SELECT * FROM document_layout WHERE document_id=?", (document_id,)),
        "document_furniture": _dump(conn, "SELECT * FROM document_furniture WHERE document_id=?", (document_id,)),
        "title_page_field": _dump(conn, "SELECT * FROM title_page_field WHERE document_id=?", (document_id,)),
        "document_style_overrides": _dump(conn, "SELECT * FROM document_style_overrides WHERE document_id=?", (document_id,)),
        # org-scoped styling (resolved against overrides at render time)
        "style_roles": _dump(conn, "SELECT * FROM style_roles WHERE org_id=?", (org_id,)),
        "org_layout": _dump(conn, "SELECT * FROM org_layout WHERE org_id=?", (org_id,)),
        # image/seal/font BLOBs go to document_version_asset — meta only here
        "document_images": _dump(conn,
            "SELECT item_id, document_id, width_mm, height_mm, mime FROM document_images "
            "WHERE document_id=?", (document_id,)),
        "tags": _dump(conn, f"SELECT * FROM tags WHERE org_id=? AND (text_id IS NULL OR text_id IN {tc})", (org_id,)),
        "text_ids": texts,
        "texts": {},
    }
    for tid in texts:
        snap["texts"][str(tid)] = {
            "text": _dump(conn, "SELECT * FROM texts WHERE id=?", (tid,)),
            "syllables": _dump(conn, "SELECT * FROM syllables WHERE text_id=? ORDER BY idx", (tid,)),
            "spans": _dump(conn, "SELECT * FROM spans WHERE text_id=?", (tid,)),
            "display_breaks": _dump(conn, "SELECT * FROM display_breaks WHERE text_id=?", (tid,)),
            "markers": _dump(conn, "SELECT * FROM markers WHERE text_id=?", (tid,)),
            "derivation_ops": _dump(conn, "SELECT * FROM derivation_ops WHERE text_id=?", (tid,)),
            "tree_nodes": _dump(conn, "SELECT * FROM tree_nodes WHERE text_id=?", (tid,)),
            "passages": _dump(conn, "SELECT * FROM passages WHERE text_id=?", (tid,)),
            "translation_chunks": _dump(conn, "SELECT * FROM translation_chunks WHERE origin_text_id=?", (tid,)),
            "phonetics": _dump(conn, "SELECT * FROM phonetics WHERE origin_text_id=?", (tid,)),
            "chunk_layouts": _dump(conn, "SELECT * FROM chunk_layouts WHERE text_id=?", (tid,)),
        }
    # cross-text child tables, captured once by the collected id sets
    snap["translations"] = _dump(conn, f"SELECT * FROM translations WHERE chunk_id IN {cc}")
    snap["translation_overrides"] = _dump(conn, f"SELECT * FROM translation_overrides WHERE chunk_id IN {cc}")
    snap["derivation_op_syllables"] = _dump(conn, f"SELECT * FROM derivation_op_syllables WHERE op_id IN {oc}")
    snap["layout_titles"] = _dump(conn, f"SELECT * FROM layout_titles WHERE layout_id IN {lc}")
    snap["passage_members"] = _dump(conn, f"SELECT * FROM passage_members WHERE passage_id IN {pc}")
    return snap


def _store_snapshot(conn, version_id: int, document_id: int):
    """Capture + gzip the snapshot JSON, copy the binary assets, mark has_snapshot."""
    org_id = _require_doc(conn, document_id)["org_id"]
    snap = _capture_snapshot(conn, document_id)
    blob = gzip.compress(json.dumps(snap, ensure_ascii=False, default=str).encode("utf-8"))
    conn.execute(
        "INSERT INTO document_version_snapshot (version_id, data, byte_size, created_at) "
        "VALUES (?, ?, ?, CURRENT_TIMESTAMP) "
        "ON CONFLICT(version_id) DO UPDATE SET data=excluded.data, byte_size=excluded.byte_size",
        (version_id, blob, len(blob)))
    # Binary assets → document_version_asset (image/seal/font), for future re-render/restore.
    for img in conn.execute(
            "SELECT item_id, mime, width_mm, height_mm, data FROM document_images "
            "WHERE document_id=?", (document_id,)).fetchall():
        conn.execute(
            "INSERT OR REPLACE INTO document_version_asset "
            "(version_id, kind, ref, mime, meta, data) VALUES (?, 'image', ?, ?, ?, ?)",
            (version_id, str(img["item_id"]), img["mime"],
             json.dumps({"width_mm": img["width_mm"], "height_mm": img["height_mm"]}),
             img["data"]))
    seal = conn.execute("SELECT mime, data FROM org_seal WHERE org_id=?", (org_id,)).fetchone()
    if seal:
        conn.execute(
            "INSERT OR REPLACE INTO document_version_asset "
            "(version_id, kind, ref, mime, meta, data) VALUES (?, 'seal', '', ?, '{}', ?)",
            (version_id, seal["mime"], seal["data"]))
    for font in conn.execute(
            "SELECT id, family, weight, italic, mime, data FROM org_fonts WHERE org_id=?",
            (org_id,)).fetchall():
        conn.execute(
            "INSERT OR REPLACE INTO document_version_asset "
            "(version_id, kind, ref, mime, meta, data) VALUES (?, 'font', ?, ?, ?, ?)",
            (version_id, str(font["id"]), font["mime"],
             json.dumps({"family": font["family"], "weight": font["weight"], "italic": font["italic"]}),
             font["data"]))
    conn.execute("UPDATE document_versions SET has_snapshot=1 WHERE id=?", (version_id,))


def _prune_major_snapshots(conn, document_id: int, keep_version_id: int, major: int):
    """Keep exactly one data snapshot per major, at its current tip. Drop the snapshot
    (and its assets) from every OTHER version in the same major; their PDFs stay."""
    stale = conn.execute(
        "SELECT id FROM document_versions WHERE document_id=? AND major=? AND id!=? "
        "AND has_snapshot=1", (document_id, major, keep_version_id)).fetchall()
    for r in stale:
        conn.execute("DELETE FROM document_version_snapshot WHERE version_id=?", (r["id"],))
        conn.execute("DELETE FROM document_version_asset WHERE version_id=?", (r["id"],))
        conn.execute("UPDATE document_versions SET has_snapshot=0 WHERE id=?", (r["id"],))


# ─── Version endpoints (all path-scoped by document_id → the main.py "documents"
#     guard supplies org isolation; no _ORG_RESOLVERS change needed) ───────────────

@router.get("/documents/{document_id}/versions", response_model=List[DocumentVersionOut])
def list_versions(document_id: int):
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        rows = conn.execute(
            "SELECT * FROM document_versions WHERE document_id=? "
            "ORDER BY major DESC, minor DESC", (document_id,)).fetchall()
        return [_version_out(r) for r in rows]
    finally:
        conn.close()


@router.post("/documents/{document_id}/versions", response_model=DocumentVersionOut)
def create_version(document_id: int, payload: DocumentVersionCreate):
    """Bump the booklet. Synchronously: freeze a lossless data snapshot (of the exact
    current DB), prune old same-major snapshots, insert the version row; then enqueue
    the (slow) PDF render off-thread. Returns the row in 'rendering'."""
    if payload.bump not in ("major", "minor"):
        raise HTTPException(400, "bump must be 'major' or 'minor'")
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        langs = _doc_languages(conn, document_id)
        if not langs:
            raise HTTPException(400, "This booklet has no languages to publish.")
        org_id = _require_doc(conn, document_id)["org_id"]
        major, minor = _next_semver(conn, document_id, payload.bump)
        semver = f"{major}.{minor}"
        cur = conn.execute(
            "INSERT INTO document_versions "
            "(document_id, org_id, major, minor, semver, bump, note, status, langs, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, 'rendering', ?, CURRENT_TIMESTAMP)",
            (document_id, org_id, major, minor, semver, payload.bump, payload.note,
             json.dumps(langs)))
        version_id = cur.lastrowid
        # Snapshot (sync) freezes the exact bump moment; then keep one per major (tip).
        _store_snapshot(conn, version_id, document_id)
        _prune_major_snapshots(conn, document_id, version_id, major)
        conn.commit()
        row = conn.execute("SELECT * FROM document_versions WHERE id=?", (version_id,)).fetchone()
    finally:
        conn.close()
    _start_version_worker()
    _version_render_q.put(version_id)
    return _version_out(row)


@router.get("/documents/{document_id}/versions/{version_id}/pdf")
def get_version_pdf(document_id: int, version_id: int, lang: str = "en", download: int = 0):
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        v = conn.execute(
            "SELECT semver FROM document_versions WHERE id=? AND document_id=?",
            (version_id, document_id)).fetchone()
        if not v:
            raise HTTPException(404, "Version not found")
        row = conn.execute(
            "SELECT pdf FROM document_version_pdf WHERE version_id=? AND lang=?",
            (version_id, lang)).fetchone()
        if not row:
            raise HTTPException(404, "No PDF for this version/edition (still rendering, or failed).")
        pdf = row["pdf"]
        semver = v["semver"]
    finally:
        conn.close()
    disp = "attachment" if download else "inline"
    return Response(
        content=pdf, media_type="application/pdf",
        headers={"Content-Disposition": f'{disp}; filename="v{semver}-{lang}.pdf"'})


@router.post("/documents/{document_id}/versions/{version_id}/retry",
             response_model=DocumentVersionOut)
def retry_version(document_id: int, version_id: int):
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        row = conn.execute(
            "SELECT * FROM document_versions WHERE id=? AND document_id=?",
            (version_id, document_id)).fetchone()
        if not row:
            raise HTTPException(404, "Version not found")
        if row["status"] == "rendering":
            raise HTTPException(409, "This version is already rendering.")
        conn.execute("UPDATE document_versions SET status='rendering', error=NULL WHERE id=?",
                     (version_id,))
        conn.commit()
        row = conn.execute("SELECT * FROM document_versions WHERE id=?", (version_id,)).fetchone()
    finally:
        conn.close()
    _start_version_worker()
    _version_render_q.put(version_id)
    return _version_out(row)


@router.delete("/documents/{document_id}/versions/{version_id}")
def delete_version(document_id: int, version_id: int):
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        if not conn.execute(
                "SELECT 1 FROM document_versions WHERE id=? AND document_id=?",
                (version_id, document_id)).fetchone():
            raise HTTPException(404, "Version not found")
        conn.execute("DELETE FROM document_versions WHERE id=?", (version_id,))  # CASCADE pdf/snapshot/asset
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@router.get("/documents/{document_id}/versions/{version_id}/snapshot")
def get_version_snapshot(document_id: int, version_id: int):
    """The gunzipped snapshot JSON for the read-only viewer (tip-of-major versions only)."""
    conn = get_db()
    try:
        _require_doc(conn, document_id)
        if not conn.execute(
                "SELECT 1 FROM document_versions WHERE id=? AND document_id=?",
                (version_id, document_id)).fetchone():
            raise HTTPException(404, "Version not found")
        row = conn.execute(
            "SELECT data FROM document_version_snapshot WHERE version_id=?",
            (version_id,)).fetchone()
        if not row:
            raise HTTPException(404, "This version has no data snapshot.")
        data = json.loads(gzip.decompress(row["data"]).decode("utf-8"))
    finally:
        conn.close()
    return data
