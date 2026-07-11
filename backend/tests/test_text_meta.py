"""Part 10: editable text metadata (inline title rename + manual group label).

`PATCH /api/texts/{id}` (`update_text_meta`) applies only the provided fields: a non-empty
`title` renames the text; a `text_group` sets its collection label, with an empty string
clearing it to NULL (ungrouped). The list endpoints surface `text_group` on every row.

Drives the router functions directly against a temp DB_PATH. Run: `python tests/test_text_meta.py`.
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
from app.routers.texts import _create_primary_text, update_text_meta, list_texts  # noqa: E402
from app.schemas import TextMetaUpdate  # noqa: E402
from fastapi import HTTPException  # noqa: E402

init_db()

RAW = "སངས་རྒྱས་ཆོས་དང་ཚོགས་ཀྱི་མཆོག་རྣམས་ལ།། \n"


def _mk(title):
    conn = get_db()
    tid = _create_primary_text(conn, "t.txt", title, RAW)
    conn.commit()
    conn.close()
    return tid


TEXT_A = _mk("first line looking title")
TEXT_B = _mk("another")


def _row(text_id):
    return next(t for t in list_texts() if t["id"] == text_id)


def test_new_text_is_ungrouped():
    assert _row(TEXT_A)["text_group"] is None


def test_rename_title():
    out = update_text_meta(TEXT_A, TextMetaUpdate(title="  Union of the Three Roots  "))
    assert out["title"] == "Union of the Three Roots"  # trimmed
    assert _row(TEXT_A)["title"] == "Union of the Three Roots"


def test_empty_title_rejected():
    try:
        update_text_meta(TEXT_A, TextMetaUpdate(title="   "))
        assert False, "expected 400 on empty title"
    except HTTPException as e:
        assert e.status_code == 400


def test_set_group():
    out = update_text_meta(TEXT_A, TextMetaUpdate(text_group="Guru Padma cycle"))
    assert out["text_group"] == "Guru Padma cycle"
    assert _row(TEXT_A)["text_group"] == "Guru Padma cycle"


def test_clear_group_with_empty_string():
    update_text_meta(TEXT_B, TextMetaUpdate(text_group="Temp"))
    out = update_text_meta(TEXT_B, TextMetaUpdate(text_group=""))
    assert out["text_group"] is None  # empty → ungrouped


def test_partial_update_leaves_other_fields():
    update_text_meta(TEXT_A, TextMetaUpdate(title="Kept", text_group="G"))
    out = update_text_meta(TEXT_A, TextMetaUpdate(title="Renamed"))  # group untouched
    assert out["title"] == "Renamed" and out["text_group"] == "G"


def test_group_path_normalized():
    # Sub-groups are a "/"-path: segments trimmed, empties dropped, re-joined.
    out = update_text_meta(TEXT_B, TextMetaUpdate(text_group=" Guru Padma / / Root "))
    assert out["text_group"] == "Guru Padma/Root"


def test_group_path_only_slashes_clears():
    out = update_text_meta(TEXT_B, TextMetaUpdate(text_group=" / / "))
    assert out["text_group"] is None  # nothing but separators → ungrouped


def test_unknown_id_404():
    try:
        update_text_meta(999999, TextMetaUpdate(title="x"))
        assert False, "expected 404"
    except HTTPException as e:
        assert e.status_code == 404


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    for fn in fns:
        fn(); print("ok", fn.__name__)
    print(f"\n{len(fns)} passed")
