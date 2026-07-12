"""Live inheritance of structure (markers/notes/passages) down the derive graph.

A secondary does NOT copy the parent's structure — it inherits it live on read, so
edits on the primary ripple. Regression cover for the copied-marker-on-a-child bug.
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

RAW = "སངས་རྒྱས་ཆོས་དང་ཚོགས་ཀྱི་མཆོག་རྣམས་ལ།"


def _mk_primary(conn, title, instance, raw):
    cur = conn.execute(
        "INSERT INTO texts (filename, title, source_text, raw_text, text_type) "
        "VALUES ('t.txt', ?, '', ?, 'primary')", (title, raw))
    tid = cur.lastrowid
    persist_syllables(conn, tid, instance, raw)
    conn.commit()
    return tid


def test_markers_notes_passages_inherit_live():
    from app.routers.texts import derive_secondary_text
    from app.routers.markers import list_markers
    from app.routers.notes import list_notes
    from app.routers.passages import list_passages

    conn = get_db()
    p = _mk_primary(conn, "InhP", "inh_p", RAW)
    syls = load_syllables(conn, p)
    conn.close()

    child = derive_secondary_text(p, {})["id"]

    # No structure copied at derive — the child's own tables are empty.
    conn = get_db()
    assert conn.execute("SELECT COUNT(*) c FROM markers WHERE text_id=?", (child,)).fetchone()["c"] == 0
    assert conn.execute("SELECT COUNT(*) c FROM passages WHERE text_id=?", (child,)).fetchone()["c"] == 0

    # Add structure on the PARENT after derive → must appear on the child live.
    conn.execute("INSERT INTO markers (text_id, syl_id) VALUES (?, ?)", (p, syls[4]["id"]))
    conn.execute("INSERT INTO notes (text_id, body, start_syl_id, end_syl_id) "
                 "VALUES (?, 'parent note', ?, ?)", (p, syls[2]["id"], syls[3]["id"]))
    # A passage: anchor downstream of a member run (members = syls[1..2], anchor = syls[6]).
    pg = conn.execute("INSERT INTO passages (text_id, anchor_syl_id, position) VALUES (?, ?, 0)",
                      (p, syls[6]["id"])).lastrowid
    conn.execute("INSERT INTO passage_members (passage_id, position, src_start_syl_id, src_end_syl_id) "
                 "VALUES (?, 0, ?, ?)", (pg, syls[1]["id"], syls[2]["id"]))
    conn.commit()
    conn.close()

    ms = list_markers(child)
    assert any(m["syl_id"] == syls[4]["id"] and m["inherited"] for m in ms)
    ns = list_notes(child)
    assert len(ns) == 1 and ns[0]["inherited"] and ns[0]["body"] == "parent note"
    ps = list_passages(child)
    assert len(ps) == 1 and ps[0]["inherited"] and ps[0]["text_id"] == child
    assert [s["syl_id"] for s in ps[0]["members"][0]["syllables"]] == [syls[1]["id"], syls[2]["id"]]

    # The child can add its OWN boundary (inherited=False), coexisting.
    conn = get_db()
    conn.execute("INSERT INTO markers (text_id, syl_id) VALUES (?, ?)", (child, syls[7]["id"]))
    conn.commit()
    conn.close()
    ms = list_markers(child)
    own = [m for m in ms if not m["inherited"]]
    assert len(own) == 1 and own[0]["syl_id"] == syls[7]["id"]


if __name__ == "__main__":
    test_markers_notes_passages_inherit_live()
    print("ok")
