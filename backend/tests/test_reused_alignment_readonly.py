"""A booklet imports a reused aligned text as it stands.

An aligned text is where its text is aligned. A booklet that reuses it takes that layout
whole — no adjustment expected, none allowed — and only the page numbers differ. The rows a
booklet used to write against the reused text page's item (which shadowed the inherited ones,
so the same text printed differently in two places) are deleted by `_drop_booklet_shadow_rows`.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
from app import db as _dbmod  # noqa: E402
_dbmod.DB_PATH = _tmp.name

from app.db import init_db, get_db, _drop_booklet_shadow_rows  # noqa: E402

init_db()


def _two_documents(conn):
    """A text page with an item of its own, and a booklet that reuses it."""
    page_id = conn.execute(
        "INSERT INTO documents (title, org_id, kind) VALUES ('aligned', 1, 'textpage')").lastrowid
    page_item = conn.execute(
        "INSERT INTO document_items (document_id, position, kind) VALUES (?, 0, 'text')",
        (page_id,)).lastrowid
    book_id = conn.execute(
        "INSERT INTO documents (title, org_id) VALUES ('booklet', 1)").lastrowid
    book_item = conn.execute(
        "INSERT INTO document_items (document_id, position, kind, ref_document_id) "
        "VALUES (?, 0, 'textpage', ?)", (book_id, page_id)).lastrowid
    conn.commit()
    return page_id, page_item, book_id, book_item


def _row(conn, doc_id, item_id, anchor='a1', kind='page_break', value=1.0):
    conn.execute(
        "INSERT INTO document_layout (document_id, item_id, anchor_syl_id, kind, value, lang) "
        "VALUES (?, ?, ?, ?, ?, '')", (doc_id, item_id, anchor, kind, value))


def _count(conn, doc_id):
    return conn.execute("SELECT COUNT(*) FROM document_layout WHERE document_id = ?",
                        (doc_id,)).fetchone()[0]


def test_drops_the_rows_a_booklet_wrote_on_a_text_it_reuses():
    conn = get_db()
    try:
        page_id, page_item, book_id, book_item = _two_documents(conn)
        _row(conn, page_id, page_item)                    # the aligned text's own — stays
        _row(conn, book_id, page_item, anchor='a2')       # the booklet SHADOWING it — goes
        _row(conn, book_id, book_item, anchor='a3')       # the booklet's own item — stays
        conn.commit()
        _drop_booklet_shadow_rows(conn)
        _drop_booklet_shadow_rows(conn)                   # idempotent
        conn.commit()
        assert _count(conn, page_id) == 1
        assert _count(conn, book_id) == 1
        left = conn.execute(
            "SELECT item_id, anchor_syl_id FROM document_layout WHERE document_id = ?",
            (book_id,)).fetchone()
        assert (left["item_id"], left["anchor_syl_id"]) == (book_item, 'a3')
    finally:
        conn.close()


def test_a_booklet_may_not_write_on_a_reused_text_page_s_item():
    from app.routers.documents import upsert_layout_row
    from app.schemas import DocumentLayoutIn
    from fastapi import HTTPException
    conn = get_db()
    try:
        page_id, page_item, book_id, book_item = _two_documents(conn)
    finally:
        conn.close()
    # Its own furniture: allowed.
    upsert_layout_row(book_id, DocumentLayoutIn(
        item_id=book_item, anchor_syl_id='x', kind='page_break', value=1.0))
    # The text it reuses: refused.
    try:
        upsert_layout_row(book_id, DocumentLayoutIn(
            item_id=page_item, anchor_syl_id='x', kind='page_break', value=1.0))
        raise AssertionError("expected the write to be refused")
    except HTTPException as e:
        assert e.status_code == 404


def test_the_booklet_reads_the_aligned_text_s_rows_marked_inherited():
    from app.routers.documents import get_layout
    conn = get_db()
    try:
        page_id, page_item, book_id, _ = _two_documents(conn)
        _row(conn, page_id, page_item, anchor='b1')
        _row(conn, page_id, page_item, anchor='b2')
        conn.commit()
    finally:
        conn.close()
    rows = get_layout(book_id).rows
    assert {r.anchor_syl_id for r in rows} == {'b1', 'b2'}
    assert all(r.inherited for r in rows)
