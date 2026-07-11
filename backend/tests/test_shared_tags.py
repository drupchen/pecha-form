"""Part 8: shared vs. private tags.

A tag's owner (`tags.text_id`) decides its scope: a non-NULL owner == private to that
text; a NULL owner == *shared*, appearing in every text's palette. Only regular tags may
be shared (session tags carry per-text syllable anchors). Deleting a text CASCADE-drops
its private tags but leaves shared (NULL) ones untouched.

These tests drive the router functions directly (they open their own connections against
the temp DB_PATH). Run: `python tests/test_shared_tags.py`.
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
from app.routers.tags import create_tag, update_tag, delete_tag, list_tags  # noqa: E402
from app.routers.spans import create_span, list_spans  # noqa: E402
from app.schemas import TagCreate, TagUpdate, SpanCreate  # noqa: E402
from fastapi import HTTPException  # noqa: E402

init_db()

RAW_A = "སངས་རྒྱས་ཆོས་དང་ཚོགས་ཀྱི་མཆོག་རྣམས་ལ།། \n"
RAW_B = "བྱང་ཆུབ་སེམས་དཔའ་རྣམས་ལ་ཕྱག་འཚལ་ལོ།། \n"


def _mk(title, raw):
    conn = get_db()
    tid = _create_primary_text(conn, "t.txt", title, raw)
    conn.commit()
    conn.close()
    return tid


TEXT_A = _mk("A", RAW_A)
TEXT_B = _mk("B", RAW_B)


def _names(text_id):
    return {t["name"] for t in list_tags(text_id)}


def test_private_tag_is_scoped_to_its_text():
    t = create_tag(TEXT_A, TagCreate(name="Deity", color="#111", tag_kind="regular"))
    assert t["is_shared"] is False and t["text_id"] == TEXT_A
    assert "Deity" in _names(TEXT_A)
    assert "Deity" not in _names(TEXT_B)  # private → not in B's palette


def test_toggle_shared_appears_in_every_text():
    t = create_tag(TEXT_A, TagCreate(name="Mantra", color="#222", tag_kind="regular"))
    shared = update_tag(t["id"], TagUpdate(is_shared=True))
    assert shared["is_shared"] is True and shared["text_id"] is None
    assert "Mantra" in _names(TEXT_A)
    assert "Mantra" in _names(TEXT_B)  # shared → visible everywhere


def test_shared_tag_is_applicable_in_another_text():
    t = create_tag(TEXT_A, TagCreate(name="Verse", color="#333", tag_kind="regular"))
    update_tag(t["id"], TagUpdate(is_shared=True))
    # tag a selection in B with the shared tag (B never "owned" it)
    syls = load_syllables(get_db(), TEXT_B)
    span = create_span(TEXT_B, SpanCreate(
        tag_id=t["id"], start_syl_id=syls[0]["id"], end_syl_id=syls[1]["id"]))
    assert span["tag_id"] == t["id"]
    assert any(s["tag_id"] == t["id"] for s in list_spans(TEXT_B))


def test_toggle_back_private_removes_from_other_texts():
    t = create_tag(TEXT_A, TagCreate(name="Note", color="#444", tag_kind="regular"))
    update_tag(t["id"], TagUpdate(is_shared=True))
    assert "Note" in _names(TEXT_B)
    update_tag(t["id"], TagUpdate(is_shared=False, text_id=TEXT_A))  # private to A again
    assert "Note" in _names(TEXT_A)
    assert "Note" not in _names(TEXT_B)


def test_session_tags_cannot_be_shared():
    t = create_tag(TEXT_A, TagCreate(name="A1", color="#555", tag_kind="session"))
    try:
        update_tag(t["id"], TagUpdate(is_shared=True))
        assert False, "expected 400 sharing a session tag"
    except HTTPException as e:
        assert e.status_code == 400


def test_name_collision_between_shared_and_private_is_refused():
    # A private "Dup" in B, then a shared "Dup" created from A → collision in B's palette.
    create_tag(TEXT_B, TagCreate(name="Dup", color="#666", tag_kind="regular"))
    shared = create_tag(TEXT_A, TagCreate(name="Dup", color="#777", tag_kind="regular"))
    try:
        update_tag(shared["id"], TagUpdate(is_shared=True))
        assert False, "expected 400: shared name collides with a private tag in B"
    except HTTPException as e:
        assert e.status_code == 400


def test_shared_survives_origin_delete_private_cascades():
    # A shared tag born in a throwaway text must outlive that text; a private tag dies with it.
    origin = _mk("Origin", RAW_A)
    shared = create_tag(origin, TagCreate(name="Global", color="#888", tag_kind="regular"))
    update_tag(shared["id"], TagUpdate(is_shared=True))
    private = create_tag(origin, TagCreate(name="Local", color="#999", tag_kind="regular"))

    conn = get_db()  # get_db sets PRAGMA foreign_keys = ON → CASCADE fires
    conn.execute("DELETE FROM texts WHERE id = ?", (origin,))
    conn.commit()
    rows = {r["name"]: r["text_id"] for r in
            conn.execute("SELECT name, text_id FROM tags WHERE name IN ('Global','Local')")}
    conn.close()
    assert rows.get("Global") is None       # shared tag survived, now ownerless
    assert "Local" not in rows              # private tag cascade-deleted with its text
    assert "Global" in _names(TEXT_B)       # still usable elsewhere


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    for fn in fns:
        fn(); print("ok", fn.__name__)
    print(f"\n{len(fns)} passed")
