"""Inserting BETWEEN the segments of a transcluded text.

An op is positioned between BASE tokens — "before this parent syllable, in this order among
the ops there" — so it could never land inside another op's emitted run. Transcluding after
the first of a transcluded text's two segments therefore slid past the whole of it, which is
what the user saw: the mantra always came out after the second segment.

Transclusion now CUTS the run it lands in. The cut is the delicate part, and the first test
here is the reason why: `(syllable, op_id)` is the occurrence identity every layer above
anchors on — the booklet stores page breaks, hairlines, splits and widths as
`startSylId#opId`, 291 such rows in the live data — so both halves must keep composing under
the ORIGINAL op's id. A cut that renumbered the tail would orphan every anchor inside it,
silently.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
from app import db as _dbmod  # noqa: E402
_dbmod.DB_PATH = _tmp.name

import pytest  # noqa: E402
from app.db import init_db, get_db  # noqa: E402
from app.manifest import persist_syllables  # noqa: E402
from app import derivation  # noqa: E402

init_db()

HOST = "ཀ་ཁ་ག་ང་།"          # the parent the secondary derives from
TWO_SEG = "ཅ་ཆ་ཇ་ཉ་།"        # the transcluded text we cut in two
MANTRA = "ཏ་ཐ་།"              # what gets inserted between its segments


def _primary(conn, title, instance, raw):
    cur = conn.execute(
        "INSERT INTO texts (filename, title, source_text, raw_text, text_type) "
        "VALUES ('t.txt', ?, '', ?, 'primary')", (title, raw))
    tid = cur.lastrowid
    persist_syllables(conn, tid, instance, raw)
    conn.commit()
    return tid


def _secondary(conn, parent_id):
    cur = conn.execute(
        "INSERT INTO texts (filename, title, source_text, raw_text, text_type, parent_text_id) "
        "VALUES ('t.txt','Secondary','','','secondary', ?)", (parent_id,))
    conn.commit()
    return cur.lastrowid


def _scene():
    """A secondary that transcludes a two-segment text, ready to be cut."""
    conn = get_db()
    host = _primary(conn, "Host", f"host{_scene.n}", HOST)
    two = _primary(conn, "TwoSeg", f"two{_scene.n}", TWO_SEG)
    mantra = _primary(conn, "Mantra", f"mantra{_scene.n}", MANTRA)
    _scene.n += 1
    sec = _secondary(conn, host)
    derivation.transclude(conn, sec, None, two)          # append the whole two-seg text
    conn.commit()
    return conn, sec, two, mantra


_scene.n = 0


def _stream(conn, text_id):
    return [(t["id"], t.get("op_id"), t["text"]) for t in derivation.base_tokens(conn, text_id)]


def _src_ids(conn, text_id):
    return [t["id"] for t in derivation.base_tokens(conn, text_id)]


def test_the_cut_keeps_every_token_s_OCCURRENCE(  # the whole point
):
    conn, sec, two, mantra = _scene()
    try:
        before = {tid: op for tid, op, _ in _stream(conn, sec)}
        mid = _src_ids(conn, two)[2]                     # a syllable INSIDE the run
        derivation.transclude(conn, sec, mid, mantra)
        conn.commit()
        after = {tid: op for tid, op, _ in _stream(conn, sec)}
        for tid, op in before.items():
            assert after[tid] == op, (
                f"{tid} composed under op {op} and now under {after[tid]} — every booklet row "
                "anchored as startSylId#opId inside the cut half would be orphaned")
    finally:
        conn.close()


def test_the_insertion_lands_between_the_segments():
    conn, sec, two, mantra = _scene()
    try:
        two_ids = _src_ids(conn, two)
        mantra_ids = set(_src_ids(conn, mantra))
        derivation.transclude(conn, sec, two_ids[2], mantra)
        conn.commit()
        order = [tid for tid, _, _ in _stream(conn, sec)]
        first_mantra = min(order.index(i) for i in mantra_ids if i in order)
        # The head of the cut run is before it, the tail after it — not all of it before.
        assert order.index(two_ids[1]) < first_mantra < order.index(two_ids[2])
    finally:
        conn.close()


def test_removing_the_insertion_leaves_the_run_as_it_was():
    conn, sec, two, mantra = _scene()
    try:
        原 = _stream(conn, sec)
        two_ids = _src_ids(conn, two)
        derivation.transclude(conn, sec, two_ids[2], mantra)
        conn.commit()
        new_op = conn.execute(
            "SELECT id FROM derivation_ops WHERE text_id = ? AND src_text_id = ?",
            (sec, mantra)).fetchone()["id"]
        derivation.delete_op(conn, new_op)
        conn.commit()
        # Two adjacent halves compose exactly what the single op did.
        assert _stream(conn, sec) == 原
    finally:
        conn.close()


def test_a_second_insertion_into_a_cut_half_still_lands_there():
    conn, sec, two, mantra = _scene()
    try:
        two_ids = _src_ids(conn, two)
        derivation.transclude(conn, sec, two_ids[2], mantra)
        conn.commit()
        # The caller sends the id the token COMPOSED under — the ancestor's, for both halves.
        occurrence = next(op for tid, op, _ in _stream(conn, sec) if tid == two_ids[1])
        derivation.transclude(conn, sec, two_ids[1], mantra, anchor_op_id=occurrence)
        conn.commit()
        order = [tid for tid, _, _ in _stream(conn, sec)]
        assert order.index(two_ids[0]) < order.index(two_ids[1])
        assert len([1 for tid, _, _ in _stream(conn, sec) if tid in set(_src_ids(conn, mantra))]) \
            == 2 * len(_src_ids(conn, mantra))
    finally:
        conn.close()


def test_a_line_break_mid_run_still_refuses():
    # Only transclusion learned to cut: a line break placed mid-run would silently move to
    # the run's end, so it still says so and points at the display break instead.
    conn, sec, two, _mantra = _scene()
    try:
        with pytest.raises(Exception):
            derivation.insert_break(conn, sec, _src_ids(conn, two)[2], 1)
    finally:
        conn.close()


if __name__ == "__main__":
    test_the_cut_keeps_every_token_s_OCCURRENCE()
    test_the_insertion_lands_between_the_segments()
    test_removing_the_insertion_leaves_the_run_as_it_was()
    test_a_second_insertion_into_a_cut_half_still_lands_there()
    test_a_line_break_mid_run_still_refuses()
    print("ok")
