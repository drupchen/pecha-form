"""The organization TEMPLATE: what every booklet inherits or is seeded from.

Two arrangements that must not be confused, and are tested as opposites here:

  * the COPYRIGHT template is COPIED — adding a back cover writes the org's words into the
    booklet, which owns them from then on. Editing the template later changes what the NEXT
    booklet opens with and nothing already on a page.
  * the org IMAGE LIBRARY is INHERITED — a house keeps several, any page picks one, and the
    one marked `default_for` its kind stands in for every page that picks none. That default
    is what makes the library behave exactly as the single seal did for a booklet nobody has
    touched.
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


# ── The org image library ───────────────────────────────────────────────────

def _upload(name, data=b"PNGBYTES", default_for=""):
    """Insert straight into the table — the endpoint is async (UploadFile) and what these
    tests are about is the LIBRARY's behaviour, not multipart parsing."""
    conn = get_db()
    try:
        role = default_for or None
        if role:
            conn.execute("UPDATE org_images SET default_for = NULL "
                         "WHERE org_id = 1 AND default_for = ?", (role,))
        rid = conn.execute(
            "INSERT INTO org_images (org_id, name, mime, data, default_for) "
            "VALUES (1, ?, 'image/png', ?, ?)", (name, data, role)).lastrowid
        conn.commit()
        return rid
    finally:
        conn.close()


def _clear_images():
    conn = get_db()
    try:
        conn.execute("DELETE FROM org_images")
        conn.commit()
    finally:
        conn.close()


def test_a_house_may_keep_several_images_side_by_side():
    from app.routers.styles import list_org_images
    _clear_images()
    _upload("Order seal", default_for="cover")
    _upload("Centre logo")
    _upload("Colophon mark")
    lib = list_org_images(org_id=1)
    assert [i.name for i in lib] == ["Order seal", "Centre logo", "Colophon mark"]
    # Only one of them stands in for a page that picks nothing.
    assert [i.default_for for i in lib] == ["cover", None, None]


def test_claiming_a_default_takes_it_off_whoever_held_it():
    """At most one image per role, so a page that picks nothing has one answer, not two."""
    from app.routers.styles import list_org_images, patch_org_image, ImagePatch
    _clear_images()
    first = _upload("Order seal", default_for="cover")
    second = _upload("Centre logo")
    patch_org_image(second, ImagePatch(default_for="cover"), org_id=1)
    by_id = {i.id: i.default_for for i in list_org_images(org_id=1)}
    assert by_id[first] is None and by_id[second] == "cover"


def test_a_role_may_be_left_to_nobody():
    """A legitimate state: every page picks for itself and nothing stands in."""
    from app.routers.styles import list_org_images, patch_org_image, ImagePatch
    _clear_images()
    only = _upload("Order seal", default_for="cover")
    patch_org_image(only, ImagePatch(default_for=""), org_id=1)
    assert list_org_images(org_id=1)[0].default_for is None


def test_the_two_roles_are_independent():
    from app.routers.styles import list_org_images
    _clear_images()
    _upload("Order seal", default_for="cover")
    _upload("Colophon mark", default_for="backcover")
    assert sorted(i.default_for for i in list_org_images(org_id=1)) == ["backcover", "cover"]


def test_renaming_does_not_disturb_the_size():
    """`set_size` is why: a null width means "natural size", so a PATCH that only renames
    must not be read as a request to clear the size."""
    from app.routers.styles import list_org_images, patch_org_image, ImagePatch
    _clear_images()
    rid = _upload("Order seal")
    patch_org_image(rid, ImagePatch(width_mm=30.0, height_mm=None, set_size=True), org_id=1)
    patch_org_image(rid, ImagePatch(name="Renamed"), org_id=1)
    img = list_org_images(org_id=1)[0]
    assert img.name == "Renamed" and img.width_mm == 30.0


def test_an_unknown_role_is_refused():
    from fastapi import HTTPException
    from app.routers.styles import patch_org_image, ImagePatch
    _clear_images()
    rid = _upload("Order seal")
    try:
        patch_org_image(rid, ImagePatch(default_for="spine"), org_id=1)
        raise AssertionError("expected a 400")
    except HTTPException as e:
        assert e.status_code == 400


def test_deleting_an_image_releases_the_pages_that_picked_it():
    """A page whose picked image is gone falls back to the default for its kind — which is
    what a page that never picked anything already does, so a deletion leaves no hole."""
    from app.routers.styles import delete_org_image
    _clear_images()
    rid = _upload("Centre logo")
    conn = get_db()
    try:
        doc_id = _booklet(conn, langs=())
        item = conn.execute(
            "INSERT INTO document_items (document_id, position, kind, org_image_id) "
            "VALUES (?, 0, 'cover', ?)", (doc_id, rid)).lastrowid
        conn.commit()
    finally:
        conn.close()
    delete_org_image(rid)
    conn = get_db()
    try:
        assert conn.execute("SELECT org_image_id FROM document_items WHERE id = ?",
                            (item,)).fetchone()["org_image_id"] is None
    finally:
        conn.close()


def test_a_page_records_which_image_it_prints():
    from app.routers.documents import patch_item
    from app.schemas import DocumentItemPatch
    _clear_images()
    rid = _upload("Centre logo")
    conn = get_db()
    try:
        doc_id = _booklet(conn, langs=())
        item = conn.execute(
            "INSERT INTO document_items (document_id, position, kind) VALUES (?, 0, 'cover')",
            (doc_id,)).lastrowid
        conn.commit()
    finally:
        conn.close()
    assert patch_item(item, DocumentItemPatch(org_image_id=rid)).org_image_id == rid
    # 0 clears it back to the org's default for this kind of page.
    assert patch_item(item, DocumentItemPatch(org_image_id=0)).org_image_id is None


def test_the_org_layout_answers_a_whole_config():
    """A specimen with no booklet in hand lays itself out on this, so the six editable
    geometry fields are not enough — the type defaults must ride along."""
    from app.routers.styles import get_org_layout
    cfg = get_org_layout(org_id=1)
    for key in ("page_width_mm", "page_height_mm", "margin_top_mm", "margin_bottom_mm",
                "margin_bind_mm", "margin_outer_mm", "tibetan_pt", "phonetics_pt",
                "translation_pt", "leading"):
        assert key in cfg, key
