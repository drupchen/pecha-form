from fastapi import APIRouter, HTTPException
from typing import List
import sqlite3

from ..db import get_db
from ..schemas import TagOut, TagCreate, TagUpdate
from ..syllable_anchors import anchor_for_point, anchor_for_close

router = APIRouter(prefix="/api", tags=["tags"])


@router.get("/texts/{text_id}/tags", response_model=List[TagOut])
def list_tags(text_id: int):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM tags WHERE text_id = ?", (text_id,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]


@router.post("/texts/{text_id}/tags", response_model=TagOut)
def create_tag(text_id: int, tag: TagCreate):
    conn = get_db()
    cursor = conn.cursor()

    # Unique name per doc
    cursor.execute("SELECT id FROM tags WHERE text_id = ? AND name = ?", (text_id, tag.name))
    if cursor.fetchone():
        conn.close()
        raise HTTPException(400, "Tag name already exists for this text")

    if tag.tag_kind not in ('regular', 'session'):
        conn.close()
        raise HTTPException(400, "tag_kind must be 'regular' or 'session'")

    # Session-only fields are ignored for regular tags.
    open_pos = tag.open_position if tag.tag_kind == 'session' else None
    close_pos = tag.close_position if tag.tag_kind == 'session' else None
    if open_pos is not None and close_pos is not None and open_pos >= close_pos:
        conn.close()
        raise HTTPException(400, "open_position must be less than close_position")

    # Phase 3 E4: anchor session open/close on the syllables at those boundaries.
    open_syl = anchor_for_point(conn, text_id, open_pos) if open_pos is not None else None
    close_syl = anchor_for_close(conn, text_id, close_pos) if close_pos is not None else None
    try:
        cursor.execute(
            "INSERT INTO tags (text_id, name, color, tag_kind, open_position, close_position, open_syl_id, close_syl_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (text_id, tag.name, tag.color, tag.tag_kind, open_pos, close_pos, open_syl, close_syl),
        )
        tag_id = cursor.lastrowid
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(400, "Integrity error")

    cursor.execute("SELECT * FROM tags WHERE id = ?", (tag_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row)


@router.patch("/tags/{tag_id}", response_model=TagOut)
def update_tag(tag_id: int, tag: TagUpdate):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM tags WHERE id = ?", (tag_id,))
    existing = cursor.fetchone()
    if not existing:
        conn.close()
        raise HTTPException(404, "Tag not found")

    provided = tag.model_dump(exclude_unset=True)

    new_name = tag.name if 'name' in provided and tag.name is not None else existing["name"]
    new_color = tag.color if 'color' in provided and tag.color is not None else existing["color"]
    new_open = tag.open_position if 'open_position' in provided else existing["open_position"]
    new_close = tag.close_position if 'close_position' in provided else existing["close_position"]

    if new_name != existing["name"]:
        cursor.execute(
            "SELECT id FROM tags WHERE text_id = ? AND name = ? AND id != ?",
            (existing["text_id"], new_name, tag_id),
        )
        if cursor.fetchone():
            conn.close()
            raise HTTPException(400, "Tag name already exists")

    if new_open is not None and new_close is not None and new_open >= new_close:
        conn.close()
        raise HTTPException(400, "open_position must be less than close_position")

    # Phase 3 E4: keep the syllable anchors in sync with open/close positions.
    doc_id = existing["text_id"]
    new_open_syl = anchor_for_point(conn, doc_id, new_open) if new_open is not None else None
    new_close_syl = anchor_for_close(conn, doc_id, new_close) if new_close is not None else None
    cursor.execute(
        "UPDATE tags SET name = ?, color = ?, open_position = ?, close_position = ?, "
        "open_syl_id = ?, close_syl_id = ? WHERE id = ?",
        (new_name, new_color, new_open, new_close, new_open_syl, new_close_syl, tag_id),
    )
    conn.commit()
    cursor.execute("SELECT * FROM tags WHERE id = ?", (tag_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row)


@router.delete("/tags/{tag_id}")
def delete_tag(tag_id: int):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    if not deleted:
        raise HTTPException(404, "Tag not found")
    return {"status": "ok"}
