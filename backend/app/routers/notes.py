from fastapi import APIRouter, HTTPException
from typing import List, Tuple

from ..db import get_db
from ..schemas import (
    NoteOut,
    NoteCreate,
    NoteUpdate,
    NoteCategoryOut,
    NoteCategoryCreate,
)
from ..syllable_anchors import anchor_for_range, _syl_offset_maps

router = APIRouter(prefix="/api", tags=["notes"])


def _derive_note_offsets(row: dict, id2start: dict, id2end: dict):
    # Part 6, Phase 3: note offsets are DERIVED from the syllable anchors (stored
    # start_offset/end_offset columns dropped) — a frontend render aid. A note whose
    # anchors no longer resolve (content baked away by apply-corrections) is dangling:
    # return None so list callers skip it.
    start = id2start.get(row.get("start_syl_id"))
    end = id2end.get(row.get("end_syl_id"))
    if start is None or end is None:
        return None
    row["start_offset"] = start
    row["end_offset"] = end
    return row


# ─── Categories ───────────────────────────────────────────────────────────────

@router.get(
    "/texts/{text_id}/note-categories",
    response_model=List[NoteCategoryOut],
)
def list_note_categories(text_id: int):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM note_categories WHERE text_id = ? ORDER BY name ASC",
        (text_id,),
    )
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


@router.post(
    "/texts/{text_id}/note-categories",
    response_model=NoteCategoryOut,
)
def create_note_category(text_id: int, payload: NoteCategoryCreate):
    name = payload.name.strip()
    if not name:
        raise HTTPException(400, "Category name cannot be empty")

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM texts WHERE id = ?", (text_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(404, "Text not found")

    try:
        cursor.execute(
            "INSERT INTO note_categories (text_id, name) VALUES (?, ?)",
            (text_id, name),
        )
    except Exception:
        conn.close()
        raise HTTPException(409, "Category with this name already exists")

    new_id = cursor.lastrowid
    conn.commit()
    cursor.execute("SELECT * FROM note_categories WHERE id = ?", (new_id,))
    row = dict(cursor.fetchone())
    conn.close()
    return row


@router.delete("/note-categories/{category_id}")
def delete_note_category(category_id: int):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM note_categories WHERE id = ?", (category_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    if not deleted:
        raise HTTPException(404, "Category not found")
    return {"status": "ok"}


# ─── Notes ────────────────────────────────────────────────────────────────────

NOTE_SELECT = (
    "SELECT n.id, n.text_id, n.category_id, c.name AS category_name, "
    "n.start_syl_id, n.end_syl_id, n.passage_id, n.body, n.created_at, n.updated_at "
    "FROM notes n LEFT JOIN note_categories c ON n.category_id = c.id"
)


def _validate_session_tags(cursor, tag_ids: List[int], text_id: int) -> None:
    if not tag_ids:
        return
    placeholders = ",".join("?" * len(tag_ids))
    cursor.execute(
        f"SELECT id FROM tags WHERE id IN ({placeholders}) "
        f"AND text_id = ? AND tag_kind = 'session'",
        (*tag_ids, text_id),
    )
    found = {r["id"] for r in cursor.fetchall()}
    missing = sorted(set(tag_ids) - found)
    if missing:
        raise HTTPException(
            400, f"Session tags not found for this text: {missing}"
        )


def _replace_note_sessions(cursor, note_id: int, tag_ids: List[int]) -> None:
    cursor.execute("DELETE FROM note_sessions WHERE note_id = ?", (note_id,))
    if tag_ids:
        cursor.executemany(
            "INSERT INTO note_sessions (note_id, tag_id) VALUES (?, ?)",
            [(note_id, tid) for tid in tag_ids],
        )


def _get_note_sessions(cursor, note_id: int) -> Tuple[List[int], List[str]]:
    cursor.execute(
        "SELECT ns.tag_id, t.name FROM note_sessions ns "
        "JOIN tags t ON ns.tag_id = t.id "
        "WHERE ns.note_id = ? ORDER BY t.name",
        (note_id,),
    )
    rows = cursor.fetchall()
    return [r["tag_id"] for r in rows], [r["name"] for r in rows]


def _hydrate_note_row(cursor, row: dict) -> dict:
    ids, names = _get_note_sessions(cursor, row["id"])
    row["session_tag_ids"] = ids
    row["session_tag_names"] = names
    return row


@router.get("/texts/{text_id}/notes", response_model=List[NoteOut])
def list_notes(text_id: int):
    """This text's own notes plus those INHERITED from the source chain, resolved
    onto this text's stream (a source note applies where its anchor syllables appear
    here). Own notes shadow an inherited note on the same range."""
    from ..inherit import source_texts
    conn = get_db()
    cursor = conn.cursor()
    id2start, id2end = _syl_offset_maps(conn, text_id)
    rows = []
    emitted = set()
    for origin in [text_id] + source_texts(cursor, text_id):
        inherited = origin != text_id
        cursor.execute(f"{NOTE_SELECT} WHERE n.text_id = ?", (origin,))
        for r in cursor.fetchall():
            d = _derive_note_offsets(dict(r), id2start, id2end)
            if d is None:  # anchors don't resolve in this stream
                continue
            key = (d["start_offset"], d["end_offset"], d.get("passage_id"))
            # OWN notes always render (several notes may share a span); an INHERITED
            # note is suppressed only when one already covers the same span here.
            if inherited and key in emitted:
                continue
            emitted.add(key)
            d["text_id"] = text_id
            d["inherited"] = inherited
            rows.append(d)
    # Batch-fetch session links for all gathered notes (by id, spanning origins).
    note_ids = [r["id"] for r in rows]
    by_note: dict = {}
    if note_ids:
        cursor.execute(
            f"SELECT ns.note_id, ns.tag_id, t.name FROM note_sessions ns "
            f"JOIN tags t ON ns.tag_id = t.id "
            f"WHERE ns.note_id IN ({','.join('?' * len(note_ids))}) ORDER BY t.name",
            note_ids,
        )
        for r in cursor.fetchall():
            ids_names = by_note.setdefault(r["note_id"], ([], []))
            ids_names[0].append(r["tag_id"])
            ids_names[1].append(r["name"])
    for row in rows:
        ids, names = by_note.get(row["id"], ([], []))
        row["session_tag_ids"] = ids
        row["session_tag_names"] = names
    conn.close()
    rows.sort(key=lambda r: (r["start_offset"], r.get("created_at") or ""))
    return rows


@router.post("/texts/{text_id}/notes", response_model=NoteOut)
def create_note(text_id: int, payload: NoteCreate):
    if payload.start_offset >= payload.end_offset:
        raise HTTPException(400, "start_offset must be < end_offset")

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM texts WHERE id = ?", (text_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(404, "Text not found")

    if payload.category_id is not None:
        cursor.execute(
            "SELECT id FROM note_categories WHERE id = ? AND text_id = ?",
            (payload.category_id, text_id),
        )
        if not cursor.fetchone():
            conn.close()
            raise HTTPException(404, "Category not found for this text")

    try:
        _validate_session_tags(cursor, payload.session_tag_ids, text_id)
    except HTTPException:
        conn.close()
        raise

    # Part 6, Phase 3: the payload is offset-based; map it back to syllable anchors via
    # the syllables table (off-grid offsets are rejected) and store only the anchors.
    start_syl_id, end_syl_id = anchor_for_range(
        conn, text_id, payload.start_offset, payload.end_offset
    )
    if start_syl_id is None or end_syl_id is None:
        conn.close()
        raise HTTPException(400, "Note offsets must align with syllable boundaries")
    # A note with passage_id targets THAT passage occurrence only (the anchors are the
    # shared source syllables; the passage id scopes where it renders).
    if payload.passage_id is not None:
        cursor.execute(
            "SELECT 1 FROM passages WHERE id = ? AND text_id = ?",
            (payload.passage_id, text_id),
        )
        if not cursor.fetchone():
            conn.close()
            raise HTTPException(404, "Passage not found in this text")
    cursor.execute(
        "INSERT INTO notes (text_id, category_id, body, start_syl_id, end_syl_id, passage_id) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (text_id, payload.category_id, payload.body, start_syl_id, end_syl_id, payload.passage_id),
    )
    new_id = cursor.lastrowid
    _replace_note_sessions(cursor, new_id, payload.session_tag_ids)
    conn.commit()
    cursor.execute(f"{NOTE_SELECT} WHERE n.id = ?", (new_id,))
    id2start, id2end = _syl_offset_maps(conn, text_id)
    row = _derive_note_offsets(
        _hydrate_note_row(cursor, dict(cursor.fetchone())), id2start, id2end
    )
    conn.close()
    if row is None:  # unreachable: anchors were just validated
        raise HTTPException(409, "Note anchors do not resolve in this text")
    return row


@router.patch("/notes/{note_id}", response_model=NoteOut)
def update_note(note_id: int, payload: NoteUpdate):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM notes WHERE id = ?", (note_id,))
    existing = cursor.fetchone()
    if not existing:
        conn.close()
        raise HTTPException(404, "Note not found")

    fields = payload.model_dump(exclude_unset=True)

    if "category_id" in fields and fields["category_id"] is not None:
        cursor.execute(
            "SELECT id FROM note_categories WHERE id = ? AND text_id = ?",
            (fields["category_id"], existing["text_id"]),
        )
        if not cursor.fetchone():
            conn.close()
            raise HTTPException(404, "Category not found for this text")

    if "session_tag_ids" in fields:
        try:
            _validate_session_tags(
                cursor, fields["session_tag_ids"], existing["text_id"]
            )
        except HTTPException:
            conn.close()
            raise

    sets = []
    values: list = []
    for key in ("category_id", "body"):
        if key in fields:
            sets.append(f"{key} = ?")
            values.append(fields[key])

    if sets:
        sets.append("updated_at = CURRENT_TIMESTAMP")
        values.append(note_id)
        cursor.execute(f"UPDATE notes SET {', '.join(sets)} WHERE id = ?", values)

    if "session_tag_ids" in fields:
        _replace_note_sessions(cursor, note_id, fields["session_tag_ids"])

    conn.commit()
    cursor.execute(f"{NOTE_SELECT} WHERE n.id = ?", (note_id,))
    id2start, id2end = _syl_offset_maps(conn, existing["text_id"])
    row = _derive_note_offsets(
        _hydrate_note_row(cursor, dict(cursor.fetchone())), id2start, id2end
    )
    conn.close()
    if row is None:  # note's content was baked away — it no longer renders
        raise HTTPException(409, "Note anchors no longer resolve in this text")
    return row


@router.delete("/notes/{note_id}")
def delete_note(note_id: int):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM notes WHERE id = ?", (note_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    if not deleted:
        raise HTTPException(404, "Note not found")
    return {"status": "ok"}
