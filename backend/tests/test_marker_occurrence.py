"""A segment boundary can belong to ONE occurrence of a transcluded run.

The same source is often transcluded into one host several times, and it may legitimately be
a segment of its own in one place and sit inside a segment in another. A boundary used to be
"this syllable, in this text" — one row, one position, every occurrence — so that was not
expressible: making a run stand alone re-segmented all its siblings.

`markers.op_id` names the occurrence: 0 (every row that predates it, and every inherited
boundary) means "wherever this syllable appears"; a transclusion op's id means that run only.
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
from app.manifest import persist_syllables  # noqa: E402
from app import derivation  # noqa: E402
from app.routers.markers import list_markers, create_marker  # noqa: E402
from app.schemas import MarkerCreate  # noqa: E402

init_db()

HOST = "ཀ་ཁ་ག་ང་།"
MANTRA = "ཏ་ཐ་ད་།"


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
    conn = get_db()
    host = _primary(conn, "Host", f"h{_scene.n}", HOST)
    mantra = _primary(conn, "Mantra", f"m{_scene.n}", MANTRA)
    _scene.n += 1
    sec = _secondary(conn, host)
    return conn, sec, mantra


_scene.n = 0


def _boundaries(text_id):
    return [(m["syl_id"], m["op_id"], m["position"]) for m in list_markers(text_id)]


def test_one_source_twice_a_segment_here_and_inline_there():
    """The requirement, in one test."""
    conn, sec, mantra = _scene()
    try:
        base = [t["id"] for t in derivation.base_tokens(conn, sec)]
        standalone = derivation.transclude(conn, sec, base[1], mantra)   # before ཁ
        inline = derivation.transclude(conn, sec, base[3], mantra)       # before ང
        conn.commit()
        head = standalone["first_syl_id"]
        # Only the FIRST occurrence is given a boundary, scoped to its op.
        create_marker(sec, MarkerCreate(syl_id=head, op_id=standalone["op_id"]))

        marks = _boundaries(sec)
        scoped = [m for m in marks if m[0] == head]
        assert len(scoped) == 1, f"one boundary, at one occurrence — got {scoped}"
        assert scoped[0][1] == standalone["op_id"]

        # …and it sits at THAT run, not at the other one.
        occ = derivation.base_tokens(conn, sec)
        firsts = [i for i, t in enumerate(occ) if t["id"] == head]
        assert len(firsts) == 2, "the source really is here twice"
        # Position of the boundary matches the first occurrence's offset, not the second's.
        offs, pos = [], 0
        for t in occ:
            offs.append(pos)
            pos += len(t["text"])
        assert scoped[0][2] == offs[firsts[0]]
        assert scoped[0][2] != offs[firsts[1]], "the inline copy must not gain a boundary"
        _ = inline
    finally:
        conn.close()


def test_an_unscoped_boundary_still_applies_everywhere():
    # Everything placed before the column carries op_id 0 and must keep its meaning.
    conn, sec, mantra = _scene()
    try:
        base = [t["id"] for t in derivation.base_tokens(conn, sec)]
        create_marker(sec, MarkerCreate(syl_id=base[2]))
        marks = _boundaries(sec)
        assert [m for m in marks if m[0] == base[2]][0][1] == 0
    finally:
        conn.close()


def test_both_scopes_can_coexist_at_one_syllable():
    # The widened UNIQUE(text_id, syl_id, op_id) is what allows this pair.
    conn, sec, mantra = _scene()
    try:
        base = [t["id"] for t in derivation.base_tokens(conn, sec)]
        made = derivation.transclude(conn, sec, base[1], mantra)
        conn.commit()
        head = made["first_syl_id"]
        create_marker(sec, MarkerCreate(syl_id=head))                       # any occurrence
        create_marker(sec, MarkerCreate(syl_id=head, op_id=made["op_id"]))  # this one
        rows = conn.execute("SELECT op_id FROM markers WHERE text_id = ? AND syl_id = ?",
                            (sec, head)).fetchall()
        assert sorted(r["op_id"] for r in rows) == [0, made["op_id"]]
    finally:
        conn.close()


def test_a_boundary_survives_its_run_being_cut():
    # Inserting between two segments of a run cuts it; both halves keep the ORIGINAL op as
    # their occurrence, so a boundary scoped to it still resolves.
    conn, sec, mantra = _scene()
    try:
        base = [t["id"] for t in derivation.base_tokens(conn, sec)]
        made = derivation.transclude(conn, sec, base[1], mantra)
        conn.commit()
        create_marker(sec, MarkerCreate(syl_id=made["first_syl_id"], op_id=made["op_id"]))
        before = _boundaries(sec)

        # Cut the run by inserting something in the middle of it.
        run = [t["id"] for t in derivation.base_tokens(conn, sec)
               if t.get("op_id") == made["op_id"]]
        other = _primary(conn, "Other", f"o{_scene.n}", "ཙ་།")
        _scene.n += 1
        derivation.transclude(conn, sec, run[2], other, anchor_op_id=made["op_id"])
        conn.commit()

        after = _boundaries(sec)
        kept = [m for m in after if m[0] == made["first_syl_id"]]
        assert kept and kept[0][1] == made["op_id"], "the boundary lost its occurrence"
        assert kept[0][2] == [m for m in before if m[0] == made["first_syl_id"]][0][2]
    finally:
        conn.close()


def test_as_segment_places_the_boundary_itself():
    from app.routers.derivation import post_transclude
    from app.schemas import TranscludeIn
    conn, sec, mantra = _scene()
    base = [t["id"] for t in derivation.base_tokens(conn, sec)]
    conn.close()
    post_transclude(sec, TranscludeIn(anchor_syl_id=base[1], src_text_id=mantra,
                                      as_segment=True))
    conn = get_db()
    try:
        head = conn.execute(
            "SELECT syl_id, op_id FROM markers WHERE text_id = ? AND op_id != 0",
            (sec,)).fetchone()
        assert head is not None, "as_segment must give the run a boundary of its own"
        run_first = [t["id"] for t in derivation.base_tokens(conn, sec)
                     if t.get("op_id") == head["op_id"]][0]
        assert head["syl_id"] == run_first
    finally:
        conn.close()


if __name__ == "__main__":
    test_one_source_twice_a_segment_here_and_inline_there()
    test_an_unscoped_boundary_still_applies_everywhere()
    test_both_scopes_can_coexist_at_one_syllable()
    test_a_boundary_survives_its_run_being_cut()
    test_as_segment_places_the_boundary_itself()
    print("ok")
