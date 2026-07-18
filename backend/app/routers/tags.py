from fastapi import APIRouter, HTTPException
from typing import List
import sqlite3

from ..auth import active_org_id
from ..db import get_db
from ..schemas import TagOut, TagCreate, TagUpdate
from ..syllable_anchors import anchor_for_point, anchor_for_close, _syl_offset_maps

router = APIRouter(prefix="/api", tags=["tags"])


def _serialize_tag(d: dict, id2start: dict, id2end: dict) -> dict:
    # Part 6, Phase 3: open/close positions are DERIVED from the syllable anchors
    # (the stored open_position/close_position columns were dropped) — a frontend aid.
    osyl, csyl = d.get("open_syl_id"), d.get("close_syl_id")
    d["open_position"] = id2start.get(osyl) if osyl is not None else None
    d["close_position"] = id2end.get(csyl) if csyl is not None else None
    # Part 8: a NULL owner means the tag is shared across every text's palette.
    d["is_shared"] = d.get("text_id") is None
    return d


@router.get("/texts/{text_id}/tags", response_model=List[TagOut])
def list_tags(text_id: int):
    conn = get_db()
    cursor = conn.cursor()
    # Part 8: a text's palette = its own private tags + every shared (NULL owner) tag.
    # Shared means shared within the ORG — never across organizations.
    cursor.execute(
        "SELECT * FROM tags WHERE text_id = ? OR (text_id IS NULL AND org_id = ?)",
        (text_id, active_org_id())
    )
    rows = [dict(r) for r in cursor.fetchall()]
    id2start, id2end = _syl_offset_maps(conn, text_id)
    conn.close()
    return [_serialize_tag(r, id2start, id2end) for r in rows]


@router.post("/texts/{text_id}/tags", response_model=TagOut)
def create_tag(text_id: int, tag: TagCreate):
    conn = get_db()
    cursor = conn.cursor()

    # Unique name within this text's visible palette — its own private tags plus every
    # shared (NULL owner) tag (Part 8), so a new private tag can't collide with a shared one.
    cursor.execute(
        "SELECT id FROM tags WHERE (text_id = ? OR (text_id IS NULL AND org_id = ?)) "
        "AND name = ?",
        (text_id, active_org_id(), tag.name),
    )
    if cursor.fetchone():
        conn.close()
        raise HTTPException(400, "Tag name already exists for this text")

    if tag.tag_kind not in ('regular', 'session'):
        conn.close()
        raise HTTPException(400, "tag_kind must be 'regular' or 'session'")

    id2start, id2end = _syl_offset_maps(conn, text_id)

    # Session-only boundaries. Part 6: anchor by syllable UUID. Prefer the syllable id
    # (existence is the boundary check); the legacy offset path maps the offset back to
    # a syllable via the syllables table. Regular tags carry no boundaries.
    open_syl = close_syl = None
    if tag.tag_kind == 'session':
        if tag.open_syl_id is not None:
            if tag.open_syl_id not in id2start:
                conn.close()
                raise HTTPException(400, f"open_syl_id {tag.open_syl_id!r} not in text {text_id}")
            open_syl = tag.open_syl_id
        elif tag.open_position is not None:
            open_syl = anchor_for_point(conn, text_id, tag.open_position)
            if open_syl is None:
                conn.close()
                raise HTTPException(400, "open_position must fall on a syllable boundary")
        if tag.close_syl_id is not None:
            if tag.close_syl_id not in id2end:
                conn.close()
                raise HTTPException(400, f"close_syl_id {tag.close_syl_id!r} not in text {text_id}")
            close_syl = tag.close_syl_id
        elif tag.close_position is not None:
            close_syl = anchor_for_close(conn, text_id, tag.close_position)
            if close_syl is None:
                conn.close()
                raise HTTPException(400, "close_position must fall on a syllable boundary")

    open_pos = id2start.get(open_syl) if open_syl is not None else None
    close_pos = id2end.get(close_syl) if close_syl is not None else None
    if open_pos is not None and close_pos is not None and open_pos >= close_pos:
        conn.close()
        raise HTTPException(400, "open_position must be less than close_position")
    try:
        cursor.execute(
            "INSERT INTO tags (org_id, text_id, name, color, tag_kind, open_syl_id, close_syl_id) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (active_org_id(), text_id, tag.name, tag.color, tag.tag_kind, open_syl, close_syl),
        )
        tag_id = cursor.lastrowid
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        raise HTTPException(400, "Integrity error")

    cursor.execute("SELECT * FROM tags WHERE id = ?", (tag_id,))
    row = dict(cursor.fetchone())
    conn.close()
    return _serialize_tag(row, id2start, id2end)


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

    doc_id = existing["text_id"]
    id2start, id2end = _syl_offset_maps(conn, doc_id)
    new_name = tag.name if 'name' in provided and tag.name is not None else existing["name"]
    new_color = tag.color if 'color' in provided and tag.color is not None else existing["color"]

    # Part 6: resolve the open/close boundaries to syllable ids (the stored anchor).
    # A syllable id (when sent) is authoritative; explicit None on either field clears
    # the boundary; the legacy offset field maps back to a syllable via the syllables
    # table; absent leaves the existing anchor untouched.
    try:
        if 'open_syl_id' in provided:
            new_open_syl = tag.open_syl_id
            if new_open_syl is not None and new_open_syl not in id2start:
                raise ValueError(f"open_syl_id {new_open_syl!r} not in text {doc_id}")
        elif 'open_position' in provided:
            new_open_syl = (anchor_for_point(conn, doc_id, tag.open_position)
                            if tag.open_position is not None else None)
            if tag.open_position is not None and new_open_syl is None:
                raise ValueError("open_position must fall on a syllable boundary")
        else:
            new_open_syl = existing["open_syl_id"]

        if 'close_syl_id' in provided:
            new_close_syl = tag.close_syl_id
            if new_close_syl is not None and new_close_syl not in id2end:
                raise ValueError(f"close_syl_id {new_close_syl!r} not in text {doc_id}")
        elif 'close_position' in provided:
            new_close_syl = (anchor_for_close(conn, doc_id, tag.close_position)
                             if tag.close_position is not None else None)
            if tag.close_position is not None and new_close_syl is None:
                raise ValueError("close_position must fall on a syllable boundary")
        else:
            new_close_syl = existing["close_syl_id"]
    except ValueError as e:
        conn.close()
        raise HTTPException(400, str(e))

    # Part 8: resolve the share toggle → the tag's new owner. is_shared=True makes it
    # global (text_id NULL); False makes it private to the supplied text. Only regular
    # tags may be shared (session tags carry per-text syllable anchors).
    new_text_id = existing["text_id"]
    if 'is_shared' in provided and tag.is_shared is not None:
        if existing["tag_kind"] == 'session':
            conn.close()
            raise HTTPException(400, "Session tags cannot be shared")
        if tag.is_shared:
            new_text_id = None
        else:
            if tag.text_id is None:
                conn.close()
                raise HTTPException(400, "text_id is required to make a tag private")
            new_text_id = tag.text_id

    # Name must stay unique within the destination scope (re-checked on rename OR reshare):
    # a shared tag among all shared tags; a private tag within its text's visible palette
    # (its own private tags + every shared tag).
    if new_name != existing["name"] or new_text_id != existing["text_id"]:
        if new_text_id is None:
            # A shared tag shows in every palette OF ITS ORG, so its name must be
            # unique across all of the org's tags (private ones included).
            cursor.execute(
                "SELECT id FROM tags WHERE org_id = ? AND name = ? AND id != ?",
                (existing["org_id"], new_name, tag_id),
            )
        else:
            cursor.execute(
                "SELECT id FROM tags WHERE (text_id = ? OR (text_id IS NULL AND org_id = ?)) "
                "AND name = ? AND id != ?",
                (new_text_id, existing["org_id"], new_name, tag_id),
            )
        if cursor.fetchone():
            conn.close()
            raise HTTPException(400, "Tag name already exists")

    new_open = id2start.get(new_open_syl) if new_open_syl is not None else None
    new_close = id2end.get(new_close_syl) if new_close_syl is not None else None
    if new_open is not None and new_close is not None and new_open >= new_close:
        conn.close()
        raise HTTPException(400, "open_position must be less than close_position")

    cursor.execute(
        "UPDATE tags SET text_id = ?, name = ?, color = ?, open_syl_id = ?, close_syl_id = ? WHERE id = ?",
        (new_text_id, new_name, new_color, new_open_syl, new_close_syl, tag_id),
    )
    conn.commit()
    cursor.execute("SELECT * FROM tags WHERE id = ?", (tag_id,))
    row = dict(cursor.fetchone())
    conn.close()
    return _serialize_tag(row, id2start, id2end)


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
