from fastapi import APIRouter, HTTPException

from ..db import get_db
from ..derivation import (
    compose_secondary, composed_raw_text, edit_range, transclude, delete_op,
)
from ..schemas import ComposedOut, EditRangeIn, TranscludeIn

router = APIRouter(prefix="/api", tags=["derivation"])


def _composed_payload(conn, text_id: int) -> dict:
    tokens = compose_secondary(conn, text_id)
    return {"tokens": tokens, "raw_text": composed_raw_text(tokens)}


@router.get("/texts/{text_id}/composed", response_model=ComposedOut)
def get_composed(text_id: int):
    """The derived syllable sequence for a secondary text (parent links + overrides +
    added/transcluded), each token tagged with its ``source`` provenance."""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT text_type FROM texts WHERE id = ?", (text_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "Text not found")
        if row["text_type"] != "secondary":
            raise HTTPException(400, "Not a secondary text.")
        return _composed_payload(conn, text_id)
    finally:
        conn.close()


@router.post("/texts/{text_id}/edit-range", response_model=ComposedOut)
def post_edit_range(text_id: int, payload: EditRangeIn):
    """Edit a run of a secondary text as free text; reconcile into derivation ops."""
    conn = get_db()
    try:
        edit_range(conn, text_id, payload.start_syl_id, payload.end_syl_id, payload.new_text)
        conn.commit()
        return _composed_payload(conn, text_id)
    finally:
        conn.close()


@router.post("/texts/{text_id}/transclude", response_model=ComposedOut)
def post_transclude(text_id: int, payload: TranscludeIn):
    """Splice a range from another text into a secondary text (links, not copies)."""
    conn = get_db()
    try:
        transclude(conn, text_id, payload.anchor_syl_id, payload.src_text_id,
                   payload.src_start_syl_id, payload.src_end_syl_id)
        conn.commit()
        return _composed_payload(conn, text_id)
    finally:
        conn.close()


@router.delete("/derivation-ops/{op_id}")
def delete_derivation_op(op_id: int):
    conn = get_db()
    try:
        if not delete_op(conn, op_id):
            raise HTTPException(404, "Derivation op not found")
        conn.commit()
        return {"status": "ok"}
    finally:
        conn.close()
