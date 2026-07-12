"""Bake-snapping guarantees (_snap_refs_after_bake), incl. the T1–T3 layer.

When apply-corrections bakes a primary and a syllable is DELETED, every uuid
reference to it must be re-anchored or cleanly dropped — never left to silently
mis-resolve. Regression cover for the copied-marker-on-a-child bug: a boundary
whose anchor syllable dies is DELETED, not snapped forward.
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
from app.manifest import load_syllables, persist_syllables, syllable_ids_between  # noqa: E402
from app.derivation import base_tokens  # noqa: E402

init_db()

RAW = "སངས་རྒྱས་ཆོས་དང་ཚོགས་ཀྱི་མཆོག་རྣམས་ལ།"


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


def test_bake_snaps_and_drops_all_reference_layers():
    from app.routers.texts import apply_corrections
    from app.routers.suggestions import create_suggestion
    from app.schemas import SuggestionCreate

    conn = get_db()
    p = _mk_primary(conn, "SnapP", "snap_p", RAW)
    syls = load_syllables(conn, p)
    # idx 4 (ཚོགས་) is the doomed syllable; anchor references straddling it.
    doomed = syls[4]["id"]
    before = syls[3]["id"]
    after = syls[5]["id"]

    # A marker + display break ON the doomed syllable.
    conn.execute("INSERT INTO markers (text_id, syl_id) VALUES (?, ?)", (p, doomed))
    conn.execute("INSERT INTO display_breaks (text_id, syl_id, count) VALUES (?, ?, 1)",
                 (p, doomed))
    # A translation chunk whose END is the doomed syllable (start survives).
    conn.execute("INSERT INTO languages (code, name) VALUES ('en','English') "
                 "ON CONFLICT DO NOTHING")
    ch = conn.execute(
        "INSERT INTO translation_chunks (origin_text_id, start_syl_id, end_syl_id, kind) "
        "VALUES (?, ?, ?, 'text')", (p, syls[2]["id"], doomed)).lastrowid
    conn.execute("INSERT INTO translations (chunk_id, lang, body) VALUES (?, 'en', 'hi')", (ch,))
    # Phonetics whose START is the doomed syllable (end survives).
    conn.execute(
        "INSERT INTO phonetics (origin_text_id, start_syl_id, end_syl_id, kind, body) "
        "VALUES (?, ?, ?, 'bo', 'tsok')", (p, doomed, after))
    conn.commit()
    conn.close()

    # Delete the doomed syllable (empty replacement) and bake.
    create_suggestion(p, SuggestionCreate(
        suggested_text="", start_syl_id=doomed, end_syl_id=doomed))
    apply_corrections(p)

    conn = get_db()
    new_ids = {s["id"] for s in load_syllables(conn, p)}
    assert doomed not in new_ids  # actually deleted

    # Marker + display break on the dead syllable are DELETED (not snapped).
    assert conn.execute("SELECT COUNT(*) c FROM markers WHERE text_id=?", (p,)).fetchone()["c"] == 0
    assert conn.execute("SELECT COUNT(*) c FROM display_breaks WHERE text_id=?", (p,)).fetchone()["c"] == 0

    toks = base_tokens(conn, p)
    # Translation chunk end snapped back to the previous survivor; still resolves.
    row = conn.execute("SELECT start_syl_id, end_syl_id FROM translation_chunks WHERE id=?", (ch,)).fetchone()
    assert row["end_syl_id"] == before
    assert syllable_ids_between(toks, row["start_syl_id"], row["end_syl_id"])
    # Phonetics start snapped forward to the next survivor; still resolves.
    ph = conn.execute("SELECT start_syl_id, end_syl_id FROM phonetics WHERE origin_text_id=?", (p,)).fetchone()
    assert ph["start_syl_id"] == after
    assert syllable_ids_between(toks, ph["start_syl_id"], ph["end_syl_id"])
    conn.close()


def test_no_span_reversed_in_new_order():
    """A span snapped across a deletion must not end up reversed in the NEW order."""
    from app.routers.texts import apply_corrections
    from app.routers.suggestions import create_suggestion
    from app.routers.tags import create_tag
    from app.routers.spans import create_span
    from app.schemas import SuggestionCreate, TagCreate, SpanCreate

    conn = get_db()
    p = _mk_primary(conn, "RevP", "rev_p", RAW)
    syls = load_syllables(conn, p)
    conn.close()

    tag = create_tag(p, TagCreate(name="verse"))
    # A tight span on adjacent syllables 4,5; delete BOTH → both anchors die.
    create_span(p, SpanCreate(tag_id=tag["id"],
                              start_syl_id=syls[4]["id"], end_syl_id=syls[5]["id"]))
    create_suggestion(p, SuggestionCreate(
        suggested_text="", start_syl_id=syls[4]["id"], end_syl_id=syls[5]["id"]))
    apply_corrections(p)

    conn = get_db()
    toks = base_tokens(conn, p)
    pos = {t["id"]: i for i, t in enumerate(toks)}
    for s in conn.execute("SELECT start_syl_id, end_syl_id FROM spans WHERE text_id=?", (p,)).fetchall():
        i, j = pos.get(s["start_syl_id"]), pos.get(s["end_syl_id"])
        # Either dangling (dropped on read) or in order — never reversed.
        assert i is None or j is None or i <= j
    conn.close()


if __name__ == "__main__":
    test_bake_snaps_and_drops_all_reference_layers()
    test_no_span_reversed_in_new_order()
    print("ok")
