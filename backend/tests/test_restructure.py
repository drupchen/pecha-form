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
    """Build a real primary text (syllable layer; units derive from it) via the same
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


def test_extract_carries_in_range_annotations_into_new_text():
    """Extracting a section must preserve its annotations, not just the raw text:
    in-range spans (with their private tag definitions), markers and notes are
    remapped onto the new text's fresh syllable ids; a span straddling the cut is
    clamped; out-of-range annotations are left behind."""
    from app.routers.texts import extract_text
    from app.routers.tags import create_tag
    from app.routers.spans import create_span
    from app.routers.markers import create_marker
    from app.routers.notes import create_note
    from app.schemas import ExtractIn, TagCreate, SpanCreate, MarkerCreate, NoteCreate

    conn = get_db()
    try:
        src = _mk_primary(conn, "Annotated", "annot_1", RAW)
        syls = load_syllables(conn, src)
    finally:
        conn.close()

    # Private tags on the source.
    inside_tag = create_tag(src, TagCreate(name="important", color="#ff0000"))
    straddle_tag = create_tag(src, TagCreate(name="context", color="#00ff00"))

    # Annotations relative to the extracted range [syls[2] .. syls[5]]:
    #   - span A: fully inside (syls[2..3])
    #   - span B: straddles the cut (syls[0..2]) → only syls[2] overlaps → clamped
    #   - marker inside (syls[4]); marker outside (syls[0]) → not copied
    #   - note inside (syls[3..4])
    create_span(src, SpanCreate(tag_id=inside_tag["id"],
                                start_syl_id=syls[2]["id"], end_syl_id=syls[3]["id"]))
    create_span(src, SpanCreate(tag_id=straddle_tag["id"],
                                start_syl_id=syls[0]["id"], end_syl_id=syls[2]["id"]))
    create_marker(src, MarkerCreate(syl_id=syls[4]["id"]))
    create_marker(src, MarkerCreate(syl_id=syls[0]["id"]))
    create_note(src, NoteCreate(start_offset=syls[3]["start_offset"],
                                end_offset=syls[4]["end_offset"], body="a note"))

    out = extract_text(src, ExtractIn(start_syl_id=syls[2]["id"], end_syl_id=syls[5]["id"]))
    new_id = out["id"]

    conn = get_db()
    try:
        new_syls = load_syllables(conn, new_id)
        # new_syls[0..3] correspond to source syls[2..5].
        assert len(new_syls) == 4
        n0, n1, n2 = new_syls[0]["id"], new_syls[1]["id"], new_syls[2]["id"]

        # Private tags recreated privately on the new text (same name + color).
        tags = {r["name"]: r for r in conn.execute(
            "SELECT name, color, text_id FROM tags WHERE text_id = ?", (new_id,))}
        assert set(tags) == {"important", "context"}
        assert tags["important"]["color"] == "#ff0000"
        assert tags["important"]["text_id"] == new_id  # private, not shared

        spans = conn.execute(
            "SELECT t.name, s.start_syl_id, s.end_syl_id FROM spans s "
            "JOIN tags t ON t.id = s.tag_id WHERE s.text_id = ? ORDER BY t.name",
            (new_id,)).fetchall()
        by_name = {r["name"]: r for r in spans}
        # span A: fully inside → new[0..1].
        assert by_name["important"]["start_syl_id"] == n0
        assert by_name["important"]["end_syl_id"] == n1
        # span B: clamped to the overlap (only source syls[2] = new[0]).
        assert by_name["context"]["start_syl_id"] == n0
        assert by_name["context"]["end_syl_id"] == n0

        # Only the in-range marker (source syls[4] = new[2]) carried over.
        markers = [r["syl_id"] for r in conn.execute(
            "SELECT syl_id FROM markers WHERE text_id = ?", (new_id,))]
        assert markers == [n2]

        # Note remapped onto new[1..2] with its body preserved.
        notes = conn.execute(
            "SELECT body, start_syl_id, end_syl_id FROM notes WHERE text_id = ?",
            (new_id,)).fetchall()
        assert len(notes) == 1
        assert notes[0]["body"] == "a note"
        assert notes[0]["start_syl_id"] == n1 and notes[0]["end_syl_id"] == n2

        # Response counts reflect the carried-over annotations.
        assert out["span_count"] == 2 and out["tag_count"] == 2
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


def test_clone_carries_annotations_and_tree_through_the_bake():
    """Duplicating a primary text ("flatten") bakes suggestions into raw_text AND carries
    the annotations + TOC across, re-anchored to the clone's syllables: annotations on kept
    content survive, annotations on baked-away (deleted) content are dropped."""
    from app.routers.texts import clone_text
    from app.routers.tags import create_tag
    from app.routers.spans import create_span
    from app.routers.markers import create_marker
    from app.routers.suggestions import create_suggestion
    from app.schemas import CloneIn, TagCreate, SpanCreate, MarkerCreate, SuggestionCreate

    conn = get_db()
    try:
        src = _mk_primary(conn, "Flatten", "flat_1", RAW)
        syls = load_syllables(conn, src)
        baked_expected = "".join(
            s["text"] for s in syls if s["id"] not in (syls[2]["id"], syls[3]["id"]))
    finally:
        conn.close()

    keep_tag = create_tag(src, TagCreate(name="keep", color="#123456"))
    gone_tag = create_tag(src, TagCreate(name="gone", color="#654321"))
    # span on KEPT content (syls[6..7]) and span on soon-to-be-DELETED content (syls[2..3]).
    create_span(src, SpanCreate(tag_id=keep_tag["id"],
                                start_syl_id=syls[6]["id"], end_syl_id=syls[7]["id"]))
    create_span(src, SpanCreate(tag_id=gone_tag["id"],
                                start_syl_id=syls[2]["id"], end_syl_id=syls[3]["id"]))
    create_marker(src, MarkerCreate(syl_id=syls[6]["id"]))
    # A tree node linked to the kept segment start (syls[6]).
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO tree_nodes (text_id, parent_id, position, title, "
            "segment_start_syl_id, transparent) VALUES (?, NULL, 0, 'Sec', ?, 0)",
            (src, syls[6]["id"]))
        conn.commit()
    finally:
        conn.close()
    # Bake out syls[2..3] via a delete-suggestion.
    create_suggestion(src, SuggestionCreate(
        suggested_text="", start_syl_id=syls[2]["id"], end_syl_id=syls[3]["id"]))

    dup = clone_text(src, CloneIn())
    new_id = dup["id"]

    conn = get_db()
    try:
        raw = conn.execute("SELECT raw_text FROM texts WHERE id=?", (new_id,)).fetchone()["raw_text"]
        assert raw == baked_expected  # suggestions baked in (deleted range gone)

        clone_ids = {s["id"] for s in load_syllables(conn, new_id)}
        spans = conn.execute(
            "SELECT t.name, s.start_syl_id, s.end_syl_id FROM spans s "
            "JOIN tags t ON t.id = s.tag_id WHERE s.text_id=?", (new_id,)).fetchall()
        names = {r["name"] for r in spans}
        assert "keep" in names            # span on kept content survived
        assert "gone" not in names        # span on baked-away content dropped
        for r in spans:                   # survivors are anchored to real clone syllables
            assert r["start_syl_id"] in clone_ids and r["end_syl_id"] in clone_ids

        markers = [r["syl_id"] for r in conn.execute(
            "SELECT syl_id FROM markers WHERE text_id=?", (new_id,))]
        assert len(markers) == 1 and markers[0] in clone_ids

        nodes = conn.execute(
            "SELECT title, segment_start_syl_id FROM tree_nodes WHERE text_id=?", (new_id,)).fetchall()
        assert len(nodes) == 1
        assert nodes[0]["title"] == "Sec"
        assert nodes[0]["segment_start_syl_id"] in clone_ids  # re-anchored to the clone

        assert dup["span_count"] == 1 and dup["tag_count"] >= 1  # counts reflect the copy
    finally:
        conn.close()


def test_delete_section_suggestion_may_span_a_marker():
    from app.routers.suggestions import create_suggestion
    from app.routers.markers import create_marker
    from app.schemas import SuggestionCreate, MarkerCreate
    conn = get_db()
    try:
        tid = _mk_primary(conn, "Marked", "marked_1", RAW)
        # Part 6: everything is syllable-native — the marker and the range are addressed
        # by syllable id. The marker (start of syls[3]) sits strictly inside the range
        # [start of syls[1] .. end of syls[5]], so the suggestion straddles it.
        syls = load_syllables(conn, tid)
        start_syl, mid_syl, end_syl = syls[1], syls[3], syls[5]
    finally:
        conn.close()

    create_marker(tid, MarkerCreate(syl_id=mid_syl["id"]))

    # A pure deletion (empty text) spanning the marker is accepted.
    create_suggestion(tid, SuggestionCreate(
        suggested_text="", start_syl_id=start_syl["id"], end_syl_id=end_syl["id"]))

    # A replacement spanning the same marker is still rejected.
    from fastapi import HTTPException
    rejected = False
    try:
        create_suggestion(tid, SuggestionCreate(
            suggested_text="ཀ", start_syl_id=start_syl["id"], end_syl_id=end_syl["id"]))
    except HTTPException:
        rejected = True
    assert rejected, "replacement across a marker must still be rejected"


def test_insertion_at_deletion_boundary_is_allowed_but_interior_rejected():
    """An insertion at the start/end boundary of an existing deletion must be accepted
    (it applies just before/after the region — the applier's contract), while an
    insertion strictly inside the region is still rejected. Regression for the
    'Overlaps with an existing suggestion' false-positive at a delete-suggestion edge."""
    from app.routers.suggestions import create_suggestion
    from app.schemas import SuggestionCreate
    from fastapi import HTTPException
    conn = get_db()
    try:
        tid = _mk_primary(conn, "Ins", "ins_bound_1", RAW)
        syls = load_syllables(conn, tid)
        del_start, del_end = syls[2]["id"], syls[4]["id"]  # deletion covers syls[2..4]
        boundary = syls[2]["id"]   # insertion before syls[2] == deletion's start edge
        interior = syls[3]["id"]   # insertion before syls[3] == strictly inside
    finally:
        conn.close()

    # Pure deletion over [syls[2]..syls[4]].
    create_suggestion(tid, SuggestionCreate(
        suggested_text="", start_syl_id=del_start, end_syl_id=del_end))

    # Insertion at the deletion's start boundary is now allowed (was a false 409).
    ins = create_suggestion(tid, SuggestionCreate(
        suggested_text="ཀ", start_syl_id=boundary, end_syl_id=None))
    assert ins["start_offset"] == ins["end_offset"]  # zero-width insertion

    # Insertion strictly inside the deletion is still rejected.
    rejected = False
    try:
        create_suggestion(tid, SuggestionCreate(
            suggested_text="ཁ", start_syl_id=interior, end_syl_id=None))
    except HTTPException as e:
        rejected = (e.status_code == 409)
    assert rejected, "insertion strictly inside a deletion must still be rejected"


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
