"""Part 6: syllable-native source of truth (char-offset columns dropped).

Regression for the reported bug: tagging the full last segment failed because
`texts.units_json` (from tokenize_tibetan) and the `syllables` table (from
generate_syllables) disagreed on trailing whitespace, so a legitimate
syllable-aligned selection was rejected by the units_json boundary check.

Phase 1 flipped the write path to anchor by syllable id. Phase 2 made units a
projection of the syllables table (one partition). Phase 3 *drops* every stored
char-offset column: annotations store only their `*_syl_id` anchors and every offset
(the frontend render aid, the apply core) is DERIVED on read from the current
syllable sequence — there is no second partition and nothing to heal. These tests
exercise the WRITE contract directly (calling the router functions).
Run: `python tests/test_offset_drop.py`.
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
from app.manifest import load_syllables, units_from_syllables  # noqa: E402
from app.routers.texts import _create_primary_text, _units_for  # noqa: E402
from app.routers.tags import create_tag, update_tag  # noqa: E402
from app.routers.spans import create_span, list_spans  # noqa: E402
from app.routers.suggestions import create_suggestion  # noqa: E402
from app.routers.markers import create_marker  # noqa: E402
from app.routers.tree_nodes import create_tree_node  # noqa: E402
from app.schemas import (  # noqa: E402
    TagCreate, TagUpdate, SpanCreate, SuggestionCreate, MarkerCreate, TreeNodeCreate,
)
from fastapi import HTTPException  # noqa: E402

init_db()

# Trailing "།། \n" reproduces the real doc: generate_syllables splits the final
# "\n" into its own syllable (so the last *visible* syllable ends before it),
# while tokenize_tibetan groups the tail into one unit — the exact divergence.
RAW = "སངས་རྒྱས་ཆོས་དང་ཚོགས་ཀྱི་མཆོག་རྣམས་ལ།། \n"


def _mk_primary(conn, title, raw):
    tid = _create_primary_text(conn, "t.txt", title, raw)
    conn.commit()
    return tid


def _unit_ends(conn, text_id):
    # Units are DERIVED from the syllable partition (no stored units_json column).
    return {u[1] for u in _units_for(conn, text_id)}


def test_units_derive_from_syllables():
    """Phase 3: units are a projection of the syllables table (single partition), so
    every syllable end offset IS a unit boundary — the divergence that caused the
    last-segment bug is structurally gone — and the derived units equal the
    per-syllable projection exactly."""
    conn = get_db()
    try:
        tid = _mk_primary(conn, "Derive", RAW)
        syls = load_syllables(conn, tid)
        ends = _unit_ends(conn, tid)
        off = 0
        for s in syls:
            off += len(s["text"])
            assert off in ends, f"syllable end {off} must be a unit boundary"
        assert _units_for(conn, tid) == units_from_syllables(syls)
    finally:
        conn.close()


def test_last_visible_syllable_accepted_by_both_paths():
    """The full-last-segment selection lands on the last visible syllable's end. That
    offset is a unit boundary, so BOTH the syllable-native path and the legacy offset
    path accept it (one partition, no divergence left to reject)."""
    conn = get_db()
    try:
        tid = _mk_primary(conn, "SpanSyl", RAW)
        syls = load_syllables(conn, tid)
        ends = _unit_ends(conn, tid)
        last_visible = [s for s in syls if s["text"].strip()][-1]
        # end offset of last_visible = cumulative text length up to and incl. it
        id2end, pos = {}, 0
        for s in syls:
            pos += len(s["text"])
            id2end[s["id"]] = pos
        off = id2end[last_visible["id"]]
        assert off in ends, "last visible syllable end is a unit boundary"
        tag = create_tag(tid, TagCreate(name="X"))
        tag2 = create_tag(tid, TagCreate(name="Y"))
    finally:
        conn.close()

    # Syllable-native path: accepted (server derives offsets from the syllables table).
    span = create_span(tid, SpanCreate(
        tag_id=tag["id"],
        start_syl_id=last_visible["id"],
        end_syl_id=last_visible["id"],
    ))
    assert span["start_syl_id"] == last_visible["id"]
    assert span["end_offset"] == off

    # Legacy offset path with the same end offset now ALSO succeeds — one partition.
    span2 = create_span(tid, SpanCreate(
        tag_id=tag2["id"],
        start_offset=span["start_offset"],
        end_offset=off,
    ))
    assert span2["end_offset"] == off


def test_offsets_are_derived_not_stored():
    """Phase 3: offset columns are gone. A span stores only its syllable anchors, and
    its offsets are recomputed from the current syllable sequence on every read — so
    the derived offsets always match cumulative syllable lengths and the `spans` table
    has no start_offset/end_offset column at all."""
    conn = get_db()
    try:
        tid = _mk_primary(conn, "Derived", RAW)
        syls = load_syllables(conn, tid)
        first, last_visible = syls[0], [s for s in syls if s["text"].strip()][-1]
        tag = create_tag(tid, TagCreate(name="D"))
    finally:
        conn.close()

    span = create_span(tid, SpanCreate(
        tag_id=tag["id"], start_syl_id=first["id"], end_syl_id=last_visible["id"]))

    conn = get_db()
    try:
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(spans)")}
        assert "start_offset" not in cols and "end_offset" not in cols, \
            "offset columns must be dropped"
        # Derived offsets match cumulative syllable text lengths.
        id2end = {}
        pos = 0
        for s in syls:
            pos += len(s["text"])
            id2end[s["id"]] = pos
        rows = list_spans(tid)
        got = next(r for r in rows if r["id"] == span["id"])
        assert got["start_offset"] == 0
        assert got["end_offset"] == id2end[last_visible["id"]]
    finally:
        conn.close()


def test_all_annotation_types_round_trip_by_syl_id():
    """Every write path accepts syllable ids and stores the right anchor — even on
    the off-grid last visible syllable that broke the legacy offset check."""
    conn = get_db()
    try:
        tid = _mk_primary(conn, "RoundTrip", RAW)
        syls = load_syllables(conn, tid)
        first = syls[0]
        last_visible = [s for s in syls if s["text"].strip()][-1]
        # A syllable well away from the `first` replacement below (avoid overlap).
        mid = syls[4]
    finally:
        conn.close()

    # span (range on the off-grid last syllable)
    conn = get_db()
    try:
        tag = create_tag(tid, TagCreate(name="Sp"))
    finally:
        conn.close()
    span = create_span(tid, SpanCreate(
        tag_id=tag["id"], start_syl_id=last_visible["id"], end_syl_id=last_visible["id"]))
    assert span["start_syl_id"] == last_visible["id"]

    # suggestion — range replacement
    sug = create_suggestion(tid, SuggestionCreate(
        suggested_text="X", start_syl_id=first["id"], end_syl_id=first["id"]))
    assert sug["start_syl_id"] == first["id"] and sug["end_syl_id"] == first["id"]

    # suggestion — zero-width insertion before `mid` (end_syl_id None)
    ins = create_suggestion(tid, SuggestionCreate(
        suggested_text="Y", start_syl_id=mid["id"], end_syl_id=None))
    assert ins["start_syl_id"] == mid["id"]
    assert ins["start_offset"] == ins["end_offset"], "insertion is zero-width"

    # marker — split at the last visible syllable's start
    mk = create_marker(tid, MarkerCreate(syl_id=last_visible["id"]))
    assert mk["syl_id"] == last_visible["id"]

    # tree node — link segment_start to a syllable
    node = create_tree_node(tid, TreeNodeCreate(
        title="N", segment_start_syl_id=last_visible["id"]))
    assert node["segment_start_syl_id"] == last_visible["id"]

    # session tag — open/close by syllable ids
    stag = create_tag(tid, TagCreate(
        name="A1", tag_kind="session", open_syl_id=first["id"]))
    assert stag["open_syl_id"] == first["id"]
    closed = update_tag(stag["id"], TagUpdate(close_syl_id=last_visible["id"]))
    assert closed["close_syl_id"] == last_visible["id"]


def test_unknown_syl_id_is_rejected():
    conn = get_db()
    try:
        tid = _mk_primary(conn, "Bad", RAW)
        tag = create_tag(tid, TagCreate(name="B"))
    finally:
        conn.close()
    try:
        create_span(tid, SpanCreate(
            tag_id=tag["id"], start_syl_id="not-a-real-uuid", end_syl_id="not-a-real-uuid"))
        assert False, "unknown syl id must be rejected"
    except HTTPException as e:
        assert e.status_code == 400


if __name__ == "__main__":
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    passed = 0
    for fn in fns:
        try:
            fn()
            print("ok", fn.__name__)
            passed += 1
        except Exception:
            print("FAIL", fn.__name__)
            traceback.print_exc()
    print(f"\n{passed}/{len(fns)} passed")
    sys.exit(0 if passed == len(fns) else 1)
