from fastapi import APIRouter, HTTPException
from typing import List
import json

from ..db import get_db
from ..schemas import SuggestionOut, SuggestionCreate
from ..syllable_anchors import anchor_for_range

router = APIRouter(prefix="/api", tags=["suggestions"])


def _validate_unit_boundaries(units: list, start: int, end: int) -> None:
    """Both offsets must align with tokenizer units. start == end is allowed (insertion)."""
    starts = {u[0] for u in units}
    ends = {u[1] for u in units}
    if start == end:
        # Pure insertion: offset must be a known unit boundary (start or end).
        if start not in starts and start not in ends and start != 0:
            raise HTTPException(400, "Suggestion offset must align with a unit boundary")
    else:
        if start not in starts:
            raise HTTPException(400, "Suggestion start_offset must align with a unit boundary")
        if end not in ends:
            raise HTTPException(400, "Suggestion end_offset must align with a unit boundary")


def _validate_no_boundary_straddle(
    cursor, text_id: int, start: int, end: int, suggested_text: str = "x"
) -> None:
    """Reject suggestions that cross a segment boundary (marker position).

    Pure insertions exactly on a boundary are allowed. A pure deletion
    (``suggested_text == ""``) is also allowed to span markers: "delete a section"
    may cover several segments — only the text is removed, the markers themselves are
    untouched. Replacements still must lie within a single segment.
    """
    if start == end or suggested_text == "":
        return  # insertion or pure deletion — boundary OK
    cursor.execute(
        "SELECT position FROM markers WHERE text_id = ?",
        (text_id,),
    )
    for row in cursor.fetchall():
        pos = row["position"]
        if start < pos < end:
            raise HTTPException(
                400, "Suggestion must lie within a single segment"
            )


def _check_overlap(
    cursor, text_id: int, start: int, end: int,
    exclude_id: int | None = None,
) -> None:
    """Reject a new suggestion that conflicts with an existing one (strict writer).

    The applier tolerates a zero-width insertion *adjacent* to a region, but to keep the
    correction set clean we forbid creating one that *touches* a region at all: an
    insertion is rejected when its point lies in the closed span ``[start, end]`` of a
    positive-width edit (boundary or interior), or coincides with another insertion.
    Symmetrically, a positive-width edit is rejected when it overlaps another region or
    closes over an existing insertion point.
    """
    if start == end:  # insertion
        cursor.execute(
            "SELECT id FROM suggestions WHERE text_id = ? AND ("
            "  (start_offset = ? AND end_offset = ?)"               # coincident insertion
            "  OR (end_offset > start_offset AND start_offset <= ? AND end_offset >= ?)"  # touches a region
            ") AND (? IS NULL OR id != ?)",
            (text_id, start, end, start, start, exclude_id, exclude_id),
        )
    else:  # replacement / deletion
        cursor.execute(
            "SELECT id FROM suggestions WHERE text_id = ? AND ("
            "  (end_offset > start_offset AND start_offset < ? AND end_offset > ?)"       # region overlap
            "  OR (start_offset = end_offset AND start_offset >= ? AND start_offset <= ?)"  # closes over an insertion
            ") AND (? IS NULL OR id != ?)",
            (text_id, end, start, start, end, exclude_id, exclude_id),
        )
    if cursor.fetchone():
        raise HTTPException(409, "Overlaps with an existing suggestion")


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/texts/{text_id}/suggestions", response_model=List[SuggestionOut])
def list_suggestions(text_id: int):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT * FROM suggestions WHERE text_id = ? ORDER BY start_offset ASC, created_at ASC",
        (text_id,),
    )
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows


@router.post("/texts/{text_id}/suggestions", response_model=SuggestionOut)
def create_suggestion(text_id: int, payload: SuggestionCreate):
    conn = get_db()
    cursor = conn.cursor()

    # Validate text + fetch units
    cursor.execute("SELECT units_json FROM texts WHERE id = ?", (text_id,))
    doc = cursor.fetchone()
    if not doc:
        conn.close()
        raise HTTPException(404, "Text not found")
    units = json.loads(doc["units_json"])

    if payload.start_offset > payload.end_offset:
        conn.close()
        raise HTTPException(400, "start_offset must be <= end_offset")

    try:
        _validate_unit_boundaries(units, payload.start_offset, payload.end_offset)
        _validate_no_boundary_straddle(
            cursor, text_id, payload.start_offset, payload.end_offset, payload.suggested_text
        )
        _check_overlap(
            cursor, text_id, payload.start_offset, payload.end_offset
        )
    except HTTPException:
        conn.close()
        raise

    # Phase 3 E4: anchor on syllable UUIDs (end NULL for a zero-width insertion).
    start_syl_id, end_syl_id = anchor_for_range(conn, text_id, payload.start_offset, payload.end_offset)
    cursor.execute(
        "INSERT INTO suggestions (text_id, start_offset, end_offset, suggested_text, start_syl_id, end_syl_id) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (text_id, payload.start_offset, payload.end_offset, payload.suggested_text, start_syl_id, end_syl_id),
    )
    new_id = cursor.lastrowid
    conn.commit()
    cursor.execute("SELECT * FROM suggestions WHERE id = ?", (new_id,))
    row = dict(cursor.fetchone())
    conn.close()
    return row


@router.delete("/suggestions/{suggestion_id}")
def delete_suggestion(suggestion_id: int):
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM suggestions WHERE id = ?", (suggestion_id,))
    deleted = cursor.rowcount > 0
    conn.commit()
    conn.close()
    if not deleted:
        raise HTTPException(404, "Suggestion not found")
    return {"status": "ok"}
