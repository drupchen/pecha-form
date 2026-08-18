"""The organization TEMPLATE: what every booklet inherits or is seeded from.

Two arrangements that must not be confused, and are tested as opposites here:

  * the COPYRIGHT template is COPIED — adding a back cover writes the org's words into the
    booklet, which owns them from then on. Editing the template later changes what the NEXT
    booklet opens with and nothing already on a page.
  * the org IMAGES are INHERITED — printed by every booklet that has not uploaded its own.
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

init_db()


def _booklet(conn, langs=("en", "fr")):
    doc_id = conn.execute(
        "INSERT INTO documents (title, org_id, kind) VALUES ('booklet', 1, 'booklet')").lastrowid
    for i, lg in enumerate(langs):
        conn.execute("INSERT INTO document_languages (document_id, lang, position) "
                     "VALUES (?, ?, ?)", (doc_id, lg, i))
    conn.commit()
    return doc_id


def _set_template(lang, body):
    from app.routers.styles import put_org_copyright, CopyrightIn
    return put_org_copyright(lang, CopyrightIn(body=body), org_id=1)


def _add_backcover(doc_id):
    from app.routers.documents import add_item
    from app.schemas import DocumentItemIn
    return add_item(doc_id, DocumentItemIn(kind="backcover"))


def _bodies(doc_id, item_id):
    conn = get_db()
    try:
        return {r["lang"]: r["body"] for r in conn.execute(
            "SELECT lang, body FROM document_furniture WHERE document_id = ? AND item_id = ? "
            "AND block = ''", (doc_id, item_id)).fetchall()}
    finally:
        conn.close()


# ── The copyright template ───────────────────────────────────────────────────

def test_a_template_round_trips_and_clears():
    from app.routers.styles import get_org_copyright, delete_org_copyright
    assert _set_template("en", "Copyright © {{year}}")["body"] == "Copyright © {{year}}"
    assert {r["lang"]: r["body"] for r in get_org_copyright(org_id=1)}["en"] \
        == "Copyright © {{year}}"
    delete_org_copyright("en", org_id=1)
    assert all(r["lang"] != "en" for r in get_org_copyright(org_id=1))


def test_the_variables_survive_sanitizing():
    """The body goes through the furniture sanitizer, which escapes stray markup. `{{…}}`
    carries no angle brackets, so it must come out the other side character for character —
    the whole template is worthless if the braces are mangled."""
    body = "Translations by X, version {{version}}<br>Copyright © {{year}} Shechen."
    assert "{{version}}" in _set_template("fr", body)["body"]
    assert "{{year}}" in _set_template("fr", body)["body"]


def test_an_unknown_language_is_refused():
    from fastapi import HTTPException
    from app.routers.styles import put_org_copyright, CopyrightIn
    try:
        put_org_copyright("zz", CopyrightIn(body="x"), org_id=1)
        raise AssertionError("expected a 404")
    except HTTPException as e:
        assert e.status_code == 404


# ── …and how a booklet gets it ───────────────────────────────────────────────

def test_a_new_back_cover_opens_with_the_template():
    _set_template("en", "EN boilerplate")
    _set_template("fr", "FR boilerplate")
    conn = get_db()
    try:
        doc_id = _booklet(conn)
    finally:
        conn.close()
    item = _add_backcover(doc_id)
    assert _bodies(doc_id, item.id) == {"en": "EN boilerplate", "fr": "FR boilerplate"}


def test_it_seeds_only_the_booklet_s_own_languages():
    _set_template("en", "EN boilerplate")
    _set_template("de", "DE boilerplate")
    conn = get_db()
    try:
        doc_id = _booklet(conn, langs=("en",))
    finally:
        conn.close()
    item = _add_backcover(doc_id)
    assert _bodies(doc_id, item.id) == {"en": "EN boilerplate"}


def test_a_booklet_with_no_languages_yet_is_seeded_with_nothing():
    """A new booklet has no languages until they are chosen, which is exactly why the seeding
    hangs off the back cover rather than off document creation — and why it must be a no-op
    when the page is added first."""
    conn = get_db()
    try:
        doc_id = _booklet(conn, langs=())
    finally:
        conn.close()
    item = _add_backcover(doc_id)
    assert _bodies(doc_id, item.id) == {}


def test_only_the_back_cover_is_seeded():
    _set_template("en", "EN boilerplate")
    from app.routers.documents import add_item
    from app.schemas import DocumentItemIn
    conn = get_db()
    try:
        doc_id = _booklet(conn, langs=("en",))
    finally:
        conn.close()
    cover = add_item(doc_id, DocumentItemIn(kind="cover"))
    assert _bodies(doc_id, cover.id) == {}


def test_editing_the_template_does_not_touch_a_booklet_already_made():
    """The point of a copy. A house that republishes an old booklet must not find its
    copyright silently rewritten."""
    _set_template("en", "First wording")
    conn = get_db()
    try:
        doc_id = _booklet(conn, langs=("en",))
    finally:
        conn.close()
    item = _add_backcover(doc_id)
    _set_template("en", "Second wording")
    assert _bodies(doc_id, item.id) == {"en": "First wording"}


def test_an_empty_template_seeds_nothing_rather_than_a_blank_paragraph():
    _set_template("en", "   ")
    conn = get_db()
    try:
        doc_id = _booklet(conn, langs=("en",))
    finally:
        conn.close()
    item = _add_backcover(doc_id)
    assert _bodies(doc_id, item.id) == {}
