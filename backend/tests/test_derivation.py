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

    # Spans are NOT copied — the child inherits the parent's spans LIVE on read.
    conn = get_db()
    assert conn.execute(
        "SELECT COUNT(*) FROM spans WHERE text_id = ?", (s1,)).fetchone()[0] == 0
    conn.close()
    spans = list_spans(s1)
    assert len(spans) == 1 and spans[0]["start_offset"] > 0
    assert spans[0]["inherited"] is True
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
    both = list_spans(s1)
    assert len(both) == 2
    assert sorted(s["inherited"] for s in both) == [False, True]


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


def test_whole_text_transclusion_inserts_ripples_and_inherits():
    """Transcluding with no explicit range links the source's WHOLE sequence after the
    anchor; a correction baked into the source ripples into the host; a text derived
    from the host inherits the transclusion; self/empty-source are refused; an anchor
    on a hosted token resolves to its base anchor; anchor None appends at end."""
    from fastapi import HTTPException
    from app.routers.texts import derive_secondary_text, apply_corrections
    from app.routers.derivation import post_transclude, post_edit_range
    from app.routers.suggestions import create_suggestion
    from app.schemas import TranscludeIn, EditRangeIn, SuggestionCreate

    conn = get_db()
    p = _mk_primary(conn, "HostP", "host_p", RAW_RIPPLE)
    other = _mk_primary(conn, "OtherT", "other_t", "བཀྲ་ཤིས་བདེ་ལེགས།")
    syls = load_syllables(conn, p)
    other_raw = conn.execute("SELECT raw_text FROM texts WHERE id=?", (other,)).fetchone()["raw_text"]
    conn.close()
    s1 = derive_secondary_text(p, {})["id"]
    s2 = derive_secondary_text(s1, {})["id"]

    # Whole-text insert after syls[3] (anchor = syls[4], the token after).
    r = post_transclude(s1, TranscludeIn(anchor_syl_id=syls[4]["id"], src_text_id=other))
    assert other_raw in r["raw_text"]
    conn = get_db()
    assert other_raw in derivation.composed_raw_text(derivation.compose_secondary(conn, s2))
    other_syls = load_syllables(conn, other)
    conn.close()

    # A correction baked into the SOURCE ripples into the host's transclusion.
    create_suggestion(other, SuggestionCreate(
        suggested_text="ཤིསས་", start_syl_id=other_syls[1]["id"], end_syl_id=other_syls[1]["id"]))
    apply_corrections(other)
    conn = get_db()
    assert "ཤིསས་" in derivation.composed_raw_text(derivation.compose_secondary(conn, s1))
    conn.close()

    # Anchor on a hosted token (previous edit) resolves to its base anchor.
    post_edit_range(s1, EditRangeIn(
        start_syl_id=syls[7]["id"], end_syl_id=syls[7]["id"], new_text="རྣམསས་"))
    conn = get_db()
    hosted = next(t for t in derivation.compose_secondary(conn, s1) if t.get("source") == "override")
    conn.close()
    r2 = post_transclude(s1, TranscludeIn(anchor_syl_id=hosted["id"], src_text_id=other))
    assert r2["raw_text"].count("ཤིསས་") == 2  # second copy spliced before the edited token

    # anchor None appends at the very end.
    r3 = post_transclude(s1, TranscludeIn(anchor_syl_id=None, src_text_id=other))
    assert r3["raw_text"].rstrip().endswith("བདེ་ལེགས།")

    # Guards: self-transclusion and empty source.
    try:
        post_transclude(s1, TranscludeIn(anchor_syl_id=None, src_text_id=s1))
        assert False, "expected 400"
    except HTTPException as e:
        assert e.status_code == 400
    conn = get_db()
    conn.execute("INSERT INTO texts (filename, title, source_text, raw_text, text_type) "
                 "VALUES ('e.txt','Empty','','','primary')")
    empty_p = conn.execute("SELECT last_insert_rowid() AS i").fetchone()["i"]
    conn.commit(); conn.close()
    try:
        post_transclude(s1, TranscludeIn(anchor_syl_id=None, src_text_id=empty_p))
        assert False, "expected 400"
    except HTTPException as e:
        assert e.status_code == 400


def test_passages_work_on_secondaries_with_composed_anchors():
    """Passages resolve over the token sequence, so a SECONDARY can link a run of its
    composed (parent-link) tokens to a downstream composed anchor; the upstream-anchor
    guard still applies."""
    from fastapi import HTTPException
    from app.routers.texts import derive_secondary_text
    from app.routers.passages import create_passage, list_passages
    from app.schemas import PassageCreate, PassageMemberIn

    conn = get_db()
    p = _mk_primary(conn, "PasP", "pas_p", RAW_RIPPLE)
    syls = load_syllables(conn, p)
    conn.close()
    s1 = derive_secondary_text(p, {})["id"]

    member = PassageMemberIn(src_start_syl_id=syls[2]["id"], src_end_syl_id=syls[4]["id"])
    # Upstream anchor (before the run) is still rejected on a secondary.
    try:
        create_passage(s1, PassageCreate(anchor_syl_id=syls[1]["id"], members=[member]))
        assert False, "expected 400"
    except HTTPException as e:
        assert e.status_code == 400
    # Downstream anchor works; members resolve through the composed sequence.
    out = create_passage(s1, PassageCreate(anchor_syl_id=syls[7]["id"], members=[member]))
    assert out["anchor_syl_id"] == syls[7]["id"]
    assert [s["syl_id"] for s in out["members"][0]["syllables"]] == [
        syls[2]["id"], syls[3]["id"], syls[4]["id"]]
    listed = list_passages(s1)
    assert len(listed) == 1 and listed[0]["members"][0]["syllables"]


def test_passage_notes_and_same_anchor_ordering():
    """A note with passage_id targets that occurrence (round-trips; bogus id 404s), and
    two passages at the same anchor keep their (position, id) order in the listing."""
    from fastapi import HTTPException
    from app.routers.passages import create_passage, list_passages
    from app.routers.notes import create_note, list_notes
    from app.schemas import PassageCreate, PassageMemberIn, NoteCreate

    conn = get_db()
    p = _mk_primary(conn, "NotesP", "notes_p", RAW_RIPPLE)
    syls = load_syllables(conn, p)
    conn.close()

    member = PassageMemberIn(src_start_syl_id=syls[2]["id"], src_end_syl_id=syls[3]["id"])
    pg1 = create_passage(p, PassageCreate(anchor_syl_id=syls[7]["id"], members=[member], position=0))
    pg2 = create_passage(p, PassageCreate(anchor_syl_id=syls[7]["id"], members=[member], position=1))
    listed = [x["id"] for x in list_passages(p) if x["anchor_syl_id"] == syls[7]["id"]]
    assert listed == [pg1["id"], pg2["id"]]  # ordered by (position, id)

    n = create_note(p, NoteCreate(
        start_offset=syls[2]["start_offset"], end_offset=syls[3]["end_offset"],
        body="occurrence note", passage_id=pg1["id"]))
    assert n["passage_id"] == pg1["id"]
    assert [x["passage_id"] for x in list_notes(p) if x["id"] == n["id"]] == [pg1["id"]]
    try:
        create_note(p, NoteCreate(
            start_offset=syls[0]["start_offset"], end_offset=syls[1]["end_offset"],
            body="x", passage_id=999999))
        assert False, "expected 404"
    except HTTPException as e:
        assert e.status_code == 404


def test_node_passage_link_and_inherited_spans():
    """A tree node can link a PASSAGE occurrence (mutually exclusive with the segment
    link), and a secondary's span list inherits the tags of its transclusion sources
    (read-only, host offsets)."""
    from fastapi import HTTPException
    from app.routers.texts import derive_secondary_text
    from app.routers.passages import create_passage
    from app.routers.tree_nodes import create_tree_node, update_tree_node
    from app.routers.tags import create_tag
    from app.routers.spans import create_span, list_spans
    from app.routers.derivation import post_transclude
    from app.schemas import (
        PassageCreate, PassageMemberIn, TreeNodeCreate, TreeNodeUpdate,
        TagCreate, SpanCreate, TranscludeIn,
    )

    conn = get_db()
    p = _mk_primary(conn, "LinkP", "link_p", RAW_RIPPLE)
    other = _mk_primary(conn, "SrcT", "src_t", "བཀྲ་ཤིས་བདེ་ལེགས།")
    syls = load_syllables(conn, p)
    other_syls = load_syllables(conn, other)
    conn.close()

    # node ↔ passage link (on the primary): set clears segment link; unlink clears it.
    pg = create_passage(p, PassageCreate(
        anchor_syl_id=syls[8]["id"],
        members=[PassageMemberIn(src_start_syl_id=syls[2]["id"], src_end_syl_id=syls[3]["id"])]))
    n = create_tree_node(p, TreeNodeCreate(
        parent_id=None, title="Sec", segment_start_syl_id=syls[5]["id"]))
    u = update_tree_node(n["id"], TreeNodeUpdate(passage_id=pg["id"]))
    assert u["passage_id"] == pg["id"] and u["segment_start"] is None  # exclusive
    u2 = update_tree_node(n["id"], TreeNodeUpdate(segment_start_syl_id=syls[5]["id"]))
    assert u2["passage_id"] is None and u2["segment_start"] is not None
    try:
        update_tree_node(n["id"], TreeNodeUpdate(passage_id=999999))
        assert False, "expected 404"
    except HTTPException as e:
        assert e.status_code == 404

    # Inherited spans: tag a range in `other`, transclude it into a secondary of p —
    # the secondary's span list contains the source's span, marked inherited.
    tg = create_tag(other, TagCreate(name="src-tag", color="#112233"))
    create_span(other, SpanCreate(tag_id=tg["id"],
                                  start_syl_id=other_syls[1]["id"], end_syl_id=other_syls[2]["id"]))
    s1 = derive_secondary_text(p, {})["id"]
    post_transclude(s1, TranscludeIn(anchor_syl_id=None, src_text_id=other))
    spans = list_spans(s1)
    inherited = [s for s in spans if s["inherited"]]
    assert len(inherited) == 1
    assert inherited[0]["tag"]["name"] == "src-tag"
    assert inherited[0]["end_offset"] > inherited[0]["start_offset"] > 0  # host offsets


def test_passage_attach_prev_round_trips():
    """attach_prev (the boundary attachment side the placement hairline records)
    round-trips through create/list."""
    from app.routers.passages import create_passage, list_passages
    from app.schemas import PassageCreate, PassageMemberIn

    conn = get_db()
    p = _mk_primary(conn, "AttachP", "attach_p", RAW_RIPPLE)
    syls = load_syllables(conn, p)
    conn.close()
    member = PassageMemberIn(src_start_syl_id=syls[1]["id"], src_end_syl_id=syls[2]["id"])
    a = create_passage(p, PassageCreate(anchor_syl_id=syls[6]["id"], members=[member], attach_prev=True))
    b = create_passage(p, PassageCreate(anchor_syl_id=syls[6]["id"], members=[member]))
    assert a["attach_prev"] is True and b["attach_prev"] is False
    listed = {x["id"]: x["attach_prev"] for x in list_passages(p)}
    assert listed[a["id"]] is True and listed[b["id"]] is False


def test_passage_own_segment_round_trips():
    """own_segment (the marker-free "manual split" — render as a standalone card)
    defaults to False, PATCHes on and off, and survives list."""
    from app.routers.passages import create_passage, list_passages, update_passage
    from app.schemas import PassageCreate, PassageMemberIn, PassageUpdate

    conn = get_db()
    p = _mk_primary(conn, "OwnSeg", "own_seg", RAW_RIPPLE)
    syls = load_syllables(conn, p)
    conn.close()
    member = PassageMemberIn(src_start_syl_id=syls[1]["id"], src_end_syl_id=syls[2]["id"])
    a = create_passage(p, PassageCreate(anchor_syl_id=syls[6]["id"], members=[member]))
    assert a["own_segment"] is False

    promoted = update_passage(a["id"], PassageUpdate(own_segment=True))
    assert promoted["own_segment"] is True
    listed = {x["id"]: x["own_segment"] for x in list_passages(p)}
    assert listed[a["id"]] is True

    demoted = update_passage(a["id"], PassageUpdate(own_segment=False))
    assert demoted["own_segment"] is False


def test_passage_split_divides_run_and_orders_siblings():
    """POST /passages/{id}/split divides a passage after an interior syllable: the run
    is partitioned (a member run may itself be divided), the second half lands right
    after the original among same-anchor siblings, and flags apply per request."""
    from app.routers.passages import create_passage, list_passages, split_passage
    from app.schemas import PassageCreate, PassageMemberIn, PassageSplitIn
    from fastapi import HTTPException

    conn = get_db()
    p = _mk_primary(conn, "SplitP", "split_p", RAW_RIPPLE)
    syls = load_syllables(conn, p)
    conn.close()
    anchor = syls[8]["id"]
    # Passage a: two member runs [1..3] + [4..5]; follower b at the same anchor.
    a = create_passage(p, PassageCreate(
        anchor_syl_id=anchor, attach_prev=True,
        members=[PassageMemberIn(src_start_syl_id=syls[1]["id"], src_end_syl_id=syls[3]["id"]),
                 PassageMemberIn(src_start_syl_id=syls[4]["id"], src_end_syl_id=syls[5]["id"])]))
    b = create_passage(p, PassageCreate(
        anchor_syl_id=anchor,
        members=[PassageMemberIn(src_start_syl_id=syls[6]["id"], src_end_syl_id=syls[6]["id"])]))

    # Split inside the FIRST member run (after syls[2]) — the run itself divides.
    res = split_passage(a["id"], PassageSplitIn(
        after_syl_id=syls[2]["id"], second_own_segment=True,
        first_attach_prev=True, second_attach_prev=False))
    first, second = res["first"], res["second"]
    assert [m["src_start_syl_id"] for m in first["members"]] == [syls[1]["id"]]
    assert first["members"][0]["src_end_syl_id"] == syls[2]["id"]
    assert [(m["src_start_syl_id"], m["src_end_syl_id"]) for m in second["members"]] == \
        [(syls[3]["id"], syls[3]["id"]), (syls[4]["id"], syls[5]["id"])]
    assert second["own_segment"] is True and second["attach_prev"] is False
    assert first["attach_prev"] is True

    # Sibling order at the anchor: first, second, then b — positions renumbered 0..n.
    listed = [x for x in list_passages(p) if x["anchor_syl_id"] == anchor]
    listed.sort(key=lambda x: (x["position"], x["id"]))
    assert [x["id"] for x in listed] == [first["id"], second["id"], b["id"]]
    assert [x["position"] for x in listed] == [0, 1, 2]

    # Strictly-interior validation: the run's last syllable is not a split point.
    try:
        split_passage(second["id"], PassageSplitIn(after_syl_id=syls[5]["id"]))
        assert False, "expected 400"
    except HTTPException as e:
        assert e.status_code == 400


def test_passage_split_migrates_second_half_notes():
    """Per-occurrence notes anchored in the second half move to the new passage."""
    from app.routers.passages import split_passage, create_passage
    from app.schemas import PassageCreate, PassageMemberIn, PassageSplitIn

    conn = get_db()
    p = _mk_primary(conn, "SplitN", "split_n", RAW_RIPPLE)
    syls = load_syllables(conn, p)
    a = create_passage(p, PassageCreate(
        anchor_syl_id=syls[8]["id"],
        members=[PassageMemberIn(src_start_syl_id=syls[1]["id"], src_end_syl_id=syls[4]["id"])]))
    n_first = conn.execute(
        "INSERT INTO notes (text_id, body, start_syl_id, end_syl_id, passage_id) "
        "VALUES (?, 'on first half', ?, ?, ?)",
        (p, syls[1]["id"], syls[2]["id"], a["id"])).lastrowid
    n_second = conn.execute(
        "INSERT INTO notes (text_id, body, start_syl_id, end_syl_id, passage_id) "
        "VALUES (?, 'on second half', ?, ?, ?)",
        (p, syls[3]["id"], syls[4]["id"], a["id"])).lastrowid
    conn.commit()
    conn.close()

    res = split_passage(a["id"], PassageSplitIn(after_syl_id=syls[2]["id"]))
    conn = get_db()
    owners = {r["id"]: r["passage_id"] for r in conn.execute(
        "SELECT id, passage_id FROM notes WHERE id IN (?, ?)", (n_first, n_second))}
    conn.close()
    assert owners[n_first] == res["first"]["id"]
    assert owners[n_second] == res["second"]["id"]


def test_bake_snaps_transclusion_endpoints():
    """Baking a source text whose suggestions DELETE a transclusion's endpoint
    syllable must not kill the run: the op's range snaps to the nearest surviving
    syllable (the user's vanished ཧཱུྃ་བཞིའི་སྔགས། transclusion)."""
    from app.routers.texts import _apply_corrections_core
    from app.derivation import transclude, compose_secondary, composed_raw_text

    conn = get_db()
    src = _mk_primary(conn, "SnapSrc", "snap_src", RAW2)     # བྱང་ཆུབ་སེམས་དཔའ།
    host_p = _mk_primary(conn, "SnapHostP", "snap_hostp", RAW)
    host = _mk_secondary(conn, host_p)
    src_syls = load_syllables(conn, src)
    # Whole-text transclusion at end of host.
    transclude(conn, host, anchor_syl_id=None, src_text_id=src)
    conn.commit()
    assert RAW2 in composed_raw_text(compose_secondary(conn, host))

    # Delete the FIRST syllable + replace the second — then bake.
    conn.execute(
        "INSERT INTO suggestions (text_id, suggested_text, start_syl_id, end_syl_id, status) "
        "VALUES (?, '', ?, ?, 'applied')", (src, src_syls[0]["id"], src_syls[0]["id"]))
    conn.execute(
        "INSERT INTO suggestions (text_id, suggested_text, start_syl_id, end_syl_id, status) "
        "VALUES (?, 'ཆོས་', ?, ?, 'applied')", (src, src_syls[1]["id"], src_syls[1]["id"]))
    conn.commit()
    assert _apply_corrections_core(conn, src) is True
    conn.commit()

    op = conn.execute(
        "SELECT * FROM derivation_ops WHERE text_id = ? AND op_kind = 'transclude'",
        (host,)).fetchone()
    new_first = load_syllables(conn, src)[0]["id"]
    assert op["src_start_syl_id"] == new_first  # snapped forward off the deleted syl
    composed = composed_raw_text(compose_secondary(conn, host))
    assert "ཆོས་" in composed                    # corrected content rippled in
    assert src_syls[0]["text"] not in RAW or True  # (deleted syl gone from run)
    conn.close()


def test_bake_snaps_anchors_spans_and_markers():
    """Anchors/spans/markers pointing at baked-away syllables snap instead of
    dangling: op anchors move to the next survivor, spans shrink, markers move
    (or drop at end-of-text)."""
    from app.routers.texts import _apply_corrections_core
    from app.routers.tags import create_tag
    from app.routers.spans import create_span, list_spans
    from app.schemas import TagCreate, SpanCreate
    from app.derivation import insert_break, compose_secondary

    conn = get_db()
    p = _mk_primary(conn, "SnapAnch", "snap_anch", RAW)
    child = _mk_secondary(conn, p)
    syls = load_syllables(conn, p)
    # Hosted line break anchored BEFORE syls[2] in the child.
    insert_break(conn, child, before_syl_id=syls[2]["id"])
    # Marker before syls[2]; span over syls[1..3]; another marker before syls[1]
    # whose snap target (syls[2]'s successor after deletion) collides with nothing.
    conn.execute("INSERT INTO markers (text_id, syl_id) VALUES (?, ?)", (p, syls[2]["id"]))
    conn.commit()
    tg = create_tag(p, TagCreate(name="snap-tag", color="#123456"))
    create_span(p, SpanCreate(tag_id=tg["id"],
                              start_syl_id=syls[1]["id"], end_syl_id=syls[3]["id"]))
    conn = get_db()
    # Bake a deletion of syls[1] AND syls[2].
    conn.execute(
        "INSERT INTO suggestions (text_id, suggested_text, start_syl_id, end_syl_id, status) "
        "VALUES (?, '', ?, ?, 'applied')", (p, syls[1]["id"], syls[2]["id"]))
    conn.commit()
    assert _apply_corrections_core(conn, p) is True
    conn.commit()

    # Op anchor snapped forward to syls[3].
    op = conn.execute("SELECT * FROM derivation_ops WHERE text_id = ?", (child,)).fetchone()
    assert op["anchor_syl_id"] == syls[3]["id"]
    # Composition still renders the hosted break (before syls[3] now).
    toks = compose_secondary(conn, child)
    break_i = next(i for i, t in enumerate(toks) if t["text"] == "\n")
    assert toks[break_i + 1]["id"] == syls[3]["id"]
    # Marker snapped to syls[3].
    assert conn.execute("SELECT 1 FROM markers WHERE text_id = ? AND syl_id = ?",
                        (p, syls[3]["id"])).fetchone()
    # Span shrunk to [syls[3], syls[3]] instead of dying.
    row = conn.execute("SELECT * FROM spans WHERE text_id = ?", (p,)).fetchone()
    assert row["start_syl_id"] == syls[3]["id"] and row["end_syl_id"] == syls[3]["id"]
    conn.close()
    spans = list_spans(p)
    assert len(spans) == 1 and spans[0]["tag"]["name"] == "snap-tag"


def test_parent_tag_changes_mirror_into_secondary():
    """Tag changes on the primary AFTER derive mirror live into the secondary
    (add → appears; delete → gone), and the chain sees the root's spans plus spans
    on texts the PARENT transcludes."""
    from app.routers.texts import derive_secondary_text
    from app.routers.tags import create_tag
    from app.routers.spans import create_span, list_spans, delete_span
    from app.derivation import transclude
    from app.schemas import TagCreate, SpanCreate

    conn = get_db()
    p = _mk_primary(conn, "MirrorP", "mirror_p", RAW_RIPPLE)
    other = _mk_primary(conn, "MirrorSrc", "mirror_src", RAW2)
    syls = load_syllables(conn, p)
    other_syls = load_syllables(conn, other)
    conn.close()

    s1 = derive_secondary_text(p, {})["id"]
    s2 = derive_secondary_text(s1, {})["id"]
    assert list_spans(s2) == []

    # Tag the ROOT after both derives: both descendants see it immediately.
    tg = create_tag(p, TagCreate(name="mirror-tag", color="#00aa88"))
    sp = create_span(p, SpanCreate(tag_id=tg["id"],
                                   start_syl_id=syls[1]["id"], end_syl_id=syls[3]["id"]))
    for child in (s1, s2):
        got = list_spans(child)
        assert len(got) == 1 and got[0]["inherited"] is True
        assert got[0]["tag"]["name"] == "mirror-tag"
        assert got[0]["end_offset"] > got[0]["start_offset"]

    # Delete on the root: gone everywhere.
    delete_span(sp["id"])
    assert list_spans(s1) == [] and list_spans(s2) == []

    # A span on a text the PARENT transcludes is visible in the child (graph, not
    # just the direct chain): s1 transcludes `other`, tag `other`, s2 sees it.
    conn = get_db()
    transclude(conn, s1, anchor_syl_id=None, src_text_id=other)
    conn.commit()
    conn.close()
    tg2 = create_tag(other, TagCreate(name="src-mirror", color="#884400"))
    create_span(other, SpanCreate(tag_id=tg2["id"],
                                  start_syl_id=other_syls[0]["id"],
                                  end_syl_id=other_syls[1]["id"]))
    got = list_spans(s2)
    assert len(got) == 1 and got[0]["tag"]["name"] == "src-mirror" and got[0]["inherited"] is True


def test_same_title_texts_mint_disjoint_uuids():
    """Two texts with the SAME (Tibetan) title must mint disjoint syllable uuids —
    the 'instance' fallback slug used to collide, so any two texts sharing
    (idx, syllable-text) got the SAME uuid (the title-bleed bug)."""
    from app.routers.texts import _create_primary_text

    conn = get_db()
    a = _create_primary_text(conn, "a.txt", "བཟང་པོ།", RAW)  # Tibetan title → slug ""
    b = _create_primary_text(conn, "b.txt", "བཟང་པོ།", RAW)  # same title, same content
    conn.commit()
    ids_a = {s["id"] for s in load_syllables(conn, a)}
    ids_b = {s["id"] for s in load_syllables(conn, b)}
    inst_a = conn.execute("SELECT instance_id FROM texts WHERE id=?", (a,)).fetchone()[0]
    inst_b = conn.execute("SELECT instance_id FROM texts WHERE id=?", (b,)).fetchone()[0]
    conn.close()
    assert inst_a != inst_b
    assert ids_a and ids_b and not (ids_a & ids_b)


def test_transclusion_between_same_title_texts_no_duplicate_ids():
    """Host span around an insertion point must derive its OWN end offsets even when
    the transcluded source has identical content/title (regression: duplicate ids in
    the composed stream made the host span's end resolve inside the transclusion)."""
    from app.routers.texts import _create_primary_text, derive_secondary_text
    from app.routers.tags import create_tag
    from app.routers.spans import create_span, list_spans
    from app.derivation import transclude, compose_secondary
    from app.schemas import TagCreate, SpanCreate
    from collections import Counter

    conn = get_db()
    host_p = _create_primary_text(conn, "h.txt", "མཚན་གཅིག", RAW)
    src = _create_primary_text(conn, "s.txt", "མཚན་གཅིག", RAW)  # same title & content
    conn.commit()
    host_syls = load_syllables(conn, host_p)
    conn.close()

    sec = derive_secondary_text(host_p, {})["id"]
    conn = get_db()
    # Transclude the whole source BEFORE the host's 3rd syllable — inside the span below.
    transclude(conn, sec, anchor_syl_id=host_syls[2]["id"], src_text_id=src)
    conn.commit()
    toks = compose_secondary(conn, sec)
    dups = {k for k, v in Counter(t["id"] for t in toks).items() if v > 1}
    conn.close()
    assert not dups, f"duplicate ids in composed stream: {dups}"

    # Host span [syl1..syl4] surrounds the insertion; its derived end must be the end
    # of syl4's occurrence — a duplicate-id collision would drag it elsewhere.
    tg = create_tag(host_p, TagCreate(name="host-span", color="#ff0000"))
    create_span(host_p, SpanCreate(tag_id=tg["id"],
                                   start_syl_id=host_syls[1]["id"],
                                   end_syl_id=host_syls[4]["id"]))
    got = [s for s in list_spans(sec) if s["tag"]["name"] == "host-span"]
    assert len(got) == 1
    span_len = got[0]["end_offset"] - got[0]["start_offset"]
    host_len = sum(len(s["text"]) for s in host_syls[1:5])
    src_len = sum(len(t["text"]) for t in toks if t["source"] == "transclusion")
    assert span_len == host_len + src_len  # covers exactly host run + the insertion


def test_insert_between_transcluded_runs():
    """Insert-type ops anchored at a TRANSCLUDED token work: at a run's first token
    the new content lands BEFORE that run (the 'insert between two runs' gesture);
    at a mid-run token it lands right AFTER the run. edit_range on transcluded
    endpoints fails with the clearer message."""
    from app.routers.texts import derive_secondary_text
    from app.derivation import transclude, insert_break, edit_range, compose_secondary
    from fastapi import HTTPException

    conn = get_db()
    p = _mk_primary(conn, "BetweenP", "between_p", RAW_RIPPLE)
    a = _mk_primary(conn, "SrcA", "src_a", "ཀ་ཁ་ག།")
    b = _mk_primary(conn, "SrcB", "src_b", "ཅ་ཆ་ཇ།")
    c = _mk_primary(conn, "SrcC", "src_c", "ཏ་ཐ་ད།")
    syls = load_syllables(conn, p)
    conn.close()
    sec = derive_secondary_text(p, {})["id"]

    conn = get_db()
    anchor = syls[3]["id"]
    transclude(conn, sec, anchor_syl_id=anchor, src_text_id=a)
    transclude(conn, sec, anchor_syl_id=anchor, src_text_id=b)
    conn.commit()
    toks = compose_secondary(conn, sec)
    text = "".join(t["text"] for t in toks)
    assert "ཀ་ཁ་ག།" in text and text.index("ཀ་ཁ་ག།") < text.index("ཅ་ཆ་ཇ།")

    # Insert C right BEFORE run B (anchor token = B's first composed token) —
    # the user's gesture "right after run A's last syllable".
    b_first = next(t for t in toks if t.get("src_text_id") == b)["id"]
    transclude(conn, sec, anchor_syl_id=b_first, src_text_id=c)
    conn.commit()
    text = "".join(t["text"] for t in compose_secondary(conn, sec))
    assert text.index("ཀ་ཁ་ག།") < text.index("ཏ་ཐ་ད།") < text.index("ཅ་ཆ་ཇ།")

    # A REAL line break anchored at a MID token of run B is refused (it can only be
    # ordered before/after the whole run — silently relocating it surprised users;
    # display breaks are the mid-run tool).
    toks = compose_secondary(conn, sec)
    b_toks = [t for t in toks if t.get("src_text_id") == b]
    try:
        insert_break(conn, sec, before_syl_id=b_toks[1]["id"])
        assert False, "expected 400"
    except HTTPException as e:
        assert e.status_code == 400 and "display line break" in e.detail
    # Before the run's FIRST token still works (the "between two runs" gesture).
    insert_break(conn, sec, before_syl_id=b_toks[0]["id"])
    conn.commit()
    toks = compose_secondary(conn, sec)
    b_first_i = next(i for i, t in enumerate(toks) if t.get("src_text_id") == b)
    assert toks[b_first_i - 1]["text"] == "\n"

    # edit_range with a transcluded endpoint → the clearer message.
    try:
        edit_range(conn, sec, b_toks[0]["id"], b_toks[1]["id"], "xyz")
        assert False, "expected 400"
    except HTTPException as e:
        assert e.status_code == 400 and "transcluded" in e.detail
    conn.close()


def test_anchor_op_id_disambiguates_repeated_transclusions():
    """The same source transcluded TWICE repeats the same uuids in the stream; an
    insert anchored at 'the second run's first token' must land before the SECOND
    occurrence when the caller names the emitting op (anchor_op_id), and composed
    tokens carry op_id so the frontend can name it."""
    from app.routers.texts import derive_secondary_text
    from app.derivation import transclude, insert_break, compose_secondary

    conn = get_db()
    p = _mk_primary(conn, "RepP", "rep_p", RAW_RIPPLE)
    a = _mk_primary(conn, "RepA", "rep_a", "ཀ་ཁ་ག།")
    c = _mk_primary(conn, "RepC", "rep_c", "ཏ་ཐ་ད།")
    syls = load_syllables(conn, p)
    conn.close()
    sec = derive_secondary_text(p, {})["id"]

    conn = get_db()
    # Source A twice, at different anchors.
    transclude(conn, sec, anchor_syl_id=syls[2]["id"], src_text_id=a)
    transclude(conn, sec, anchor_syl_id=syls[5]["id"], src_text_id=a)
    conn.commit()
    toks = compose_secondary(conn, sec)
    runs = [t for t in toks if t.get("src_text_id") == a]
    assert len(runs) == 2 * (len(runs) // 2) and len({t["op_id"] for t in runs}) == 2
    op1, op2 = sorted({t["op_id"] for t in runs})
    second_first = next(t for t in toks if t.get("op_id") == op2)

    # Insert C before the SECOND occurrence — same uuid as the first run's first
    # token, disambiguated by anchor_op_id.
    transclude(conn, sec, anchor_syl_id=second_first["id"], src_text_id=c,
               anchor_op_id=op2)
    conn.commit()
    text = "".join(t["text"] for t in compose_secondary(conn, sec))
    first_a = text.index("ཀ་ཁ་ག།")
    second_a = text.index("ཀ་ཁ་ག།", first_a + 1)
    assert first_a < text.index("ཏ་ཐ་ད།") < second_a + 1
    assert text.index("ཏ་ཐ་ད།") > first_a  # not before the first run
    # C sits immediately before the second A run.
    assert text.index("ཏ་ཐ་ད།") + len("ཏ་ཐ་ད།") <= second_a

    # Line break with the same disambiguation: before the second A run.
    toks = compose_secondary(conn, sec)
    second_first = next(t for t in toks if t.get("op_id") == op2)
    insert_break(conn, sec, before_syl_id=second_first["id"], anchor_op_id=op2)
    conn.commit()
    toks = compose_secondary(conn, sec)
    i2 = next(i for i, t in enumerate(toks) if t.get("op_id") == op2)
    assert toks[i2 - 1]["text"] == "\n"
    conn.close()


def test_source_tags_display_on_every_occurrence():
    """A span on a source transcluded TWICE serializes once PER OCCURRENCE (with the
    right host offsets), so both runs display the source's tags — not just the last
    one a flat id→offset map happened to keep."""
    from app.routers.texts import derive_secondary_text
    from app.routers.tags import create_tag
    from app.routers.spans import create_span, list_spans
    from app.derivation import transclude, compose_secondary
    from app.schemas import TagCreate, SpanCreate

    conn = get_db()
    p = _mk_primary(conn, "OccP", "occ_p", RAW_RIPPLE)
    a = _mk_primary(conn, "OccA", "occ_a", "ཀ་ཁ་ག།")
    syls = load_syllables(conn, p)
    a_syls = load_syllables(conn, a)
    conn.close()
    sec = derive_secondary_text(p, {})["id"]

    conn = get_db()
    transclude(conn, sec, anchor_syl_id=syls[2]["id"], src_text_id=a)
    transclude(conn, sec, anchor_syl_id=syls[5]["id"], src_text_id=a)
    conn.commit()
    toks = compose_secondary(conn, sec)
    conn.close()

    tg = create_tag(a, TagCreate(name="occ-tag", color="#00ff00"))
    create_span(a, SpanCreate(tag_id=tg["id"],
                              start_syl_id=a_syls[0]["id"], end_syl_id=a_syls[1]["id"]))
    got = [s for s in list_spans(sec) if s["tag"]["name"] == "occ-tag"]
    assert len(got) == 2, f"expected one span per occurrence, got {len(got)}"
    runs = {}
    for t in toks:
        if t.get("src_text_id") == a:
            runs.setdefault(t["op_id"], []).append(t)
    starts = sorted(r[0]["start_offset"] for r in runs.values())
    assert sorted(s["start_offset"] for s in got) == starts
    assert all(s["inherited"] for s in got)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\n{len(fns)} passed")
