from fastapi import APIRouter, HTTPException
from typing import List
import json

from ..db import get_db
from ..schemas import MarkerOut, MarkerCreate
from ..syllable_anchors import anchor_for_point

router = APIRouter(prefix="/api", tags=["markers"])


@router.get("/texts/{text_id}/markers", response_model=List[MarkerOut])
def list_markers(text_id: int):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM markers WHERE text_id = ? ORDER BY position ASC",
        (text_id,)
    )
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


@router.post("/texts/{text_id}/markers", response_model=MarkerOut)
def create_marker(text_id: int, marker: MarkerCreate):
    conn = get_db()
    cursor = conn.cursor()

    cursor.execute("SELECT units_json FROM texts WHERE id = ?", (text_id,))
    doc_row = cursor.fetchone()
    if not doc_row:
        conn.close()
        raise HTTPException(404, "Text not found")

    units = json.loads(doc_row["units_json"])
    # Accept any unit boundary (start or end). This allows position 0 ("before first syllable").
    unit_boundaries = {u[0] for u in units} | {u[1] for u in units}

    if marker.position not in unit_boundaries:
        conn.close()
        raise HTTPException(400, "Marker position must fall on a unit-end boundary")

    try:
        # Phase 3 E4: anchor on the syllable that starts at this position.
        syl_id = anchor_for_point(conn, text_id, marker.position)
        cursor.execute(
            "INSERT INTO markers (text_id, position, syl_id) VALUES (?, ?, ?)",
            (text_id, marker.position, syl_id)
        )
        marker_id = cursor.lastrowid
        conn.commit()
    except Exception:
        conn.close()
        raise HTTPException(409, "A marker already exists at this position")

    conn.close()
    return {"id": marker_id, "text_id": text_id, "position": marker.position}


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
