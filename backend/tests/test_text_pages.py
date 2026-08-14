"""Aligned TEXT PAGES, reused by booklets.

Aligning a text against its translations — page breaks, mid-line splits, gaps, block widths —
is the expensive hand work, and `document_layout` addresses it by `item_id`. So the same text
in a second booklet used to mean a second item with nothing on it and the whole alignment done
again (960 rows on one item, in the live data).

A text page now owns that work, and a booklet reuses it by reference: same item id, same rows,
nothing copied. The booklet may still tune it locally, and its own row shadows the inherited
one exactly where it is placed.
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
from app.manifest import load_syllables, persist_syllables  # noqa: E402

init_db()

RAW = "སངས་རྒྱས་ཆོས་དང་ཚོགས་ཀྱི་མཆོག་རྣམས་ལ།"


def _mk_text(conn, title, instance):
    cur = conn.execute(
        "INSERT INTO texts (filename, title, source_text, raw_text, text_type) "
        "VALUES ('t.txt', ?, '', ?, 'primary')", (title, RAW))
    tid = cur.lastrowid
    persist_syllables(conn, tid, instance, RAW)
    conn.commit()
    return tid


def _anchors(conn, text_id, n=3):
    return [s["id"] for s in load_syllables(conn, text_id)[:n]]


def _booklet_with_text(title, text_id):
    """A booklet holding its own text page, as everything was before the split."""
    from app.routers.documents import create_document, add_item
    from app.schemas import DocumentCreate, DocumentItemIn
    doc = create_document(DocumentCreate(title=title))
    item = add_item(doc.id, DocumentItemIn(kind="text", text_id=text_id))
    return doc.id, item.id


def _put(doc_id, item_id, anchor, kind="page_break", lang=None, value=None):
    from app.routers.documents import upsert_layout_row
    from app.schemas import DocumentLayoutIn
    return upsert_layout_row(doc_id, DocumentLayoutIn(
        item_id=item_id, anchor_syl_id=anchor, kind=kind, lang=lang, value=value))


def test_extracting_keeps_every_layout_row_and_the_item_id():
    from app.routers.documents import extract_text_page, get_document, get_layout

    conn = get_db()
    tid = _mk_text(conn, "AlignA", "align_a")
    a = _anchors(conn, tid)
    conn.close()
    doc, item = _booklet_with_text("Booklet A", tid)
    for x in a:
        _put(doc, item, x)
    before = {(r.item_id, r.anchor_syl_id, r.kind, r.lang) for r in get_layout(doc).rows}
    assert len(before) == 3

    ref = extract_text_page(item)
    assert ref.kind == "textpage"
    # The reference resolves to the same text, and to the item the alignment is keyed by.
    assert ref.text_id == tid
    assert ref.layout_item_id == item

    # The booklet still sees every row — now inherited, not owned.
    after = get_layout(doc).rows
    assert {(r.item_id, r.anchor_syl_id, r.kind, r.lang) for r in after} == before
    assert all(r.inherited for r in after)
    # And its page is the reference, in the same position.
    kinds = [i.kind for i in get_document(doc).items]
    assert kinds == ["textpage"]


def test_a_second_booklet_gets_the_alignment_for_free():
    from app.routers.documents import extract_text_page, get_layout, create_document, add_item
    from app.schemas import DocumentCreate, DocumentItemIn

    conn = get_db()
    tid = _mk_text(conn, "AlignB", "align_b")
    a = _anchors(conn, tid)
    conn.close()
    doc, item = _booklet_with_text("Booklet B", tid)
    for x in a:
        _put(doc, item, x)
    page = extract_text_page(item).ref_document_id

    # The point of the whole change: a NEW booklet, referencing the same aligned text,
    # arrives already aligned — without a row of its own.
    other = create_document(DocumentCreate(title="Booklet B2"))
    add_item(other.id, DocumentItemIn(kind="textpage", ref_document_id=page))
    rows = get_layout(other.id).rows
    assert {(r.item_id, r.anchor_syl_id, r.kind) for r in rows} \
        == {(item, x, "page_break") for x in a}
    assert all(r.inherited for r in rows)


def test_a_booklet_may_tune_the_alignment_without_touching_the_others():
    from app.routers.documents import (
        extract_text_page, get_layout, create_document, add_item, delete_layout_row)
    from app.schemas import DocumentCreate, DocumentItemIn, DocumentLayoutDeleteIn

    conn = get_db()
    tid = _mk_text(conn, "AlignC", "align_c")
    a = _anchors(conn, tid)
    conn.close()
    doc, item = _booklet_with_text("Booklet C", tid)
    _put(doc, item, a[0], kind="line_space", lang="en", value=1.0)
    page = extract_text_page(item).ref_document_id

    other = create_document(DocumentCreate(title="Booklet C2"))
    add_item(other.id, DocumentItemIn(kind="textpage", ref_document_id=page))
    # A local tweak on the SAME (item, anchor, kind, lang) shadows the inherited row…
    _put(other.id, item, a[0], kind="line_space", lang="en", value=4.5)
    rows = get_layout(other.id).rows
    assert len(rows) == 1
    assert rows[0].value == 4.5 and rows[0].inherited is False
    # …and leaves the other booklet — and the aligned text — alone.
    assert [r.value for r in get_layout(doc).rows] == [1.0]
    assert [r.value for r in get_layout(page).rows] == [1.0]

    # Dropping the override falls back to what the aligned text says.
    delete_layout_row(other.id, DocumentLayoutDeleteIn(
        item_id=item, anchor_syl_id=a[0], kind="line_space", lang="en"))
    back = get_layout(other.id).rows
    assert len(back) == 1 and back[0].value == 1.0 and back[0].inherited is True


def test_only_a_text_page_can_be_reused_and_only_once_extracted():
    from app.routers.documents import extract_text_page, create_document, add_item
    from app.schemas import DocumentCreate, DocumentItemIn
    import pytest

    conn = get_db()
    tid = _mk_text(conn, "AlignD", "align_d")
    conn.close()
    doc, item = _booklet_with_text("Booklet D", tid)

    # A booklet is not an ingredient.
    other = create_document(DocumentCreate(title="Booklet D2"))
    with pytest.raises(Exception):
        add_item(other.id, DocumentItemIn(kind="textpage", ref_document_id=doc))

    page = extract_text_page(item).ref_document_id
    # An aligned text is already extracted; it cannot be extracted again.
    with pytest.raises(Exception):
        extract_text_page(item)
    # …and it IS reusable.
    added = add_item(other.id, DocumentItemIn(kind="textpage", ref_document_id=page))
    assert added.text_id == tid


if __name__ == "__main__":
    test_extracting_keeps_every_layout_row_and_the_item_id()
    test_a_second_booklet_gets_the_alignment_for_free()
    test_a_booklet_may_tune_the_alignment_without_touching_the_others()
    test_only_a_text_page_can_be_reused_and_only_once_extracted()
    print("ok")
