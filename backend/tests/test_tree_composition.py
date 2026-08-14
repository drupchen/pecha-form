"""Sapche sections on a text that inherits its parent's tree.

A secondary renders its parent's sections and may add its own. `position` numbers
siblings within ONE owner — the secondary must never renumber rows the primary owns —
so display order across owners is composed from the nodes' anchors instead. These
tests pin that composition and the write paths that used to refuse it outright.
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

# Four sentences, so sections have somewhere to sit.
RAW = ("སངས་རྒྱས་ཆོས་དང་ཚོགས་ཀྱི་མཆོག་རྣམས་ལ། "
       "བྱང་ཆུབ་བར་དུ་བདག་ནི་སྐྱབས་སུ་མཆི། "
       "བདག་གིས་སྦྱིན་སོགས་བགྱིས་པའི་བསོད་ནམས་ཀྱིས། "
       "འགྲོ་ལ་ཕན་ཕྱིར་སངས་རྒྱས་འགྲུབ་པར་ཤོག")


def _mk_primary(conn, title, instance, raw=RAW):
    cur = conn.execute(
        "INSERT INTO texts (filename, title, source_text, raw_text, text_type) "
        "VALUES ('t.txt', ?, '', ?, 'primary')", (title, raw))
    tid = cur.lastrowid
    persist_syllables(conn, tid, instance, raw)
    conn.commit()
    return tid


def _roots(text_id):
    from app.routers.tree_nodes import list_tree_nodes
    return [n for n in list_tree_nodes(text_id) if n["parent_id"] is None]


def test_own_section_splices_among_inherited_by_its_anchor():
    from app.routers.texts import derive_secondary_text
    from app.routers.tree_nodes import create_tree_node
    from app.schemas import TreeNodeCreate

    conn = get_db()
    p = _mk_primary(conn, "TreeP", "tree_p")
    syls = load_syllables(conn, p)
    conn.close()

    # Primary: two sections, at the start and near the end.
    first = create_tree_node(p, TreeNodeCreate(
        parent_id=None, title="first", segment_start_syl_id=syls[0]["id"]))
    last = create_tree_node(p, TreeNodeCreate(
        parent_id=None, title="last", segment_start_syl_id=syls[-4]["id"]))

    child = derive_secondary_text(p, {})["id"]
    assert [n["id"] for n in _roots(child)] == [first["id"], last["id"]]
    assert all(n["inherited"] for n in _roots(child))

    # A section added on the SECONDARY, anchored between the two inherited ones.
    mid_syl = syls[len(syls) // 2]["id"]
    mine = create_tree_node(child, TreeNodeCreate(
        parent_id=None, title="mine", segment_start_syl_id=mid_syl))

    # It lands where its anchor sits, not at an end.
    assert [n["id"] for n in _roots(child)] == [first["id"], mine["id"], last["id"]]
    ordered = _roots(child)
    assert [n["sort_index"] for n in ordered] == [0, 1, 2]
    assert ordered[1]["owner_text_id"] == child and not ordered[1]["inherited"]

    # The primary is untouched — same rows, same positions, same order.
    conn = get_db()
    rows = conn.execute(
        "SELECT id, parent_id, position FROM tree_nodes WHERE text_id = ? "
        "ORDER BY position", (p,)).fetchall()
    conn.close()
    assert [tuple(r) for r in rows] == [(first["id"], None, 0), (last["id"], None, 1)]
    assert [n["id"] for n in _roots(p)] == [first["id"], last["id"]]


def test_own_subsection_nests_under_an_inherited_parent():
    """The read path composes cross-owner hierarchies; the write path used to 404."""
    from app.routers.texts import derive_secondary_text
    from app.routers.tree_nodes import create_tree_node, list_tree_nodes
    from app.schemas import TreeNodeCreate

    conn = get_db()
    p = _mk_primary(conn, "NestP", "nest_p")
    syls = load_syllables(conn, p)
    conn.close()

    parent = create_tree_node(p, TreeNodeCreate(
        parent_id=None, title="parent section", segment_start_syl_id=syls[0]["id"]))
    # A child the PRIMARY owns, so the level below is mixed too.
    own_child = create_tree_node(p, TreeNodeCreate(
        parent_id=parent["id"], title="primary's child",
        segment_start_syl_id=syls[1]["id"]))

    child_text = derive_secondary_text(p, {})["id"]
    sub = create_tree_node(child_text, TreeNodeCreate(
        parent_id=parent["id"], title="secondary's subsection",
        segment_start_syl_id=syls[len(syls) // 2]["id"]))
    assert sub["parent_id"] == parent["id"]

    kids = [n for n in list_tree_nodes(child_text) if n["parent_id"] == parent["id"]]
    assert {n["id"] for n in kids} == {own_child["id"], sub["id"]}
    # Anchored later than the primary's child, so it sorts after it.
    assert [n["id"] for n in sorted(kids, key=lambda n: n["sort_index"])] \
        == [own_child["id"], sub["id"]]

    # Adding it must not have renumbered the primary's child.
    conn = get_db()
    pos = conn.execute("SELECT position FROM tree_nodes WHERE id = ?",
                       (own_child["id"],)).fetchone()["position"]
    conn.close()
    assert pos == 0


def test_secondary_sections_are_numbered_independently_of_inherited_ones():
    """Own positions start at 0 even when inherited siblings already occupy 0..n."""
    from app.routers.texts import derive_secondary_text
    from app.routers.tree_nodes import create_tree_node, move_tree_node
    from app.schemas import TreeNodeCreate, TreeNodeMove

    conn = get_db()
    p = _mk_primary(conn, "NumP", "num_p")
    syls = load_syllables(conn, p)
    conn.close()

    for i in range(3):
        create_tree_node(p, TreeNodeCreate(
            parent_id=None, title=f"inherited {i}",
            segment_start_syl_id=syls[i]["id"]))
    child = derive_secondary_text(p, {})["id"]

    a = create_tree_node(child, TreeNodeCreate(parent_id=None, title="mine A"))
    b = create_tree_node(child, TreeNodeCreate(parent_id=None, title="mine B"))
    assert (a["position"], b["position"]) == (0, 1)

    # Reordering within the own run works (this is what the arrows drive).
    move_tree_node(b["id"], TreeNodeMove(new_parent_id=None, new_position=0))
    own = [n for n in _roots(child) if not n["inherited"]]
    assert [n["id"] for n in own] == [b["id"], a["id"]]


def test_single_owner_level_keeps_its_stored_order():
    """A text whose own sections sit out of anchor order is expressing an intent;
    composition must not silently 'correct' it (live data has such a case)."""
    from app.routers.tree_nodes import create_tree_node
    from app.schemas import TreeNodeCreate

    conn = get_db()
    p = _mk_primary(conn, "OrderP", "order_p")
    syls = load_syllables(conn, p)
    conn.close()

    late = create_tree_node(p, TreeNodeCreate(
        parent_id=None, title="anchored late", segment_start_syl_id=syls[-3]["id"]))
    early = create_tree_node(p, TreeNodeCreate(
        parent_id=None, title="anchored early", segment_start_syl_id=syls[1]["id"]))

    # Stored order (late first) is preserved, though anchors would say otherwise.
    assert [n["id"] for n in _roots(p)] == [late["id"], early["id"]]


def test_unanchored_own_section_lands_at_the_end():
    from app.routers.texts import derive_secondary_text
    from app.routers.tree_nodes import create_tree_node
    from app.schemas import TreeNodeCreate

    conn = get_db()
    p = _mk_primary(conn, "FreeP", "free_p")
    syls = load_syllables(conn, p)
    conn.close()

    create_tree_node(p, TreeNodeCreate(
        parent_id=None, title="anchored", segment_start_syl_id=syls[0]["id"]))
    child = derive_secondary_text(p, {})["id"]
    free = create_tree_node(child, TreeNodeCreate(parent_id=None, title="free-form"))

    assert _roots(child)[-1]["id"] == free["id"]


if __name__ == "__main__":
    test_own_section_splices_among_inherited_by_its_anchor()
    test_own_subsection_nests_under_an_inherited_parent()
    test_secondary_sections_are_numbered_independently_of_inherited_ones()
    test_single_owner_level_keeps_its_stored_order()
    test_unanchored_own_section_lands_at_the_end()
    print("ok")
