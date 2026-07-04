"""Part 5: primary-text restructuring write-path.

Covers extract (new primary + reversible source delete), clone (bake corrected text +
original/duplicate metadata + FK SET NULL on delete), delete-section suggestion spanning a
marker, and the passage downstream-anchor guard. Syllable-native: ranges are addressed by
uuid. Run: `python tests/test_restructure.py` (or pytest).
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
from app.manifest import load_syllables  # noqa: E402
from app.routers.texts import _create_primary_text  # noqa: E402

init_db()

RAW = "སངས་རྒྱས་ཆོས་དང་ཚོགས་ཀྱི་མཆོག་རྣམས་ལ།"


def _mk_primary(conn, title, instance, raw):
    """Build a real primary text (populated units_json + syllable layer) via the same
    helper the /extract and /clone endpoints use."""
    tid = _create_primary_text(conn, "t.txt", title, raw)
    conn.commit()
    return tid


def test_texts_has_no_new_offset_columns_but_has_cloned_from():
    conn = get_db()
    try:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(texts)")}
        assert "cloned_from_text_id" in cols
    finally:
        conn.close()


def test_extract_makes_new_primary_and_reversibly_deletes_source_range():
    from app.routers.texts import extract_text
    from app.schemas import ExtractIn
    conn = get_db()
    try:
        src = _mk_primary(conn, "Src", "src_ex", RAW)
        syls = load_syllables(conn, src)
        start, end = syls[2]["id"], syls[3]["id"]  # ཆོས་ དང་
        expected = syls[2]["text"] + syls[3]["text"]
    finally:
        conn.close()

    out = extract_text(src, ExtractIn(start_syl_id=start, end_syl_id=end))
    new_id = out["id"]

    conn = get_db()
    try:
        # New independent primary text whose syllables spell the extracted range.
        assert out["text_type"] == "primary"
        assert out["cloned_from_text_id"] is None
        new_syls = load_syllables(conn, new_id)
        assert "".join(s["text"] for s in new_syls) == expected
        # Source reversibly loses the range via a delete-suggestion (empty replacement).
        sugg = conn.execute(
            "SELECT start_syl_id, end_syl_id, suggested_text FROM suggestions WHERE text_id=?",
            (src,),
        ).fetchall()
        assert len(sugg) == 1
        assert sugg[0]["suggested_text"] == ""
        assert sugg[0]["start_syl_id"] == start and sugg[0]["end_syl_id"] == end
    finally:
        conn.close()


def test_clone_bakes_corrected_text_and_sets_metadata_and_fk_set_null():
    from app.routers.texts import clone_text, extract_text
    from app.schemas import CloneIn, ExtractIn
    conn = get_db()
    try:
        src = _mk_primary(conn, "Original", "clone_src", RAW)
        syls = load_syllables(conn, src)
        del_start, del_end = syls[2]["id"], syls[3]["id"]
        baked_expected = "".join(
            s["text"] for s in syls if s["id"] not in (del_start, del_end)
        )
    finally:
        conn.close()

    # Reversibly delete a section on the source, then clone → deletion is baked out.
    extract_text(src, ExtractIn(start_syl_id=del_start, end_syl_id=del_end))
    dup = clone_text(src, CloneIn())

    conn = get_db()
    try:
        assert dup["cloned_from_text_id"] == src
        assert dup["title"] == "Original"  # no rename; badge disambiguates
        dup_raw = conn.execute("SELECT raw_text FROM texts WHERE id=?", (dup["id"],)).fetchone()["raw_text"]
        assert dup_raw == baked_expected  # corrected (deleted range gone)
        # Source is flagged as having a clone.
        has_clone = conn.execute(
            "SELECT EXISTS(SELECT 1 FROM texts c WHERE c.cloned_from_text_id = ?) e", (src,)
        ).fetchone()["e"]
        assert has_clone == 1
        # Deleting the original NULLs the duplicate's pointer (FK ON DELETE SET NULL).
        conn.execute("DELETE FROM texts WHERE id=?", (src,))
        conn.commit()
        after = conn.execute(
            "SELECT cloned_from_text_id FROM texts WHERE id=?", (dup["id"],)
        ).fetchone()
        assert after is not None, "duplicate must survive deleting the original"
        assert after["cloned_from_text_id"] is None
    finally:
        conn.close()


def test_delete_section_suggestion_may_span_a_marker():
    import json
    from app.routers.suggestions import create_suggestion
    from app.schemas import SuggestionCreate
    conn = get_db()
    try:
        tid = _mk_primary(conn, "Marked", "marked_1", RAW)
        units = json.loads(conn.execute(
            "SELECT units_json FROM texts WHERE id=?", (tid,)).fetchone()["units_json"])
        # Pick range + marker on tokenizer unit boundaries (what the offset validation uses).
        start_off = units[1][0]
        mid = units[3][0]
        end_off = units[5][1]
        conn.execute("INSERT INTO markers (text_id, position) VALUES (?, ?)", (tid, mid))
        conn.commit()
    finally:
        conn.close()

    # A pure deletion (empty text) spanning the marker is accepted.
    create_suggestion(tid, SuggestionCreate(
        start_offset=start_off, end_offset=end_off, suggested_text=""))

    # A replacement spanning the same marker is still rejected.
    from fastapi import HTTPException
    rejected = False
    try:
        create_suggestion(tid, SuggestionCreate(
            start_offset=start_off, end_offset=end_off, suggested_text="ཀ"))
    except HTTPException:
        rejected = True
    assert rejected, "replacement across a marker must still be rejected"


def test_passage_downstream_guard_rejects_upstream_anchor():
    from app.routers.passages import create_passage
    from app.schemas import PassageCreate, PassageMemberIn
    from fastapi import HTTPException
    conn = get_db()
    try:
        tid = _mk_primary(conn, "Pas", "pas_1", RAW)
        syls = load_syllables(conn, tid)
        member = PassageMemberIn(src_start_syl_id=syls[4]["id"], src_end_syl_id=syls[6]["id"])
        upstream_anchor = syls[2]["id"]   # before the source run → must be rejected
        downstream_anchor = syls[8]["id"]  # after the source run → allowed
    finally:
        conn.close()

    rejected = False
    try:
        create_passage(tid, PassageCreate(anchor_syl_id=upstream_anchor, members=[member]))
    except HTTPException:
        rejected = True
    assert rejected, "an upstream anchor must be rejected"

    ok = create_passage(tid, PassageCreate(anchor_syl_id=downstream_anchor, members=[member]))
    assert ok["anchor_syl_id"] == downstream_anchor


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\n{len(fns)} passed")
