from fastapi import APIRouter, HTTPException

from ..db import get_db
from ..derivation import (
    compose_secondary, composed_raw_text, edit_range, transclude, delete_op,
    base_tokens, insert_break,
)
from ..schemas import ComposedOut, EditRangeIn, TranscludeIn, InsertBreakIn

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
                   payload.src_start_syl_id, payload.src_end_syl_id,
                   anchor_op_id=payload.anchor_op_id)
        conn.commit()
        return _composed_payload(conn, text_id)
    finally:
        conn.close()


@router.post("/texts/{text_id}/insert-break", response_model=ComposedOut)
def post_insert_break(text_id: int, payload: InsertBreakIn):
    """Insert a manual line break (a hosted "\\n" token) before a composed token."""
    conn = get_db()
    try:
        insert_break(conn, text_id, payload.before_syl_id,
                     anchor_op_id=payload.anchor_op_id)
        conn.commit()
        return _composed_payload(conn, text_id)
    finally:
        conn.close()


@router.get("/texts/{text_id}/derivation-ops")
def list_derivation_ops(text_id: int):
    """The secondary's edit ops, each with a human-readable summary and a jump anchor —
    the sidebar's analogue of the primaries' suggestions list (delete an op to undo it)."""
    conn = get_db()
    try:
        row = conn.execute(
            "SELECT text_type, parent_text_id FROM texts WHERE id = ?", (text_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "Text not found")
        if row["text_type"] != "secondary":
            return []
        base = {t["id"]: t for t in base_tokens(conn, row["parent_text_id"])}
        out = []
        for op in conn.execute(
            "SELECT * FROM derivation_ops WHERE text_id = ? ORDER BY position, id",
            (text_id,),
        ).fetchall():
            d = dict(op)
            hosted = "".join(r["text"] for r in conn.execute(
                "SELECT s.text FROM derivation_op_syllables l "
                "JOIN syllables s ON s.id = l.syl_id AND s.text_id = ? "
                "WHERE l.op_id = ? ORDER BY l.position",
                (text_id, op["id"]),
            ))
            anchor_tok = base.get(op["anchor_syl_id"]) if op["anchor_syl_id"] else None
            anchor_text = (anchor_tok["text"] if anchor_tok else "").replace("\n", "⏎")
            shown = hosted.replace("\n", "⏎")
            kind = op["op_kind"]
            if kind == "override":
                summary = f"“{anchor_text}” → “{shown}”"
            elif kind == "delete":
                summary = f"deleted “{anchor_text}”"
            elif kind == "insert":
                summary = f"inserted “{shown}”" + ("" if anchor_tok else " (at end)")
            else:  # transclude
                src = conn.execute(
                    "SELECT title FROM texts WHERE id = ?", (op["src_text_id"],)
                ).fetchone()
                summary = f"transcluded from “{src['title'] if src else '?'}”"
            d["summary"] = summary
            out.append(d)
        return out
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
