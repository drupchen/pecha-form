"""Part 3/4: passages (primary-text inline links) + secondary-text derivation.

Syllable-native round-trips: every anchor/ref is a syllable uuid and the new tables
carry no char offsets. Run: `venv/bin/python tests/test_derivation.py` (or pytest).
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# Point the DB at a fresh temp file BEFORE importing anything that binds DB_PATH.
_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
from app import db as _dbmod  # noqa: E402
_dbmod.DB_PATH = _tmp.name

from app.db import init_db, get_db  # noqa: E402
from app.manifest import load_syllables, persist_syllables  # noqa: E402
from app import derivation  # noqa: E402

init_db()

RAW = "སངས་རྒྱས་ཆོས་དང་ཚོགས་ཀྱི་མཆོག་རྣམས་ལ།"
RAW2 = "བྱང་ཆུབ་སེམས་དཔའ།"


def _mk_primary(conn, title, instance, raw):
    cur = conn.execute(
        "INSERT INTO texts (filename, title, source_text, raw_text, text_type) "
        "VALUES ('t.txt', ?, '', ?, 'primary')",
        (title, raw),
    )
    tid = cur.lastrowid
    persist_syllables(conn, tid, instance, raw)
    conn.commit()
    return tid


def _mk_secondary(conn, parent_id):
    cur = conn.execute(
        "INSERT INTO texts (filename, title, source_text, raw_text, "
        "text_type, parent_text_id) VALUES ('t.txt','Secondary','', '', "
        "'secondary', ?)",
        (parent_id,),
    )
    conn.commit()
    return cur.lastrowid


def test_new_tables_have_no_offset_columns():
    conn = get_db()
    try:
        for tbl in ("passages", "passage_members", "derivation_ops", "derivation_op_syllables"):
            cols = {r["name"] for r in conn.execute(f"PRAGMA table_info({tbl})")}
            assert not any("offset" in c.lower() for c in cols), f"{tbl} carries an offset column: {cols}"
    finally:
        conn.close()


def test_empty_secondary_composes_to_parent():
    conn = get_db()
    try:
        parent = _mk_primary(conn, "P0", "p0", RAW)
        sec = _mk_secondary(conn, parent)
        psyls = load_syllables(conn, parent)
        tokens = derivation.compose_secondary(conn, sec)
        assert derivation.composed_raw_text(tokens) == RAW
        assert all(t["source"] == "parent-link" for t in tokens)
        assert [t["id"] for t in tokens] == [s["id"] for s in psyls]  # links keep parent uuids
    finally:
        conn.close()


def test_edit_range_produces_override_and_added_with_provenance():
    conn = get_db()
    try:
        parent = _mk_primary(conn, "P1", "p1", RAW)
        sec = _mk_secondary(conn, parent)
        psyls = load_syllables(conn, parent)
        start, end = psyls[2]["id"], psyls[3]["id"]  # ཆོས་ དང་
        derivation.edit_range(conn, sec, start, end, "ཡོན་ཏན་གསུམ་")
        conn.commit()

        tokens = derivation.compose_secondary(conn, sec)
        sources = {t["source"] for t in tokens}
        assert "override" in sources and "added" in sources
        # Untouched parent syllables on both sides remain links.
        link_ids = {t["id"] for t in tokens if t["source"] == "parent-link"}
        assert psyls[0]["id"] in link_ids and psyls[4]["id"] in link_ids
        # Overrides carry provenance back to the parent syllable + its original text.
        for t in tokens:
            if t["source"] == "override":
                assert t["parent_syl_id"] in (start, end)
                assert t["original"] in (psyls[2]["text"], psyls[3]["text"])
        # Changed/added syllables are REAL hosted rows in the secondary text.
        assert len(load_syllables(conn, sec)) >= 3
    finally:
        conn.close()


def test_edit_range_is_not_accumulating_on_re_edit():
    conn = get_db()
    try:
        parent = _mk_primary(conn, "P2", "p2", RAW)
        sec = _mk_secondary(conn, parent)
        psyls = load_syllables(conn, parent)
        start, end = psyls[2]["id"], psyls[3]["id"]
        derivation.edit_range(conn, sec, start, end, "ཡོན་ཏན་གསུམ་")
        conn.commit()
        n1 = conn.execute("SELECT COUNT(*) c FROM derivation_ops WHERE text_id=?", (sec,)).fetchone()["c"]
        derivation.edit_range(conn, sec, start, end, "ཡོན་ཏན་གསུམ་")
        conn.commit()
        n2 = conn.execute("SELECT COUNT(*) c FROM derivation_ops WHERE text_id=?", (sec,)).fetchone()["c"]
        assert n1 == n2
    finally:
        conn.close()


def test_transclusion_links_source_syllables():
    conn = get_db()
    try:
        parent = _mk_primary(conn, "P3", "p3", RAW)
        other = _mk_primary(conn, "Other", "o3", RAW2)
        sec = _mk_secondary(conn, parent)
        psyls = load_syllables(conn, parent)
        osyls = load_syllables(conn, other)
        derivation.transclude(conn, sec, psyls[5]["id"], other, osyls[0]["id"], osyls[1]["id"])
        conn.commit()
        tokens = derivation.compose_secondary(conn, sec)
        trans = [t for t in tokens if t["source"] == "transclusion"]
        assert [t["id"] for t in trans] == [osyls[0]["id"], osyls[1]["id"]]  # links, not copies
        assert all(t["src_text_id"] == other for t in trans)
    finally:
        conn.close()


def test_passage_round_trip_resolves_two_same_text_ranges():
    from app.routers import passages as prt
    from app.schemas import PassageCreate, PassageMemberIn
    conn = get_db()
    try:
        parent = _mk_primary(conn, "P4", "p4", RAW)
        syls = load_syllables(conn, parent)
        # Two separated runs of the SAME text: [idx2..idx4] and [idx6..idx7].
        members = [
            PassageMemberIn(src_start_syl_id=syls[1]["id"], src_end_syl_id=syls[3]["id"]),
            PassageMemberIn(src_start_syl_id=syls[5]["id"], src_end_syl_id=syls[6]["id"]),
        ]
        prt._validate_members(conn, parent, members)
        cur = conn.execute(
            "INSERT INTO passages (text_id, anchor_syl_id, position, color) VALUES (?, ?, 0, NULL)",
            (parent, syls[0]["id"]),
        )
        pid = cur.lastrowid
        for i, m in enumerate(members):
            conn.execute(
                "INSERT INTO passage_members (passage_id, position, src_start_syl_id, src_end_syl_id) "
                "VALUES (?, ?, ?, ?)",
                (pid, i, m.src_start_syl_id, m.src_end_syl_id),
            )
        conn.commit()
        resolved = prt._resolve_members(conn, parent, pid)
        assert len(resolved) == 2
        got0 = [s["syl_id"] for s in resolved[0]["syllables"]]
        assert got0 == [syls[1]["id"], syls[2]["id"], syls[3]["id"]]  # inclusive run by idx
        got1 = [s["syl_id"] for s in resolved[1]["syllables"]]
        assert got1 == [syls[5]["id"], syls[6]["id"]]
    finally:
        conn.close()


RAW_RIPPLE = "སངས་རྒྱས་ཆོས་དང་ཚོགས་ཀྱི་མཆོག་རྣམས་ལ།"


def test_chain_composes_and_corrections_ripple_through_bake():
    """P→S1→S2: a suggestion on P baked via apply-corrections ripples through the
    whole chain (the edited syllable KEEPS its uuid), and the staged suggestions are
    consumed. The ripple architecture's core contract."""
    from app.routers.texts import derive_secondary_text, apply_corrections
    from app.routers.suggestions import create_suggestion
    from app.schemas import SuggestionCreate

    conn = get_db()
    p = _mk_primary(conn, "RippleP", "ripple_p", RAW_RIPPLE)
    syls = load_syllables(conn, p)
    conn.close()

    s1 = derive_secondary_text(p, {})["id"]
    s2 = derive_secondary_text(s1, {})["id"]

    conn = get_db()
    assert derivation.composed_raw_text(derivation.compose_secondary(conn, s2)) == RAW_RIPPLE
    conn.close()

    target = syls[2]
    create_suggestion(p, SuggestionCreate(
        suggested_text="ཆོསས་", start_syl_id=target["id"], end_syl_id=target["id"]))
    apply_corrections(p)

    conn = get_db()
    expected = RAW_RIPPLE.replace("ཆོས་", "ཆོསས་", 1)
    assert derivation.composed_raw_text(derivation.compose_secondary(conn, s1)) == expected
    assert derivation.composed_raw_text(derivation.compose_secondary(conn, s2)) == expected
    # Stable identity: the corrected syllable kept its uuid through the bake.
    edited = [s for s in load_syllables(conn, p) if s["text"] == "ཆོསས་"]
    assert edited and edited[0]["id"] == target["id"]
    assert conn.execute(
        "SELECT COUNT(*) FROM suggestions WHERE text_id = ?", (p,)).fetchone()[0] == 0
    conn.close()


def test_derive_copies_annotations_and_secondary_is_taggable():
    """Derive inherits the parent's spans (+tags), markers and tree with resolvable
    offsets (identity remap over the composed anchor space), and NEW annotations can
    be created directly on the secondary's parent-link syllables."""
    from app.routers.texts import derive_secondary_text
    from app.routers.tags import create_tag
    from app.routers.spans import create_span, list_spans
    from app.routers.markers import create_marker, list_markers
    from app.schemas import TagCreate, SpanCreate, MarkerCreate

    conn = get_db()
    p = _mk_primary(conn, "AnnP", "ann_p", RAW_RIPPLE)
    syls = load_syllables(conn, p)
    conn.execute(
        "INSERT INTO tree_nodes (text_id, parent_id, position, title, "
        "segment_start_syl_id, transparent) VALUES (?, NULL, 0, 'Sec', ?, 0)",
        (p, syls[6]["id"]))
    conn.commit()
    conn.close()

    tg = create_tag(p, TagCreate(name="ripple-verse", color="#f97316"))
    create_span(p, SpanCreate(tag_id=tg["id"],
                              start_syl_id=syls[2]["id"], end_syl_id=syls[4]["id"]))
    create_marker(p, MarkerCreate(syl_id=syls[6]["id"]))

    out = derive_secondary_text(p, {})
    s1 = out["id"]
    assert out["span_count"] == 1

    spans = list_spans(s1)
    assert len(spans) == 1 and spans[0]["start_offset"] > 0
    assert [m["position"] for m in list_markers(s1)]  # inherited marker resolves
    conn = get_db()
    assert conn.execute(
        "SELECT COUNT(*) FROM tree_nodes WHERE text_id = ?", (s1,)).fetchone()[0] == 1
    conn.close()

    # Fully taggable: a new span anchored on parent-link syllables of the secondary.
    tg2 = create_tag(s1, TagCreate(name="own", color="#123456"))
    sp = create_span(s1, SpanCreate(tag_id=tg2["id"],
                                    start_syl_id=syls[0]["id"], end_syl_id=syls[1]["id"]))
    assert sp["end_offset"] > sp["start_offset"] >= 0
    assert len(list_spans(s1)) == 2


def test_manual_break_and_edits_inherit_down_the_chain():
    """A hosted "\\n" break and an edit op on S1 both appear in S2's composition;
    deleting the break op removes it everywhere; re-editing over a hosted override
    resolves back to the base anchor (replaces the op, no accumulation)."""
    from app.routers.texts import derive_secondary_text
    from app.routers.derivation import (
        post_edit_range, post_insert_break, list_derivation_ops, delete_derivation_op,
    )
    from app.schemas import EditRangeIn, InsertBreakIn

    conn = get_db()
    p = _mk_primary(conn, "BreakP", "break_p", RAW_RIPPLE)
    syls = load_syllables(conn, p)
    conn.close()

    s1 = derive_secondary_text(p, {})["id"]
    s2 = derive_secondary_text(s1, {})["id"]

    r = post_edit_range(s1, EditRangeIn(
        start_syl_id=syls[2]["id"], end_syl_id=syls[2]["id"], new_text="ཆོསས་"))
    assert "ཆོསས་" in r["raw_text"]
    post_insert_break(s1, InsertBreakIn(before_syl_id=syls[4]["id"]))

    conn = get_db()
    s2_text = derivation.composed_raw_text(derivation.compose_secondary(conn, s2))
    assert "ཆོསས་" in s2_text and "\n" in s2_text  # both inherited
    toks = derivation.compose_secondary(conn, s1)
    conn.close()

    # Re-edit with an endpoint ON the hosted override token (base-anchor resolution).
    override_tok = next(t for t in toks if t.get("source") == "override")
    r2 = post_edit_range(s1, EditRangeIn(
        start_syl_id=override_tok["id"], end_syl_id=override_tok["id"], new_text="ཆོ་"))
    assert "ཆོ་" in r2["raw_text"] and "ཆོསས་" not in r2["raw_text"]

    ops = list_derivation_ops(s1)
    brk = next(o for o in ops if o["op_kind"] == "insert" and "⏎" in o["summary"])
    delete_derivation_op(brk["id"])
    conn = get_db()
    assert "\n" not in derivation.composed_raw_text(derivation.compose_secondary(conn, s1))
    conn.close()


def test_suggestions_are_refused_on_secondaries():
    """Secondary edits are derivation ops; the suggestions staging path is primary-only."""
    from fastapi import HTTPException
    from app.routers.texts import derive_secondary_text
    from app.routers.suggestions import create_suggestion
    from app.schemas import SuggestionCreate

    conn = get_db()
    p = _mk_primary(conn, "GuardP", "guard_p", RAW_RIPPLE)
    syls = load_syllables(conn, p)
    conn.close()
    s1 = derive_secondary_text(p, {})["id"]

    try:
        create_suggestion(s1, SuggestionCreate(
            suggested_text="x", start_syl_id=syls[0]["id"], end_syl_id=syls[0]["id"]))
        assert False, "expected 400"
    except HTTPException as e:
        assert e.status_code == 400


def test_upstream_suggestion_review_stage_ripple_and_reject():
    """A correction suggested on S1 for P-owned syllables routes to P as PENDING (no
    effect); accept(stage) joins P's staged corrections; accept(ripple) bakes just that
    suggestion into P's base (uuid-stable) and ripples to S1/S2 immediately while P's
    other staged corrections stay staged; reject deletes."""
    from app.routers.texts import _create_primary_text as _mk  # noqa: F401
    from app.routers.texts import derive_secondary_text
    from app.routers.suggestions import (
        suggest_upstream, accept_suggestion, create_suggestion, list_suggestions,
        delete_suggestion,
    )
    from app.schemas import SuggestUpstreamIn, SuggestionAcceptIn, SuggestionCreate
    from app.manifest import _text_corrected

    conn = get_db()
    p = _mk_primary(conn, "UpP", "up_p", RAW_RIPPLE)
    syls = load_syllables(conn, p)
    conn.close()
    s1 = derive_secondary_text(p, {})["id"]
    s2 = derive_secondary_text(s1, {})["id"]

    # Route: pending on P, origin recorded, corrected view unchanged.
    out = suggest_upstream(s1, SuggestUpstreamIn(
        start_syl_id=syls[2]["id"], end_syl_id=syls[2]["id"], suggested_text="ཆོསས་"))
    assert out["routed_to_text_id"] == p
    conn = get_db()
    assert _text_corrected(conn, p)[1] == RAW_RIPPLE
    conn.close()
    rows = list_suggestions(p)
    assert rows[0]["status"] == "pending" and rows[0]["origin_text_id"] == s1

    # A local staged correction on P must survive the single-suggestion bake below.
    create_suggestion(p, SuggestionCreate(
        suggested_text="ལ་", start_syl_id=syls[8]["id"], end_syl_id=syls[8]["id"]))

    # Accept & ripple: base baked, chain updated immediately, staged row untouched.
    r = accept_suggestion(out["suggestion_id"], SuggestionAcceptIn(mode="ripple"))
    assert r["status"] == "baked"
    conn = get_db()
    expected = RAW_RIPPLE.replace("ཆོས་", "ཆོསས་", 1)
    assert conn.execute("SELECT raw_text FROM texts WHERE id=?", (p,)).fetchone()["raw_text"] == expected
    assert derivation.composed_raw_text(derivation.compose_secondary(conn, s1)) == expected
    assert derivation.composed_raw_text(derivation.compose_secondary(conn, s2)) == expected
    assert conn.execute(
        "SELECT COUNT(*) FROM suggestions WHERE text_id=? AND status='applied'", (p,)
    ).fetchone()[0] == 1
    syls2 = load_syllables(conn, p)
    conn.close()

    # Accept (stage): joins staged corrections — corrected view shows it, base untouched.
    out2 = suggest_upstream(s1, SuggestUpstreamIn(
        start_syl_id=syls2[4]["id"], end_syl_id=syls2[4]["id"], suggested_text="ཚོགསས་"))
    r2 = accept_suggestion(out2["suggestion_id"], SuggestionAcceptIn(mode="stage"))
    assert r2["status"] == "staged"
    conn = get_db()
    assert "ཚོགསས་" in _text_corrected(conn, p)[1]
    assert "ཚོགསས་" not in conn.execute(
        "SELECT raw_text FROM texts WHERE id=?", (p,)).fetchone()["raw_text"]
    conn.close()

    # Reject = delete: a third pending disappears without any effect.
    out3 = suggest_upstream(s1, SuggestUpstreamIn(
        start_syl_id=syls2[6]["id"], end_syl_id=syls2[6]["id"], suggested_text="x་"))
    delete_suggestion(out3["suggestion_id"])
    assert all(s["id"] != out3["suggestion_id"] for s in list_suggestions(p))


def test_upstream_to_intermediate_secondary_accepts_as_op():
    """S2 suggests on an S1-HOSTED syllable → pending on S1 (the level where it first
    appears); accepting applies it as an S1 edit op (live ripple), row deleted. Guards:
    own-content and mixed-owner selections are refused."""
    from fastapi import HTTPException
    from app.routers.texts import derive_secondary_text
    from app.routers.suggestions import suggest_upstream, accept_suggestion, list_suggestions
    from app.routers.derivation import post_edit_range
    from app.schemas import SuggestUpstreamIn, SuggestionAcceptIn, EditRangeIn

    conn = get_db()
    p = _mk_primary(conn, "MidP", "mid_p", RAW_RIPPLE)
    syls = load_syllables(conn, p)
    conn.close()
    s1 = derive_secondary_text(p, {})["id"]
    s2 = derive_secondary_text(s1, {})["id"]

    post_edit_range(s1, EditRangeIn(
        start_syl_id=syls[6]["id"], end_syl_id=syls[6]["id"], new_text="མཆོགག་"))
    conn = get_db()
    # In S2's composition the S1-hosted override arrives as a plain base pass-through
    # (source "parent-link") — its id is still S1's hosted syllable uuid, which is what
    # the owner lookup routes on. Find it by its text.
    hosted = next(t for t in derivation.compose_secondary(conn, s2) if t["text"] == "མཆོགག་")
    conn.close()

    out = suggest_upstream(s2, SuggestUpstreamIn(
        start_syl_id=hosted["id"], end_syl_id=hosted["id"], suggested_text="མཆོགགག་"))
    assert out["routed_to_text_id"] == s1
    assert list_suggestions(s1)[0]["status"] == "pending"

    r = accept_suggestion(out["suggestion_id"], SuggestionAcceptIn(mode="stage"))
    assert r["status"] == "applied-as-op"
    conn = get_db()
    for tid in (s1, s2):
        assert "མཆོགགག་" in derivation.composed_raw_text(derivation.compose_secondary(conn, tid))
    assert conn.execute("SELECT COUNT(*) FROM suggestions WHERE text_id=?", (s1,)).fetchone()[0] == 0
    own_tok = next(t for t in derivation.compose_secondary(conn, s1) if t.get("source") == "override")
    conn.close()

    # Own-content guard: S1 suggesting on its own hosted syllable → edit locally.
    try:
        suggest_upstream(s1, SuggestUpstreamIn(
            start_syl_id=own_tok["id"], end_syl_id=own_tok["id"], suggested_text="x"))
        assert False, "expected 400"
    except HTTPException as e:
        assert e.status_code == 400
    # Mixed-owner guard: a run spanning P-owned and S1-hosted syllables.
    try:
        suggest_upstream(s1, SuggestUpstreamIn(
            start_syl_id=syls[5]["id"], end_syl_id=own_tok["id"], suggested_text="x"))
        assert False, "expected 400"
    except HTTPException as e:
        assert e.status_code == 400


def test_pending_survives_apply_all_bake():
    """Apply-all bakes and consumes only APPLIED suggestions; an incoming pending
    survives with valid anchors and can still be accepted afterwards."""
    from app.routers.texts import derive_secondary_text, apply_corrections
    from app.routers.suggestions import (
        suggest_upstream, accept_suggestion, create_suggestion, list_suggestions,
    )
    from app.schemas import SuggestUpstreamIn, SuggestionAcceptIn, SuggestionCreate

    conn = get_db()
    p = _mk_primary(conn, "BakeP", "bake_p", RAW_RIPPLE)
    syls = load_syllables(conn, p)
    conn.close()
    s1 = derive_secondary_text(p, {})["id"]

    out = suggest_upstream(s1, SuggestUpstreamIn(
        start_syl_id=syls[2]["id"], end_syl_id=syls[2]["id"], suggested_text="ཆོསས་"))
    create_suggestion(p, SuggestionCreate(
        suggested_text="ལ་", start_syl_id=syls[8]["id"], end_syl_id=syls[8]["id"]))
    apply_corrections(p)

    rows = list_suggestions(p)
    assert len(rows) == 1 and rows[0]["status"] == "pending"  # pending survived the bake
    r = accept_suggestion(out["suggestion_id"], SuggestionAcceptIn(mode="ripple"))
    assert r["status"] == "baked"
    conn = get_db()
    assert "ཆོསས་" in conn.execute(
        "SELECT raw_text FROM texts WHERE id=?", (p,)).fetchone()["raw_text"]
    conn.close()


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\n{len(fns)} passed")
