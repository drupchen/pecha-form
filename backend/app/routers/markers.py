from fastapi import APIRouter, HTTPException
from typing import List

from ..db import get_db
from ..schemas import MarkerOut, MarkerCreate
from ..syllable_anchors import anchor_for_point, offset_for_syl_start, _syl_offset_maps

router = APIRouter(prefix="/api", tags=["markers"])


def _position_for(syl_id, id2start, total_len):
    # Derive the marker position (a frontend render aid) from its syllable anchor.
    # syl_id NULL is the end-of-text sentinel → position at the end of the text.
    if syl_id is None:
        return total_len
    return id2start.get(syl_id, total_len)


@router.get("/texts/{text_id}/markers", response_model=List[MarkerOut])
def list_markers(text_id: int):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM markers WHERE text_id = ?", (text_id,))
    id2start, id2end = _syl_offset_maps(conn, text_id)
    total_len = max(id2end.values(), default=0)
    rows = []
    for r in cursor.fetchall():
        d = dict(r)
        # A marker whose (non-sentinel) anchor no longer resolves — its syllable was
        # baked away by apply-corrections — is dangling: skip it rather than render a
        # stray separator at the end of the text.
        if d.get("syl_id") is not None and d["syl_id"] not in id2start:
            continue
        d["position"] = _position_for(d.get("syl_id"), id2start, total_len)
        rows.append(d)
    conn.close()
    rows.sort(key=lambda d: d["position"])
    return rows


@router.post("/texts/{text_id}/markers", response_model=MarkerOut)
def create_marker(text_id: int, marker: MarkerCreate):
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT id FROM texts WHERE id = ?", (text_id,))
    if not cursor.fetchone():
        conn.close()
        raise HTTPException(404, "Text not found")

    # Part 6: a marker is anchored by the syllable it precedes. Prefer the syllable id
    # the frontend clicked (existence is the boundary check); the legacy offset path
    # maps the offset back to a syllable start via the syllables table. syl_id=None is
    # the end-of-text sentinel.
    if marker.syl_id is not None:
        try:
            offset_for_syl_start(conn, text_id, marker.syl_id)
        except ValueError as e:
            conn.close()
            raise HTTPException(400, str(e))
        syl_id = marker.syl_id
    else:
        if marker.position is None:
            conn.close()
            raise HTTPException(400, "syl_id or position required")
        syl_id = anchor_for_point(conn, text_id, marker.position)
        if syl_id is None:
            conn.close()
            raise HTTPException(400, "Marker position must fall on a syllable boundary")

    try:
        cursor.execute(
            "INSERT INTO markers (text_id, syl_id) VALUES (?, ?)",
            (text_id, syl_id),
        )
        marker_id = cursor.lastrowid
        conn.commit()
    except Exception:
        conn.close()
        raise HTTPException(409, "A marker already exists at this position")

    id2start, id2end = _syl_offset_maps(conn, text_id)
    position = _position_for(syl_id, id2start, max(id2end.values(), default=0))
    conn.close()
    return {"id": marker_id, "text_id": text_id, "position": position, "syl_id": syl_id}


@router.delete("/markers/{marker_id}")
def delete_marker(marker_id: int):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM markers WHERE id = ?", (marker_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    if not deleted:
        raise HTTPException(404, "Marker not found")
    return {"status": "ok"}
