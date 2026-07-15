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

from ..db import get_db
import json
import os
import re
import shutil
import subprocess
import tempfile

from ..schemas import (
    DocumentCreate, DocumentUpdate, DocumentOut, DocumentDetailOut,
    DocumentItemIn, DocumentItemPatch, DocumentItemOut,
    DocumentReorderIn, DocumentLanguagesIn, TocEntry, TocSection,
    DocumentLayoutRow, DocumentLayoutIn, DocumentLayoutDeleteIn,
    DocumentLayoutConfigIn, DocumentLayoutOut, PaginationStampIn,
    DocumentFurnitureRow, DocumentFurnitureIn, ImageSizeIn,
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
    # How many CHANGED SYLLABLES the automatic breaks may drift before the bench re-flows
    # them by itself (see `documents.pagination_sig`). Not geometry, but per-document user
    # config, which is what this JSON already is.
    "reflow_threshold": 50,
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
        rows = conn.execute("SELECT * FROM documents ORDER BY updated_at DESC, id").fetchall()
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
        cur = conn.execute("INSERT INTO documents (title) VALUES (?)", (title,))
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

def _effective_config(row) -> dict:
    cfg = dict(DEFAULT_LAYOUT_CONFIG)
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
            config=_effective_config(row),
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
            config=_effective_config(row),
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
        return [DocumentFurnitureRow(item_id=r["item_id"], lang=r["lang"], body=r["body"])
                for r in conn.execute(
                    "SELECT item_id, lang, body FROM document_furniture WHERE document_id = ?",
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
            "INSERT INTO document_furniture (document_id, item_id, lang, body) "
            "VALUES (?, ?, ?, ?) "
            "ON CONFLICT(document_id, item_id, lang) DO UPDATE SET body = excluded.body",
            (document_id, payload.item_id, payload.lang, body))
        _touch(conn, document_id)
        conn.commit()
        return DocumentFurnitureRow(item_id=payload.item_id, lang=payload.lang, body=body)
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


@router.get("/documents/{document_id}/pdf")
def export_pdf(document_id: int, lang: str = "en"):
    conn = get_db()
    try:
        doc = _require_doc(conn, document_id)
        title = doc["title"]
    finally:
        conn.close()

    chrome = _find_chrome()
    if not chrome:
        raise HTTPException(500, "No Chrome/Chromium binary found on the server for PDF export.")

    fd, out_path = tempfile.mkstemp(suffix=".pdf", prefix="booklet_")
    os.close(fd)
    url = f"{FRONTEND_URL}/?print={document_id}&lang={lang}"
    cmd = [
        chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
        "--no-pdf-header-footer", "--virtual-time-budget=25000",
        f"--print-to-pdf={out_path}", url,
    ]
    try:
        subprocess.run(cmd, capture_output=True, timeout=180, check=False)
    except subprocess.TimeoutExpired:
        _safe_unlink(out_path)
        raise HTTPException(504, "PDF render timed out. Is the frontend reachable at PECHA_FRONTEND_URL?")

    if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        _safe_unlink(out_path)
        raise HTTPException(500, "PDF render produced no output.")

    # Add the PDF navigation outline (bookmarks) — best-effort; a failure just yields a
    # booklet without bookmarks rather than no PDF.
    try:
        outline = _fetch_outline(chrome, url)
        if outline:
            _inject_outline(out_path, outline)
    except Exception:
        pass

    safe = "".join(c for c in (title or "booklet") if c.isalnum() or c in " -_").strip() or "booklet"
    filename = f"{safe}-{lang}.pdf"
    return FileResponse(
        out_path, media_type="application/pdf", filename=filename,
        background=BackgroundTask(_safe_unlink, out_path),
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
