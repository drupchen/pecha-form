"""Part 12: persistent group registry + group reorg.

The `text_groups` table lets an *empty* group (created via the list "+" buttons) persist
with no text in it. `move` nests a group under another, prefix-rewriting every affected
text and registry row; `delete` removes an empty group only.

Drives the router functions directly against a temp DB_PATH. Run: `python tests/test_text_groups.py`.
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
from app.routers.text_groups import (  # noqa: E402
    create_text_group, list_text_groups, move_text_group, reorder_text_group, delete_text_group,
)
from app.schemas import (  # noqa: E402
    TextMetaUpdate, TextGroupCreate, TextGroupMove, TextGroupDelete, TextGroupReorder,
)
from fastapi import HTTPException  # noqa: E402

init_db()

RAW = "སངས་རྒྱས་ཆོས་དང་ཚོགས་ཀྱི་མཆོག་རྣམས་ལ།། \n"


def _mk(title):
    conn = get_db()
    tid = _create_primary_text(conn, "t.txt", title, RAW)
    conn.commit()
    conn.close()
    return tid


def _group_of(text_id):
    return next(t for t in list_texts() if t["id"] == text_id)["text_group"]


def test_create_and_list():
    out = create_text_group(TextGroupCreate(path=" Guru Padma / Root "))
    assert "Guru Padma/Root" in out           # normalized
    assert "Guru Padma/Root" in list_text_groups()


def test_create_empty_rejected():
    try:
        create_text_group(TextGroupCreate(path="  /  "))
        assert False, "expected 400"
    except HTTPException as e:
        assert e.status_code == 400


def test_move_rewrites_texts_and_registry():
    create_text_group(TextGroupCreate(path="Guru Padma"))
    create_text_group(TextGroupCreate(path="Guru Padma/Root"))
    tid = _mk("a text")
    update_text_meta(tid, TextMetaUpdate(text_group="Guru Padma/Root"))
    # Move the whole "Guru Padma" group under a new "Cycle" parent.
    move_text_group(TextGroupMove(src_path="Guru Padma", dest_path="Cycle"))
    assert _group_of(tid) == "Cycle/Guru Padma/Root"      # text prefix rewritten
    paths = list_text_groups()
    assert "Cycle/Guru Padma" in paths and "Cycle/Guru Padma/Root" in paths
    assert "Guru Padma" not in paths and "Guru Padma/Root" not in paths


def test_move_to_root():
    create_text_group(TextGroupCreate(path="Outer/Inner"))
    move_text_group(TextGroupMove(src_path="Outer/Inner", dest_path=""))
    assert "Inner" in list_text_groups()


def test_move_into_descendant_rejected():
    create_text_group(TextGroupCreate(path="A/B"))
    try:
        move_text_group(TextGroupMove(src_path="A", dest_path="A/B"))
        assert False, "expected 400"
    except HTTPException as e:
        assert e.status_code == 400


def test_delete_empty_group():
    create_text_group(TextGroupCreate(path="Trash Me"))
    delete_text_group(TextGroupDelete(path="Trash Me"))
    assert "Trash Me" not in list_text_groups()


def test_delete_nonempty_group_rejected():
    create_text_group(TextGroupCreate(path="Full"))
    tid = _mk("resident")
    update_text_meta(tid, TextMetaUpdate(text_group="Full/Sub"))
    try:
        delete_text_group(TextGroupDelete(path="Full"))
        assert False, "expected 409"
    except HTTPException as e:
        assert e.status_code == 409


def _order_of(*paths):
    """Relative order of the given paths within the full registry listing."""
    listing = list_text_groups()
    return [p for p in listing if p in set(paths)]


def test_reorder_root_columns():
    for p in ("RA", "RB", "RC"):
        create_text_group(TextGroupCreate(path=p))
    # Move RC before RA → order among the three becomes RC, RA, RB.
    reorder_text_group(TextGroupReorder(src_path="RC", parent_path="", before_path="RA"))
    assert _order_of("RA", "RB", "RC") == ["RC", "RA", "RB"]
    # Append RC to the end (no before_path).
    reorder_text_group(TextGroupReorder(src_path="RC", parent_path="", before_path=""))
    assert _order_of("RA", "RB", "RC") == ["RA", "RB", "RC"]


def test_reorder_promotes_subgroup_to_root():
    create_text_group(TextGroupCreate(path="PromoteRoot"))       # a positioned root anchor
    reorder_text_group(TextGroupReorder(src_path="PromoteRoot", parent_path="", before_path=""))
    tid = _mk("promoted text")
    update_text_meta(tid, TextMetaUpdate(text_group="Parent/Sub"))
    # Pull "Parent/Sub" out to root, placed before the anchor.
    reorder_text_group(TextGroupReorder(src_path="Parent/Sub", parent_path="", before_path="PromoteRoot"))
    assert _group_of(tid) == "Sub"                                # text's path rewritten to root
    assert _order_of("Sub", "PromoteRoot") == ["Sub", "PromoteRoot"]


def test_reorder_name_clash_rejected():
    create_text_group(TextGroupCreate(path="ClashTarget"))
    create_text_group(TextGroupCreate(path="Holder/ClashTarget"))
    try:
        reorder_text_group(TextGroupReorder(src_path="Holder/ClashTarget", parent_path="", before_path=""))
        assert False, "expected 400"
    except HTTPException as e:
        assert e.status_code == 400


def test_reorder_into_descendant_rejected():
    create_text_group(TextGroupCreate(path="Anc/Desc"))
    try:
        reorder_text_group(TextGroupReorder(src_path="Anc", parent_path="Anc/Desc", before_path=""))
        assert False, "expected 400"
    except HTTPException as e:
        assert e.status_code == 400


def test_init_db_idempotent():
    init_db()  # re-run: table already exists (and gains `position`), no error
    assert isinstance(list_text_groups(), list)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    for fn in fns:
        fn(); print("ok", fn.__name__)
    print(f"\n{len(fns)} passed")
