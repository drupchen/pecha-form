"""The cover image's placement became SHARED across editions (`_share_image_placement`).

One picture prints in every booklet, and it sits directly above the Tibetan title, whose
placement has always been shared. Keying the two differently is what let an edition drift: a
missing translation re-centred the page, and the odd edition was nudged to compensate. Rows
written per edition would simply stop resolving once the reader looks for `lang = ''`, so the
migration folds each group into one shared row — keeping the value the editions agree on, which
is the one that was never a compensation.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
from app import db as _dbmod  # noqa: E402
_dbmod.DB_PATH = _tmp.name

from app.db import init_db, get_db, _share_image_placement  # noqa: E402

init_db()


def _doc(conn, langs=("fr", "pt", "de", "en")):
    doc_id = conn.execute(
        "INSERT INTO documents (title, org_id) VALUES ('booklet', 1)").lastrowid
    for i, lg in enumerate(langs):
        conn.execute("INSERT INTO document_languages (document_id, lang, position) "
                     "VALUES (?, ?, ?)", (doc_id, lg, i))
    item_id = conn.execute(
        "INSERT INTO document_items (document_id, position, kind) VALUES (?, 0, 'cover')",
        (doc_id,)).lastrowid
    return doc_id, item_id


def _place(conn, doc_id, item_id, values: dict, key="#image"):
    for lg, v in values.items():
        conn.execute(
            "INSERT INTO document_layout (document_id, item_id, anchor_syl_id, kind, value, lang) "
            "VALUES (?, ?, ?, 'shift_furniture', ?, ?)", (doc_id, item_id, key, v, lg))


def _rows(conn, doc_id, item_id, key="#image"):
    return {r["lang"]: r["value"] for r in conn.execute(
        "SELECT lang, value FROM document_layout WHERE document_id = ? AND item_id = ? "
        "AND kind = 'shift_furniture' AND anchor_syl_id = ?", (doc_id, item_id, key))}


def test_folds_to_one_shared_row_keeping_the_agreed_value():
    conn = get_db()
    try:
        doc_id, item_id = _doc(conn)
        # The live shape: three editions agree, one was nudged to compensate for the
        # re-centring this change removes.
        _place(conn, doc_id, item_id, {"fr": 7.3, "pt": 7.3, "de": 7.3, "en": 8.2})
        conn.commit()
        _share_image_placement(conn)
        conn.commit()
        assert _rows(conn, doc_id, item_id) == {"": 7.3}
    finally:
        conn.close()


def test_a_tie_takes_the_documents_first_edition():
    conn = get_db()
    try:
        doc_id, item_id = _doc(conn, langs=("pt", "fr"))
        _place(conn, doc_id, item_id, {"pt": 4.0, "fr": 9.0})
        conn.commit()
        _share_image_placement(conn)
        conn.commit()
        assert _rows(conn, doc_id, item_id) == {"": 4.0}
    finally:
        conn.close()


def test_leaves_other_blocks_and_is_idempotent():
    conn = get_db()
    try:
        doc_id, item_id = _doc(conn)
        _place(conn, doc_id, item_id, {"fr": 2.0, "en": 3.0}, key="#title_main")
        _place(conn, doc_id, item_id, {"fr": 5.0, "en": 5.0})
        conn.commit()
        _share_image_placement(conn)
        _share_image_placement(conn)          # a re-run must change nothing
        conn.commit()
        assert _rows(conn, doc_id, item_id) == {"": 5.0}
        # The translated block keeps its per-edition rows — it is that edition's text.
        assert _rows(conn, doc_id, item_id, key="#title_main") == {"fr": 2.0, "en": 3.0}
    finally:
        conn.close()


def test_an_already_shared_placement_is_untouched():
    conn = get_db()
    try:
        doc_id, item_id = _doc(conn)
        _place(conn, doc_id, item_id, {"": 6.5})
        conn.commit()
        _share_image_placement(conn)
        conn.commit()
        assert _rows(conn, doc_id, item_id) == {"": 6.5}
    finally:
        conn.close()
