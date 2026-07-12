"""Documents (Phase D1): booklets assembled from an ordered sequence of pages.

A document is a booklet — ordered `document_items` (multiple secondary texts +
furniture pages: cover/blank/toc/copyright/image/backcover) published in a set of
`document_languages` that page-align. D1 is the structure + management layer only;
pagination lands page numbers (D2) and PDF export (D3) come later. The auto-TOC is
computed from each text page's section tree (reuses tree_nodes.get_nested_tree).
"""
from typing import List

from fastapi import APIRouter, HTTPException

from ..db import get_db
from ..schemas import (
    DocumentCreate, DocumentUpdate, DocumentOut, DocumentDetailOut,
    DocumentItemIn, DocumentItemPatch, DocumentItemOut,
    DocumentReorderIn, DocumentLanguagesIn, TocEntry, TocSection,
)
from .tree_nodes import get_nested_tree

router = APIRouter(prefix="/api", tags=["documents"])


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
    return DocumentItemOut(
        id=row["id"], document_id=row["document_id"], position=row["position"],
        kind=row["kind"], text_id=row["text_id"], text_title=title,
        caption=row["caption"], body=row["body"])


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
            out.append(TocSection(title=title, level=None, children=kids))
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
