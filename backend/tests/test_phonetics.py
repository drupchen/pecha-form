"""Phonetics round-trip: PUT/GET/DELETE, owner canonicalization, ripple to origin.

Phonetics anchor to origin-text syllables (like translations), so a row saved from
a secondary canonicalizes at the owner and is visible from the origin text too.
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


def test_phonetics_round_trip_and_ripple():
    from app.routers.texts import derive_secondary_text
    from app.routers.phonetics import (
        list_text_phonetics, upsert_phonetic, delete_phonetic,
        PhoneticIn, PhoneticDeleteIn,
    )

    conn = get_db()
    p = _mk_primary(conn, "PhonP", "phon_p", RAW)
    syls = load_syllables(conn, p)
    conn.close()

    child = derive_secondary_text(p, {})["id"]

    # Save a phonetics line FROM the secondary; both endpoints are the parent's
    # syllables → it canonicalizes at the owner (the primary).
    saved = upsert_phonetic(PhoneticIn(
        context_text_id=child, start_syl_id=syls[0]["id"], end_syl_id=syls[3]["id"],
        kind="bo", body="sang gye chö dang", status="edited"))
    assert saved.origin_text_id == p
    assert saved.body == "sang gye chö dang"
    assert saved.text == "".join(syls[i]["text"] for i in range(4))

    # Visible from BOTH the secondary (inherited) and the origin primary (own).
    from_child = list_text_phonetics(child)
    from_parent = list_text_phonetics(p)
    assert len(from_child) == 1 and from_child[0].body == "sang gye chö dang"
    assert len(from_parent) == 1 and from_parent[0].origin_text_id == p

    # Upsert overwrites in place (same range+kind).
    upsert_phonetic(PhoneticIn(
        context_text_id=p, start_syl_id=syls[0]["id"], end_syl_id=syls[3]["id"],
        kind="bo", body="revised", status="reviewed"))
    rows = list_text_phonetics(p)
    assert len(rows) == 1 and rows[0].body == "revised" and rows[0].status == "reviewed"

    # A skt row on the same range coexists (different kind).
    upsert_phonetic(PhoneticIn(
        context_text_id=p, start_syl_id=syls[0]["id"], end_syl_id=syls[3]["id"],
        kind="skt", body="om ah hung", status="auto"))
    assert len(list_text_phonetics(p)) == 2

    # DELETE removes just the bo row.
    delete_phonetic(PhoneticDeleteIn(
        context_text_id=p, start_syl_id=syls[0]["id"], end_syl_id=syls[3]["id"], kind="bo"))
    left = list_text_phonetics(p)
    assert len(left) == 1 and left[0].kind == "skt"


def test_phonetics_language_specific():
    """Same range+kind holds a distinct body per language; GET filters by lang."""
    from app.routers.texts import derive_secondary_text  # noqa: F401
    from app.routers.phonetics import (
        list_text_phonetics, upsert_phonetic, delete_phonetic,
        PhoneticIn, PhoneticDeleteIn,
    )
    conn = get_db()
    p = _mk_primary(conn, "LangP", "lang_p", RAW)
    syls = load_syllables(conn, p)
    conn.close()

    rng = dict(context_text_id=p, start_syl_id=syls[0]["id"], end_syl_id=syls[2]["id"], kind="skt")
    upsert_phonetic(PhoneticIn(**rng, lang="en", body="Om Ah Hung", status="reviewed"))
    upsert_phonetic(PhoneticIn(**rng, lang="fr", body="Om Ah Houng", status="reviewed"))

    # Both coexist on the same range+kind.
    allrows = list_text_phonetics(p)
    assert len(allrows) == 2
    assert {r.lang for r in allrows} == {"en", "fr"}

    # GET filters by language.
    en = list_text_phonetics(p, lang="en")
    fr = list_text_phonetics(p, lang="fr")
    assert len(en) == 1 and en[0].body == "Om Ah Hung"
    assert len(fr) == 1 and fr[0].body == "Om Ah Houng"

    # Editing one language leaves the other intact.
    upsert_phonetic(PhoneticIn(**rng, lang="en", body="Om Ah Hum", status="edited"))
    assert list_text_phonetics(p, lang="en")[0].body == "Om Ah Hum"
    assert list_text_phonetics(p, lang="fr")[0].body == "Om Ah Houng"

    # DELETE is per-language.
    delete_phonetic(PhoneticDeleteIn(**rng, lang="en"))
    assert list_text_phonetics(p, lang="en") == []
    assert len(list_text_phonetics(p, lang="fr")) == 1


def test_phonetics_auto_populate_sibling_documents():
    """A phonetic authored in ONE document that includes a primary must show up in
    EVERY other document that includes the same primary — the ripple the user asked
    for. It works because the row canonicalizes at the shared owner (the primary),
    and every including document gathers its source chain on read."""
    from app.routers.texts import derive_secondary_text
    from app.routers.phonetics import (
        list_text_phonetics, upsert_phonetic, PhoneticIn,
    )

    conn = get_db()
    p = _mk_primary(conn, "SibP", "sib_p", RAW)
    syls = load_syllables(conn, p)
    conn.close()

    # Two independent documents both derived from the same primary.
    doc_a = derive_secondary_text(p, {})["id"]
    doc_b = derive_secondary_text(p, {})["id"]

    # Author a phonetic from document A → canonicalizes at the shared primary.
    saved = upsert_phonetic(PhoneticIn(
        context_text_id=doc_a, start_syl_id=syls[0]["id"], end_syl_id=syls[2]["id"],
        kind="bo", body="sang gye chö", status="reviewed"))
    assert saved.origin_text_id == p

    # Document B (never touched) sees it live, marked inherited-from-source.
    from_b = list_text_phonetics(doc_b)
    assert len(from_b) == 1
    assert from_b[0].body == "sang gye chö"
    assert from_b[0].origin_text_id == p


if __name__ == "__main__":
    test_phonetics_round_trip_and_ripple()
    print("ok")
