"""Where a title comes from, and which text seeded a cover.

Two nullable columns on `document_items`.
`title_disposition` reads differently on the two kinds of page that carry a title: on a TEXT,
'none'/NULL = no inner title page, 'page' = it has an inner cover, 'body' = its title heads its
first page; on a COVER, 'own' = it stands alone, seeded from no text at all. `source_item_id` is
the aligned text a cover was filled from — whose title it carries, and whose inner cover follows
it.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
from app import db as _dbmod  # noqa: E402
_dbmod.DB_PATH = _tmp.name

from app.db import init_db, get_db  # noqa: E402

init_db()


def _doc_with_item(conn):
    doc_id = conn.execute(
        "INSERT INTO documents (title, org_id) VALUES ('booklet', 1)").lastrowid
    item_id = conn.execute(
        "INSERT INTO document_items (document_id, position, kind) VALUES (?, 0, 'cover')",
        (doc_id,)).lastrowid
    conn.commit()
    return doc_id, item_id


def _patch(item_id, **kw):
    from app.routers.documents import patch_item
    from app.schemas import DocumentItemPatch
    return patch_item(item_id, DocumentItemPatch(**kw))


def test_defaults_to_absent_so_an_existing_booklet_is_unchanged():
    conn = get_db()
    try:
        _, item_id = _doc_with_item(conn)
        from app.routers.documents import get_document
        row = conn.execute("SELECT * FROM document_items WHERE id = ?", (item_id,)).fetchone()
        assert row["title_disposition"] is None
        assert row["source_item_id"] is None
    finally:
        conn.close()


def test_sets_and_clears_the_disposition():
    conn = get_db()
    try:
        _, item_id = _doc_with_item(conn)
    finally:
        conn.close()
    assert _patch(item_id, title_disposition="page").title_disposition == "page"
    assert _patch(item_id, title_disposition="page_direct").title_disposition == "page_direct"
    assert _patch(item_id, title_disposition="body").title_disposition == "body"
    assert _patch(item_id, title_disposition="none").title_disposition == "none"
    # '' is the sentinel for "back to the default rule" — NULL, not the empty string.
    assert _patch(item_id, title_disposition="").title_disposition is None


def test_a_cover_may_stand_alone():
    """'own' — the cover is seeded from no aligned text, so its blank slots print blank.

    The same column as a text's 'page'/'body'; which of the two vocabularies applies is read
    from the item's kind, so the endpoint accepts all three and the editor offers each only
    where it means something.
    """
    conn = get_db()
    try:
        _, cover_id = _doc_with_item(conn)
    finally:
        conn.close()
    assert _patch(cover_id, title_disposition="own").title_disposition == "own"
    # Detaching also lets go of any text it had been filled from — the two travel together in
    # one patch, so the cover cannot be detached and still bind a text's inner cover.
    out = _patch(cover_id, title_disposition="own", source_item_id=0)
    assert out.title_disposition == "own" and out.source_item_id is None
    assert _patch(cover_id, title_disposition="").title_disposition is None


def test_refuses_a_disposition_it_does_not_know():
    from fastapi import HTTPException
    conn = get_db()
    try:
        _, item_id = _doc_with_item(conn)
    finally:
        conn.close()
    try:
        _patch(item_id, title_disposition="somewhere-else")
        raise AssertionError("expected a 400")
    except HTTPException as e:
        assert e.status_code == 400


def test_records_and_clears_the_cover_s_source_text():
    conn = get_db()
    try:
        doc_id, cover_id = _doc_with_item(conn)
        text_item = conn.execute(
            "INSERT INTO document_items (document_id, position, kind) VALUES (?, 1, 'text')",
            (doc_id,)).lastrowid
        conn.commit()
    finally:
        conn.close()
    assert _patch(cover_id, source_item_id=text_item).source_item_id == text_item
    # 0 clears it: the cover is seeded from no text and binds nobody's inner cover.
    assert _patch(cover_id, source_item_id=0).source_item_id is None


def test_the_other_fields_still_patch_without_touching_these():
    conn = get_db()
    try:
        _, item_id = _doc_with_item(conn)
    finally:
        conn.close()
    _patch(item_id, title_disposition="page")
    out = _patch(item_id, caption="a caption")
    assert out.caption == "a caption"
    assert out.title_disposition == "page"      # untouched, not cleared
