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
        "INSERT INTO texts (filename, title, source_text, raw_text, units_json, text_type) "
        "VALUES ('t.txt', ?, '', ?, '[]', 'primary')",
        (title, raw),
    )
    tid = cur.lastrowid
    persist_syllables(conn, tid, instance, raw)
    conn.commit()
    return tid


def _mk_secondary(conn, parent_id):
    cur = conn.execute(
        "INSERT INTO texts (filename, title, source_text, raw_text, units_json, "
        "text_type, parent_text_id) VALUES ('t.txt','Secondary','', '', '[]', "
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


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\n{len(fns)} passed")
