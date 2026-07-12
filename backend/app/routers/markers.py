from fastapi import APIRouter, HTTPException
from typing import List

from ..db import get_db
from ..inherit import source_texts
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
    """Segment boundaries applicable to this text: its OWN markers plus those
    INHERITED from the source chain (parent + transclusion sources), resolved onto
    this text's composed stream. A source boundary applies wherever its anchor
    syllable appears here — so re-segmenting a primary ripples into every secondary
    live (the child no longer carries a frozen copy). Deduped by anchor: the child's
    own boundary at a position shadows an inherited one (and stays editable)."""
    conn = get_db()
    cursor = conn.cursor()
    id2start, id2end = _syl_offset_maps(conn, text_id)
    total_len = max(id2end.values(), default=0)
    by_key: dict = {}
    for origin in [text_id] + source_texts(cursor, text_id):
        inherited = origin != text_id
        for r in cursor.execute("SELECT * FROM markers WHERE text_id = ?", (origin,)).fetchall():
            syl = r["syl_id"]
            # Applies only if the anchor resolves in THIS stream (a dead/foreign
            # anchor is skipped — the graceful dangling floor).
            if syl is not None and syl not in id2start:
                continue
            key = syl if syl is not None else "__end__"
            if key in by_key and not by_key[key]["inherited"]:
                continue  # the child's own boundary already claims this position
            by_key[key] = {
                "id": r["id"], "text_id": text_id, "syl_id": syl,
                "position": _position_for(syl, id2start, total_len),
                "inherited": inherited,
            }
    conn.close()
    return sorted(by_key.values(), key=lambda d: d["position"])


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
