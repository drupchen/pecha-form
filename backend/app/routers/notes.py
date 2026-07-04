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
from ..syllable_anchors import anchor_for_range

router = APIRouter(prefix="/api", tags=["notes"])


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
    "n.start_offset, n.end_offset, n.body, n.created_at, n.updated_at "
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
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        f"{NOTE_SELECT} WHERE n.text_id = ? "
        "ORDER BY n.start_offset ASC, n.created_at ASC",
        (text_id,),
    )
    rows = [dict(r) for r in cursor.fetchall()]
    # Batch-fetch all session links for this text and join in Python to
    # avoid N+1 queries.
    cursor.execute(
        "SELECT ns.note_id, ns.tag_id, t.name "
        "FROM note_sessions ns "
        "JOIN notes n ON ns.note_id = n.id "
        "JOIN tags t ON ns.tag_id = t.id "
        "WHERE n.text_id = ? "
        "ORDER BY t.name",
        (text_id,),
    )
    by_note: dict = {}
    for r in cursor.fetchall():
        ids_names = by_note.setdefault(r["note_id"], ([], []))
        ids_names[0].append(r["tag_id"])
        ids_names[1].append(r["name"])
    for row in rows:
        ids, names = by_note.get(row["id"], ([], []))
        row["session_tag_ids"] = ids
        row["session_tag_names"] = names
    conn.close()
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

    # Phase 3 E4: anchor on syllable UUIDs at create time (offsets stay primary).
    start_syl_id, end_syl_id = anchor_for_range(conn, text_id, payload.start_offset, payload.end_offset)
    cursor.execute(
        "INSERT INTO notes (text_id, category_id, start_offset, end_offset, body, start_syl_id, end_syl_id) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            text_id,
            payload.category_id,
            payload.start_offset,
            payload.end_offset,
            payload.body,
            start_syl_id,
            end_syl_id,
        ),
    )
    new_id = cursor.lastrowid
    _replace_note_sessions(cursor, new_id, payload.session_tag_ids)
    conn.commit()
    cursor.execute(f"{NOTE_SELECT} WHERE n.id = ?", (new_id,))
    row = _hydrate_note_row(cursor, dict(cursor.fetchone()))
    conn.close()
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
    row = _hydrate_note_row(cursor, dict(cursor.fetchone()))
    conn.close()
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
