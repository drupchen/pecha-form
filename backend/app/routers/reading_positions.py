"""Per-user last-viewed position in a text (the segment the user left off at).

Syllable-native: the position is the syllable that begins the last-viewed segment, so
it survives raw-offset drift. User-scoped via ``current_user_id`` (Depends) — the
account seam; a single local user for now (see app/auth.py).
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException

from ..db import get_db
from ..auth import current_user_id
from ..schemas import ReadingPositionIn, ReadingPositionOut

router = APIRouter(prefix="/api", tags=["reading-positions"])


@router.get("/texts/{text_id}/reading-position", response_model=Optional[ReadingPositionOut])
def get_reading_position(text_id: int, user_id: int = Depends(current_user_id)):
    """The user's last-viewed position for this text, or ``null`` if none saved."""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT text_id, syl_id, updated_at FROM reading_positions "
            "WHERE user_id = ? AND text_id = ?",
            (user_id, text_id),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


@router.put("/texts/{text_id}/reading-position", response_model=ReadingPositionOut)
def put_reading_position(
    text_id: int, payload: ReadingPositionIn, user_id: int = Depends(current_user_id)
):
    """Upsert the user's last-viewed position (the segment-start syllable) for a text."""
    conn = get_db()
    try:
        if not conn.execute("SELECT 1 FROM texts WHERE id = ?", (text_id,)).fetchone():
            raise HTTPException(404, "Text not found")
        conn.execute(
            "INSERT INTO reading_positions (user_id, text_id, syl_id, updated_at) "
            "VALUES (?, ?, ?, CURRENT_TIMESTAMP) "
            "ON CONFLICT(user_id, text_id) DO UPDATE SET "
            "syl_id = excluded.syl_id, updated_at = CURRENT_TIMESTAMP",
            (user_id, text_id, payload.syl_id),
        )
        conn.commit()
        row = conn.execute(
            "SELECT text_id, syl_id, updated_at FROM reading_positions "
            "WHERE user_id = ? AND text_id = ?",
            (user_id, text_id),
        ).fetchone()
        return dict(row)
    finally:
        conn.close()
