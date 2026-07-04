from fastapi import APIRouter, HTTPException
from typing import List
import json

from ..db import get_db
from ..schemas import SpanOut, SpanCreate, SpanUpdate
from ..syllable_anchors import anchor_for_range

router = APIRouter(prefix="/api", tags=["spans"])


def _serialize_span(d: dict) -> dict:
    return {
        "id": d["id"],
        "text_id": d["text_id"],
        "tag_id": d["tag_id"],
        "start_offset": d["start_offset"],
        "end_offset": d["end_offset"],
        "tag": {
            "id": d["tag_id"],
            "text_id": d["text_id"],
            "name": d["tag_name"],
            "color": d["tag_color"],
            "tag_kind": d["tag_kind"],
        },
    }


@router.get("/texts/{text_id}/spans", response_model=List[SpanOut])
def list_spans(text_id: int):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT s.*, t.name as tag_name, t.color as tag_color, t.tag_kind as tag_kind
        FROM spans s
        JOIN tags t ON s.tag_id = t.id
        WHERE s.text_id = ?
        ORDER BY s.start_offset ASC
        """,
        (text_id,),
    )
    results = [_serialize_span(dict(r)) for r in cursor.fetchall()]
    conn.close()
    return results


@router.post("/texts/{text_id}/spans", response_model=SpanOut)
def create_span(text_id: int, span: SpanCreate):
    """Create a span (an inline annotation). Spans may freely overlap any
    range — overlap and uniqueness are not enforced."""
    conn = get_db()
    cursor = conn.cursor()

    # Validate text + unit boundaries
    cursor.execute("SELECT units_json FROM texts WHERE id = ?", (text_id,))
    doc_row = cursor.fetchone()
    if not doc_row:
        conn.close()
        raise HTTPException(404, "Text not found")
    units = json.loads(doc_row["units_json"])
    unit_starts = {u[0] for u in units}
    unit_ends = {u[1] for u in units}
    if span.start_offset not in unit_starts or span.end_offset not in unit_ends:
        conn.close()
        raise HTTPException(400, "Span offsets do not align with token boundaries")

    # Validate tag belongs to the same text and is a regular tag.
    # Session tags don't use spans — they use their own open/close positions.
    cursor.execute("SELECT text_id, tag_kind FROM tags WHERE id = ?", (span.tag_id,))
    tag_row = cursor.fetchone()
    if not tag_row:
        conn.close()
        raise HTTPException(404, "Tag not found")
    if tag_row["text_id"] != text_id:
        conn.close()
        raise HTTPException(400, "Tag belongs to a different text")
    if tag_row["tag_kind"] != 'regular':
        conn.close()
        raise HTTPException(400, "Spans can only be created for regular tags")

    # Phase 3 E4: anchor on syllable UUIDs at create time (offsets stay primary).
    start_syl_id, end_syl_id = anchor_for_range(conn, text_id, span.start_offset, span.end_offset)
    cursor.execute(
        "INSERT INTO spans (text_id, tag_id, start_offset, end_offset, start_syl_id, end_syl_id) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (text_id, span.tag_id, span.start_offset, span.end_offset, start_syl_id, end_syl_id),
    )
    span_id = cursor.lastrowid
    conn.commit()

    cursor.execute(
        """
        SELECT s.*, t.name as tag_name, t.color as tag_color, t.tag_kind as tag_kind
        FROM spans s
        JOIN tags t ON s.tag_id = t.id
        WHERE s.id = ?
        """,
        (span_id,),
    )
    span_dict = _serialize_span(dict(cursor.fetchone()))
    conn.close()
    return span_dict


@router.patch("/spans/{span_id}", response_model=SpanOut)
def update_span(span_id: int, payload: SpanUpdate):
    """Update a span. Currently only `tag_id` may change."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT s.*, t.name as tag_name, t.color as tag_color, t.tag_kind as tag_kind
        FROM spans s
        JOIN tags t ON s.tag_id = t.id
        WHERE s.id = ?
        """,
        (span_id,),
    )
    existing = cursor.fetchone()
    if not existing:
        conn.close()
        raise HTTPException(404, "Span not found")

    provided = payload.model_dump(exclude_unset=True)

    if "tag_id" in provided and payload.tag_id is not None and payload.tag_id != existing["tag_id"]:
        cursor.execute(
            "SELECT id, text_id, tag_kind FROM tags WHERE id = ?",
            (payload.tag_id,),
        )
        new_tag = cursor.fetchone()
        if not new_tag:
            conn.close()
            raise HTTPException(404, "Tag not found")
        if new_tag["text_id"] != existing["text_id"]:
            conn.close()
            raise HTTPException(400, "Tag belongs to a different text")
        if new_tag["tag_kind"] != 'regular':
            conn.close()
            raise HTTPException(400, "Spans can only point to regular tags")
        cursor.execute(
            "UPDATE spans SET tag_id = ? WHERE id = ?",
            (payload.tag_id, span_id),
        )
        conn.commit()

    cursor.execute(
        """
        SELECT s.*, t.name as tag_name, t.color as tag_color, t.tag_kind as tag_kind
        FROM spans s
        JOIN tags t ON s.tag_id = t.id
        WHERE s.id = ?
        """,
        (span_id,),
    )
    span_dict = _serialize_span(dict(cursor.fetchone()))
    conn.close()
    return span_dict


@router.delete("/spans/{span_id}")
def delete_span(span_id: int):
    """Delete a span. Spans no longer participate in tree-node linking, so
    deletion is unconditional — referencing tree nodes no longer exist."""
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT id FROM spans WHERE id = ?", (span_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(404, "Span not found")

    cursor.execute("DELETE FROM spans WHERE id = ?", (span_id,))
    conn.commit()
    conn.close()
    return {"status": "ok"}
