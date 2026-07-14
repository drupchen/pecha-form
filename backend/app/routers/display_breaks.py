"""Display-only line-break overrides (the ¶ line-break mode).

Each row says: while the mode is on, render ``count`` newlines after the token
``syl_id`` (0 = suppress the break the automatic layer would draw there). This is a
pure display layer — the text data (including its real "\\n" syllables) never changes.
No row = automatic behavior (verse/sapche rules, real newlines render themselves).

Syllable-native: positions survive corrections. A passage run repeats its source
syllables' uuids, so an override applies at every occurrence — a documented
limitation of keying by uuid.
"""
from typing import List

from fastapi import APIRouter, HTTPException

from ..db import get_db
from ..derivation import base_tokens
from ..inherit import source_texts
from ..schemas import DisplayBreakIn, DisplayBreakOut

router = APIRouter(prefix="/api", tags=["display-breaks"])


@router.get("/texts/{text_id}/display-breaks", response_model=List[DisplayBreakOut])
def list_display_breaks(text_id: int):
    """This text's OWN break overrides plus those INHERITED from its source chain
    (parent + transclusion sources), resolved onto this text's composed stream. A source
    override applies wherever its anchor syllable appears here — so re-lineating a primary
    ripples into every secondary live. The child's own break at a syllable shadows an
    inherited one (and stays editable)."""
    conn = get_db()
    try:
        valid = {t["id"] for t in base_tokens(conn, text_id)}
        cursor = conn.cursor()
        by_syl: dict = {}  # syl_id -> {"count", "own"}
        for origin in [text_id] + source_texts(cursor, text_id):
            own = origin == text_id
            for r in cursor.execute(
                "SELECT syl_id, count FROM display_breaks WHERE text_id = ?", (origin,)
            ).fetchall():
                syl = r["syl_id"]
                if syl not in valid:
                    continue  # dead/foreign anchor — graceful dangling floor
                if syl in by_syl and by_syl[syl]["own"]:
                    continue  # the child's own break already claims this syllable
                by_syl[syl] = {"count": r["count"], "own": own}
        return [{"syl_id": syl, "count": v["count"]} for syl, v in by_syl.items()]
    finally:
        conn.close()


@router.put("/texts/{text_id}/display-breaks/{syl_id}", response_model=DisplayBreakOut)
def put_display_break(text_id: int, syl_id: str, payload: DisplayBreakIn):
    """Upsert the override at one position. The anchor must be a token of the text's
    exposed sequence (own syllables for a primary, composed stream for a secondary)."""
    if payload.count not in (0, 1, 2):
        raise HTTPException(400, "count must be 0, 1 or 2")
    conn = get_db()
    try:
        if not conn.execute("SELECT 1 FROM texts WHERE id = ?", (text_id,)).fetchone():
            raise HTTPException(404, "Text not found")
        if not any(t["id"] == syl_id for t in base_tokens(conn, text_id)):
            raise HTTPException(400, "syl_id is not a token of this text")
        conn.execute(
            "INSERT INTO display_breaks (text_id, syl_id, count) VALUES (?, ?, ?) "
            "ON CONFLICT(text_id, syl_id) DO UPDATE SET count = excluded.count",
            (text_id, syl_id, payload.count),
        )
        conn.commit()
        return {"syl_id": syl_id, "count": payload.count}
    finally:
        conn.close()


@router.delete("/texts/{text_id}/display-breaks/{syl_id}")
def delete_display_break(text_id: int, syl_id: str):
    """Remove the override — the position falls back to automatic behavior."""
    conn = get_db()
    try:
        conn.execute(
            "DELETE FROM display_breaks WHERE text_id = ? AND syl_id = ?",
            (text_id, syl_id),
        )
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()
