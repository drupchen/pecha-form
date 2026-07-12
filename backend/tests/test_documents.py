"""Documents (Phase D1): compose booklets from ordered items, languages, auto-TOC."""
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


def _mk_primary(conn, title, instance, raw):
    cur = conn.execute(
        "INSERT INTO texts (filename, title, source_text, raw_text, text_type) "
        "VALUES ('t.txt', ?, '', ?, 'primary')", (title, raw))
    tid = cur.lastrowid
    persist_syllables(conn, tid, instance, raw)
    conn.commit()
    return tid


def test_document_compose_reorder_languages_toc_and_cascade():
    from app.routers.documents import (
        create_document, get_document, add_item, reorder_items, delete_item,
        set_languages, document_toc, delete_document, list_documents,
    )
    from app.schemas import (
        DocumentCreate, DocumentItemIn, DocumentReorderIn, DocumentLanguagesIn,
    )

    conn = get_db()
    t = _mk_primary(conn, "SecA", "sec_a", RAW)
    syls = load_syllables(conn, t)
    # A titled top-level section + an untitled (transparent) node with a titled child.
    conn.execute(
        "INSERT INTO tree_nodes (text_id, parent_id, position, title, segment_start_syl_id, "
        "transparent) VALUES (?, NULL, 0, 'Refuge', ?, 0)", (t, syls[0]["id"]))
    parent = conn.execute(
        "INSERT INTO tree_nodes (text_id, parent_id, position, title, segment_start_syl_id, "
        "transparent) VALUES (?, NULL, 1, NULL, ?, 1)", (t, syls[2]["id"])).lastrowid
    conn.execute(
        "INSERT INTO tree_nodes (text_id, parent_id, position, title, segment_start_syl_id, "
        "transparent) VALUES (?, ?, 0, 'Bodhicitta', ?, 0)", (t, parent, syls[3]["id"]))
    conn.commit()
    conn.close()

    doc = create_document(DocumentCreate(title="  Rangjung Pema Nyingtik  "))
    assert doc.title == "Rangjung Pema Nyingtik" and doc.item_count == 0

    cover = add_item(doc.id, DocumentItemIn(kind="cover"))
    toc = add_item(doc.id, DocumentItemIn(kind="toc"))
    text_pg = add_item(doc.id, DocumentItemIn(kind="text", text_id=t))
    back = add_item(doc.id, DocumentItemIn(kind="backcover"))
    assert text_pg.text_title == "SecA"
    assert [i.position for i in (cover, toc, text_pg, back)] == [0, 1, 2, 3]

    # A text page requires a text_id; furniture must not carry one.
    import pytest
    with pytest.raises(Exception):
        add_item(doc.id, DocumentItemIn(kind="text"))
    with pytest.raises(Exception):
        add_item(doc.id, DocumentItemIn(kind="blank", text_id=t))

    # Reorder: move the back cover before the text page.
    reordered = reorder_items(doc.id, DocumentReorderIn(
        ordered_ids=[cover.id, toc.id, back.id, text_pg.id]))
    assert [i.id for i in reordered] == [cover.id, toc.id, back.id, text_pg.id]

    # Languages replace-set, order preserved, unknown/dupes dropped.
    langs = set_languages(doc.id, DocumentLanguagesIn(langs=["fr", "en", "fr", "xx", "de"]))
    assert langs == ["fr", "en", "de"]

    detail = get_document(doc.id)
    assert detail.languages == ["fr", "en", "de"]
    assert len(detail.items) == 4

    # TOC: one entry for the text page; titled sections kept, untitled node's titled
    # child promoted to top level.
    toc_entries = document_toc(doc.id)
    assert len(toc_entries) == 1
    entry = toc_entries[0]
    assert entry.text_id == t and entry.text_title == "SecA"
    section_titles = [s.title for s in entry.sections]
    assert section_titles == ["Refuge", "Bodhicitta"]

    # Delete an item, then the whole document (cascades items + languages).
    delete_item(cover.id)
    assert len(get_document(doc.id).items) == 3
    delete_document(doc.id)
    assert all(d.id != doc.id for d in list_documents())
    conn = get_db()
    assert conn.execute("SELECT COUNT(*) c FROM document_items WHERE document_id=?",
                        (doc.id,)).fetchone()["c"] == 0
    assert conn.execute("SELECT COUNT(*) c FROM document_languages WHERE document_id=?",
                        (doc.id,)).fetchone()["c"] == 0
    conn.close()


def test_document_layout_config_and_rows():
    from app.routers.documents import (
        create_document, add_item, get_layout, put_layout_config,
        upsert_layout_row, delete_layout_row, delete_document,
        DEFAULT_LAYOUT_CONFIG,
    )
    from app.schemas import (
        DocumentCreate, DocumentItemIn, DocumentLayoutConfigIn,
        DocumentLayoutIn, DocumentLayoutDeleteIn,
    )

    conn = get_db()
    t = _mk_primary(conn, "LayoutT", "layout_t", RAW)
    syls = load_syllables(conn, t)
    conn.close()

    doc = create_document(DocumentCreate(title="Booklet"))
    item = add_item(doc.id, DocumentItemIn(kind="text", text_id=t))

    # Defaults until overridden.
    lay = get_layout(doc.id)
    assert lay.config["page_width_mm"] == DEFAULT_LAYOUT_CONFIG["page_width_mm"]
    assert lay.rows == []

    # Config override merges onto defaults; junk keys ignored.
    lay = put_layout_config(doc.id, DocumentLayoutConfigIn(
        config={"translation_pt": 12.0, "bogus": 99}))
    assert lay.config["translation_pt"] == 12.0
    assert "bogus" not in lay.config
    assert lay.config["page_height_mm"] == DEFAULT_LAYOUT_CONFIG["page_height_mm"]

    # A shared page break (lang None → stored as '') plus a per-line balancing row.
    br = upsert_layout_row(doc.id, DocumentLayoutIn(
        item_id=item.id, anchor_syl_id=syls[3]["id"], kind="page_break", char_offset=2))
    assert br.kind == "page_break" and br.char_offset == 2 and (br.lang or "") == ""
    upsert_layout_row(doc.id, DocumentLayoutIn(
        item_id=item.id, anchor_syl_id=syls[1]["id"], kind="line_space", value=-4.0))

    # Upsert is idempotent (same key updates, no duplicate).
    upsert_layout_row(doc.id, DocumentLayoutIn(
        item_id=item.id, anchor_syl_id=syls[3]["id"], kind="page_break", char_offset=5))
    rows = get_layout(doc.id).rows
    breaks = [r for r in rows if r.kind == "page_break"]
    assert len(breaks) == 1 and breaks[0].char_offset == 5
    assert len(rows) == 2

    # Delete the break; the balancing row remains.
    delete_layout_row(doc.id, DocumentLayoutDeleteIn(
        item_id=item.id, anchor_syl_id=syls[3]["id"], kind="page_break"))
    rows = get_layout(doc.id).rows
    assert len(rows) == 1 and rows[0].kind == "line_space"

    # Deleting the document cascades the layout rows.
    delete_document(doc.id)
    conn = get_db()
    assert conn.execute("SELECT COUNT(*) c FROM document_layout WHERE document_id=?",
                        (doc.id,)).fetchone()["c"] == 0
    conn.close()


if __name__ == "__main__":
    test_document_compose_reorder_languages_toc_and_cascade()
    print("ok")
