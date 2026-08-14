"""Translation provenance: who wrote which wording, and when.

`translations` keeps one row per chunk × language and overwrites it in place, so the
append-only `translation_revisions` log is the only record of a previous wording and
its author. These tests pin the two properties that make the log readable: every real
wording change is captured with its author, and nothing else is.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

_tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_tmp.close()
from app import db as _dbmod  # noqa: E402
_dbmod.DB_PATH = _tmp.name

from app.auth import AuthContext, _ctx  # noqa: E402
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


def _mk_user(conn, name, email):
    cur = conn.execute(
        "INSERT INTO users (email, display_name, is_superuser) VALUES (?, ?, 0)",
        (email, name))
    conn.commit()
    return cur.lastrowid


def _as(user_id):
    """Make the next call look like it came from this user."""
    _ctx.set(AuthContext(user_id=user_id, org_id=1, is_superuser=True))


def test_revisions_capture_author_and_ignore_no_ops():
    from app.routers.translations import (
        upsert_translation, list_translation_revisions, TranslationUpsertIn,
    )

    conn = get_db()
    p = _mk_primary(conn, "RevP", "rev_p", RAW)
    dolma = _mk_user(conn, "Dolma", "dolma@example.org")
    tenzin = _mk_user(conn, "Tenzin", "tenzin@example.org")
    syls = load_syllables(conn, p)
    conn.close()

    args = dict(context_text_id=p, start_syl_id=syls[0]["id"],
                end_syl_id=syls[3]["id"], lang="en")

    _as(dolma)
    ch = upsert_translation(TranslationUpsertIn(
        body="Buddha, Dharma and the supreme Assembly", status="draft", **args))
    chunk_id = ch.id

    _as(tenzin)
    upsert_translation(TranslationUpsertIn(
        body="the Buddha, the Dharma and the noble Sangha", status="draft", **args))

    revs = list_translation_revisions(chunk_id, lang="en")
    assert len(revs) == 2
    # Newest first: Tenzin's rewording, then Dolma's original.
    assert revs[0].author_id == tenzin and revs[0].author_name == "Tenzin"
    assert "noble Sangha" in revs[0].body
    assert revs[1].author_id == dolma and revs[1].author_name == "Dolma"
    assert "supreme Assembly" in revs[1].body
    assert all(r.scope == "canonical" and r.source == "manual" for r in revs)

    # Re-saving the identical wording is not a new wording.
    upsert_translation(TranslationUpsertIn(
        body="the Buddha, the Dharma and the noble Sangha", status="draft", **args))
    assert len(list_translation_revisions(chunk_id, lang="en")) == 2

    # Neither is promoting draft → final: the words did not change.
    upsert_translation(TranslationUpsertIn(
        body="the Buddha, the Dharma and the noble Sangha", status="final", **args))
    assert len(list_translation_revisions(chunk_id, lang="en")) == 2


def test_override_revisions_carry_their_booklet():
    from app.routers.texts import derive_secondary_text
    from app.routers.translations import (
        upsert_translation, upsert_override, list_translation_revisions,
        TranslationUpsertIn, OverrideIn,
    )

    conn = get_db()
    p = _mk_primary(conn, "RevO", "rev_o", RAW)
    pema = _mk_user(conn, "Pema", "pema@example.org")
    syls = load_syllables(conn, p)
    conn.close()
    booklet = derive_secondary_text(p, {})["id"]

    _as(pema)
    ch = upsert_translation(TranslationUpsertIn(
        context_text_id=p, start_syl_id=syls[0]["id"], end_syl_id=syls[3]["id"],
        lang="en", body="canonical wording", status="draft"))

    upsert_override(booklet, OverrideIn(
        chunk_id=ch.id, lang="en", body="this booklet says it differently"))

    revs = list_translation_revisions(ch.id, lang="en")
    assert len(revs) == 2
    assert revs[0].scope == "override" and revs[0].text_id == booklet
    assert revs[1].scope == "canonical" and revs[1].text_id is None

    # Narrowing to the booklet returns only its own overrides.
    only_booklet = list_translation_revisions(ch.id, lang="en", text_id=booklet)
    assert len(only_booklet) == 1 and only_booklet[0].scope == "override"


def test_accepted_suggestion_is_attributed_to_whoever_accepted():
    from app.routers.texts import derive_secondary_text
    from app.routers.translations import (
        upsert_translation, create_suggestion, resolve_suggestion,
        list_translation_revisions, TranslationUpsertIn, SuggestionIn, ResolveIn,
    )

    conn = get_db()
    p = _mk_primary(conn, "RevS", "rev_s", RAW)
    author = _mk_user(conn, "Norbu", "norbu@example.org")
    editor = _mk_user(conn, "Yangchen", "yangchen@example.org")
    syls = load_syllables(conn, p)
    conn.close()
    booklet = derive_secondary_text(p, {})["id"]

    _as(author)
    ch = upsert_translation(TranslationUpsertIn(
        context_text_id=p, start_syl_id=syls[0]["id"], end_syl_id=syls[3]["id"],
        lang="en", body="first wording", status="draft"))
    sug = create_suggestion(SuggestionIn(
        chunk_id=ch.id, lang="en", body="a better wording", from_text_id=booklet))

    _as(editor)
    resolve_suggestion(sug.id, ResolveIn(accept=True))

    revs = list_translation_revisions(ch.id, lang="en")
    assert len(revs) == 2
    assert revs[0].source == "suggestion"
    assert revs[0].body == "a better wording"
    # The person who accepted it chose it for the canonical, so it is theirs.
    assert revs[0].author_id == editor
    assert str(booklet) in (revs[0].note or "")


if __name__ == "__main__":
    test_revisions_capture_author_and_ignore_no_ops()
    test_override_revisions_carry_their_booklet()
    test_accepted_suggestion_is_attributed_to_whoever_accepted()
    print("ok")
